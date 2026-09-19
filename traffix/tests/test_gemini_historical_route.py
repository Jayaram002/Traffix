import pytest
from fastapi.testclient import TestClient
from traffix.api.app import app, service

@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c

def test_historical_route_analytics_grounded_in_database():
    """Verify that get_historical_route_analytics extracts present vs past database metrics."""
    # Pick known route segments
    test_segments = ["S001", "S002", "S003"]
    analytics = service.get_historical_route_analytics(test_segments, present_timestamp="2026-01-16 02:00:00")
    
    assert isinstance(analytics, dict)
    assert "present_speed_kmh" in analytics
    assert "past_avg_speed_kmh" in analytics
    assert "speed_delta_pct" in analytics
    assert "recurrence_rate_pct" in analytics
    assert "db_records_analyzed" in analytics
    assert analytics["db_records_analyzed"] > 0
    assert "data_source" in analytics
    assert "present_time" in analytics
    assert "past_time" in analytics

def test_gemini_engine_historical_route_decision():
    """Verify Gemini AI route detection using present vs past time and database grounding."""
    from traffix.engines.gemini_engine import GeminiIntelligenceEngine
    if not service.gemini_engine:
        service.gemini_engine = GeminiIntelligenceEngine()
    ge = service.gemini_engine
    assert ge is not None

    selected_route = {
        "route_id": "ROUTE_1",
        "route_label": "Direct Arterial (N014 to N086)",
        "distance_km": 12.5,
        "predicted_travel_time_min": 18.0,
        "predicted_delay_min": 1.5,
        "reliability_score": 93.0,
        "corridor_conflict": False,
        "segments": ["S014", "S015", "S016"]
    }
    candidate_routes = [selected_route]
    hist_data = {
        "present_speed_kmh": 41.5,
        "past_avg_speed_kmh": 44.0,
        "speed_delta_pct": -5.7,
        "recurrence_rate_pct": 11.2,
        "db_records_analyzed": 2840,
        "data_source": "Neon Lakebase Postgres (traffic_validation.csv)"
    }

    decision = ge.detect_route_with_historical_gemini(
        selected_route=selected_route,
        candidate_routes=candidate_routes,
        present_time="2026-01-16 04:30:00",
        past_time="Historical 60-min Database Horizon",
        historical_db_data=hist_data,
        origin_label="HITEC City",
        dest_label="Secunderabad"
    )

    assert isinstance(decision, dict)
    assert "decision_verdict" in decision
    assert "decision_title" in decision
    assert "present_vs_past_analysis" in decision
    assert "historical_pattern_insight" in decision
    assert "recommended_action" in decision
    assert "departure_urgency" in decision
    assert "speed_metrics" in decision
    assert decision["speed_metrics"]["db_records_analyzed"] == 2840

def test_api_route_gemini_decision_endpoint(client):
    """Test POST /api/route/gemini-decision."""
    payload = {
        "origin_node": "N014",
        "destination_node": "N086",
        "selected_route_id": "ROUTE_1",
        "present_time": "2026-01-16 04:30:00",
        "origin_label": "HITEC City",
        "destination_label": "Secunderabad"
    }
    resp = client.post("/api/route/gemini-decision", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert "decision_verdict" in data
    assert "decision_title" in data
    assert "present_vs_past_analysis" in data
    assert "historical_analytics" in data
    assert "speed_metrics" in data
    assert data["historical_analytics"]["db_records_analyzed"] > 0

def test_api_ml_predict_includes_historical_decision(client):
    """Test POST /api/route/ml-predict returns both ML routes and Gemini historical decision."""
    payload = {
        "origin_node": "N014",
        "destination_node": "N086",
        "k": 3,
        "present_time": "2026-01-16 04:30:00"
    }
    resp = client.post("/api/route/ml-predict", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert "routes" in data
    assert len(data["routes"]) > 0
    assert "gemini_historical_decision" in data
    hist_dec = data["gemini_historical_decision"]
    assert "decision_verdict" in hist_dec
    assert "historical_analytics" in hist_dec
