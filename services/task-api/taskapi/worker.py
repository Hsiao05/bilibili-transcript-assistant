"""Worker process: leases queued jobs, heartbeats and recovers after restart."""

from __future__ import annotations

import argparse
import os
import socket
import threading
import time
import uuid

from .config import Settings, load_settings
from .runner import JobRunner
from .startup import print_runtime
from .store import Store

LEASE_SECONDS = 180
HEARTBEAT_SECONDS = 30


class Worker:
    def __init__(self, settings: Settings, store: Store | None = None):
        self.settings = settings
        self.store = store or Store(settings)
        self.runner = JobRunner(settings, self.store)
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self.stopped = threading.Event()

    def run_once(self) -> bool:
        job = self.store.claim_job(self.worker_id, LEASE_SECONDS)
        if not job:
            return False
        stop_heartbeat = threading.Event()

        def heartbeat() -> None:
            while not stop_heartbeat.wait(HEARTBEAT_SECONDS):
                if not self.store.renew_lease(job.id, self.worker_id, LEASE_SECONDS):
                    return

        thread = threading.Thread(target=heartbeat, name=f"heartbeat-{job.id}", daemon=True)
        thread.start()
        try:
            self.runner.run(job, self.worker_id)
        finally:
            stop_heartbeat.set()
            thread.join(timeout=5)
        return True

    def run_forever(self, poll_seconds: float = 1.0) -> None:
        recovered = self.store.recover_expired_jobs()
        if recovered:
            print(f"[worker] recovered {recovered} expired job(s)")
        print(f"[worker] started as {self.worker_id}")
        last_recovery = time.monotonic()
        while not self.stopped.is_set():
            did_work = self.run_once()
            if time.monotonic() - last_recovery > 30:
                self.store.recover_expired_jobs()
                last_recovery = time.monotonic()
            if not did_work:
                self.stopped.wait(poll_seconds)

    def stop(self) -> None:
        self.stopped.set()


def main() -> None:
    parser = argparse.ArgumentParser(description="Bilibili transcript task worker")
    parser.add_argument("--once", action="store_true", help="process at most one job and exit")
    args = parser.parse_args()
    settings = load_settings()
    print_runtime(settings, "worker")
    worker = Worker(settings)
    if args.once:
        worker.store.recover_expired_jobs()
        worker.run_once()
        return
    try:
        worker.run_forever()
    except KeyboardInterrupt:
        worker.stop()


if __name__ == "__main__":
    main()
