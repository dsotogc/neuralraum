# Public API · local setup

Use Linux, Python 3.11+ and a dedicated environment. From the repository root:

```sh
cd services/api
python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export NEURALRAUM_TEMP_DIR="${XDG_RUNTIME_DIR:-/tmp}/neuralraum-$(id -u)"
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```

Use the same absolute `NEURALRAUM_TEMP_DIR` in the analyzer terminal. Use a private, dedicated directory on a local filesystem supporting `flock`. The API creates it if absent. The analyzer URL defaults to `http://127.0.0.1:8001`; override with `NEURALRAUM_ANALYZER_URL`. Start exactly one API process for this directory (no reload mode). Browser origins `http://localhost:5173` and `http://127.0.0.1:5173` are allowed, or use the web development proxy.

Run the component checks from `services/api`:

```sh
.venv/bin/python -B -m unittest -v
```

Tests use temporary directories, HTTP transports in process, a stub analyzer and small header fixtures. The metadata test checks the production 300,000,000-byte boundary; the stream test uses the same counting logic with a 64-byte ceiling. No large input, network listener, audio decoder or running analyzer is required.

`POST /v1/jobs` requires `application/json`; the JSON body is limited to 4,096 bytes independently of the declared audio size. Internal HTTP requests have a 10-second total deadline, including the response body. Expiry is treated as lost contact, not as proof that the analyzer has released the file.

For manual verification, use the job lifecycle in [`../../contracts/README.md`](../../contracts/README.md). Poll public status while uploading and waiting. A retry creates a new ID and uploads the original local file again. Terminal status means the job directory has been removed. A transient analyzer outage can delay that transition; a held reader lock delays removal even after the contact timeout. On restart old public IDs are unknown, and orphan cleanup runs in the background.
