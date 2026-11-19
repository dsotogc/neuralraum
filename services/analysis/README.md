# Internal audio analyzer

From `services/analysis`, on Linux with CPython 3.12:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export NEURALRAUM_TEMP_DIR=/absolute/path/to/existing/private/shared-directory
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8001 --workers 1
```

The public API must use the same local directory under the same user. The analyzer never creates or removes shared files. Use a single server process: the registry is in memory; restart loses job IDs. See `../../contracts/README.md` for the HTTP routes and cleanup protocol.

## Signal and resource model

Two worker threads decode independent MP3s through libsndfile, **inside the lease-holding process**. Each holds a shared directory lock until its input closes. Active cancellation is cooperative at block boundaries; terminal status is published only after closing the directory descriptor. A queued cancellation can release immediately. DELETE before dispatch creates a tombstone. Terminal results expire on the first 15-second sweep after ten minutes.

Each pass decodes at native rate in roughly 1.28-second blocks; overlapping Hann windows span 40 ms, stepped every 10 ms. Broadband and bass spectral changes have independent causal thresholds. A transient opens a fixed 70 ms grouping window. If a bass attack joins it, the timestamp follows the strongest qualifying bass rise inside that window; the weight uses its peak local 30–150 Hz energy on a fixed full-scale reference. When groups compete within 160 ms, the one with higher bass weight retains its timestamp. Times use window centers on the gapless decoder sample clock. This attack-based approximation can miss legato beats and mark subdivisions; it does not invent pulses in quiet passages.

At most 32 jobs can be queued or running, including the two readers. Workers consume a FIFO keyed by job ID. Cancelling a queued job removes its work item immediately under the same lock that admits and dispatches jobs; its terminal status remains available for replays. Native numeric thread pools are limited to one thread each. Sample and spectrum buffers stay block-sized; timestamp lists and JSON result size grow with detected attacks. Progress counts decoded frames against the decoder's reported frame total and is capped below one until release. These bounds are not a long-set capacity measurement.

## Verification

From this directory, with FFmpeg (`libmp3lame`) available for encoding tiny deterministic test fixtures only:

```sh
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python -m unittest -v
```

Verified locally with Python 3.12.15: all six tests passed (0.670 s unittest time; 1.05 s elapsed, 152836 KiB peak RSS). Four-second encoded MP3 fixtures verify silence, weak/strong contrast, and 72 Hz kicks paired with 3.2 kHz transients. With leads of 0, 25, 45, 50, 60, 69, 71, 80, and 100 ms, maximum absolute kick timing error was 6.01 ms and all weights exceeded 0.75. The 250 ms kick with a 50 ms lead was timestamped at 249.43 ms. With both readers blocked, two batches of 30 jobs filled the queue, rejected overflow, and left zero pending work after cancellation. The next admitted job succeeded. These small tests do not establish real-track quality, maximum input capacity, or throughput.
