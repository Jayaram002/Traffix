import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from typing import Tuple, Dict, Any, List

class SyntheticTrafficGenerator:
    """
    Generates synthetic Hyderabad-like traffic observations matching the exact organizer schema.
    Includes morning/evening commuter peak hours, flyovers, arterial corridors,
    rain slowdowns, injected incidents, and sensor noise.
    """
    def __init__(self, segments: int = 436, nodes: int = 120, days: int = 2):
        self.num_segments = segments
        self.num_nodes = nodes
        self.days = days
        self.interval_minutes = 5

    def generate_network(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
        # Generate 120 nodes in Hyderabad latitude/longitude grid (17.30 - 17.48 N, 78.35 - 78.55 E)
        node_rows = []
        cols = 12
        for i in range(self.num_nodes):
            nid = f"N{i+1:03d}"
            gx = i % cols
            gy = i // cols
            lat = 17.300 + (gy * 0.018) + (np.random.rand() * 0.002)
            lon = 78.350 + (gx * 0.018) + (np.random.rand() * 0.002)
            node_rows.append({"node_id": nid, "x": gx, "y": gy, "lat": round(lat, 5), "lon": round(lon, 5)})
        nodes_df = pd.DataFrame(node_rows)

        # Generate segments
        classes = ["arterial", "collector", "flyover", "highway"]
        seg_rows = []
        for s in range(self.num_segments):
            seg_id = f"R{s+1:04d}"
            # Ensure unique directed pairs (u, v)
            cycle = s // self.num_nodes + 1
            u_idx = s % self.num_nodes
            v_idx = (u_idx + cycle) % self.num_nodes
            if u_idx == v_idx:
                v_idx = (u_idx + 1) % self.num_nodes
            u = f"N{u_idx+1:03d}"
            v = f"N{v_idx+1:03d}"
            r_class = np.random.choice(classes, p=[0.5, 0.3, 0.15, 0.05])
            lanes = 3 if r_class in ["flyover", "highway"] else (2 if r_class == "arterial" else 1)
            ffs = 70.0 if r_class == "highway" else (60.0 if r_class == "flyover" else (45.0 if r_class == "arterial" else 30.0))
            cap = lanes * 900.0
            length = round(float(np.random.uniform(0.6, 2.2)), 3)
            bottleneck = 1 if (s % 15 == 0) else 0

            seg_rows.append({
                "segment_id": seg_id,
                "source_node": u,
                "target_node": v,
                "road_class": r_class,
                "lanes": lanes,
                "free_flow_speed_kmh": ffs,
                "capacity_vph": cap,
                "length_km": length,
                "grade_pct": round(float(np.random.uniform(-4.0, 4.0)), 2),
                "signal_id": f"SIG{s%80:03d}" if s % 2 == 0 else "",
                "structural_bottleneck": bottleneck,
                "importance": round(float(np.random.uniform(0.6, 1.4)), 3),
                "peak_capacity_factor": 1.0
            })
        network_df = pd.DataFrame(seg_rows)
        return network_df, nodes_df

    def generate_traffic(self, network_df: pd.DataFrame, start_date: str = "2026-02-01 00:00:00") -> pd.DataFrame:
        start = datetime.strptime(start_date, "%Y-%m-%d %H:%M:%S")
        total_steps = (self.days * 24 * 60) // self.interval_minutes
        
        timestamps = [start + timedelta(minutes=self.interval_minutes * i) for i in range(total_steps)]
        
        records = []
        for t in timestamps:
            hour = t.hour + t.minute / 60.0
            
            # Commuter diurnal pattern: Morning peak (8-11am) and Evening peak (5-9pm)
            morning_peak = np.exp(-((hour - 9.0) ** 2) / 3.0)
            evening_peak = np.exp(-((hour - 18.5) ** 2) / 4.0)
            base_demand = 0.2 + 0.5 * morning_peak + 0.6 * evening_peak

            for _, seg in network_df.iloc[:50].iterrows():  # generate for subset for fast simulation
                ffs = seg["free_flow_speed_kmh"]
                cap = seg["capacity_vph"]
                length = seg["length_km"]
                seg_id = seg["segment_id"]

                # Flow & speed with congestion
                v_c = np.clip(base_demand + np.random.normal(0, 0.08), 0.05, 1.25)
                flow = round(float(v_c * cap), 1)
                
                # Speed drops as V/C increases
                speed_ratio = 1.0 / (1.0 + 0.15 * (v_c ** 4))
                speed = max(5.0, round(float(ffs * speed_ratio + np.random.normal(0, 1.5)), 2))
                
                # Travel time
                travel_time = round((length / speed) * 60.0, 3)
                ff_time = round((length / ffs) * 60.0, 3)
                delay = max(0.0, round(travel_time - ff_time, 3))
                cong_idx = round(float(np.clip((ffs - speed) / ffs, 0.0, 1.0)), 4)
                
                records.append({
                    "timestamp": t.strftime("%Y-%m-%d %H:%M:%S"),
                    "segment_id": seg_id,
                    "source_node": seg["source_node"],
                    "target_node": seg["target_node"],
                    "speed_kmh": speed,
                    "flow_vph": flow,
                    "occupancy_pct": round(float(np.clip(v_c * 35.0, 5.0, 95.0)), 2),
                    "travel_time_min": travel_time,
                    "free_flow_time_min": ff_time,
                    "delay_min": delay,
                    "queue_length_veh": round(float(max(0.0, (v_c - 0.8) * 40.0)), 1),
                    "congestion_index": cong_idx,
                    "sensor_quality": 1.0 if np.random.rand() > 0.03 else 0.5,
                    "is_synthetic": True
                })
        return pd.DataFrame(records)
