"""Serialized job transitions; only the bounded pool may open shared audio."""
from collections import OrderedDict
from dataclasses import dataclass, field
import fcntl
import os
from pathlib import Path
import stat
import threading
import time

from dsp import analyze, Cancelled


class Problem(Exception):
    def __init__(self, status, code, message):
        self.status = status
        self.error = {"code": code, "message": message}


@dataclass
class Job:
    id: str
    state: str = "queued"
    fraction: float | None = None
    error: dict | None = None
    result: dict | None = None
    ended: float | None = None
    stop: threading.Event = field(default_factory=threading.Event)

    def status(self):
        return dict(id=self.id, state=self.state, analysis_fraction=self.fraction,
                    error=self.error, released=self.ended is not None)

    def terminal(self, state):
        self.state = state
        self.ended = time.monotonic()
        self.fraction = 1 if state == "succeeded" else None


class Jobs:
    def __init__(self, root: Path, analyzer=analyze):
        self.root = root
        self.analyze = analyzer
        self.lock = threading.Lock()
        self.jobs = {}
        self.ready = threading.Condition(self.lock)
        self.pending = OrderedDict()
        self.running = set()
        self.closing = False
        self.workers = [threading.Thread(target=self.consume) for _ in range(2)]
        for worker in self.workers:
            worker.start()

    def consume(self):
        while True:
            with self.ready:
                self.ready.wait_for(lambda: self.closing or self.pending)
                if self.closing:
                    return
                key, job = self.pending.popitem(last=False)
                self.running.add(key)
            self.run(job)

    def expire(self):
        with self.lock:
            cutoff = time.monotonic() - 600
            self.jobs = {k: j for k, j in self.jobs.items()
                         if j.ended is None or j.ended > cutoff}

    def put(self, key):
        with self.lock:
            if key in self.jobs:
                return 200, self.jobs[key].status()
            if not (self.root / key / "audio.mp3").is_file():
                raise Problem(409, "invalid_state", "Published audio is missing.")
            if self.closing or len(self.running) + len(self.pending) >= 32:
                raise Problem(503, "unavailable", "Analysis queue is full.")
            job = self.jobs[key] = Job(key)
            self.pending[key] = job
            self.ready.notify()
            return 202, job.status()

    def get(self, key, result=False):
        with self.lock:
            if key not in self.jobs:
                raise Problem(404, "unknown_job", "Unknown analysis job.")
            job = self.jobs[key]
            if result and job.state != "succeeded":
                raise Problem(409, "not_ready", "Timeline is not available.")
            return 200, job.result if result else job.status()

    def delete(self, key):
        with self.lock:
            if key not in self.jobs:
                self.jobs[key] = Job(key)
                self.jobs[key].terminal("cancelled")
            job = self.jobs[key]
            if job.ended is None:
                job.stop.set()
                job.fraction = None
                job.state = "cancelling"
                if self.pending.pop(key, None) is not None:
                    job.terminal("cancelled")
            return (200 if job.ended is not None else 202), job.status()

    def run(self, job):
        def progress(value):
            with self.lock:
                if job.state == "analyzing":
                    job.fraction = value

        result = None
        try:
            directory = os.open(self.root / job.id, os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                while not job.stop.is_set():
                    try:
                        fcntl.flock(directory, fcntl.LOCK_SH | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        job.stop.wait(.05)
                with self.lock:
                    if job.stop.is_set():
                        raise Cancelled
                    job.state = "analyzing"
                fd = os.open("audio.mp3", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
                with os.fdopen(fd, "rb") as file:
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        raise ValueError("Invalid input")
                    result = self.analyze(file, job.stop, progress)
            finally:
                os.close(directory)  # releases flock after in-process reader closes
        except Exception:
            # Never send decoder diagnostics (potentially containing local paths).
            result = None
        with self.lock:
            self.running.remove(job.id)
            if job.stop.is_set():
                job.terminal("cancelled")
            elif result is None:
                job.error = dict(code="analysis_failed", message="Unable to analyze audio.")
                job.terminal("failed")
            else:
                job.result = result
                job.terminal("succeeded")

    def close(self):
        with self.ready:
            self.closing = True
            for job in self.pending.values():
                job.terminal("cancelled")
            self.pending.clear()
            for key in self.running:
                self.jobs[key].stop.set()
            self.ready.notify_all()
        for worker in self.workers:
            worker.join()
