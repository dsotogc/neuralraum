# Neuralraum

A Berlin-inspired club for your own music. The desktop player pairs a local MP3 with an industrial dance floor, amber silhouettes and speaker cones driven by the track's pulse and bass energy.

## How the playable prototype works

The browser plays your original file. A public API accepts a temporary copy and a separate Python analyzer reads it in blocks. The resulting timeline uses seconds from the beginning of the recording, so a late result can join the music without restarting playback. This version uses signal processing; training a musical-section classifier is a later phase.

| Component | Responsibility |
|---|---|
| [`apps/web/`](apps/web/README.md) | Desktop player and PixiJS club |
| [`services/api/`](services/api/README.md) | Uploads, job status, cancellation and file cleanup |
| [`services/analysis/`](services/analysis/README.md) | Pulse detection and bass weighting |
| [`contracts/`](contracts/README.md) | Shared job protocol, timeline units and fixtures |
| [`tools/audio_pilot/`](tools/audio_pilot/README.md) | Compare listening notes with measured audio features |
| [`prototypes/spatial-proof/`](prototypes/spatial-proof/README.md) | Standalone study of the room and crowd |

## Local development

Use a Linux desktop with Firefox. Set up the API and analyzer in separate Python environments using their linked instructions. Both processes must run as the same user and share one private local directory. In **each** service terminal:

```sh
export NEURALRAUM_TEMP_DIR="${XDG_RUNTIME_DIR:-/tmp}/neuralraum-$(id -u)"
install -d -m 700 "$NEURALRAUM_TEMP_DIR"
```

Start one analyzer on `127.0.0.1:8001` and one API on `127.0.0.1:8000`. The browser development server uses port `5173`. These services run locally; no trained model, annotation file or pilot environment is required for playback.

In a third terminal, with Node 22.18+ and npm:

```sh
cd apps/web
npm ci
npm run dev
```

Open **http://localhost:5173** in Firefox. Select an MP3 and choose **Enter hall** when enabled. Watch a speaker cone through a passage with audible kicks, pause and resume. The cone should stop on pause and return on the current beat. The [player guide](apps/web/README.md) includes cancellation, retry and memory checks.
