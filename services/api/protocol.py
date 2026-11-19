"""Public admission and internal wire validation."""
import json
import math
from pathlib import Path

from jsonschema import Draft202012Validator

LIMIT = 300_000_000
CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
WIRE = json.loads((CONTRACTS / "wire.schema.json").read_text())
WORKER = Draft202012Validator({"$defs": WIRE["$defs"], "$ref": "#/$defs/WorkerStatus"})
TIMELINE = Draft202012Validator(json.loads((CONTRACTS / "timeline.schema.json").read_text()))


class Problem(Exception):
    def __init__(self, status, code, message):
        self.status = status
        self.error = {"code": code, "message": message}


def check_count(count, limit=LIMIT):
    if count > limit:
        raise Problem(413, "too_large", f"{count} bytes exceeds the limit of {limit} bytes.")


def metadata(body):
    if (not isinstance(body, dict) or body.keys() != {"name", "size_bytes"}
            or not isinstance(body["name"], str) or type(body["size_bytes"]) is not int
            or body["size_bytes"] < 0):
        raise Problem(400, "invalid_request", "Expected a name and a nonnegative integer size_bytes.")
    size = body["size_bytes"]
    check_count(size)
    if not size or not body["name"].lower().endswith(".mp3"):
        raise Problem(415, "unsupported_audio", f"Expected an MP3 (received {size} bytes; limit {LIMIT}).")
    return size


def layer_three(file):
    file.seek(0)
    header = file.read(10)
    if header.startswith(b"ID3"):
        if len(header) < 10 or header[3] not in (2, 3, 4) or max(header[6:]) >= 128:
            return False
        size = 0
        for byte in header[6:]:
            size = (size << 7) + byte
        file.seek(10 + size + (10 if header[3] == 4 and header[5] & 16 else 0))
        header = file.read(4)
    return (len(header) >= 4 and header[0] == 255 and header[1] & 224 == 224
            and header[1] & 24 != 8 and header[1] & 6 == 2 and header[2] >> 4 != 15
            and header[2] & 12 != 12 and header[3] & 3 != 2)


def valid_timeline(value):
    if not TIMELINE.is_valid(value) or not math.isfinite(value["duration_s"]):
        return False
    last = -1
    for beat in value["beats"]:
        if not (last < beat["time_s"] < value["duration_s"] and 0 <= beat["low_energy"] <= 1):
            return False
        last = beat["time_s"]
    return True
