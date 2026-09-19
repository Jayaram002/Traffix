import os
from pathlib import Path

# Base Paths
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(r"D:\temp C\all filess\ram\Neurax3.0\Training set")
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Dataset file paths (defaults to organizer dataset directory if present)
DATASET_PATHS = {
    "network": DATA_DIR / "network.csv",
    "nodes": DATA_DIR / "nodes.csv",
    "traffic_validation": DATA_DIR / "traffic_validation.csv",
    "traffic_train": DATA_DIR / "traffic_train.csv",
    "forecast_targets_val": DATA_DIR / "forecast_targets_validation.csv",
    "incidents_val": DATA_DIR / "incidents_validation.csv",
    "incidents_train": DATA_DIR / "incidents_train.csv",
    "context_train": DATA_DIR / "context_train.csv",
    "context_val": DATA_DIR / "context_validation.csv",
    "roadworks_val": DATA_DIR / "roadworks_validation.csv",
    "planning_candidates": DATA_DIR / "planning_candidates.csv",
    "signal_plans": DATA_DIR / "signal_plans.csv",
    "scenario_examples": DATA_DIR / "scenario_examples.csv"
}

# Column Mapping configuration for Data Adapter
COLUMN_MAPPINGS = {
    "network": {
        "segment_id": "segment_id",
        "source_node": "source_node",
        "target_node": "target_node",
        "road_class": "road_class",
        "lanes": "lanes",
        "free_flow_speed_kmh": "free_flow_speed_kmh",
        "capacity_vph": "capacity_vph",
        "length_km": "length_km",
        "grade_pct": "grade_pct",
        "signal_id": "signal_id",
        "structural_bottleneck": "structural_bottleneck",
        "importance": "importance",
        "peak_capacity_factor": "peak_capacity_factor"
    },
    "nodes": {
        "node_id": "node_id",
        "lat": "lat",
        "lon": "lon",
        "x": "x",
        "y": "y"
    },
    "traffic": {
        "timestamp": "timestamp",
        "segment_id": "segment_id",
        "source_node": "source_node",
        "target_node": "target_node",
        "speed_kmh": "speed_kmh",
        "flow_vph": "flow_vph",
        "occupancy_pct": "occupancy_pct",
        "travel_time_min": "travel_time_min",
        "free_flow_time_min": "free_flow_time_min",
        "delay_min": "delay_min",
        "queue_length_veh": "queue_length_veh",
        "congestion_index": "congestion_index",
        "sensor_quality": "sensor_quality"
    }
}

# Thresholds for Congestion Levels (speed ratio = speed / free_flow_speed)
CONGESTION_THRESHOLDS = {
    "free": 0.80,    # >= 80% free flow speed
    "slow": 0.50,    # 50% - 80%
    "heavy": 0.25,   # 25% - 50%
    "jam": 0.0       # < 25%
}

# BPR parameters for dynamic routing & delay calculations
BPR_ALPHA = 0.15
BPR_BETA = 4.0

# Server config
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000

# Google Gemini & Neon AI Gateway Configuration
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyDefaultTraffixNeuraxGeminiPipelineKey2026").strip()
if not GEMINI_API_KEY:
    GEMINI_API_KEY = "AIzaSyDefaultTraffixNeuraxGeminiPipelineKey2026"
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash").strip()
NEON_AI_GATEWAY_BASE_URL = os.getenv("NEON_AI_GATEWAY_BASE_URL", "").strip()
NEON_AI_GATEWAY_TOKEN = os.getenv("NEON_AI_GATEWAY_TOKEN", "").strip()
