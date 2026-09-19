import unittest
import sys
from pathlib import Path
import pandas as pd

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from traffix.core.data_adapter import DataAdapter
from traffix.core.network_graph import RoadNetworkGraph
from traffix.core.synthetic_generator import SyntheticTrafficGenerator
from traffix.engines.state_estimator import NetworkStateEstimator
from traffix.engines.incident_detector import HybridIncidentDetector
from traffix.engines.forecaster import MultiHorizonForecaster
from traffix.engines.emergency_corridor import EmergencyCorridorEngine
from traffix.engines.recommender import TrafficRecommendationEngine
from traffix.engines.robustness_harness import RobustnessEvaluationHarness

class TestTraffixSystem(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Generate synthetic test data to guarantee test repeatability
        cls.generator = SyntheticTrafficGenerator(segments=20, nodes=10, days=1)
        cls.network_df, cls.nodes_df = cls.generator.generate_network()
        cls.traffic_df = cls.generator.generate_traffic(cls.network_df)
        cls.graph = RoadNetworkGraph(cls.network_df, cls.nodes_df)

    def test_01_graph_construction(self):
        """Verify network graph has nodes and directed edges."""
        self.assertEqual(len(self.graph.graph.nodes), 10)
        self.assertGreaterEqual(len(self.graph.graph.edges), 15)
        # Verify GeoJSON export
        geojson = self.graph.export_geojson()
        self.assertEqual(geojson["type"], "FeatureCollection")
        self.assertGreater(len(geojson["features"]), 0)

    def test_02_pathfinding_and_routing(self):
        """Verify Dijkstra routing returns valid path, distance, and coordinates."""
        u = self.nodes_df["node_id"].iloc[0]
        v = self.nodes_df["node_id"].iloc[1]
        route = self.graph.find_best_route(u, v)
        self.assertIsNotNone(route)
        self.assertIn("estimated_time_min", route)
        self.assertIn("distance_km", route)
        self.assertGreater(len(route["coordinates"]), 0)

    def test_03_state_estimator(self):
        """Verify state estimator classifies congestion and detects spillbacks."""
        estimator = NetworkStateEstimator(self.graph)
        estimator.fit_baseline(self.traffic_df)
        snapshot = self.traffic_df[self.traffic_df["timestamp"] == self.traffic_df["timestamp"].iloc[0]]
        state = estimator.estimate_network_state(snapshot)
        self.assertIn("total_segments", state)
        self.assertIn("network_congestion_pct", state)
        self.assertIn("segment_states", state)

    def test_04_incident_detector(self):
        """Verify hybrid incident detector flags anomalies and handles persistence."""
        detector = HybridIncidentDetector(self.graph)
        snapshot = self.traffic_df[self.traffic_df["timestamp"] == self.traffic_df["timestamp"].iloc[0]]
        alerts = detector.detect_anomalies(snapshot)
        self.assertIsInstance(alerts, list)

    def test_05_multi_horizon_forecaster(self):
        """Verify forecaster generates 15, 30, 45, 60m predictions with confidence intervals."""
        forecaster = MultiHorizonForecaster(self.graph)
        forecaster.train(self.traffic_df)
        self.assertTrue(forecaster.is_trained)
        seg_id = self.network_df["segment_id"].iloc[0]
        res = forecaster.predict_segment(seg_id, {"speed_kmh": 45.0, "flow_vph": 800.0}, "2026-01-16 08:30:00")
        self.assertIn("forecasts", res)
        for h in [15, 30, 45, 60]:
            self.assertIn(f"{h}m", res["forecasts"])
            f = res["forecasts"][f"{h}m"]
            self.assertLessEqual(f["lower_bound_kmh"], f["predicted_speed_kmh"])
            self.assertGreaterEqual(f["upper_bound_kmh"], f["predicted_speed_kmh"])

    def test_06_emergency_green_corridor(self):
        """Verify emergency corridor prioritizes vehicle, computes signal preemption and diversions."""
        engine = EmergencyCorridorEngine(self.graph)
        u = self.nodes_df["node_id"].iloc[0]
        v = self.nodes_df["node_id"].iloc[5]
        res = engine.create_green_corridor(u, v, vehicle_type="Ambulance")
        self.assertTrue(res["success"])
        self.assertEqual(res["active_status"], "GREEN_CORRIDOR_ACTIVE")
        self.assertIn("signal_preemptions", res)
        self.assertIn("civilian_diversions", res)

    def test_07_infrastructure_bpr_counterfactual(self):
        """Verify long-term planning candidate simulation with BPR volume-delay function."""
        recommender = TrafficRecommendationEngine(self.graph)
        cand_df = pd.DataFrame([{
            "candidate_id": "TEST_PLAN_01",
            "target_segment": self.network_df["segment_id"].iloc[0],
            "intervention_type": "lane_addition",
            "capacity_delta_vph": 900,
            "cost_index": 5,
            "feasibility_band": "high"
        }])
        eval_res = recommender.evaluate_infrastructure_candidates(cand_df, self.traffic_df)
        self.assertEqual(len(eval_res), 1)
        impact = eval_res[0]["impact"]
        self.assertGreaterEqual(impact["travel_time_saved_min"], 0.0)
        self.assertIn("benefit_cost_ratio", impact)

    def test_08_robustness_harness(self):
        """Verify robustness stress tests evaluate degradation across all scenarios."""
        harness = RobustnessEvaluationHarness(self.graph)
        res = harness.run_stress_tests(self.traffic_df)
        self.assertIn("scenarios", res)
        self.assertGreater(len(res["scenarios"]), 5)
        self.assertIn("overall_system_resilience_score", res)

if __name__ == "__main__":
    unittest.main()
