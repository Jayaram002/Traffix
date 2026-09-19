import os
import sys
import logging
from pathlib import Path
import pandas as pd
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("NeonDataLoader")

BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(dotenv_path=BASE_DIR / ".env")

DATA_DIR = Path(r"D:\temp C\all filess\ram\Neurax3.0\Training set")

def get_neon_engine():
    raw_url = os.getenv("DATABASE_URL")
    if not raw_url:
        raise ValueError("DATABASE_URL environment variable is not set in .env")
    
    if raw_url.startswith("postgresql://"):
        engine_url = raw_url.replace("postgresql://", "postgresql+psycopg://", 1)
    else:
        engine_url = raw_url
    
    return create_engine(engine_url, pool_pre_ping=True)

def load_dataset_manifest(engine):
    """Loads manifest metadata into Neon."""
    manifest_path = DATA_DIR / "DATASET_MANIFEST.json"
    if manifest_path.exists():
        with open(manifest_path, "r") as f:
            content = f.read()
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS dataset_manifest (
                    id SERIAL PRIMARY KEY,
                    manifest_json JSONB,
                    loaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """))
            conn.execute(text("INSERT INTO dataset_manifest (manifest_json) VALUES (:mj)"), {"mj": content})
        logger.info("Loaded DATASET_MANIFEST.json into dataset_manifest table.")

def sync_csv_to_neon(engine, filename: str, table_name: str, max_rows: int = None, if_exists: str = "replace", index_cols: list = None):
    file_path = DATA_DIR / filename
    if not file_path.exists():
        logger.warning(f"File {file_path} not found. Skipping.")
        return 0

    logger.info(f"Ingesting {filename} into Neon table '{table_name}'...")
    
    if max_rows and file_path.stat().st_size > 5 * 1024 * 1024:
        # Stream in chunks
        csv_chunk_size = 10000
        total_rows = 0
        is_first = True
        for chunk in pd.read_csv(file_path, chunksize=csv_chunk_size, nrows=max_rows):
            mode = if_exists if is_first else "append"
            chunk.to_sql(table_name, engine, if_exists=mode, index=False, chunksize=2000, method="multi")
            total_rows += len(chunk)
            is_first = False
            logger.info(f"  Pushed {total_rows} rows to '{table_name}'...")
            if max_rows and total_rows >= max_rows:
                break
    else:
        df = pd.read_csv(file_path, nrows=max_rows)
        df.to_sql(table_name, engine, if_exists=if_exists, index=False, chunksize=2000, method="multi")
        total_rows = len(df)
        logger.info(f"  Pushed {total_rows} rows to '{table_name}'.")

    # Create indexes for high performance querying
    if index_cols:
        with engine.begin() as conn:
            for col in index_cols:
                idx_name = f"idx_{table_name}_{col}"
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table_name} ({col});"))
        logger.info(f"  Created indexes on {index_cols} for '{table_name}'.")

    return total_rows

def link_all_training_data_to_neon():
    engine = get_neon_engine()
    logger.info("Connected to Neon Lakebase Postgres. Beginning dataset migration...")

    # 1. Dataset Manifest
    load_dataset_manifest(engine)

    # 2. Network & Topology
    sync_csv_to_neon(engine, "nodes.csv", "nodes", index_cols=["node_id"])
    sync_csv_to_neon(engine, "network.csv", "network_segments", index_cols=["segment_id", "source_node", "target_node"])
    sync_csv_to_neon(engine, "turn_restrictions.csv", "turn_restrictions")
    sync_csv_to_neon(engine, "signal_plans.csv", "signal_plans", index_cols=["signal_id"])

    # 3. Operations & Incidents
    sync_csv_to_neon(engine, "incidents_train.csv", "incidents_train", index_cols=["segment_id"])
    sync_csv_to_neon(engine, "incidents_validation.csv", "incidents_validation", index_cols=["segment_id"])
    sync_csv_to_neon(engine, "roadworks_train.csv", "roadworks_train", index_cols=["segment_id"])
    sync_csv_to_neon(engine, "roadworks_validation.csv", "roadworks_validation", index_cols=["segment_id"])

    # 4. Context & Planning
    sync_csv_to_neon(engine, "planning_candidates.csv", "planning_candidates", index_cols=["candidate_id"])
    sync_csv_to_neon(engine, "od_demand_profiles.csv", "od_demand_profiles")
    sync_csv_to_neon(engine, "scenario_examples.csv", "scenario_examples")
    sync_csv_to_neon(engine, "context_train.csv", "context_train", index_cols=["timestamp"])
    sync_csv_to_neon(engine, "context_validation.csv", "context_validation", index_cols=["timestamp"])

    # 5. Traffic Telemetry Observations (Load comprehensive 50,000 rows sample into Neon)
    sync_csv_to_neon(engine, "traffic_validation.csv", "traffic_validation", max_rows=50000, index_cols=["segment_id", "timestamp"])

    # 6. Forecast Targets
    sync_csv_to_neon(engine, "forecast_targets_validation.csv", "forecast_targets_validation", max_rows=30000, index_cols=["segment_id", "timestamp"])

    # Print summary of tables in Neon
    with engine.connect() as conn:
        res = conn.execute(text("""
            SELECT table_name, 
                   (xpath('/row/cnt/text()', xml_count))[1]::text::int as row_count
            FROM (
              SELECT table_name, 
                     query_to_xml(format('select count(*) as cnt from %I', table_name), false, true, '') as xml_count
              FROM information_schema.tables
              WHERE table_schema = 'public'
            ) t
            ORDER BY table_name;
        """)).fetchall()

        print("\n" + "="*60)
        print("NEON POSTGRES LINKED TABLES SUMMARY")
        print("="*60)
        for row in res:
            print(f"  • {row[0]:<30} {row[1]:>8} rows")
        print("="*60 + "\n")

if __name__ == "__main__":
    link_all_training_data_to_neon()
