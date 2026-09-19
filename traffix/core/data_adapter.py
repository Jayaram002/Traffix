import pandas as pd
import numpy as np
from pathlib import Path
from typing import Dict, Any, Tuple, Optional
import logging
from traffix.core.config import DATASET_PATHS, COLUMN_MAPPINGS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("DataAdapter")

class DataAdapter:
    def __init__(self, custom_paths: Optional[Dict[str, Path]] = None, custom_mappings: Optional[Dict[str, Dict[str, str]]] = None):
        self.paths = custom_paths or DATASET_PATHS
        self.mappings = custom_mappings or COLUMN_MAPPINGS

    def load_network(self, file_path: Optional[Path] = None) -> pd.DataFrame:
        path = file_path or self.paths.get("network")
        if not path or not Path(path).exists():
            raise FileNotFoundError(f"Network file not found at {path}")
        
        df = pd.read_csv(path)
        mapping = self.mappings.get("network", {})
        # Rename columns if needed
        inv_map = {v: k for k, v in mapping.items() if v in df.columns}
        df = df.rename(columns=inv_map)

        # Validation & Cleaning
        required_cols = ["segment_id", "source_node", "target_node", "free_flow_speed_kmh", "capacity_vph", "length_km"]
        for col in required_cols:
            if col not in df.columns:
                raise ValueError(f"Missing mandatory column in network schema: {col}")
        
        # Ensure positive physical quantities
        df["free_flow_speed_kmh"] = df["free_flow_speed_kmh"].clip(lower=10.0, upper=140.0)
        df["capacity_vph"] = df["capacity_vph"].clip(lower=100.0, upper=10000.0)
        df["length_km"] = df["length_km"].clip(lower=0.01)
        if "lanes" in df.columns:
            df["lanes"] = df["lanes"].fillna(1).astype(int)
        
        return df

    def load_nodes(self, file_path: Optional[Path] = None) -> pd.DataFrame:
        path = file_path or self.paths.get("nodes")
        if not path or not Path(path).exists():
            raise FileNotFoundError(f"Nodes file not found at {path}")
        
        df = pd.read_csv(path)
        mapping = self.mappings.get("nodes", {})
        inv_map = {v: k for k, v in mapping.items() if v in df.columns}
        df = df.rename(columns=inv_map)

        required_cols = ["node_id", "lat", "lon"]
        for col in required_cols:
            if col not in df.columns:
                raise ValueError(f"Missing mandatory column in nodes schema: {col}")
        return df

    def load_traffic(self, file_path: Optional[Path] = None, nrows: Optional[int] = None) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        path = file_path or self.paths.get("traffic_validation")
        if not path or not Path(path).exists():
            raise FileNotFoundError(f"Traffic file not found at {path}")

        logger.info(f"Loading traffic observations from {path} (nrows={nrows})...")
        df = pd.read_csv(path, nrows=nrows)
        
        # Column mapping
        mapping = self.mappings.get("traffic", {})
        inv_map = {v: k for k, v in mapping.items() if v in df.columns}
        df = df.rename(columns=inv_map)

        # Ensure datetime
        df["timestamp"] = pd.to_datetime(df["timestamp"])

        # Quality & Imputation Tracking
        initial_rows = len(df)
        missing_speed_cnt = df["speed_kmh"].isna().sum()
        neg_speed_cnt = (df["speed_kmh"] < 0).sum() if "speed_kmh" in df.columns else 0

        # Mark was_imputed
        df["was_imputed"] = df["speed_kmh"].isna() | (df["speed_kmh"] < 0) | (df["speed_kmh"] > 180)
        
        # Clip impossible negative values and outlier spikes
        if "speed_kmh" in df.columns:
            df["speed_kmh"] = df["speed_kmh"].mask(df["speed_kmh"] < 0, np.nan)
            df["speed_kmh"] = df["speed_kmh"].mask(df["speed_kmh"] > 160, 160)
            # Impute forward fill per segment then median
            df["speed_kmh"] = df.groupby("segment_id")["speed_kmh"].transform(lambda x: x.ffill().bfill())
            df["speed_kmh"] = df["speed_kmh"].fillna(40.0)

        if "flow_vph" in df.columns:
            df["flow_vph"] = df["flow_vph"].clip(lower=0, upper=6000)
            df["flow_vph"] = df["flow_vph"].fillna(0.0)

        if "congestion_index" in df.columns:
            df["congestion_index"] = df["congestion_index"].clip(lower=0.0, upper=1.0)
            df["congestion_index"] = df["congestion_index"].fillna(0.0)

        quality_report = {
            "total_rows": initial_rows,
            "missing_speed_values": int(missing_speed_cnt),
            "negative_speed_values": int(neg_speed_cnt),
            "imputed_fraction": float(df["was_imputed"].mean()),
            "segments_covered": int(df["segment_id"].nunique()),
            "time_range": [str(df["timestamp"].min()), str(df["timestamp"].max())] if not df.empty else []
        }
        
        return df, quality_report

    def load_incidents(self, file_path: Optional[Path] = None) -> pd.DataFrame:
        path = file_path or self.paths.get("incidents_val")
        if not path or not Path(path).exists():
            path = self.paths.get("incidents_train")
        if not path or not Path(path).exists():
            return pd.DataFrame(columns=["incident_id", "start_time", "end_time", "segment_id", "incident_type", "severity", "lanes_blocked"])
        
        df = pd.read_csv(path)
        df["start_time"] = pd.to_datetime(df["start_time"])
        df["end_time"] = pd.to_datetime(df["end_time"])
        return df

    def load_planning_candidates(self, file_path: Optional[Path] = None) -> pd.DataFrame:
        path = file_path or self.paths.get("planning_candidates")
        if not path or not Path(path).exists():
            return pd.DataFrame(columns=["candidate_id", "target_segment", "intervention_type", "capacity_delta_vph", "cost_index", "feasibility_band"])
        return pd.read_csv(path)
