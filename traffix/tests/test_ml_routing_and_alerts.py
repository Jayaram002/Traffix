import pytest
from fastapi.testclient import TestClient
from traffix.api.app import app, service
from traffix.engines.route_ml import MLRoutePredictor

client = TestClient(app)

def setup_module(module):
    """Ensure service is initialized before tests run."""
    service.initialize()

def test_ml_route_predictor_direct():
    predictor = MLRoutePredictor(service.network_graph)
    assert predictor.is_trained is True

    nodes = list(service.network_graph.graph.nodes())
    assert len(nodes) >= 2
    u, v = nodes[0], nodes[1]

    routes = predictor.find_and_classify_routes(u, v, k=3)
    assert isinstance(routes, list)
    assert len(routes) > 0

    first = routes[0]
    assert "route_id" in first
    assert "predicted_travel_time_min" in first
    assert "ml_classification" in first
    assert first["ml_classification"] in [
        "OPTIMAL_SAFE", "MODERATE_CONGESTION", "BOTTLENECK_PRONE", "EMERGENCY_CONFLICT"
    ]
    assert 0 <= first["reliability_score"] <= 100
    assert "coordinates" in first
    assert len(first["coordinates"]) >= 2

def test_api_ml_route_predict_endpoint():
    nodes = list(service.network_graph.graph.nodes())
    u, v = nodes[0], nodes[1]

    resp = client.post("/api/route/ml-predict", json={
        "origin_node": u,
        "destination_node": v,
        "k": 3
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["origin_node"] == u
    assert data["destination_node"] == v
    assert data["routes_evaluated"] > 0
    assert len(data["routes"]) > 0

    first_route = data["routes"][0]
    assert "predicted_travel_time_min" in first_route
    assert "ml_classification" in first_route
    assert "reliability_score" in first_route
    assert "is_recommended" in first_route

def test_emergency_corridor_activation_and_alert_broadcast():
    nodes = list(service.network_graph.graph.nodes())
    u, v = nodes[0], nodes[2] if len(nodes) > 2 else nodes[1]

    # 1. Unauthenticated or Civilian attempt should be BLOCKED (403 Forbidden)
    civ_token_res = client.post("/auth/login", json={"username_or_email": "viewer", "password": "ViewerPass123!"})
    civ_token = civ_token_res.json().get("access_token")
    civ_headers = {"Authorization": f"Bearer {civ_token}"} if civ_token else {}

    unauth_resp = client.post("/api/route/emergency", json={
        "origin_node": u,
        "destination_node": v,
        "vehicle_type": "Ambulance",
        "priority_level": "Critical"
    }, headers=civ_headers)
    assert unauth_resp.status_code == 403, "Civilian/viewer must be forbidden from activating emergency corridor"

    # 2. Authorized Emergency Service (EMS / Operator) activation succeeds (200 OK)
    auth_token_res = client.post("/auth/login", json={"username_or_email": "ems108", "password": "emergency123"})
    if auth_token_res.status_code != 200:
        # Fallback to operator if ems108 hasn't been seeded in this test db session
        auth_token_res = client.post("/auth/login", json={"username_or_email": "operator", "password": "OperatorPass123!"})
    auth_token = auth_token_res.json()["access_token"]
    auth_headers = {"Authorization": f"Bearer {auth_token}"}

    emerg_resp = client.post("/api/route/emergency", json={
        "origin_node": u,
        "destination_node": v,
        "vehicle_type": "Ambulance",
        "priority_level": "Critical"
    }, headers=auth_headers)
    assert emerg_resp.status_code == 200
    emerg_data = emerg_resp.json()
    assert emerg_data["success"] is True
    corridor_id = emerg_data["corridor_id"]
    assert len(emerg_data["signal_preemptions"]) > 0

    # 3. Check active emergency alerts endpoint
    alerts_resp = client.get("/api/emergency/alerts")
    assert alerts_resp.status_code == 200
    alerts_data = alerts_resp.json()
    assert alerts_data["active_count"] >= 1
    found = any(a["corridor_id"] == corridor_id for a in alerts_data["alerts"])
    assert found is True

    # 4. Call ML route predictor along that path - should detect emergency conflict
    ml_resp = client.post("/api/route/ml-predict", json={
        "origin_node": u,
        "destination_node": v,
        "k": 3
    })
    assert ml_resp.status_code == 200
    ml_data = ml_resp.json()
    assert ml_data["emergency_alert"] is not None
    assert "EMERGENCY PRIORITY ACTIVE" in ml_data["emergency_alert"]["message"]
    # At least one candidate route should reflect the corridor conflict
    conflicted = any(r["corridor_conflict"] is True for r in ml_data["routes"])
    assert conflicted is True

    # 5. Civilian attempt to clear corridor should be BLOCKED (403 Forbidden)
    civ_clear_resp = client.post("/api/emergency/clear", json={"corridor_id": corridor_id}, headers=civ_headers)
    assert civ_clear_resp.status_code == 403

    # 6. Authorized Emergency Service clears corridor
    clear_resp = client.post("/api/emergency/clear", json={
        "corridor_id": corridor_id
    }, headers=auth_headers)
    assert clear_resp.status_code == 200
    clear_data = clear_resp.json()
    assert clear_data["success"] is True

    # 7. Verify alert is now cleared
    after_clear_resp = client.get("/api/emergency/alerts")
    after_data = after_clear_resp.json()
    still_active = any(a["corridor_id"] == corridor_id for a in after_data["alerts"])
    assert still_active is False
