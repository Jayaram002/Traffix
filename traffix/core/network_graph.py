import networkx as nx
import pandas as pd
from typing import Dict, Any, List, Optional, Tuple
import math
from traffix.core.config import BPR_ALPHA, BPR_BETA

class RoadNetworkGraph:
    def __init__(self, network_df: pd.DataFrame, nodes_df: pd.DataFrame):
        self.network_df = network_df.copy()
        self.nodes_df = nodes_df.copy()
        self.graph = nx.DiGraph()
        self.segment_lookup: Dict[str, Dict[str, Any]] = {}
        self.node_lookup: Dict[str, Dict[str, float]] = {}
        self._build_graph()

    def _build_graph(self):
        # Add nodes with coordinates
        for _, row in self.nodes_df.iterrows():
            nid = str(row["node_id"])
            lat = float(row["lat"])
            lon = float(row["lon"])
            x = float(row.get("x", 0.0))
            y = float(row.get("y", 0.0))
            self.graph.add_node(nid, lat=lat, lon=lon, x=x, y=y)
            self.node_lookup[nid] = {"lat": lat, "lon": lon, "x": x, "y": y}

        # Add directed edges
        for _, row in self.network_df.iterrows():
            seg_id = str(row["segment_id"])
            u = str(row["source_node"])
            v = str(row["target_node"])
            length = float(row["length_km"])
            ffs = float(row["free_flow_speed_kmh"])
            cap = float(row["capacity_vph"])
            lanes = int(row.get("lanes", 1))
            road_class = str(row.get("road_class", "arterial"))
            bottleneck = int(row.get("structural_bottleneck", 0))
            sig_id = str(row.get("signal_id", "")) if pd.notna(row.get("signal_id")) else None

            # Free flow travel time in minutes: (length / speed) * 60
            ff_travel_time = (length / max(ffs, 1.0)) * 60.0

            edge_attrs = {
                "segment_id": seg_id,
                "source_node": u,
                "target_node": v,
                "length_km": length,
                "free_flow_speed_kmh": ffs,
                "capacity_vph": cap,
                "lanes": lanes,
                "road_class": road_class,
                "structural_bottleneck": bottleneck,
                "signal_id": sig_id,
                "free_flow_time_min": ff_travel_time,
                "current_speed_kmh": ffs,
                "current_flow_vph": 0.0,
                "current_travel_time_min": ff_travel_time
            }

            self.graph.add_edge(u, v, **edge_attrs)
            self.segment_lookup[seg_id] = edge_attrs

    def update_live_states(self, traffic_snapshot: pd.DataFrame):
        """Updates graph edge weights based on latest traffic speeds and flows."""
        for _, row in traffic_snapshot.iterrows():
            seg_id = str(row["segment_id"])
            if seg_id in self.segment_lookup:
                speed = float(row.get("speed_kmh", self.segment_lookup[seg_id]["free_flow_speed_kmh"]))
                flow = float(row.get("flow_vph", 0.0))
                tt = float(row.get("travel_time_min", (self.segment_lookup[seg_id]["length_km"] / max(speed, 5.0)) * 60.0))
                
                self.segment_lookup[seg_id]["current_speed_kmh"] = speed
                self.segment_lookup[seg_id]["current_flow_vph"] = flow
                self.segment_lookup[seg_id]["current_travel_time_min"] = tt

                u = self.segment_lookup[seg_id]["source_node"]
                v = self.segment_lookup[seg_id]["target_node"]
                if self.graph.has_edge(u, v):
                    self.graph[u][v]["current_speed_kmh"] = speed
                    self.graph[u][v]["current_flow_vph"] = flow
                    self.graph[u][v]["current_travel_time_min"] = tt

    def compute_bpr_travel_time(self, seg_id: str, flow_vph: Optional[float] = None) -> float:
        """BPR volume-delay formula: t = t_0 * (1 + alpha * (V / C) ^ beta)"""
        seg = self.segment_lookup.get(seg_id)
        if not seg:
            return 5.0
        t0 = seg["free_flow_time_min"]
        capacity = seg["capacity_vph"]
        flow = flow_vph if flow_vph is not None else seg["current_flow_vph"]
        ratio = max(0.0, flow / max(capacity, 1.0))
        return t0 * (1.0 + BPR_ALPHA * (ratio ** BPR_BETA))

    def get_upstream_segments(self, seg_id: str) -> List[str]:
        seg = self.segment_lookup.get(seg_id)
        if not seg:
            return []
        src = seg["source_node"]
        # Find all edges pointing to src
        upstream = []
        for u in self.graph.predecessors(src):
            edge_data = self.graph.get_edge_data(u, src)
            if edge_data and "segment_id" in edge_data:
                upstream.append(edge_data["segment_id"])
        return upstream

    def get_downstream_segments(self, seg_id: str) -> List[str]:
        seg = self.segment_lookup.get(seg_id)
        if not seg:
            return []
        tgt = seg["target_node"]
        downstream = []
        for v in self.graph.successors(tgt):
            edge_data = self.graph.get_edge_data(tgt, v)
            if edge_data and "segment_id" in edge_data:
                downstream.append(edge_data["segment_id"])
        return downstream

    def find_best_route(self, origin_node: str, dest_node: str, weight_type: str = "travel_time", penalized_segments: Optional[Dict[str, float]] = None) -> Optional[Dict[str, Any]]:
        """
        Dijkstra pathfinding.
        weight_type: 'free_flow_time_min', 'current_travel_time_min', or 'distance_km'.
        penalized_segments: dict of segment_id -> penalty multiplier (used to divert away from incidents or congested roads).
        """
        if origin_node not in self.graph or dest_node not in self.graph:
            return None

        penalties = penalized_segments or {}

        def weight_func(u, v, data):
            seg_id = data["segment_id"]
            if weight_type == "distance_km":
                w = data["length_km"]
            elif weight_type == "free_flow_time_min":
                w = data["free_flow_time_min"]
            else:
                w = data.get("current_travel_time_min", data["free_flow_time_min"])
            
            # Apply penalty multiplier if segment is penalized (e.g. incident or capacity constraint)
            if seg_id in penalties:
                w *= penalties[seg_id]
            return w

        try:
            node_path = nx.shortest_path(self.graph, source=origin_node, target=dest_node, weight=weight_func)
            
            # Extract segment details
            segments = []
            total_time = 0.0
            total_dist = 0.0
            for i in range(len(node_path) - 1):
                u = node_path[i]
                v = node_path[i + 1]
                edge_data = self.graph[u][v]
                segments.append(edge_data["segment_id"])
                total_time += edge_data.get("current_travel_time_min", edge_data["free_flow_time_min"])
                total_dist += edge_data["length_km"]

            # Coordinates list for mapping
            coords = []
            for n in node_path:
                node_info = self.node_lookup[n]
                coords.append([node_info["lat"], node_info["lon"]])

            return {
                "nodes": node_path,
                "segments": segments,
                "estimated_time_min": round(total_time, 2),
                "distance_km": round(total_dist, 2),
                "coordinates": coords
            }
        except nx.NetworkXNoPath:
            return None

    def export_geojson(self) -> Dict[str, Any]:
        """Export road network graph as GeoJSON for frontend Leaflet rendering."""
        features = []
        for u, v, data in self.graph.edges(data=True):
            src_coord = self.node_lookup.get(u)
            tgt_coord = self.node_lookup.get(v)
            if src_coord and tgt_coord:
                features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [src_coord["lon"], src_coord["lat"]],
                            [tgt_coord["lon"], tgt_coord["lat"]]
                        ]
                    },
                    "properties": {
                        "segment_id": data["segment_id"],
                        "source_node": u,
                        "target_node": v,
                        "road_class": data["road_class"],
                        "lanes": data["lanes"],
                        "free_flow_speed_kmh": data["free_flow_speed_kmh"],
                        "capacity_vph": data["capacity_vph"],
                        "length_km": data["length_km"],
                        "structural_bottleneck": data["structural_bottleneck"]
                    }
                })
        return {"type": "FeatureCollection", "features": features}
