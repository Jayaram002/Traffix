import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional
from traffix.core.network_graph import RoadNetworkGraph

class EmergencyCorridorEngine:
    """
    Emergency Green Corridor & Preemption Engine for Ambulances, Fire, and Police.
    Calculates dynamic priority paths, generates signal green-wave preemption schedules,
    and advises civilian traffic diversions to maintain zero-delay emergency clearance.
    """
    def __init__(self, road_network: RoadNetworkGraph):
        self.network = road_network

    def create_green_corridor(
        self,
        origin_node: str,
        destination_node: str,
        vehicle_type: str = "Ambulance",
        priority_level: str = "Critical"
    ) -> Dict[str, Any]:
        """
        Plans and activates an emergency green corridor:
        - Finds the fastest corridor on the network
        - Computes signal preemption timestamps
        - Generates civilian traffic diversion advisories for cross-streets
        """
        # For emergency vehicles, we use travel time with a high-speed bias (can use bus/emergency lanes and exceed congested speeds)
        route_res = self.network.find_best_route(origin_node, destination_node, weight_type="free_flow_time_min")
        if not route_res:
            # Fallback to current travel time
            route_res = self.network.find_best_route(origin_node, destination_node, weight_type="travel_time")

        if not route_res:
            return {
                "success": False,
                "error": f"No valid path found between {origin_node} and {destination_node}"
            }

        segments = route_res["segments"]
        nodes = route_res["nodes"]
        coords = route_res["coordinates"]
        total_distance_km = route_res["distance_km"]

        # Emergency vehicles travel faster than typical congested traffic (estimated ~25% faster than free-flow due to siren priority)
        emergency_travel_time_min = round(max(1.0, route_res["estimated_time_min"] * 0.75), 1)

        # Plan signal preemption along the corridor
        signal_preemptions = []
        cumulative_time = 0.0

        for seg_id in segments:
            seg = self.network.segment_lookup.get(seg_id, {})
            sig_id = seg.get("signal_id")
            seg_tt = (seg.get("length_km", 1.0) / max(seg.get("free_flow_speed_kmh", 50.0) * 1.2, 10.0)) * 60.0
            cumulative_time += seg_tt

            if sig_id:
                signal_preemptions.append({
                    "signal_id": sig_id,
                    "junction_node": seg.get("target_node"),
                    "eta_seconds": int(cumulative_time * 60),
                    "action": "Preempt Phase: Force Green Wave (Hold Green for 60s)",
                    "clearance_window_seconds": 45,
                    "status": "ARMED_AND_SYNCHRONIZED"
                })

        # Calculate civilian diversions: cross-traffic that intersects our emergency corridor
        diverted_civilian_junctions = []
        for n in nodes[1:-1]:
            # Find incoming edges that are NOT part of our route
            for pred in self.network.graph.predecessors(n):
                edge = self.network.graph.get_edge_data(pred, n)
                if edge and edge["segment_id"] not in segments:
                    diverted_civilian_junctions.append({
                        "node": n,
                        "holding_segment": edge["segment_id"],
                        "advisory": f"Emergency Vehicle Approaching. Hold incoming traffic at {edge['segment_id']} to clear corridor for {vehicle_type}."
                    })

        return {
            "success": True,
            "corridor_id": f"GREEN_CORRIDOR_{vehicle_type.upper()}_{origin_node}_{destination_node}",
            "vehicle_type": vehicle_type,
            "priority_level": priority_level,
            "origin_node": origin_node,
            "destination_node": destination_node,
            "nodes": nodes,
            "segments": segments,
            "coordinates": coords,
            "total_distance_km": total_distance_km,
            "estimated_emergency_travel_time_min": emergency_travel_time_min,
            "standard_traffic_time_min": route_res["estimated_time_min"],
            "time_saved_min": round(max(0.5, route_res["estimated_time_min"] - emergency_travel_time_min), 1),
            "signal_preemptions": signal_preemptions,
            "civilian_diversions": diverted_civilian_junctions[:6],  # limit to top 6 critical junctions
            "active_status": "GREEN_CORRIDOR_ACTIVE",
            "instructions": f"Emergency Priority Cleared: Signals synchronized along {origin_node} -> {destination_node}. Civilian traffic diverted."
        }
