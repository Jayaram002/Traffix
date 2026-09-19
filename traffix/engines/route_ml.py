import numpy as np
import pandas as pd
import networkx as nx
from typing import Dict, Any, List, Optional, Tuple
from sklearn.ensemble import RandomForestClassifier, GradientBoostingRegressor
from traffix.core.network_graph import RoadNetworkGraph

class MLRoutePredictor:
    """
    Machine Learning Route Classifier & Travel Time Predictor.
    - Generates K-alternate routes using graph topology
    - Predicts travel times using gradient boosted regressions on dynamic link features
    - Classifies route quality (OPTIMAL_SAFE, MODERATE_CONGESTION, BOTTLENECK_PRONE, EMERGENCY_CONFLICT)
    - Computes Route Reliability Score (0-100)
    - Automatically detects conflicts with active emergency green corridors
    """
    def __init__(self, road_network: RoadNetworkGraph):
        self.network = road_network
        self.regressor = GradientBoostingRegressor(n_estimators=50, max_depth=4, random_state=42)
        self.classifier = RandomForestClassifier(n_estimators=50, max_depth=5, random_state=42)
        self.is_trained = False
        self._initialize_default_models()

    def _initialize_default_models(self):
        """Train baseline ML models with physical synthetic feature combinations."""
        # Feature vector: [total_distance, avg_free_flow_speed, num_segments, num_signals, avg_v_c, has_incident, near_emergency]
        np.random.seed(42)
        N = 1000
        distances = np.random.uniform(1.0, 25.0, N)
        avg_ffs = np.random.choice([35.0, 45.0, 60.0, 70.0], N)
        num_segs = np.clip((distances / 1.2).astype(int), 1, 20)
        num_signals = np.random.binomial(num_segs, 0.4)
        v_c = np.random.uniform(0.1, 1.3, N)
        has_incident = np.random.binomial(1, 0.1, N)
        near_emerg = np.random.binomial(1, 0.08, N)

        X = np.column_stack([distances, avg_ffs, num_segs, num_signals, v_c, has_incident, near_emerg])

        # Target 1: Travel time in minutes
        free_flow_time = (distances / avg_ffs) * 60.0
        congestion_delay = free_flow_time * 0.15 * (v_c ** 4)
        incident_delay = has_incident * np.random.uniform(8.0, 25.0, N)
        emergency_delay = near_emerg * np.random.uniform(4.0, 15.0, N)
        y_time = free_flow_time + congestion_delay + incident_delay + emergency_delay + np.random.normal(0, 1.0, N)
        y_time = np.maximum(y_time, 1.0)

        # Target 2: Route Classification
        # 0: OPTIMAL_SAFE, 1: MODERATE_CONGESTION, 2: BOTTLENECK_PRONE, 3: EMERGENCY_CONFLICT
        y_class = []
        for i in range(N):
            if near_emerg[i] == 1:
                y_class.append("EMERGENCY_CONFLICT")
            elif has_incident[i] == 1 or v_c[i] > 1.0:
                y_class.append("BOTTLENECK_PRONE")
            elif v_c[i] > 0.65:
                y_class.append("MODERATE_CONGESTION")
            else:
                y_class.append("OPTIMAL_SAFE")
        y_class = np.array(y_class)

        self.regressor.fit(X, y_time)
        self.classifier.fit(X, y_class)
        self.is_trained = True

    def find_and_classify_routes(
        self,
        origin_node: str,
        dest_node: str,
        k: int = 3,
        active_emergency_corridors: Optional[List[Dict[str, Any]]] = None
    ) -> List[Dict[str, Any]]:
        """
        Finds K candidate routes and applies ML models to predict travel times,
        classify risk levels, and detect emergency green corridor interference.
        """
        if origin_node not in self.network.graph or dest_node not in self.network.graph:
            return []

        # Collect active emergency segments and nodes
        emergency_segments = set()
        emergency_nodes = set()
        if active_emergency_corridors:
            for ec in active_emergency_corridors:
                for seg in ec.get("segments", []):
                    emergency_segments.add(seg)
                for node in ec.get("nodes", []):
                    emergency_nodes.add(node)

        # Generate candidate simple paths (up to k distinct routes)
        candidate_paths = []
        try:
            # Yen's K shortest paths using travel time and distance
            path_generator = nx.shortest_simple_paths(self.network.graph, origin_node, dest_node, weight="free_flow_time_min")
            count = 0
            for path in path_generator:
                candidate_paths.append(path)
                count += 1
                if count >= k:
                    break
        except Exception:
            # Fallback to single shortest path
            single = self.network.find_best_route(origin_node, dest_node)
            if single:
                candidate_paths = [single["nodes"]]

        evaluated_routes = []
        for idx, node_path in enumerate(candidate_paths):
            # Extract segments
            segments = []
            total_dist = 0.0
            speeds = []
            caps = []
            flows = []
            signals_count = 0
            has_incident = 0
            corridor_conflict = 0

            for i in range(len(node_path) - 1):
                u = node_path[i]
                v = node_path[i + 1]
                edge_data = self.network.graph[u][v]
                seg_id = edge_data["segment_id"]
                segments.append(seg_id)
                total_dist += edge_data["length_km"]
                speeds.append(edge_data.get("current_speed_kmh", edge_data["free_flow_speed_kmh"]))
                caps.append(edge_data["capacity_vph"])
                flows.append(edge_data.get("current_flow_vph", 0.0))
                if edge_data.get("signal_id"):
                    signals_count += 1

                # Check if edge is in active emergency corridor
                if seg_id in emergency_segments or u in emergency_nodes or v in emergency_nodes:
                    corridor_conflict = 1

                # Check for severe congestion or incident flag
                if edge_data.get("current_speed_kmh", 50.0) < (edge_data["free_flow_speed_kmh"] * 0.35):
                    has_incident = 1

            avg_speed = float(np.mean(speeds)) if speeds else 50.0
            avg_cap = float(np.mean(caps)) if caps else 1800.0
            avg_flow = float(np.mean(flows)) if flows else 500.0
            v_c = avg_flow / max(avg_cap, 1.0)
            num_segs = len(segments)

            # Build feature vector
            feat = np.array([[total_dist, avg_speed, num_segs, signals_count, v_c, has_incident, corridor_conflict]])

            # ML Predictions
            predicted_time = float(self.regressor.predict(feat)[0])
            predicted_class = str(self.classifier.predict(feat)[0])
            class_probs = self.classifier.predict_proba(feat)[0]
            confidence = float(np.max(class_probs))

            # Free flow baseline comparison
            free_flow_time = (total_dist / max(avg_speed, 10.0)) * 60.0
            predicted_delay = max(0.0, round(predicted_time - free_flow_time, 1))

            # Compute Safety & Reliability Score (0 to 100)
            reliability = 100.0 - (v_c * 30.0) - (has_incident * 35.0) - (corridor_conflict * 40.0) - (signals_count * 2.0)
            reliability = float(np.clip(reliability, 15.0, 99.0))

            # Coordinates for mapping
            coords = [[self.network.node_lookup[n]["lat"], self.network.node_lookup[n]["lon"]] for n in node_path]

            evaluated_routes.append({
                "route_id": f"ROUTE_{idx + 1}",
                "route_label": f"Option {idx + 1}: {'Direct Arterial' if idx == 0 else ('Flyover Express' if idx == 1 else 'Alternate Collector')}",
                "nodes": node_path,
                "segments": segments,
                "coordinates": coords,
                "distance_km": round(total_dist, 2),
                "predicted_travel_time_min": round(predicted_time, 1),
                "predicted_delay_min": predicted_delay,
                "ml_classification": predicted_class,
                "reliability_score": round(reliability, 1),
                "confidence": round(confidence, 2),
                "signals_count": signals_count,
                "corridor_conflict": bool(corridor_conflict),
                "is_recommended": (idx == 0 and corridor_conflict == 0) or (idx == 1 and candidate_paths[0] and corridor_conflict == 0)
            })

        # Sort so that non-conflicting, highest reliability route is ranked first
        evaluated_routes.sort(key=lambda r: (r["corridor_conflict"], -r["reliability_score"], r["predicted_travel_time_min"]))
        if evaluated_routes:
            evaluated_routes[0]["is_recommended"] = True
            for r in evaluated_routes[1:]:
                r["is_recommended"] = False

        return evaluated_routes
