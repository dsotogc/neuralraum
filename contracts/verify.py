"""Run with: uv run --no-project --with jsonschema python contracts/verify.py"""
from bisect import bisect_right
import json
from math import isclose, isfinite
from pathlib import Path

from jsonschema import Draft202012Validator as Validator

ROOT = Path(__file__).resolve().parent


def load(name):
    return json.loads((ROOT / name).read_text())


wire = load("wire.schema.json")
timeline = load("timeline.schema.json")
for schema in (wire, timeline):
    Validator.check_schema(schema)


def shape(name):
    return Validator({"$ref": f"#/$defs/{name}", "$defs": wire["$defs"]})


def valid_track(obj):
    if not Validator(timeline).is_valid(obj):
        return False
    times = [b["time_s"] for b in obj["beats"]]
    return isfinite(obj["duration_s"]) and all(a < b for a, b in zip(times, times[1:])) and all(
        t < obj["duration_s"] for t in times
    )


cases = load("fixtures/lifecycle.json")
for name, values in [
    ("Create", [cases["create"]]), ("Status", [*cases["public"], cases["failed"]]),
    ("WorkerStatus", cases["workerCancel"]), ("ErrorResponse", [cases["rejected"]]),
]:
    for value in values:
        shape(name).validate(value)
        Validator(wire).validate(value)
        if name == "Status":
            assert value["upload_received_bytes"] <= value["size_bytes"]
            if value["state"] in ("queued", "analyzing", "succeeded"):
                assert value["upload_received_bytes"] == value["size_bytes"]

for terminal in (cases["public"][-1], cases["failed"]):
    sequence = [*cases["public"][:-1], terminal]
    assert len({s["id"] for s in sequence}) == 1, "attempt changed ID"
    assert {s["size_bytes"] for s in sequence} == {cases["create"]["size_bytes"]}, "attempt changed declared size"
    received = [s["upload_received_bytes"] for s in sequence]
    assert received == sorted(received), "upload progress regressed"
    assert received[-1] == cases["create"]["size_bytes"], "DSP terminal before complete upload"

bad = load("fixtures/invalid.json")
assert all(not shape("Create").is_valid(bad[k]) for k in ("oversized", "unsupported"))
assert not shape("WorkerStatus").is_valid(bad["prematureRelease"])
assert all(not valid_track(bad[k]) for k in ("unsorted", "atEnd", "unscaled"))
pulse, silence = (load(f"fixtures/{name}.json") for name in ("pulse", "silence"))
assert valid_track(pulse) and valid_track(silence)


def displacement(obj, t):
    beats = obj["beats"]
    i = bisect_right([b["time_s"] for b in beats], t) - 1
    if i < 0 or t >= obj["duration_s"]:
        return 0
    beat = beats[i]
    return beat["low_energy"] * max(0, 1 - (t - beat["time_s"]) / 0.16)


for t, expected in [(0.1, 0), (0.5, 0), (1.04, 0.075), (3.04, 0.675), (3.25, 0)]:
    assert isclose(displacement(pulse, t), expected)
    assert displacement(silence, t) == 0
print("Fixtures pass; late join at 3.04 s: beat 3.00 s, displacement 0.675.")
