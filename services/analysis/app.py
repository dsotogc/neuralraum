import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
import re

# Bound native parallelism before importing any numeric libraries.
for variable in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "OMP_NUM_THREADS",
                 "NUMBA_NUM_THREADS", "BLIS_NUM_THREADS"):
    os.environ[variable] = "1"

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from jobs import Jobs, Problem


UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


@asynccontextmanager
async def lifespan(app):
    root = Path(os.environ["NEURALRAUM_TEMP_DIR"])
    if not root.is_absolute() or not root.is_dir():
        raise RuntimeError("Configure an existing absolute NEURALRAUM_TEMP_DIR")
    registry = app.state.jobs = Jobs(root)

    async def reap():
        while True:
            await asyncio.sleep(15)
            registry.expire()

    task = asyncio.create_task(reap())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        registry.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def response(status, body):
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


@app.exception_handler(Problem)
async def problem(request, exc):
    return response(exc.status, {"error": exc.error})


def registry(request, key):
    if not UUID4.fullmatch(key):
        raise Problem(404, "unknown_job", "Unknown analysis job.")
    return request.app.state.jobs


@app.put("/internal/v1/jobs/{key}")
async def put(key: str, request: Request):
    jobs = registry(request, key)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 4096:
            raise Problem(400, "invalid_request", "Expected an empty JSON object.")
        raw.extend(chunk)
    try:
        valid = json.loads(raw) == {}
    except (ValueError, RecursionError):
        valid = False
    if not valid:
        raise Problem(400, "invalid_request", "Expected an empty JSON object.")
    return response(*jobs.put(key))


@app.get("/internal/v1/jobs/{key}")
def status(key: str, request: Request):
    return response(*registry(request, key).get(key))


@app.get("/internal/v1/jobs/{key}/result")
def result(key: str, request: Request):
    return response(*registry(request, key).get(key, result=True))


@app.delete("/internal/v1/jobs/{key}")
def delete(key: str, request: Request):
    return response(*registry(request, key).delete(key))
