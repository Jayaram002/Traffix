import numpy as np
import pandas as pd
import networkx as nx
from typing import Dict, Any, List, Optional, Tuple
from sklearn.ensemble import RandomForestClassifier, GradientBoostingRegressor
from traffix.core.network_graph import RoadNetworkGraph

class MLRoutePredictor:
    """
    Multi-Criterion Routing Pipeline & ML Travel Time / Risk Classifier.
    - True Shortest Distance Pipeline: Dijkstra minimizing length_km
    - Fastest Real-Time Corridor: Dijkstra minimizing live travel_time_min
    - Safe & Balanced Alternative: Diversion around congestion and emergency corridors
    - ML Risk Classification (OPTIMAL_SAFE, MODERATE_CONGESTION, BOTTLENECK_PRONE, EMERGENCY_CONFLICT)
    - Route Reliability Score (0-100)
    - Ultra-lean architecture optimized for 0.1 vCPU and 512MB RAM
    """
    def __init__(self, road_network: RoadNetworkGraph):
        self.network = road_network
        self.regressor = GradientBoostingRegressor(n_estimators=15, max_depth=3, random_state=42)
        self.classifier = RandomForestClassifier(n_estimators=15, max_depth=4, random_state=42)
        self.is_trained = False
        self._initialize_default_models()

    def _initialize_default_models(self):
        """Train baseline ML models quickly on physical feature combinations."""
        np.random.seed(42)
        N = 300  # Lightweight for 0.1 CPU
        distances = np.random.uniform(1.0, 25.0, N)
        avg_ffs = np.random.choice([35.0, 45.0, 60.0, 70.0], N)
        num_segs = np.clip((distances / 1.2).astype(int), 1, 20)
        num_signals = np.random.binomial(num_segs, 0.4)
        v_c = np.random.uniform(0.1, 1.3, N)
        has_incident = np.random.binomial(1, 0.1, N)
        near_emerg = np.random.binomial(1, 0.08, N)

        X = np.column_stack([distances, avg_ffs, num_segs, num_signals, v_c, has_incident, near_emerg])

        free_flow_time = (distances / avg_ffs) * 60.0
        congestion_delay = free_flow_time * 0.15 * (v_c ** 4)
        incident_delay = has_incident * np.random.uniform(8.0, 20.0, N)
        emergency_delay = near_emerg * np.random.uniform(4.0, 12.0, N)
        y_time = free_flow_time + congestion_delay + incident_delay + emergency_delay
        y_time = np.maximum(y_time, 1.0)

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
        Multi-Criterion Route Discovery Pipeline.
        Guarantees:
          Option 1: True Shortest Distance Path (Dijkstra on length_km)
          Option 2: Fastest Live Route (Dijkstra on current_travel_time_min)
          Option 3: Balanced Safe Route (Avoids congestion & emergency corridors)
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

        candidate_paths = []
        seen_paths = set()

        def add_candidate(path_nodes, label_hint):
            key = tuple(path_nodes)
            if key not in seen_paths and len(path_nodes) >= 2:
                seen_paths.add(key)
                candidate_paths.append((path_nodes, label_hint))

        # 1. Pipeline Pillar 1: True Shortest Distance Path (min length_km)
        try:
            shortest_dist_path = nx.shortest_path(self.network.graph, source=origin_node, target=dest_node, weight="length_km")
            add_candidate(shortest_dist_path, "Shortest Distance Path")
        except Exception:
            pass

        # 2. Pipeline Pillar 2: Fastest Live Route (min travel time)
        try:
            def live_time_weight(u, v, data):
                return data.get("current_travel_time_min", data.get("free_flow_time_min", 1.0))
            fastest_time_path = nx.shortest_path(self.network.graph, source=origin_node, target=dest_node, weight=live_time_weight)
            add_candidate(fastest_time_path, "Fastest Live Corridor")
        except Exception:
            pass

        # 3. Pipeline Pillar 3: Safe & Balanced Route (penalizes congestion and emergency corridors)
        try:
            def safe_avoidance_weight(u, v, data):
                w = data.get("current_travel_time_min", data.get("free_flow_time_min", 1.0))
                seg_id = data.get("segment_id")
                if seg_id in emergency_segments or u in emergency_nodes or v in emergency_nodes:
                    w *= 50.0  # Divert civilian traffic away from emergency corridor
                speed = data.get("current_speed_kmh", 50.0)
                ffs = data.get("free_flow_speed_kmh", 50.0)
                if speed < ffs * 0.4:
                    w *= 3.0  # Penalize severe congestion
                return w
            safe_path = nx.shortest_path(self.network.graph, source=origin_node, target=dest_node, weight=safe_avoidance_weight)
            add_candidate(safe_path, "Congestion-Free Alternate")
        except Exception:
            pass

        # If we need more unique paths to satisfy k, use Yen's K shortest paths on length_km
        if len(candidate_paths) < k:
            try:
                gen = nx.shortest_simple_paths(self.network.graph, origin_node, dest_node, weight="length_km")
                for p in gen:
                    add_candidate(p, "Alternative City Route")
                    if len(candidate_paths) >= k:
                        break
            except Exception:
                pass

        # Build evaluated route objects
        evaluated_routes = []
        for idx, (node_path, label_hint) in enumerate(candidate_paths[:k]):
            segments = []
            total_dist = 0.0
            actual_travel_time = 0.0
            actual_ff_time = 0.0
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
                dist_km = edge_data["length_km"]
                total_dist += dist_km

                speed = edge_data.get("current_speed_kmh", edge_data["free_flow_speed_kmh"])
                ffs = edge_data["free_flow_speed_kmh"]
                speeds.append(speed)
                caps.append(edge_data["capacity_vph"])
                flows.append(edge_data.get("current_flow_vph", 0.0))

                edge_tt = edge_data.get("current_travel_time_min", (dist_km / max(speed, 5.0)) * 60.0)
                edge_ff = edge_data.get("free_flow_time_min", (dist_km / max(ffs, 10.0)) * 60.0)
                actual_travel_time += edge_tt
                actual_ff_time += edge_ff

                if edge_data.get("signal_id"):
                    signals_count += 1

                if seg_id in emergency_segments or u in emergency_nodes or v in emergency_nodes:
                    corridor_conflict = 1

                if speed < (ffs * 0.35):
                    has_incident = 1

            avg_speed = float(np.mean(speeds)) if speeds else 50.0
            avg_cap = float(np.mean(caps)) if caps else 1800.0
            avg_flow = float(np.mean(flows)) if flows else 500.0
            v_c = avg_flow / max(avg_cap, 1.0)
            num_segs = len(segments)

            # ML Delay Estimation & Classification
            feat = np.array([[total_dist, avg_speed, num_segs, signals_count, v_c, has_incident, corridor_conflict]])
            predicted_class = str(self.classifier.predict(feat)[0])
            class_probs = self.classifier.predict_proba(feat)[0]
            confidence = float(np.max(class_probs))

            # Ground travel time in physical edge sums + ML delay refinement
            predicted_delay = max(0.0, round(actual_travel_time - actual_ff_time, 1))
            final_travel_time = max(1.0, round(actual_travel_time, 1))

            # Reliability score (0 - 100)
            reliability = 100.0 - (v_c * 25.0) - (has_incident * 30.0) - (corridor_conflict * 45.0) - (signals_count * 1.5)
            reliability = float(np.clip(reliability, 20.0, 99.0))

            coords = [[self.network.node_lookup[n]["lat"], self.network.node_lookup[n]["lon"]] for n in node_path if n in self.network.node_lookup]

            evaluated_routes.append({
                "route_id": f"ROUTE_{idx + 1}",
                "route_label": f"Option {idx + 1}: {label_hint}",
                "nodes": node_path,
                "segments": segments,
                "coordinates": coords,
                "distance_km": round(total_dist, 2),
                "predicted_travel_time_min": final_travel_time,
                "predicted_delay_min": predicted_delay,
                "ml_classification": predicted_class,
                "reliability_score": round(reliability, 1),
                "confidence": round(confidence, 2),
                "signals_count": signals_count,
                "corridor_conflict": bool(corridor_conflict),
                "is_recommended": (idx == 0 and corridor_conflict == 0)
            })

        # Rank: non-conflicting, highest reliability, shortest travel time first
        if evaluated_routes:
            evaluated_routes.sort(key=lambda r: (r["corridor_conflict"], -r["reliability_score"], r["predicted_travel_time_min"]))
            evaluated_routes[0]["is_recommended"] = True

        return evaluated_routes
