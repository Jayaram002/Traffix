"""
Traffix NeuraX 3.0 - Root App Export
Exposes FastAPI `app` instance for servers and PaaS looking for app.py
"""
import os
import sys
from pathlib import Path

# Add project root to sys.path
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from traffix.api.app import app

__all__ = ["app"]

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "10000"))
    uvicorn.run("app:app", host=host, port=port)
