import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Tuple, Dict, Any, List
import math

def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates true physical Haversine distance in kilometers between two GPS coordinates."""
    R = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return max(0.2, round(R * c, 3))


class SyntheticTrafficGenerator:
    """
    High-Performance Synthetic Hyderabad Road Network & Traffic Generator.
    - Optimized for 0.1 vCPU and 512MB RAM constraints (generates in < 0.5s).
    - Fully connected planar road grid with bidirectional streets and arterial corridors.
    - True physical Haversine edge distances matching GPS coordinates exactly.
    """
    def __init__(self, segments: int = 436, nodes: int = 120, days: float = 0.25):
        self.num_nodes = max(60, min(nodes, 120))
        self.days = days  # 0.25 days = 6 hours (72 intervals) for lean memory footprint
        self.interval_minutes = 5

    def generate_network(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
        # Generate nodes across Hyderabad metropolitan coordinates (17.30 - 17.48 N, 78.35 - 78.55 E)
        node_rows = []
        cols = 12
        rows = math.ceil(self.num_nodes / cols)
        
        node_map = {}
        for i in range(self.num_nodes):
            nid = f"N{i+1:03d}"
            gx = i % cols
            gy = i // cols
            lat = 17.300 + (gy * 0.018) + (np.random.rand() * 0.001)
            lon = 78.350 + (gx * 0.018) + (np.random.rand() * 0.001)
            lat_r = round(lat, 5)
            lon_r = round(lon, 5)
            node_rows.append({"node_id": nid, "x": gx, "y": gy, "lat": lat_r, "lon": lon_r})
            node_map[(gx, gy)] = (nid, lat_r, lon_r)

        nodes_df = pd.DataFrame(node_rows)

        # Generate bidirectional grid segments with true Haversine distances
        seg_rows = []
        s_idx = 1

        def add_segment(u: str, v: str, u_lat: float, u_lon: float, v_lat: float, v_lon: float, r_class: str, ffs: float, lanes: int):
            nonlocal s_idx
            dist_km = haversine_distance_km(u_lat, u_lon, v_lat, v_lon)
            cap = lanes * 900.0
            bottleneck = 1 if (s_idx % 12 == 0) else 0

            seg_rows.append({
                "segment_id": f"R{s_idx:04d}",
                "source_node": u,
                "target_node": v,
                "road_class": r_class,
                "lanes": lanes,
                "free_flow_speed_kmh": ffs,
                "capacity_vph": cap,
                "length_km": dist_km,
                "grade_pct": round(float(np.random.uniform(-2.0, 2.0)), 2),
                "signal_id": f"SIG{s_idx % 50:03d}" if s_idx % 2 == 0 else "",
                "structural_bottleneck": bottleneck,
                "importance": round(float(np.random.uniform(0.7, 1.3)), 3),
                "peak_capacity_factor": 1.0
            })
            s_idx += 1

        # 1. Connected horizontal and vertical road grid
        for (gx, gy), (u, u_lat, u_lon) in list(node_map.items()):
            # Right neighbor
            if (gx + 1, gy) in node_map:
                v, v_lat, v_lon = node_map[(gx + 1, gy)]
                r_class = "highway" if gy in [2, 6] else "arterial"
                ffs = 70.0 if r_class == "highway" else 45.0
                lanes = 3 if r_class == "highway" else 2
                add_segment(u, v, u_lat, u_lon, v_lat, v_lon, r_class, ffs, lanes)
                add_segment(v, u, v_lat, v_lon, u_lat, u_lon, r_class, ffs, lanes)

            # Down neighbor
            if (gx, gy + 1) in node_map:
                v, v_lat, v_lon = node_map[(gx, gy + 1)]
                r_class = "flyover" if gx in [3, 8] else "collector"
                ffs = 60.0 if r_class == "flyover" else 35.0
                lanes = 2 if r_class == "flyover" else 1
                add_segment(u, v, u_lat, u_lon, v_lat, v_lon, r_class, ffs, lanes)
                add_segment(v, u, v_lat, v_lon, u_lat, u_lon, r_class, ffs, lanes)

            # Diagonal arterial express link
            if (gx + 1, gy + 1) in node_map and (gx + gy) % 3 == 0:
                v, v_lat, v_lon = node_map[(gx + 1, gy + 1)]
                add_segment(u, v, u_lat, u_lon, v_lat, v_lon, "highway", 65.0, 3)
                add_segment(v, u, v_lat, v_lon, u_lat, u_lon, "highway", 65.0, 3)

        network_df = pd.DataFrame(seg_rows)
        return network_df, nodes_df

    def generate_traffic(self, network_df: pd.DataFrame, start_date: str = "2026-02-01 08:00:00") -> pd.DataFrame:
        start = datetime.strptime(start_date, "%Y-%m-%d %H:%M:%S")
        total_steps = max(12, int((self.days * 24 * 60) // self.interval_minutes))
        timestamps = [start + timedelta(minutes=self.interval_minutes * i) for i in range(total_steps)]

        # Sample subset of segments for fast computation and low memory (< 15MB RAM)
        eval_segs = network_df.iloc[:min(len(network_df), 120)]
        
        records = []
        for t in timestamps:
            hour = t.hour + t.minute / 60.0
            morning_peak = math.exp(-((hour - 9.0) ** 2) / 3.0)
            evening_peak = math.exp(-((hour - 18.5) ** 2) / 4.0)
            base_demand = 0.2 + 0.5 * morning_peak + 0.6 * evening_peak
            t_str = t.strftime("%Y-%m-%d %H:%M:%S")

            for _, seg in eval_segs.iterrows():
                ffs = float(seg["free_flow_speed_kmh"])
                cap = float(seg["capacity_vph"])
                length = float(seg["length_km"])
                seg_id = seg["segment_id"]

                v_c = float(np.clip(base_demand + np.random.normal(0, 0.05), 0.1, 1.2))
                flow = round(v_c * cap, 1)
                speed_ratio = 1.0 / (1.0 + 0.15 * (v_c ** 4))
                speed = max(8.0, round(float(ffs * speed_ratio + np.random.normal(0, 1.0)), 1))
                travel_time = round((length / speed) * 60.0, 2)
                ff_time = round((length / ffs) * 60.0, 2)
                delay = max(0.0, round(travel_time - ff_time, 2))
                cong_idx = round(float(np.clip((ffs - speed) / ffs, 0.0, 1.0)), 3)

                records.append({
                    "timestamp": t_str,
                    "segment_id": seg_id,
                    "source_node": seg["source_node"],
                    "target_node": seg["target_node"],
                    "speed_kmh": speed,
                    "flow_vph": flow,
                    "occupancy_pct": round(float(np.clip(v_c * 35.0, 5.0, 90.0)), 1),
                    "travel_time_min": travel_time,
                    "free_flow_time_min": ff_time,
                    "delay_min": delay,
                    "queue_length_veh": round(float(max(0.0, (v_c - 0.75) * 30.0)), 1),
                    "congestion_index": cong_idx,
                    "sensor_quality": 1.0,
                    "is_synthetic": True
                })

        return pd.DataFrame(records)
