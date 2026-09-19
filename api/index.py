# Vercel Python Serverless Entry Point
# Vercel detects the `app` FastAPI instance from this file

import sys
from pathlib import Path

# Ensure the project root is on the Python path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from traffix.api.app import app  # noqa: F401 — Vercel picks up `app`
