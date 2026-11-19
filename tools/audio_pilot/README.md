# Audio analysis pilot

Compare what you hear with what librosa measures. The plot aligns three
frequency bands, estimated beats and onsets, and your own annotations in
seconds from the start of the recording.

## Setup

Tested with Python 3.14. From the repository root:

```sh
python -m venv ~/.venvs/neuralraum-audio
source ~/.venvs/neuralraum-audio/bin/activate
python -m pip install -r tools/audio_pilot/requirements.txt
```

## Analyze a track

```sh
python tools/audio_pilot/audio_pilot.py \
  "/path/to/track.mp3" "/path/to/plot.png" \
  --labels "/path/to/audacity-labels.txt"
```

The second argument is the output image; its directory must already exist.
Omit `--labels` to inspect the audio before annotation.

In Audacity, label the same recording and export labels in standard text
format (start seconds, end seconds, label; tab-separated). Use `groove`,
`buildup` or `breakdown` for intervals and `drop` for a point whose start
and end are identical. Leave uncertain passages unlabeled. The bottom
panel displays these annotations, not model predictions.
