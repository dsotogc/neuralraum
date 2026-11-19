"""HTTP-level tests with small buffers, a controllable worker and real directory locks."""
import asyncio
import fcntl
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx

from app import METADATA_LIMIT, build_app
from protocol import CONTRACTS, LIMIT

FRAME = bytes.fromhex("ff fb 90 64")
PULSE = json.loads((CONTRACTS / "fixtures/pulse.json").read_text())


class Worker:
    def __init__(self):
        self.calls = []
        self.state = "analyzing"
        self.delete_state = "cancelled"
        self.timeline = PULSE
        self.out = False
        self.lose_put = False
        self.lost = False
        self.overrides = {}

    async def __call__(self, request):
        path = request.url.path.split("/")
        id = path[-1]
        self.calls.append((request.method, id))
        handler = self.overrides.get((request.method, request.url.path))
        if handler:
            return await handler()
        if self.out or (request.method == "PUT" and self.lose_put):
            raise httpx.ReadTimeout("stub", request=request)
        if self.lost and request.method == "GET":
            return httpx.Response(404)
        if id == "result":
            return httpx.Response(200, json=self.timeline)
        state = self.delete_state if request.method == "DELETE" else self.state
        return httpx.Response(200, json={
            "id": id, "state": state, "released": state in {"cancelled", "succeeded", "failed"},
            "analysis_fraction": {"analyzing": 0.25, "succeeded": 1}.get(state),
            "error": {"code": "analysis_failed", "message": "decode"} if state == "failed" else None})


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.worker = Worker()
        self.now = 0
        self.orphan = str(uuid.uuid4())
        (self.root / self.orphan).mkdir()
        (self.root / self.orphan / "audio.mp3").write_bytes(FRAME)
        self.app = build_app(self.root, worker_transport=httpx.MockTransport(self.worker),
                             clock=lambda: self.now, interval=0.005, stream_limit=64)
        await self.enterAsyncContext(self.app.router.lifespan_context(self.app))
        self.api = await self.enterAsyncContext(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"))

    async def create(self, size=4):
        r = await self.api.post("/v1/jobs", json={"name": "../../night.MP3", "size_bytes": size})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.headers["cache-control"], "no-store")
        return "/v1/jobs/" + r.json()["id"]

    def folder(self, url):
        return self.root / url.split("/")[-1]

    async def upload(self, url, data=FRAME, headers=None):
        return await self.api.put(url + "/audio", content=data, headers=headers or {"Content-Type": "audio/mpeg"})

    async def until(self, predicate):
        async with asyncio.timeout(2):
            while not predicate():
                await asyncio.sleep(.002)

    async def state(self, url, state):
        async with asyncio.timeout(2):
            while True:
                r = (await self.api.get(url)).json()
                if r["state"] == state:
                    return r
                await asyncio.sleep(.002)

    async def test_metadata_boundary_and_precedence(self):
        j = await self.create(LIMIT)
        self.assertEqual(self.folder(j).stat().st_mode & 0o777, 0o700)
        for size, code in [(LIMIT+1, 413), (0, 415), (-1, 400), (True, 400), (1.5, 400), (4, 415)]:
            r = await self.api.post("/v1/jobs", json={"name": "x.wav", "size_bytes": size})
            self.assertEqual(r.status_code, code)
        r = await self.api.post("/v1/jobs", content=b"{", headers={"Content-Type": "application/json"})
        self.assertEqual(r.json()["error"]["code"], "invalid_request")

    async def test_metadata_rejection_stops_receiving(self):
        for headers, reads, status in [
            ({}, 0, 400), ({"Content-Type": "audio/mpeg"}, 0, 400),
            ({"Content-Type": "application/json", "Content-Length": str(METADATA_LIMIT + 1)}, 0, 413),
            ({"Content-Type": "application/json"}, 2, 413),
            ({"Content-Type": "application/json", "Content-Length": "1"}, 2, 413),
        ]:
            consumed = []

            async def chunks():
                for piece in (b" " * METADATA_LIMIT, b"x"):
                    consumed.append(len(piece))
                    yield piece
                self.fail("read past the first oversized chunk")

            reply = await self.api.post("/v1/jobs", content=chunks(), headers=headers)
            self.assertEqual((reply.status_code, len(consumed)), (status, reads))
            self.assertFalse(self.app.state.jobs.public)
        body = b'{"name":"a.mp3","size_bytes":4}'.ljust(METADATA_LIMIT)
        reply = await self.api.post("/v1/jobs", content=body,
                                    headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(reply.status_code, 201)

    async def test_actual_stream_boundary_and_retry(self):
        async def stream(n):
            yield FRAME
            yield bytes(n - len(FRAME))
        for n, code in [(64, 202), (65, 413)]:
            j = await self.create(n)
            r = await self.upload(j, stream(n), {"Content-Type": "audio/mpeg", "Content-Length": "4"})
            self.assertEqual(r.status_code, code, r.text)
            if code == 413:
                self.assertEqual((await self.state(j, "failed"))["error"]["code"], "too_large")
                self.assertFalse(self.folder(j).exists())
                self.assertEqual((await self.upload(j)).status_code, 409)

    async def test_content_mismatch_and_headers(self):
        for data, size, kind, code in [
            (b"RIFFxxxxWAVE", 12, "audio/mpeg", 415), (b"ID3\4\0\0\0\0\0\0", 10, "audio/mpeg", 415),
            (bytes.fromhex("ff fd 90 64"), 4, "audio/mpeg", 415),
            (FRAME, 5, "audio/mpeg", 400), (FRAME, 3, "audio/mpeg", 400), (FRAME, 4, "audio/wav", 415)
        ]:
            j = await self.create(size)
            self.assertEqual((await self.upload(j, data, {"Content-Type": kind})).status_code, code)
            await self.state(j, "failed")
            self.assertFalse(self.folder(j).exists())

    async def test_success_result_expiry_and_worker_failure(self):
        tag = bytes.fromhex("49 44 33 04 00 00 00 00 00 20") + bytes(32)
        j = await self.create(len(tag)+4)
        self.assertEqual((await self.api.get(j+"/result")).status_code, 409)
        self.assertEqual((await self.upload(j, tag + FRAME)).status_code, 202)
        self.assertEqual((await self.state(j, "analyzing"))["analysis_fraction"], .25)
        self.assertEqual((self.folder(j)/"audio.mp3").stat().st_mode & 0o777, 0o600)
        self.worker.state = "succeeded"
        await self.state(j, "succeeded")
        self.assertFalse(self.folder(j).exists())
        self.assertEqual((await self.api.get(j+"/result")).json(), PULSE)
        self.assertEqual((await self.api.delete(j)).json()["state"], "succeeded")
        self.now = 599
        self.assertEqual((await self.api.get(j)).status_code, 200)
        self.now = 600
        self.assertEqual((await self.api.get(j+"/result")).status_code, 404)
        for state in ("failed", "succeeded"):
            self.worker.state = state
            self.worker.timeline = dict(PULSE, beats=[{"time_s": 1000, "low_energy": 1}])
            retry = await self.create()
            self.assertNotEqual(j, retry)
            await self.upload(retry)
            self.assertEqual((await self.state(retry, "failed"))["error"]["code"], "analysis_failed")
            self.assertFalse(self.folder(retry).exists())

    async def test_stalled_receive_abandonment_isolated_by_poll(self):
        j, other = await self.create(8), await self.create()
        started, closed = asyncio.Event(), asyncio.Event()

        async def stalled():
            yield FRAME
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()

        put = asyncio.create_task(self.upload(j, stalled()))
        await asyncio.wait_for(started.wait(), 2)
        self.assertEqual((await self.api.get(j)).json()["upload_received_bytes"], 4)
        self.assertEqual((await self.upload(j)).status_code, 409)
        self.now = 100
        await self.api.get(other)
        self.now = 120
        self.app.state.jobs.sweep()
        self.assertEqual((await asyncio.wait_for(put, 2)).status_code, 409)
        await self.state(j, "cancelled")
        self.assertTrue(closed.is_set())
        self.assertFalse(self.folder(j).exists())
        self.assertEqual((await self.upload(other)).status_code, 202)
        await self.state(other, "analyzing")

    async def test_logical_then_physical_release_barrier(self):
        self.worker.delete_state = "cancelling"
        j = await self.create()
        await self.upload(j)
        await self.state(j, "analyzing")
        fd = os.open(self.folder(j), os.O_DIRECTORY)
        try:
            self.assertEqual((await self.api.delete(j)).status_code, 202)
            await self.until(lambda: ("DELETE", j.split("/")[-1]) in self.worker.calls)
            self.assertTrue((self.folder(j)/"audio.mp3").exists())
            fcntl.flock(fd, fcntl.LOCK_SH)
            self.worker.delete_state = "succeeded"  # late completion, but a reader still holds the lock
            await self.until(lambda: self.app.state.jobs.public[j.split("/")[-1]].released)
            self.assertEqual((await self.api.delete(j)).json()["state"], "cancelling")
            self.assertTrue((self.folder(j)/"audio.mp3").exists())
        finally:
            os.close(fd)
        await self.state(j, "cancelled")
        self.assertFalse(self.folder(j).exists())
        self.assertEqual((await self.api.delete(j)).status_code, 200)

    async def test_client_disconnect_and_overlapping_jobs(self):
        j = await self.create(8)
        events = iter([{"type": "http.request", "body": FRAME, "more_body": True},
                       {"type": "http.disconnect"}])
        async def receive():
            return next(events)
        async def send(message):
            pass
        await self.app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                        "method": "PUT", "path": j+"/audio", "query_string": b"",
                        "headers": [(b"content-type", b"audio/mpeg")], "scheme": "http"},
                       receive, send)
        self.assertEqual((await self.state(j, "failed"))["error"]["code"], "upload_interrupted")
        self.assertFalse(self.folder(j).exists())
        first, second = await asyncio.gather(self.create(), self.create())
        await asyncio.gather(self.upload(first), self.upload(second))
        await asyncio.gather(self.state(first, "analyzing"), self.state(second, "analyzing"))
        await self.api.delete(first)
        await self.state(first, "cancelled")
        self.assertTrue((self.folder(second)/"audio.mp3").exists())
        self.worker.state = "succeeded"
        await self.state(second, "succeeded")
        self.assertEqual((await self.api.get(second+"/result")).json(), PULSE)

    async def test_orphan_ambiguous_dispatch_outage_and_confirmed_loss(self):
        await self.until(lambda: not (self.root/self.orphan).exists())
        self.assertIn(("DELETE", self.orphan), self.worker.calls)
        self.assertEqual((await self.api.get("/v1/jobs/"+self.orphan)).status_code, 404)
        self.worker.lose_put = True
        j = await self.create()
        id = j.split("/")[-1]
        await self.upload(j)
        await self.until(lambda: self.worker.calls.count(("PUT", id)) >= 2)
        self.worker.out = True
        await self.api.delete(j)
        await self.until(lambda: ("DELETE", id) in self.worker.calls)
        fd = os.open(self.folder(j), os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_SH)
            self.now = 120
            await self.until(lambda: self.app.state.jobs.public[id].released)
            self.assertTrue((self.folder(j)/"audio.mp3").exists())
        finally:
            os.close(fd)
        await self.state(j, "cancelled")
        self.assertFalse(self.folder(j).exists())
        self.worker.out = self.worker.lose_put = False
        j = await self.create()
        await self.upload(j)
        await self.state(j, "analyzing")
        self.worker.lost = True
        self.assertEqual((await self.state(j, "failed"))["error"]["code"], "unavailable")
        self.assertFalse(self.folder(j).exists())

    async def test_stalled_dispatch_times_out_then_recovers(self):
        j = await self.create()
        id = j.split("/")[-1]
        key = ("PUT", f"/internal/v1/jobs/{id}")
        interrupted = asyncio.Event()

        async def stall_once():
            del self.worker.overrides[key]
            try:
                await asyncio.Event().wait()
            finally:
                interrupted.set()

        self.worker.overrides[key] = stall_once
        self.worker.state = "succeeded"
        with patch("jobs.REQUEST_DEADLINE", .05):
            await self.upload(j)
            await self.state(j, "succeeded")
        self.assertTrue(interrupted.is_set())
        self.assertEqual(self.worker.calls.count(("PUT", id)), 2)
        self.assertEqual((await self.api.get(j+"/result")).json(), PULSE)

    async def test_trickling_result_and_delete_respect_deadline_and_reader(self):
        j, other = await self.create(), await self.create()
        route = "/internal/v1/jobs/" + j.split("/")[-1]
        began, closed = asyncio.Event(), asyncio.Event()

        class Trickle(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"["
                began.set()
                while True:
                    yield b" "
                    await asyncio.sleep(.001)

            async def aclose(self):
                closed.set()

        async def trickle():
            return httpx.Response(200, stream=Trickle())

        self.worker.overrides["GET", route+"/result"] = trickle
        self.worker.overrides["DELETE", route] = trickle
        self.worker.state = "succeeded"
        with patch("jobs.REQUEST_DEADLINE", .05):
            await self.upload(j)
            await asyncio.wait_for(began.wait(), 2)
            fd = os.open(self.folder(j), os.O_DIRECTORY)
            try:
                fcntl.flock(fd, fcntl.LOCK_SH)
                await self.api.delete(j)
                await self.upload(other)
                await self.state(other, "succeeded")
                await self.until(lambda: ("DELETE", j.split("/")[-1]) in self.worker.calls)
                self.assertTrue(closed.is_set())
                self.now = 120
                await self.until(lambda: self.app.state.jobs.public[j.split("/")[-1]].released)
                self.assertEqual((await self.api.get(j)).json()["state"], "cancelling")
                self.assertTrue((self.folder(j)/"audio.mp3").exists())
            finally:
                os.close(fd)
            await self.state(j, "cancelled")
            self.assertFalse(self.folder(j).exists())
