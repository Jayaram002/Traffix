import pytest
from fastapi.testclient import TestClient
from traffix.api.app import app, service
from traffix.engines.gemini_engine import GeminiIntelligenceEngine

client = TestClient(app)

def test_gemini_engine_direct_fallback():
    """Verify that Gemini engine in fallback mode returns structured schema."""
    engine = GeminiIntelligenceEngine(api_key="")
    assert not engine.is_api_configured

    # 1. Telemetry Preprocessing
    stats = {
        "total_rows": 1000,
        "missing_speed_values": 25,
        "negative_speed_values": 3,
        "imputed_fraction": 0.028,
        "segments_covered": 436
    }
    prep = engine.preprocess_telemetry(stats)
    assert "sensor_integrity_score" in prep
    assert "quality_tier" in prep
    assert "anomaly_classification" in prep
    assert "provenance_summary" in prep
    assert "traffix_ml_fallback" in prep["powered_by"]

    # 2. Incident Classification
    inc_data = {
        "segment_id": "seg_101",
        "speed_kmh": 12.0,
        "speed_drop_kmh": 28.0,
        "free_flow_speed_kmh": 60.0,
        "queue_length_veh": 35.0,
        "v_c_ratio": 1.15,
        "contributing_factors": ["Sudden speed drop", "Queue buildup"]
    }
    inc_class = engine.classify_incident(inc_data)
    assert inc_class["incident_type"] == "Collision / Multi-Vehicle Crash"
    assert inc_class["severity_grade"] >= 3
    assert len(inc_class["tactical_mitigations"]) >= 2
    assert "traffix_ml_fallback" in inc_class["powered_by"]

    # 3. Route Safety Audit
    route_data = {
        "origin_node": "node_1",
        "destination_node": "node_10",
        "distance_km": 8.5,
        "estimated_time_min": 14.0,
        "normal_free_flow_time_min": 10.0,
        "congested_segments_count": 1,
        "has_emergency_conflict": False
    }
    route_class = engine.classify_route_risk(route_data)
    assert route_class["safety_classification"] in ["OPTIMAL_SAFE", "MODERATE_CONGESTION"]
    assert route_class["safety_score"] > 60
    assert not route_class["conflict_detected"]

    # Emergency Conflict Route Audit
    route_conflict = dict(route_data)
    route_conflict["has_emergency_conflict"] = True
    conflict_class = engine.classify_route_risk(route_conflict)
    assert conflict_class["safety_classification"] == "CRITICAL_EMERGENCY_CONFLICT"
    assert conflict_class["conflict_detected"] is True

    # 4. Situation Briefing
    kpis = {"congested_segments": 8, "total_delay_min": 45.2, "spillback_count": 2}
    brief = engine.generate_situation_briefing(kpis, [inc_class])
    assert "executive_summary" in brief
    assert len(brief["hotspot_corridors"]) > 0
    assert "priority_action" in brief

def test_api_ai_status():
    """Verify /api/ai/status endpoint returns valid operational mode."""
    response = client.get("/api/ai/status")
    assert response.status_code == 200
    data = response.json()
    assert "api_configured" in data
    assert "model" in data
    assert "operating_mode" in data

def test_api_ai_preprocess():
    """Verify /api/ai/preprocess endpoint."""
    response = client.post("/api/ai/preprocess", json={
        "summary_stats": {
            "total_rows": 500,
            "missing_speed_values": 5,
            "negative_speed_values": 0,
            "imputed_fraction": 0.01,
            "segments_covered": 120
        }
    })
    assert response.status_code == 200
    data = response.json()
    assert "sensor_integrity_score" in data
    assert data["quality_tier"] in ["EXCELLENT", "ACCEPTABLE", "DEGRADED"]

def test_api_ai_classify_incident():
    """Verify /api/ai/classify-incident endpoint."""
    payload = {
        "segment_id": "seg_hitec_01",
        "speed_kmh": 8.5,
        "speed_drop_kmh": 32.0,
        "free_flow_speed_kmh": 65.0,
        "queue_length_veh": 45.0,
        "v_c_ratio": 1.25,
        "rain_intensity": 0.0,
        "contributing_factors": ["Severe deceleration", "Rapid queue propagation"]
    }
    response = client.post("/api/ai/classify-incident", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "incident_type" in data
    assert "severity_grade" in data
    assert "root_cause_attribution" in data
    assert len(data["tactical_mitigations"]) > 0

def test_api_ai_classify_route():
    """Verify /api/ai/classify-route endpoint."""
    payload = {
        "origin_node": "node_banjara",
        "destination_node": "node_gachibowli",
        "distance_km": 12.4,
        "estimated_time_min": 28.0,
        "normal_free_flow_time_min": 15.0,
        "congested_segments_count": 4,
        "has_emergency_conflict": False
    }
    response = client.post("/api/ai/classify-route", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "safety_classification" in data
    assert "safety_score" in data
    assert "hazard_summary" in data

def test_api_ai_situation_briefing():
    """Verify /api/ai/situation-briefing endpoint."""
    response = client.get("/api/ai/situation-briefing")
    assert response.status_code == 200
    data = response.json()
    assert "executive_summary" in data
    assert "hotspot_corridors" in data
    assert "traffic_outlook_30m" in data
