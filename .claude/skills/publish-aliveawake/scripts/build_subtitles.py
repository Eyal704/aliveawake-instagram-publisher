#!/usr/bin/env python3
"""
Turn a word-timestamps JSON (from transcribe.py --word-timestamps) into a
styled .ass subtitle file, chunked into short readable phrases (not one word
at a time, not full sentences) based on natural pauses and punctuation.

Usage:
  python3 build_subtitles.py --words out.words.json --output subs.ass \
      [--font "Arial"] [--size 64] [--color FFFFFF] [--outline-color 000000] \
      [--max-words 6] [--max-gap 0.6] [--margin-v 120]

Then burn in with ffmpeg:
  ffmpeg -i in.mp4 -vf "ass=subs.ass" -c:a copy out.mp4

Once a style is approved by the user, reuse the same --font/--size/--color/
--outline-color/--margin-v values for every subsequent video so the look stays
consistent across the batch, per their standing instruction.
"""
import argparse
import json


def format_ass_timestamp(seconds: float) -> str:
    cs = int(round(seconds * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def chunk_words(words, max_words=6, max_gap=0.6):
    chunks = []
    current = []
    for i, w in enumerate(words):
        if current:
            gap = w["start"] - current[-1]["end"]
            ends_sentence = current[-1]["word"].strip().endswith((".", "?", "!"))
            if gap > max_gap or ends_sentence or len(current) >= max_words:
                chunks.append(current)
                current = []
        current.append(w)
    if current:
        chunks.append(current)
    return chunks


ASS_HEADER_TEMPLATE = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},&H00{color},&H000000FF,&H00{outline_color},&H00000000,1,0,0,0,100,100,0,0,1,{outline_width},0,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--words", required=True, help="Path to words.json from transcribe.py --word-timestamps")
    parser.add_argument("--output", required=True, help="Output .ass path")
    parser.add_argument("--font", default="Arial")
    parser.add_argument("--size", type=int, default=64)
    parser.add_argument("--color", default="FFFFFF", help="Text color, ASS BGR hex without #, e.g. FFFFFF = white")
    parser.add_argument("--outline-color", default="000000", help="Outline color, ASS BGR hex without #")
    parser.add_argument("--outline-width", type=float, default=3.5)
    parser.add_argument("--margin-v", type=int, default=120, help="Distance from bottom edge, in PlayResY units")
    parser.add_argument("--max-words", type=int, default=6, help="Max words per subtitle chunk")
    parser.add_argument("--max-gap", type=float, default=0.6, help="Seconds of silence between words that forces a new chunk")
    args = parser.parse_args()

    with open(args.words) as f:
        words = json.load(f)

    chunks = chunk_words(words, max_words=args.max_words, max_gap=args.max_gap)

    with open(args.output, "w") as f:
        f.write(ASS_HEADER_TEMPLATE.format(
            font=args.font, size=args.size, color=args.color,
            outline_color=args.outline_color, outline_width=args.outline_width,
            margin_v=args.margin_v,
        ))
        for chunk in chunks:
            start = format_ass_timestamp(chunk[0]["start"])
            end = format_ass_timestamp(chunk[-1]["end"])
            text = " ".join(w["word"] for w in chunk).strip()
            f.write(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n")

    print(f"[build_subtitles] Wrote {args.output} ({len(chunks)} cues)")


if __name__ == "__main__":
    main()
