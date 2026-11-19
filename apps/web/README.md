# Neuralraum · Hall 01

The desktop client plays one local MP3 per night. HTML owns admission and playback controls; bundled PixiJS 8.12.0 renders the fixed rear view. No CDN, audio decoding into JS, local spectrum analysis, or saved session.

## Run

Use Node 22.18+ and npm. From `apps/web/`:

```sh
npm ci
npm test
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/v1` to the public API at `127.0.0.1:8000`; the browser does not contact the analyzer. Start both services per the root instructions for real analysis. `npm run build` checks TypeScript and emits `dist/`; `npm run preview` serves that build on the same address (stop the dev server first). For deployment, supply the same-origin `/v1` proxy.

## Entry and synchronization

- Selection reads at most 14 header bytes, then prepares the first room frame on the poster while the upload runs. Files **up to 12,000,000 bytes** enable **Enter hall** as soon as the renderer is ready; larger accepted files also wait for a full result. This is an initial policy, not a measured latency estimate. A failed job allows DJ-only entry. A WebGL setup failure can be retried separately. Only an explicit Enter gesture starts local audio.
- Upload reports measured bytes sent. “Received” requires server acknowledgment; a lost PUT response cannot override a confirmed upload or result. Unknown analysis work has no percentage. Status polling continues during transfer and while paused, including after transient GET failures. Retry uses a new job and the original File.
- The native media element supplies the only playback clock. The lens never follows a dancer. Cone displacement uses the last timed beat, decays over 160 ms and scales with its low-band energy. People arrive in groups after the timeline joins the current night. Pause stops frame scheduling; only a completed set's exit uses a separate six-second clock.
- Pointer movement or keyboard activity reveals controls. Space toggles playback; focused buttons retain their native keyboard behavior. There is no seeking. Leave, replacement and page hide abort active transfers, retire the old job, unload the native element, revoke its URL and destroy the room. Server-side leases cover cases where browser cleanup cannot reach the API.

## Lightweight checks

`npm test` uses Node's built-in runner and `../../contracts/fixtures/`. It checks inclusive size/header admission without allocating a 300 MB file, weak/strong/silent beats, paused/late adoption, old reservations and delayed callbacks, GET recovery, and fresh-job retries.

The room check uses the actual Pixi scene graph, **without a browser or GPU**. It samples process RSS during three bounded passes of 240 poses, expects stable geometry identities/instruction counts, and stops if RSS reaches 256 MiB or grows by 64 MiB from baseline. Its diagnostic prints the samples. This does not measure the Firefox decoder, WebGL driver or server.

## Desktop acceptance

| Check | Expected |
|---|---|
| AC-1 · Select a small MP3 with weak and strong kicks, enter, then listen across both. | Sound starts locally during the passage; a concrete hall, side light, booth and speaker banks are visible. Strong bass moves the cones more; unmeasured beats and silence do not pump. |
| AC-2 · Pause before analysis finishes, wait for Ready, then resume. | Elapsed time, passage, DJ, crowd and cones hold their frame. On resume dancers start at the doorway, not mid-floor. No track restart or skipped-beat catch-up. |
| AC-3 · Select a larger MP3; inspect stage labels; cancel. Rename a WAV to `.mp3` and try again. | Cover remains during the wait. Cancel returns to the poster without opening the picker. Invalid selections show actual bytes and the limit, with no POST in Network. |
| AC-4 · Make analysis fail or disconnect the API, enter the room, restore service and retry. Replace the track while a result is pending. | DJ only on failure; same elapsed time through retry. Replacement reveals the entrance again and old callbacks do not alter it. On a separate service-side check, confirm the retired job has no temporary audio. |
| AC-5 · Start from `npm ci`; run tests/build, start the documented services, open the URL above. | The full local path works without the pilot or an external PixiJS script. |

**Bounded browser memory spot check (attended, optional).** Use one disposable Firefox profile, one tab and one short MP3; record browser-process-tree memory before entry, after 15 seconds and after Leave. Repeat once only. Stop immediately for sustained growth above baseline of 256 MiB, less than 2 GiB available system RAM, new swapping, or UI stalls. Record browser version, track size and samples; do not escalate to larger files to investigate. Keep two-tab isolation and near-limit performance checks separate from this spot check. Audible alignment, perceived movement and Firefox/GPU memory require desktop observation.
