"""One-pass, sample-clock pulse detection. No model or synthetic beat grid."""
import math
from threading import Event

import librosa
import numpy as np
import soundfile as sf


class Cancelled(Exception):
    pass


class SequentialReader(sf.SoundFile):
    def seekable(self):
        # SoundFile otherwise seeks the MP3 decoder after every block to sync
        # read/write cursors. Seeking can disrupt the MPEG bit reservoir.
        return False


def analyze(file, stop: Event, progress):
    # libsndfile decodes gapless MP3 metadata and never opens a second path.
    with SequentialReader(file.fileno(), closefd=False) as audio:
        if audio.subtype != "MPEG_LAYER_III" or not audio.frames:
            raise ValueError("Not a playable MP3")
        rate = audio.samplerate
        hop = max(1, round(rate * 0.01))
        width = 4 * hop
        window = np.hanning(width).astype("float32")
        hz = np.fft.rfftfreq(width, 1 / rate)
        bass = (hz >= 30) & (hz <= 150)
        prev = np.zeros(len(hz))
        # Left pad to put the first window center exactly at sample zero.
        tail = np.zeros(width // 2, dtype="float32")
        count = center = 0
        baseline = bass_baseline = 0.
        candidate = None
        beats = []

        def finish_candidate():
            # Competing attacks within a single pulse: prefer the one with
            # stronger measured bass. Never move a kick to an earlier hi-hat.
            if not beats or candidate["time_s"] - beats[-1]["time_s"] >= 0.16:
                beats.append(candidate)
            elif candidate["low_energy"] > beats[-1]["low_energy"]:
                beats[-1] = candidate

        while True:
            if stop.is_set():
                raise Cancelled
            block = audio.read(128 * hop, dtype="float32", always_2d=True)
            eof = not len(block)
            count += len(block)
            samples = np.concatenate((tail, np.zeros(width // 2, "float32")
                                      if eof else block.mean(axis=1)))
            if len(samples) >= width:
                frames = librosa.util.frame(samples, frame_length=width, hop_length=hop).T
                mags = np.abs(np.fft.rfft(frames * window)) / window.sum()
                for mag in mags:
                    if center >= count:
                        break
                    # Positive spectral change against a short causal background.
                    change = np.maximum(mag - prev, 0)
                    flux = np.linalg.norm(change)
                    bass_flux = np.linalg.norm(change[bass])
                    low = math.sqrt(2 * np.dot(mag[bass], mag[bass]) / 1.5)
                    t = center / rate
                    if candidate and t - opened > 0.07:
                        finish_candidate()
                        candidate = None
                    if candidate is None and (flux > max(0.0015, 2.4 * baseline)
                            or bass_flux > max(0.0015, 2.4 * bass_baseline)):
                        candidate = {"time_s": t, "low_energy": 0.}
                        opened = t
                        peak_bass_flux = 0.
                    if candidate:
                        # The grouping window starts at the first transient, but
                        # a weighted pulse belongs on the steepest bass attack.
                        if bass_flux > max(0.0015, 2.4 * bass_baseline, peak_bass_flux):
                            peak_bass_flux = bass_flux
                            candidate["time_s"] = t
                        # Fixed full-scale calibration preserves quiet/loud contrast.
                        energy = min(1., max(0., (low - 0.002) / 0.32))
                        candidate["low_energy"] = max(candidate["low_energy"], energy)
                    baseline = 0.93 * baseline + 0.07 * flux
                    bass_baseline = 0.93 * bass_baseline + 0.07 * bass_flux
                    prev = mag
                    center += hop
                tail = samples[len(frames) * hop:].copy()
            else:
                tail = samples
            if eof:
                break
            progress(min(0.999, count / audio.frames))
        if not count:
            raise ValueError("Empty decoded stream")
        if candidate:
            finish_candidate()
        return {"version": 1, "duration_s": count / rate, "beats": beats}
