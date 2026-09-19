# Vercel Python Serverless Entry Point
# Vercel discovers the `app` FastAPI instance from this file.
# All requests are routed here via vercel.json.

import sys
import logging
from pathlib import Path

# Ensure the project root is on the Python path so all internal imports resolve
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)

# Import the FastAPI app — Vercel picks up the top-level `app` name
from traffix.api.app import app  # noqa: F401, E402
