import asyncio
import json
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from jobs import Jobs, TERMINAL
from protocol import LIMIT, Problem, check_count, layer_three, metadata

METADATA_LIMIT = 4096


def response(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})


def check_length(request, limit):
    if "content-length" in request.headers:
        length = request.headers["content-length"]
        if not length.isascii() or not length.isdecimal() or len(length) > 19:
            raise Problem(400, "invalid_request", "Invalid Content-Length.")
        check_count(int(length), limit)


async def read_metadata(request):
    if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
        raise Problem(400, "invalid_request", "Expected application/json metadata.")
    check_length(request, METADATA_LIMIT)
    body = bytearray()
    try:
        async for chunk in request.stream():
            check_count(len(body) + len(chunk), METADATA_LIMIT)
            body.extend(chunk)
        return metadata(json.loads(body))
    except (ValueError, RecursionError, ClientDisconnect):
        raise Problem(400, "invalid_request", "Expected complete JSON metadata.")


async def receive_audio(request, jobs, job, limit):
    folder = jobs.root / job.id
    if request.headers.get("content-type", "").lower() != "audio/mpeg":
        raise Problem(415, "unsupported_audio", "Expected raw audio/mpeg.")
    check_length(request, limit)
    with os.fdopen(os.open(folder / "audio.part", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600), "w+b") as file:
        async for chunk in request.stream():
            count = job.received + len(chunk)
            check_count(count, limit)
            if count > job.size:
                raise Problem(400, "invalid_request", "Audio exceeds the declared size.")
            file.write(chunk)
            job.received = count
        if job.received != job.size:
            raise Problem(400, "invalid_request", "Audio does not match the declared size.")
        if not layer_three(file):
            raise Problem(415, "unsupported_audio", "No supported MPEG Layer III header.")
    (folder / "audio.part").rename(folder / "audio.mp3")
    job.state = "queued"
    jobs.drive(job)


def build_app(root=None, *, worker_transport=None, interval=1, clock=None, stream_limit=LIMIT):
    @asynccontextmanager
    async def lifespan(app):
        folder = Path(root or os.environ["NEURALRAUM_TEMP_DIR"])
        if not folder.is_absolute():
            raise RuntimeError("NEURALRAUM_TEMP_DIR must be absolute")
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        async with httpx.AsyncClient(base_url=os.environ.get("NEURALRAUM_ANALYZER_URL", "http://127.0.0.1:8001"),
                                     transport=worker_transport, timeout=5, trust_env=False) as client:
            jobs = app.state.jobs = Jobs(folder, client, interval=interval, **({"clock": clock} if clock else {}))
            jobs.recover()

            async def reap():
                while True:
                    await asyncio.sleep(15)
                    jobs.sweep()

            reaper = asyncio.create_task(reap())
            try:
                yield
            finally:
                reaper.cancel()
                with suppress(asyncio.CancelledError):
                    await reaper
                # Outstanding directories are retired on the next single-process startup.
                tasks = list(jobs.drivers) + [j.writer for j in jobs.public.values() if j.writer]
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"])

    @app.exception_handler(Problem)
    async def problem(request, exc):
        return response({"error": exc.error}, exc.status)

    def lookup(id):
        jobs = app.state.jobs
        job = jobs.public.get(id)
        if job and job.ended is not None and jobs.clock() - job.ended >= 600:
            del jobs.public[id]
            job = None
        if not job:
            raise Problem(404, "unknown_job", "Job not found.")
        return job

    @app.post("/v1/jobs")
    async def create(request: Request):
        size = await read_metadata(request)
        try:
            job = app.state.jobs.create(size)
        except OSError:
            raise Problem(503, "unavailable", "Temporary storage is unavailable.")
        return response(job.snapshot(), 201)

    @app.put("/v1/jobs/{id}/audio")
    async def upload(id: str, request: Request):
        jobs, job = app.state.jobs, lookup(id)
        if job.state != "uploading" or job.claimed:
            raise Problem(409, "invalid_state", "Job cannot accept another upload.")
        job.claimed = True
        job.writer = asyncio.create_task(receive_audio(request, jobs, job, stream_limit))
        try:
            await job.writer
        except (ClientDisconnect, asyncio.CancelledError):
            if job.state == "cancelling" or job.state == "cancelled":
                raise Problem(409, "invalid_state", "Upload cancelled.")
            job.failure = {"code": "upload_interrupted", "message": "Upload was interrupted."}
            raise Problem(400, "invalid_request", "Incomplete upload.")
        except OSError:
            job.failure = {"code": "unavailable", "message": "Temporary storage is unavailable."}
            raise Problem(503, **job.failure)
        except Problem as exc:
            job.failure = exc.error
            raise
        finally:
            job.writer = None
            if job.failure or job.state == "cancelling":
                jobs.drive(job)
        return response(job.snapshot(), 202)

    @app.get("/v1/jobs/{id}")
    async def status(id: str):
        job = lookup(id)
        job.seen = app.state.jobs.clock()
        return response(job.snapshot())

    @app.get("/v1/jobs/{id}/result")
    async def result(id: str):
        job = lookup(id)
        if job.state != "succeeded":
            raise Problem(409, "not_ready", "No completed result.")
        return response(job.result)

    @app.delete("/v1/jobs/{id}")
    async def cancel(id: str):
        job = lookup(id)
        app.state.jobs.cancel(job)
        return response(job.snapshot(), 200 if job.state in TERMINAL else 202)

    return app


app = build_app()
