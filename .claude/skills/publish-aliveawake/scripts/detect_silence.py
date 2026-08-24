#!/usr/bin/env python3
"""
Detect silent stretches in a video/audio file using ffmpeg's silencedetect filter.
Use this alongside the word-timestamps transcript to find dead-air trim points
without cutting into a word (cross-check a candidate silence window against
words.json before trimming).

Usage:
  python3 detect_silence.py --input video.mp4 [--noise -30dB] [--min-duration 0.5]

Prints JSON to stdout: [{"start": 1.23, "end": 2.01, "duration": 0.78}, ...]
"""
import argparse
import json
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--noise", default="-30dB", help="Silence threshold (default: -30dB)")
    parser.add_argument("--min-duration", type=float, default=0.5, help="Minimum silence duration in seconds (default: 0.5)")
    args = parser.parse_args()

    result = subprocess.run(
        [
            "ffmpeg", "-i", args.input,
            "-af", f"silencedetect=noise={args.noise}:d={args.min_duration}",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
    )

    stderr = result.stderr
    starts = [float(m) for m in re.findall(r"silence_start:\s*([\d.]+)", stderr)]
    ends_durations = re.findall(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", stderr)

    windows = []
    for i, start in enumerate(starts):
        if i < len(ends_durations):
            end, duration = ends_durations[i]
            windows.append({"start": round(start, 3), "end": round(float(end), 3), "duration": round(float(duration), 3)})

    print(json.dumps(windows, indent=2))


if __name__ == "__main__":
    main()
