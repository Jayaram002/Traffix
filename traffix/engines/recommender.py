import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional, Tuple
from traffix.core.network_graph import RoadNetworkGraph
from traffix.core.config import BPR_ALPHA, BPR_BETA

class TrafficRecommendationEngine:
    """
    Capacity-aware advisory & long-term infrastructure decision engine.
    - Generates tactical diversions and signal timing advisories
    - Ranks recurring bottlenecks
    - Runs macroscopic counterfactual BPR simulations for infrastructure candidates
    """
    def __init__(self, road_network: RoadNetworkGraph):
        self.network = road_network

    def generate_tactical_advisory(
        self,
        incident: Dict[str, Any],
        segment_states: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Generates capacity-aware diversion routes and signal management advisories for an incident.
        """
        seg_id = incident["segment_id"]
        seg_info = self.network.segment_lookup.get(seg_id, {})
        u = seg_info.get("source_node")
        v = seg_info.get("target_node")
        incident_type = incident.get("incident_type", "incident")
        current_speed = incident.get("speed_kmh", 15.0)
        ffs = seg_info.get("free_flow_speed_kmh", 50.0)
        length_km = seg_info.get("length_km", 1.0)
        curr_tt = (length_km / max(current_speed, 1.0)) * 60.0

        # Calculate capacity-aware alternate route bypassing the blocked segment
        # We heavily penalize the incident segment and already saturated alternate segments
        penalties = {seg_id: 100.0}  # Block or penalize incident segment
        for s_id, st in segment_states.items():
            if st.get("congestion_level") in ["heavy", "jam"]:
                penalties[s_id] = 2.5  # Discourage diverting onto already congested routes

        alt_route = self.network.find_best_route(u, v, weight_type="travel_time", penalized_segments=penalties)

        delay_saved = 0.0
        alt_segments = []
        alt_time = curr_tt
        if alt_route:
            alt_segments = alt_route["segments"]
            alt_time = alt_route["estimated_time_min"]
            delay_saved = max(0.0, round(curr_tt - alt_time, 1))

        # Determine signal and traffic control actions
        signal_advisories = []
        sig_id = seg_info.get("signal_id")
        if sig_id:
            signal_advisories.append({
                "signal_id": sig_id,
                "action": "Extend Green Wave Duration (+15s) for incident clearing",
                "target_approach": u,
                "feasibility": "High - automated SCATS/SCOOT signal controller interface"
            })

        # Upstream metering advisory
        upstream_segs = self.network.get_upstream_segments(seg_id)
        metering_advisories = []
        for up_seg in upstream_segs[:2]:
            up_sig = self.network.segment_lookup.get(up_seg, {}).get("signal_id")
            if up_sig:
                metering_advisories.append({
                    "junction": up_sig,
                    "action": "Throttle inflow rate by 20% to prevent queue spillback",
                    "segment": up_seg
                })

        return {
            "advisory_id": f"ADV_{seg_id}_{incident.get('incident_id', 'MANUAL')}",
            "trigger_incident_id": incident.get("incident_id"),
            "target_segment": seg_id,
            "corridor": f"{u} -> {v}",
            "action_type": "Capacity-Aware Dynamic Diversion",
            "recommended_alternate_route": {
                "path_segments": alt_segments,
                "estimated_travel_time_min": alt_time,
                "bottleneck_travel_time_min": round(curr_tt, 1),
                "expected_delay_saving_min": delay_saved
            },
            "signal_timing_advisories": signal_advisories,
            "upstream_metering": metering_advisories,
            "evidence": incident.get("contributing_factors", ["Significant drop in link travel speed"]),
            "confidence": incident.get("confidence", 0.8),
            "side_effects": "Potential minor volume rise on parallel secondary corridors; monitored within capacity margins",
            "status": "active"
        }

    def evaluate_infrastructure_candidates(
        self,
        candidates_df: pd.DataFrame,
        current_traffic_df: pd.DataFrame
    ) -> List[Dict[str, Any]]:
        """
        Evaluates planning candidates (from planning_candidates.csv)
        using macroscopic BPR volume-delay counterfactual simulation.
        Returns ranked proposals with before & after speeds, delays, and cost-benefit ratios.
        """
        results = []
        # Build baseline flow and speed dictionary
        traffic_map = {}
        for _, row in current_traffic_df.iterrows():
            traffic_map[str(row["segment_id"])] = {
                "flow": float(row.get("flow_vph", 1000.0)),
                "speed": float(row.get("speed_kmh", 40.0)),
                "delay": float(row.get("delay_min", 2.0))
            }

        for _, row in candidates_df.iterrows():
            cand_id = str(row["candidate_id"])
            seg_id = str(row["target_segment"])
            itype = str(row["intervention_type"])
            cap_delta = float(row["capacity_delta_vph"])
            cost_idx = float(row["cost_index"])
            feasibility = str(row["feasibility_band"])

            seg_info = self.network.segment_lookup.get(seg_id)
            if not seg_info:
                continue

            orig_cap = seg_info["capacity_vph"]
            orig_ffs = seg_info["free_flow_speed_kmh"]
            length = seg_info["length_km"]
            t0 = seg_info["free_flow_time_min"]

            # Current flow
            flow = traffic_map.get(seg_id, {}).get("flow", orig_cap * 0.85)

            # Before intervention (BPR)
            v_c_before = flow / max(orig_cap, 1.0)
            tt_before = t0 * (1.0 + BPR_ALPHA * (v_c_before ** BPR_BETA))
            speed_before = (length / max(tt_before / 60.0, 0.001))
            delay_before = max(0.0, tt_before - t0)

            # After intervention (increased capacity)
            new_cap = orig_cap + cap_delta
            v_c_after = flow / max(new_cap, 1.0)
            tt_after = t0 * (1.0 + BPR_ALPHA * (v_c_after ** BPR_BETA))
            speed_after = min(orig_ffs, length / max(tt_after / 60.0, 0.001))
            delay_after = max(0.0, tt_after - t0)

            delay_reduction_pct = round(((delay_before - delay_after) / max(delay_before, 0.01)) * 100.0, 1)
            time_saved_min = round(max(0.0, tt_before - tt_after), 2)
            roi_index = round((time_saved_min * 100.0) / max(cost_idx, 1.0), 2)

            results.append({
                "candidate_id": cand_id,
                "target_segment": seg_id,
                "source_node": seg_info["source_node"],
                "target_node": seg_info["target_node"],
                "intervention_type": itype,
                "capacity_delta_vph": cap_delta,
                "cost_index": cost_idx,
                "feasibility_band": feasibility,
                "before_metrics": {
                    "capacity_vph": orig_cap,
                    "v_c_ratio": round(v_c_before, 2),
                    "speed_kmh": round(speed_before, 1),
                    "travel_time_min": round(tt_before, 2),
                    "delay_min": round(delay_before, 2)
                },
                "after_metrics": {
                    "capacity_vph": new_cap,
                    "v_c_ratio": round(v_c_after, 2),
                    "speed_kmh": round(speed_after, 1),
                    "travel_time_min": round(tt_after, 2),
                    "delay_min": round(delay_after, 2)
                },
                "impact": {
                    "travel_time_saved_min": time_saved_min,
                    "delay_reduction_pct": delay_reduction_pct,
                    "benefit_cost_ratio": roi_index
                }
            })

        # Rank candidates by benefit-cost ratio
        results.sort(key=lambda x: x["impact"]["benefit_cost_ratio"], reverse=True)
        return results
