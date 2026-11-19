import asyncio
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from app import app, lifespan
import httpx
import numpy as np


class AnalysisTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.enterContext(patch.dict(os.environ, NEURALRAUM_TEMP_DIR=tmp.name))
        await self.enterAsyncContext(lifespan(app))
        self.http = await self.enterAsyncContext(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://worker"))

    def reserve(self):
        key = str(uuid4())
        directory = self.root / key
        directory.mkdir()
        return "/internal/v1/jobs/" + key, directory / "audio.mp3"

    async def terminal(self, url):
        async with asyncio.timeout(30):
            while True:
                status = (await self.http.get(url)).json()
                if status["released"]:
                    return status
                await asyncio.sleep(.01)

    async def encode(self, path, samples, rate):
        await asyncio.to_thread(subprocess.run, [
            "ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(rate), "-ac", "1",
            "-i", "pipe:0", "-c:a", "libmp3lame", "-threads", "1", "-b:a", "64k",
            str(path)], input=samples.astype("<f4").tobytes(), check=True)

    async def test_mp3_timing_weights_and_silence(self):
        rate = 22050
        audio = np.zeros(rate * 4)
        # Include an onset straddling a 128-hop block boundary.
        times = [.30, 1.28, 2.45, 3.63]
        t = np.arange(rate // 8) / rate
        for start, amplitude in zip(times, [.12, .85, .12, .85]):
            i = round(start * rate)
            audio[i:i+len(t)] = amplitude * np.sin(2*np.pi*72*t) * np.exp(-16*t)
        pulse, file = self.reserve()
        silent, other = self.reserve()
        for path, samples in [(file, audio), (other, audio * 0)]:
            await self.encode(path, samples, rate)
        for url in [pulse, silent]:
            created = await self.http.put(url, json={})
            self.assertEqual((created.status_code, created.json()["state"]), (202, "queued"))
        for url in [pulse, silent]:
            done = await self.terminal(url)
            self.assertEqual((done["state"], done["analysis_fraction"]), ("succeeded", 1))
            replay = await self.http.put(url, json={})
            self.assertEqual((replay.status_code, replay.json()), (200, done))
        timeline = (await self.http.get(pulse + "/result")).json()
        self.assertEqual(timeline["version"], 1)
        self.assertAlmostEqual(timeline["duration_s"], 4, delta=.002)
        beats = timeline["beats"]
        self.assertEqual(len(beats), len(times))
        for beat, expected in zip(beats, times):
            self.assertAlmostEqual(beat["time_s"], expected, delta=.035)
        self.assertGreater(beats[1]["low_energy"], .75)
        self.assertLess(beats[2]["low_energy"], beats[1]["low_energy"] / 3)
        self.assertEqual((await self.http.get(silent + "/result")).json()["beats"], [])

    async def kick_errors(self, offsets):
        rate = 22050
        audio = np.zeros(rate * 4)
        times = np.arange(8) * .5 + .25
        for start, lead in zip(times, offsets, strict=True):
            for offset, hz, amplitude, length in [(-lead, 3200, .85, .035), (0, 72, .85, .12)]:
                i = round((start + offset) * rate)
                t = np.arange(round(length * rate)) / rate
                audio[i:i+len(t)] += amplitude * np.sin(2*np.pi*hz*t) * np.exp(-16*t)
        url, file = self.reserve()
        await self.encode(file, audio, rate)
        await self.http.put(url, json={})
        self.assertEqual((await self.terminal(url))["state"], "succeeded")
        beats = (await self.http.get(url + "/result")).json()["beats"]
        self.assertEqual(len(beats), 8)
        for beat in beats:
            self.assertGreater(beat["low_energy"], .75)
        return [(beat["time_s"] - expected) for beat, expected in zip(beats, times)]

    async def test_kicks_survive_leading_treble_transients(self):
        for error in await self.kick_errors([.10] * 8):
            self.assertLessEqual(abs(error), .035)

    async def test_kick_anchor_inside_and_around_grouping_window(self):
        leads = [.050, 0., .025, .045, .060, .069, .071, .080]
        for lead, error in zip(leads, await self.kick_errors(leads)):
            with self.subTest(lead=lead):
                self.assertLessEqual(abs(error), .020)

    async def test_missing_malformed_and_tombstone(self):
        url, file = self.reserve()
        self.assertEqual((await self.http.get(url)).status_code, 404)
        self.assertEqual((await self.http.put(url, json={"path": "x"})).status_code, 400)
        self.assertEqual((await self.http.put(url, json={})).status_code, 409)
        file.write_bytes(b"invalid")
        fenced = (await self.http.delete(url)).json()
        self.assertEqual(fenced["state"], "cancelled")
        self.assertEqual((await self.http.put(url, json={})).json(), fenced)
        bad, file = self.reserve()
        file.write_bytes(b"not MPEG audio")
        await self.http.put(bad, json={})
        done = await self.terminal(bad)
        self.assertEqual((done["state"], done["error"]["code"]), ("failed", "analysis_failed"))
        self.assertEqual((await self.http.delete(bad)).json(), done)
        result = await self.http.get(bad + "/result")
        self.assertEqual((result.status_code, result.headers["cache-control"]), (409, "no-store"))

    async def test_cancel_drain_and_directory_lease(self):
        started, finish = threading.Event(), threading.Event()

        def reader(file, stop, progress):
            progress(.5)
            started.set()
            finish.wait(5)
            return {"version": 1, "duration_s": 1, "beats": []}

        app.state.jobs.analyze = reader
        url, file = self.reserve()
        file.touch()
        await self.http.put(url, json={})
        self.assertTrue(await asyncio.to_thread(started.wait, 2))
        fd = os.open(file.parent, os.O_DIRECTORY)
        try:
            self.assertEqual((await self.http.get(url)).json()["analysis_fraction"], .5)
            draining = await self.http.delete(url)
            self.assertEqual((draining.status_code, draining.json()["released"]), (202, False))
            with self.assertRaises(BlockingIOError):
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finish.set()
            self.assertEqual((await self.terminal(url))["state"], "cancelled")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(file.exists())  # API owns disposal
        finally:
            finish.set()
            os.close(fd)

    async def test_two_readers_and_queued_cancellation(self):
        entered = [threading.Event(), threading.Event()]
        finish = threading.Event()

        def reader(file, stop, progress):
            index = int(file.read())
            if index < 2:
                entered[index].set()
                finish.wait(15)
            elif index != 2:
                raise AssertionError("Cancelled reader unexpectedly started")
            return {"version": 1, "duration_s": 1, "beats": []}

        app.state.jobs.analyze = reader
        urls = []
        try:
            for i in range(2):
                url, file = self.reserve()
                urls.append(url)
                file.write_bytes(str(i).encode())
                await self.http.put(url, json={})
            for event in entered:
                self.assertTrue(await asyncio.to_thread(event.wait, 2))
            registry = app.state.jobs
            for batch in range(2):
                pending = []
                for _ in range(30):
                    url, file = self.reserve()
                    file.write_bytes(b"3")
                    pending.append(url)
                    self.assertEqual((await self.http.put(url, json={})).status_code, 202)
                next_url, file = self.reserve()
                file.write_bytes(b"2")
                self.assertEqual((await self.http.put(next_url, json={})).status_code, 503)
                for url in pending:
                    cancelled = await self.http.delete(url)
                    self.assertEqual((cancelled.status_code, cancelled.json()["released"]), (200, True))
                with registry.lock:
                    self.assertEqual(len(registry.pending), 0)
                    self.assertEqual(len(registry.running), 2)
            self.assertEqual((await self.http.put(next_url, json={})).status_code, 202)
        finally:
            finish.set()
        for url in urls + [next_url]:
            self.assertEqual((await self.terminal(url))["state"], "succeeded")
