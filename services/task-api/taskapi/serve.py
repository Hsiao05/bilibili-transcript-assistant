"""Console entry point for running the API with uvicorn.

    python -m taskapi.serve                  # uses TASKAPI_HOST / TASKAPI_PORT
    python -m taskapi.serve --port 8765      # explicit bind
    python -m taskapi.serve --print-token    # print the paired token and exit
"""

from __future__ import annotations

import argparse

import uvicorn

from .config import load_settings
from .startup import print_runtime


def main() -> None:
    settings = load_settings()
    parser = argparse.ArgumentParser(description="Bilibili transcript task API")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--reload", action="store_true")
    parser.add_argument(
        "--print-token",
        action="store_true",
        help="print the local access token (for the extension settings page) and exit",
    )
    args = parser.parse_args()
    if args.print_token:
        print(settings.token)
        return
    print_runtime(settings, "serve", args.host, args.port)
    uvicorn.run(
        "taskapi.main:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
