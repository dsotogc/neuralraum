"""Single-event-loop coordinator. Transitions without an await are atomic per job."""
import asyncio
import fcntl
import math
import os
import re
import time
import uuid
from dataclasses import dataclass, field

import httpx

from protocol import Problem, WORKER, valid_timeline

ID = re.compile(WORKER.schema["$defs"]["id"]["pattern"])
TERMINAL = {"succeeded", "failed", "cancelled"}
UNAVAILABLE = {"code": "unavailable", "message": "The analyzer is unavailable."}
FAILED = {"code": "analysis_failed", "message": "Audio analysis failed."}
REQUEST_DEADLINE = 10  # wall-clock seconds, includes reading the entire response


@dataclass
class Job:
    id: str
    size: int
    seen: float
    state: str = "uploading"
    received: int = 0
    fraction: float | None = None
    high_water: float = 0
    error: dict | None = None
    result: dict | None = None
    claimed: bool = False
    writer: asyncio.Task | None = None
    driver: asyncio.Task | None = None
    dispatched: bool = False
    acknowledged: bool = False
    released: bool = False
    failure: dict | None = None
    ended: float | None = None
    outage: float | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)

    def snapshot(self):
        return dict(id=self.id, state=self.state, size_bytes=self.size,
                    upload_received_bytes=self.received, analysis_fraction=self.fraction,
                    error=self.error)


def remove_locked(path):
    try:
        fd = os.open(path, os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in ("audio.part", "audio.mp3"):
            (path / name).unlink(missing_ok=True)
        path.rmdir()
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


class Jobs:
    def __init__(self, root, client, *, clock=time.monotonic, interval=1):
        self.root, self.client = root, client
        self.clock, self.interval = clock, interval
        self.public = {}
        self.drivers = set()

    def create(self, size):
        id = str(uuid.uuid4())
        (self.root / id).mkdir(mode=0o700)
        job = self.public[id] = Job(id, size, self.clock())
        return job

    def recover(self):
        for path in self.root.iterdir():
            if ID.fullmatch(path.name) and not path.is_symlink() and path.is_dir():
                orphan = Job(path.name, 0, self.clock(), dispatched=True)
                self.cancel(orphan)

    def sweep(self):
        now = self.clock()
        for job in list(self.public.values()):
            if job.ended is not None:
                if now - job.ended >= 600:
                    del self.public[job.id]
            elif now - job.seen >= 120:
                self.cancel(job)

    def drive(self, job):
        if job.driver is None:
            job.driver = asyncio.create_task(self._run(job))
            self.drivers.add(job.driver)
            job.driver.add_done_callback(self.drivers.discard)
        job.wake.set()

    def cancel(self, job):
        if job.state not in TERMINAL and job.state != "cancelling":
            job.state, job.fraction = "cancelling", None
            if job.writer is not None:
                job.writer.cancel()
            self.drive(job)

    async def _run(self, job):
        while job.state not in TERMINAL:
            job.wake.clear()
            await self._step(job)
            if job.state not in TERMINAL:
                try:
                    await asyncio.wait_for(job.wake.wait(), self.interval)
                except TimeoutError:
                    pass

    async def _step(self, job):
        retiring = job.state == "cancelling" or job.failure is not None
        if job.writer is not None and not job.writer.done():
            return
        route = f"/internal/v1/jobs/{job.id}"
        if not job.released and (job.dispatched or not retiring):
            method = "DELETE" if retiring else ("GET" if job.acknowledged else "PUT")
            job.dispatched = True
            try:
                reply = await self._request(method, route, **({"json": {}} if method == "PUT" else {}))
                if reply.status_code == 404 and job.acknowledged:
                    job.failure, job.released = UNAVAILABLE, True
                else:
                    reply.raise_for_status()
                    status = reply.json()
                    if not WORKER.is_valid(status) or status["id"] != job.id:
                        raise ValueError("Invalid worker response")
                    job.acknowledged = True
                    state, fraction = status["state"], status["analysis_fraction"]
                    if fraction is not None and not math.isfinite(fraction):
                        raise ValueError("Invalid fraction")
                    if not status["released"]:
                        if job.state != "cancelling" and state == "analyzing":
                            job.state = state
                            if fraction is not None:
                                job.high_water = max(job.high_water, fraction)
                                job.fraction = job.high_water
                            else:
                                job.fraction = None
                        job.outage = None
                        return
                    if job.state != "cancelling" and not job.failure:
                        if state == "succeeded":
                            result = await self._request("GET", route + "/result")
                            result.raise_for_status()
                            value = result.json()
                            if not valid_timeline(value):
                                raise ValueError("Invalid timeline")
                            job.result = value
                        else:
                            job.failure = (UNAVAILABLE if state == "failed" and
                                           status["error"]["code"] == "unavailable" else FAILED)
                    job.released = True
            except (ValueError, OverflowError, RecursionError):
                job.failure = FAILED
                if not retiring:
                    return
                self._outage(job, method)
            except (TimeoutError, httpx.HTTPError):
                self._outage(job, method)
            if not job.released:
                return
        if remove_locked(self.root / job.id):
            if job.state == "cancelling":
                job.state, job.result = "cancelled", None
            elif job.failure:
                job.state, job.fraction, job.error = "failed", None, job.failure
            else:
                job.state, job.fraction = "succeeded", 1
            job.ended = self.clock()

    async def _request(self, method, route, **kwargs):
        async with asyncio.timeout(REQUEST_DEADLINE):
            return await self.client.request(method, route, **kwargs)

    def _outage(self, job, method):
        now = self.clock()
        if job.outage is None:
            job.outage = now
        if now - job.outage >= 120:
            if method == "DELETE":
                job.released = True  # physical fence still required
            else:
                job.failure = UNAVAILABLE  # DELETE even if PUT acknowledgement was lost
