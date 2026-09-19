import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional
from traffix.core.config import CONGESTION_THRESHOLDS
from traffix.core.network_graph import RoadNetworkGraph

class NetworkStateEstimator:
    """
    Infers network state, classifies congestion levels,
    detects congestion spillback to upstream segments,
    and categorizes recurring vs non-recurring bottlenecks.
    """
    def __init__(self, road_network: RoadNetworkGraph):
        self.network = road_network
        self.historical_baseline: Dict[str, Dict[str, float]] = {}

    def fit_baseline(self, historical_traffic_df: pd.DataFrame):
        """
        Builds a historical seasonal speed baseline (by segment_id and hour-of-day).
        """
        df = historical_traffic_df.copy()
        if "hour" not in df.columns and "timestamp" in df.columns:
            df["timestamp"] = pd.to_datetime(df["timestamp"])
            df["hour"] = df["timestamp"].dt.hour
        
        # Calculate median speed and 10th percentile speed
        grouped = df.groupby(["segment_id", "hour"])["speed_kmh"].agg(["median", "std"]).reset_index()
        for _, row in grouped.iterrows():
            key = f"{row['segment_id']}_{int(row['hour'])}"
            self.historical_baseline[key] = {
                "median_speed": float(row["median"]),
                "std_speed": float(row["std"]) if pd.notna(row["std"]) and row["std"] > 0 else 5.0
            }

    def classify_congestion_level(self, speed_kmh: float, free_flow_speed: float) -> str:
        if free_flow_speed <= 0:
            return "unknown"
        ratio = speed_kmh / free_flow_speed
        if ratio >= CONGESTION_THRESHOLDS["free"]:
            return "free"
        elif ratio >= CONGESTION_THRESHOLDS["slow"]:
            return "slow"
        elif ratio >= CONGESTION_THRESHOLDS["heavy"]:
            return "heavy"
        else:
            return "jam"

    def estimate_network_state(self, current_traffic_df: pd.DataFrame) -> Dict[str, Any]:
        """
        Produces an enriched network state:
        - per-segment status
        - detected queue spillbacks
        - recurring vs non-recurring classifications
        - network-wide summary KPIs
        """
        segment_states = {}
        congested_count = 0
        total_delay = 0.0

        for _, row in current_traffic_df.iterrows():
            seg_id = str(row["segment_id"])
            speed = float(row["speed_kmh"])
            flow = float(row.get("flow_vph", 0.0))
            travel_time = float(row.get("travel_time_min", 0.0))
            delay = float(row.get("delay_min", 0.0))
            was_imputed = bool(row.get("was_imputed", False))
            
            seg_info = self.network.segment_lookup.get(seg_id, {})
            ffs = seg_info.get("free_flow_speed_kmh", 50.0)
            length_km = seg_info.get("length_km", 1.0)
            capacity = seg_info.get("capacity_vph", 1800.0)
            
            level = self.classify_congestion_level(speed, ffs)
            if level in ["heavy", "jam"]:
                congested_count += 1
            total_delay += delay

            # Determine recurring vs non-recurring
            timestamp = pd.to_datetime(row.get("timestamp", pd.Timestamp.now()))
            hour = timestamp.hour
            base_key = f"{seg_id}_{hour}"
            base_info = self.historical_baseline.get(base_key)

            is_recurring = False
            z_score = 0.0
            if base_info:
                median_s = base_info["median_speed"]
                std_s = base_info["std_speed"]
                z_score = (median_s - speed) / std_s
                # If historical median is also heavily congested, it is recurring
                if median_s / ffs < 0.6:
                    is_recurring = True
            else:
                # Fallback to structural bottleneck flag
                is_recurring = bool(seg_info.get("structural_bottleneck", 0))

            segment_states[seg_id] = {
                "segment_id": seg_id,
                "source_node": seg_info.get("source_node"),
                "target_node": seg_info.get("target_node"),
                "speed_kmh": round(speed, 2),
                "free_flow_speed_kmh": ffs,
                "speed_ratio": round(speed / max(ffs, 1.0), 3),
                "congestion_level": level,
                "flow_vph": round(flow, 1),
                "capacity_vph": capacity,
                "v_c_ratio": round(flow / max(capacity, 1.0), 2),
                "travel_time_min": round(travel_time, 2),
                "delay_min": round(delay, 2),
                "queue_length_veh": float(row.get("queue_length_veh", 0.0)),
                "is_recurring": is_recurring,
                "z_score": round(z_score, 2),
                "was_imputed": was_imputed
            }

        # Congestion spillback detection:
        # Check if upstream segments are queueing behind a congested bottleneck segment
        spillbacks = []
        for seg_id, state in segment_states.items():
            if state["congestion_level"] in ["heavy", "jam"]:
                upstream_segs = self.network.get_upstream_segments(seg_id)
                congested_upstream = []
                for up_id in upstream_segs:
                    if up_id in segment_states and segment_states[up_id]["congestion_level"] in ["slow", "heavy", "jam"]:
                        congested_upstream.append(up_id)
                
                if congested_upstream:
                    spillbacks.append({
                        "bottleneck_segment": seg_id,
                        "downstream_node": state["target_node"],
                        "bottleneck_speed": state["speed_kmh"],
                        "spillback_upstream_segments": congested_upstream,
                        "spillback_depth": len(congested_upstream),
                        "estimated_queue_total_veh": sum(segment_states[u]["queue_length_veh"] for u in congested_upstream) + state["queue_length_veh"]
                    })

        total_segs = len(segment_states)
        network_congestion_pct = round((congested_count / max(total_segs, 1)) * 100, 1)

        return {
            "timestamp": str(current_traffic_df["timestamp"].iloc[0]) if not current_traffic_df.empty else "",
            "total_segments": total_segs,
            "congested_segments_count": congested_count,
            "network_congestion_pct": network_congestion_pct,
            "total_delay_min": round(total_delay, 1),
            "segment_states": segment_states,
            "detected_spillbacks": spillbacks
        }
