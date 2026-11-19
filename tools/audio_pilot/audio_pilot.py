"""Plot band energy, beats, onsets and optional Audacity labels on one timeline."""
import argparse
import math
from pathlib import Path


def read_labels(path, duration):
    rows = []
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        try:
            left, right, name = line.split("\t")
            start, end = float(left), float(right)
            name = name.strip().lower()
            if not (math.isfinite(start) and 0 <= start <= end <= duration + 0.1):
                raise ValueError("invalid times for this recording")
            if not ((name == "drop" and start == end) or
                    (name in {"groove", "buildup", "breakdown"} and start < end)):
                raise ValueError("expected a section interval or a drop point")
        except ValueError as exc:
            raise ValueError(f"{path}:{number}: {exc}") from exc
        rows.append((start, end, name))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--labels", type=Path)
    args = parser.parse_args()
    import librosa
    import matplotlib.pyplot as plt
    import numpy as np

    y, sr = librosa.load(args.audio, sr=22050, mono=True)
    hop, size = 512, 2048
    duration = len(y) / sr
    labels = read_labels(args.labels, duration) if args.labels else []
    power = np.abs(librosa.stft(y, n_fft=size, hop_length=hop)) ** 2
    freq = librosa.fft_frequencies(sr=sr, n_fft=size)
    times = librosa.frames_to_time(np.arange(power.shape[1]), sr=sr, hop_length=hop)
    fig, axes = plt.subplots(3, sharex=True, figsize=(15, 7), layout="constrained")
    for low, high in [(30, 200), (200, 2000), (2000, 10000)]:
        band = power[(freq >= low) & (freq < high)].sum(axis=0)
        axes[0].plot(times, 10 * np.log10(np.maximum(band, 1e-10)),
                     label=f"{low}–{high} Hz", linewidth=0.7)
    axes[0].legend()
    axes[0].set_ylabel("Band energy (dB)")
    strength = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    beats = librosa.beat.beat_track(onset_envelope=strength, sr=sr, hop_length=hop)[1]
    onsets = librosa.onset.onset_detect(onset_envelope=strength, sr=sr, hop_length=hop)
    for row, frames in enumerate([beats, onsets]):
        seconds = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
        axes[1].vlines(seconds, row - .3, row + .3, linewidth=.5)
    axes[1].set_yticks([0, 1], ["Beats", "Onsets"])
    names = ["groove", "buildup", "breakdown", "drop"]
    for start, end, name in labels:
        row = names.index(name)
        if name == "drop":
            axes[2].plot(start, row, "kd")
        else:
            axes[2].broken_barh([(start, end-start)], (row-.35, .7))
    axes[2].set_yticks(range(4), names)
    axes[2].set(xlabel="Seconds", xlim=(0, duration), ylim=(-.5, 3.5))
    fig.suptitle(args.audio.name)
    fig.savefig(args.output)
    plt.close(fig)


if __name__ == "__main__":
    main()
