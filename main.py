import argparse
import uvicorn
import logging
import sys
from pathlib import Path

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from traffix.core.config import SERVER_HOST, SERVER_PORT
from traffix.core.service import TrafficIntelligenceService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("TraffixMain")

def run_server(host: str = SERVER_HOST, port: int = SERVER_PORT, reload: bool = False):
    logger.info(f"Starting Traffix Decision-Support Server at http://{host}:{port}")
    uvicorn.run("traffix.api.app:app", host=host, port=port, reload=reload)

def run_benchmark():
    logger.info("Running offline evaluation and benchmarking...")
    svc = TrafficIntelligenceService.get_instance()
    svc.initialize()

    # 1. State estimation
    state = svc.get_current_state()
    print(f"\n--- Network State Summary ---")
    print(f"Total Segments: {state['total_segments']}")
    print(f"Congested Segments: {state['congested_segments_count']} ({state['network_congestion_pct']}%)")
    print(f"Total Network Delay: {state['total_delay_min']} min")
    print(f"Detected Spillbacks: {len(state['detected_spillbacks'])}")

    # 2. Forecaster evaluation against baselines
    print(f"\n--- Multi-Horizon Forecast Benchmark ---")
    bench = svc.forecaster.evaluate_against_baselines(svc.get_traffic_snapshot())
    for horizon, metrics in bench.items():
        print(f"Horizon {horizon}:")
        print(f"  Traffix Model MAE: {metrics['our_model']['mae']} km/h (MAPE: {metrics['our_model']['mape_pct']}%)")
        print(f"  Persistence MAE:   {metrics['persistence_baseline']['mae']} km/h")
        print(f"  Improvement:       +{metrics['improvement_over_persistence_pct']}% over persistence")

    # 3. Emergency Corridor sample test
    print(f"\n--- Emergency Green Corridor Preemption Test ---")
    emerg_res = svc.emergency_engine.create_green_corridor("N001", "N025", vehicle_type="Ambulance")
    if emerg_res.get("success"):
        print(f"Status: {emerg_res['active_status']}")
        print(f"Distance: {emerg_res['total_distance_km']} km")
        print(f"Emergency ETA: {emerg_res['estimated_emergency_travel_time_min']} min (Time Saved: {emerg_res['time_saved_min']} min)")
        print(f"Preempted Signals: {len(emerg_res['signal_preemptions'])} junctions")
        print(f"Civilian Diversions Triggered: {len(emerg_res['civilian_diversions'])} approaches")

    # 4. Long-term infrastructure candidates
    print(f"\n--- Top 3 Long-Term Infrastructure Interventions (BPR Counterfactual) ---")
    candidates = svc.get_infrastructure_proposals()
    for c in candidates[:3]:
        print(f"Candidate {c['candidate_id']} ({c['intervention_type']} on {c['target_segment']}):")
        print(f"  Delay: {c['before_metrics']['delay_min']} min -> {c['after_metrics']['delay_min']} min (saved {c['impact']['travel_time_saved_min']} min)")
        print(f"  Benefit-Cost Ratio: {c['impact']['benefit_cost_ratio']}")

    print("\nBenchmark completed successfully.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Traffix NeuraX 3.0 Platform CLI")
    parser.add_argument("--mode", choices=["server", "benchmark"], default="server", help="Execution mode")
    parser.add_argument("--host", default=SERVER_HOST, help="Server bind host")
    parser.add_argument("--port", type=int, default=SERVER_PORT, help="Server port")
    args = parser.parse_args()

    if args.mode == "benchmark":
        run_benchmark()
    else:
        run_server(host=args.host, port=args.port)
