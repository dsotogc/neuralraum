# Playable club · wire contract v1

Local defaults: web `http://localhost:5173`, public API `http://127.0.0.1:8000`, internal analyzer `http://127.0.0.1:8001`. Web may proxy `/v1` to the API; otherwise allow the web origin (including PUT/DELETE and Content-Type preflight). Bind services to loopback. Both services require the same absolute `NEURALRAUM_TEMP_DIR` on a local Linux filesystem. One API process and one analyzer process, **multiple concurrent jobs** per process. No Python environment shared with the pilot.

JSON payloads use `application/json`, no envelopes except errors. `wire.schema.json` defines the named shapes below; `timeline.schema.json` defines the entire result. Responses are `Cache-Control: no-store`. IDs are server-generated random lowercase UUIDv4 capabilities; never accept a client path or derive an ID from file contents, cookies or browser identity. Unknown/expired IDs return 404. No job listing. No durable tab/session recovery.

For offline integration, `fixtures/lifecycle.json` contains **individual response bodies** keyed by scenario, not an HTTP envelope. Feed `public` in order and serve `fixtures/pulse.json` (or `fixtures/silence.json`) at its result route. For a failure run, replace **only the final succeeded snapshot** with `failed`; ID and declared size stay fixed and no result is fetched. Separately test stale generations: start a replacement attempt, deliver the previous attempt's delayed `failed` callback, and assert the new attempt's status and playback do not change. `fixtures/invalid.json` contains inputs consumers must reject. Run `uv run --no-project --with jsonschema python contracts/verify.py` from the repository root, or install `jsonschema` in an isolated environment and run the script directly.

## Public HTTP (web → API)

| Method and route | Request | Success |
|---|---|---|
| POST `/v1/jobs` | `Create` | 201 `Status`, state `uploading`; ID reserved before transmission |
| PUT `/v1/jobs/{id}/audio` | Raw MP3 bytes, `Content-Type: audio/mpeg`, no multipart | 202 `Status` once fully received and scheduled for dispatch (normally `queued`; may already be further along) |
| GET `/v1/jobs/{id}` | No body | 200 `Status`; also renews tab lease |
| GET `/v1/jobs/{id}/result` | No body | 200 `Timeline` only after `succeeded`; otherwise 409 `not_ready` |
| DELETE `/v1/jobs/{id}` | No body | 202 `Status` if draining, 200 `Status` if terminal; repeat safe |

Before POST require case-insensitive `.mp3`, size `1..300000000`, and a positive MPEG Layer III header check. Show actual size and decimal limit on rejection. Browser admission reads at most 14 bytes via `File.slice`:

1. Read up to 10 bytes at offset 0. Without `ID3` use frame offset 0. With `ID3`, require a full ID3v2 header, major version 2, 3 or 4, and four synchsafe size bytes (each below 128). Decode bytes 6–9 as a big-endian base-128 integer `n`. Skip directly to `10 + n`, adding 10 more for a v2.4 footer if flags byte 5 has bit `0x10`. Do not read the tag payload or scan through unrelated containers looking for sync.
2. Read four bytes at the frame offset; reject truncation. Require the 11 sync bits all set, MPEG version bits other than `01`, layer bits exactly `01` (Layer III), bitrate index other than `1111`, sample-rate index other than `11`, and emphasis other than reserved `10`. Neither MIME type nor successful native playback substitutes for this check.
3. Acceptance pair: an actual MPEG-1 Layer III file beginning `FF FB 90 64` passes, as does that file preceded by `49 44 33 04 00 00 00 00 00 20` and 32 tag payload bytes (frame offset 42). A playable WAV beginning `RIFF…WAVE` renamed `night.mp3` stays on the cover with an unsupported-format error and **zero POST requests**.

Server independently validates metadata and content: check size before reserving; stream to disk, enforce actual byte ceiling even if request lies or omits Content-Length, require exact declared size, reject a tag alone or non-Layer-III content. Decode failures later can still fail analysis. `name` is display metadata only. One PUT per ID; concurrent or repeated PUT is 409 `invalid_state`. Rejected PUT after writer admission retires the file and records failure unless cancellation already won. A broken upload requires a fresh job. Never buffer the whole body for admission.

POST rejection precedence after parsing the two required fields: negative/noninteger size → 400; over limit → 413; zero bytes or unsupported suffix → 415. An aborted upload might never send another byte: cancellation must interrupt the pending receive and close the writer, not wait for the next chunk.

Errors are `{"error":{"code":"…","message":"…"}}` (same `Error` object embedded in failed statuses). Codes: 400 `invalid_request` (malformed JSON/metadata or size mismatch); 413 `too_large`; 415 `unsupported_audio` (format or zero playable content); 404 `unknown_job`; 409 `invalid_state` / `not_ready`; 503 `unavailable` (temporary service failure). Asynchronous failures additionally use `upload_interrupted`, `analysis_failed` or `unavailable`. Messages are human-readable, never local paths or traces. Retry transient GET failures without stopping audio; retry a failed submission by POST + PUT of the retained local File with a **new ID**, never restart playback. Replacement starts a new night; cancel/abort old requests, ignore all old callbacks including POST responses by comparing per-attempt generation, best-effort DELETE any late-created ID.

## State, progress and entry

`uploading → queued → analyzing → succeeded`; failure may terminate any active state. Cancellation from any active state goes through `cancelling → cancelled`; a poll can skip intermediate states. Once cancellation wins the per-job transition, later worker completion is discarded. Terminal states never reverse. DELETE on a terminal job returns its existing status. Public terminal publication is a **cleanup barrier** (see below). Only `failed` carries non-null `error`.

`upload_received_bytes` counts bytes accepted by the API (never exceeds `size_bytes`); during transfer the browser uses raw-body XHR upload events for measured transport percentage, never treats 100% sent as analyzer acceptance. Full count for queued/analyzing/succeeded. `analysis_fraction` is null before measurable work and whenever total work is unknown; otherwise bounded and nondecreasing across measured updates, never 1 until success. Count completed work against a known total (e.g. decoded frames for an explicitly budgeted pass); do not convert elapsed wall time into fake percentages. Queued and uploading: null; success: 1. `cancelling`, `failed`, `cancelled`: null. Internal status uses the same fraction rules. No partial timeline.

Poll status every 1 s while waiting, including during PUT; one in-flight poll per job. No ETA field in v1. Until local measurements exist use a documented small-file immediate-entry policy and wait for completion on larger files; on analysis failure offer DJ-only entry even for large files. Keep the two stages visible independently and Cancel available on the cover. Only with calibration estimate transfer from remaining bytes/measured throughput, queue and processing from measured performance/duration; display time **to entry**, never invented countdowns. A user gesture may be required for local playback; no second audio download. See `playback.md`.

## Internal HTTP (API → analyzer)

Same ID and JSON errors; no audio, filename, absolute path or browser credentials over this interface.

| Method and route | Request | Success |
|---|---|---|
| PUT `/internal/v1/jobs/{id}` | `{}`; shared input already published | 202 `WorkerStatus` on enqueue, 200 current `WorkerStatus` on replay (including terminal); do not enqueue twice |
| GET `/internal/v1/jobs/{id}` | None | 200 `WorkerStatus` |
| GET `/internal/v1/jobs/{id}/result` | None | 200 `Timeline` only if succeeded, otherwise 409 `not_ready` |
| DELETE `/internal/v1/jobs/{id}` | None | 202 `WorkerStatus` while draining, 200 when terminal; unknown valid ID creates a released `cancelled` tombstone (fences out delayed PUT) |

Missing shared input on first PUT: 409 `invalid_state`. Internal states exclude `uploading`. `released:false` covers queued reservation, execution and draining; `released:true` means terminal and no worker/decoder can subsequently read that file. Serialize PUT/DELETE/finish per ID. API polls worker every second; retry ambiguous dispatch with the same ID. On worker success fetch, validate and cache the complete result before publishing public success. On loss of a previously acknowledged worker (404 after restart), fail with `unavailable` and retire. Keep internal terminal statuses/results at least 10 minutes then expire; no audio retention for retries.

## Shared file lease, abandonment and recovery

* API exclusively creates `$NEURALRAUM_TEMP_DIR/{id}/` (private 0700), `audio.part` (0600), then closes and atomically renames it to `audio.mp3` before dispatch. Never reuse an ID. Only API writes, unlinks and removes directories. Analyzer opens only the canonical file for a validated ID; no directory creation or fallback paths.
* Linux `flock` on the **job directory fd** is the physical lease. API tracks/drains its own writer (including aborted requests) before cleanup. Analyzer must acquire a shared lock **before opening audio**, hold until every reader, subprocess and task is stopped/joined, then unlock and publish terminal `released:true`. Do not leave independently surviving decoder subprocesses after worker death (or ensure they retain the lease until exit). API deletion requires an exclusive lock, nonblocking/retried rather than blocking the event loop. Delete both filenames and rmdir **while locked**. Never open audio before locking or recreate a removed directory: a delayed reader acquiring an old fd after unlink finds no input. Queued reservations are logical leases even before a reader opens. Normal cleanup waits for terminal release; cancellation sends internal DELETE even after ambiguous dispatch. Check state at each handoff so no local writer or dispatch starts after retirement.
* Public GET status renews a 120 s inactivity lease, initialized at POST. Poll while active even during long uploads or paused playback awaiting results. No reliance on `unload`; on explicit Cancel/replace/pagehide abort PUT and best-effort DELETE. Reaper runs at least every 15 s: expired nonterminal jobs enter cancellation; stop writer, cancel/drain analyzer, remove files. Upload bytes and internal polls do **not** renew tab life. Losing one tab cannot affect another ID. Terminal public snapshots/results expire 10 min after terminal transition regardless of polling; browser keeps fetched timeline locally.
* On unresponsive analyzer retry cancellation; after 120 s of failed contact, or confirmed worker loss, the exclusive directory lock plus permanent removal of the unique input is the fallback release fence. Never unlink under a reader or publish terminal while lock/drain fails; retry every sweep. On single-API-process startup, retire orphan UUID directories with the same cancellation/locking procedure before treating them as reclaimed. Previous browser IDs return 404. Internal tombstones can expire safely: input no longer exists or API still fences pending dispatch/cleanup. No cleanup based solely on file age.
