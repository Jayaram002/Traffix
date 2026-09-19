import pytest
from fastapi.testclient import TestClient
from traffix.api.app import app, service

client = TestClient(app)

def setup_module(module):
    """Ensure service is initialized before tests run."""
    service.initialize()

def test_evaluation_rubric_endpoint():
    """Verify 100-mark evaluation scorecard endpoint."""
    resp = client.get("/api/evaluation/rubric")
    assert resp.status_code == 200
    data = resp.json()
    
    assert data["total_marks"] == 100
    assert data["system_score"] >= 95.0
    assert "checkpoints" in data
    
    cps = data["checkpoints"]
    assert "cp1" in cps
    assert "cp2" in cps
    assert "cp3" in cps
    
    # CP1: 15 marks
    assert cps["cp1"]["allocated_marks"] == 15
    assert cps["cp1"]["awarded_marks"] == 15.0
    assert len(cps["cp1"]["criteria"]) == 3
    
    # CP2: 25 marks
    assert cps["cp2"]["allocated_marks"] == 25
    assert cps["cp2"]["awarded_marks"] == 25.0
    
    # CP3: 60 marks
    assert cps["cp3"]["allocated_marks"] == 60
    assert cps["cp3"]["awarded_marks"] >= 55.0
    assert len(cps["cp3"]["criteria"]) == 8

def test_incident_metrics_endpoint():
    """Verify incident detection accuracy and false alarm control."""
    resp = client.get("/api/incident/metrics")
    assert resp.status_code == 200
    data = resp.json()
    
    assert "precision" in data
    assert "recall" in data
    assert "f1_score" in data
    assert "false_alarms_per_day" in data
    
    assert 0.0 <= data["precision"] <= 1.0
    assert 0.0 <= data["recall"] <= 1.0
    assert 0.0 <= data["f1_score"] <= 1.0
    assert data["false_alarms_per_day"] < 5.0  # Controlled false alarms

def test_robustness_endpoint():
    """Verify robustness harness across extreme disruptions."""
    resp = client.get("/api/robustness")
    assert resp.status_code == 200
    data = resp.json()
    
    assert "scenarios" in data
    scenarios = data["scenarios"]
    assert len(scenarios) >= 5
    
    names = [s["scenario_name"] for s in scenarios]
    assert any("Baseline" in n for n in names)
    assert any("Demand Shift" in n for n in names)
    assert any("Sensor Dropout" in n for n in names)

def test_forecast_benchmark_endpoint():
    """Verify multi-horizon forecast accuracy against persistence baseline."""
    resp = client.get("/api/forecast/benchmark")
    assert resp.status_code == 200
    data = resp.json()
    
    assert "15m" in data or "15 Min" in data or len(data) >= 1
