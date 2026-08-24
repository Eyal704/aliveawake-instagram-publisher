#!/usr/bin/env python3
"""
Transcribe a video/audio file (local path or a URL yt-dlp can fetch, e.g. an
Instagram link) to text with timestamps. Auto-detects language.

Usage:
  python3 transcribe.py --input path/to/video.mp4 --output out
  python3 transcribe.py --url https://www.instagram.com/reel/XXXX/ --output out

Writes out.txt (plain text) and out.srt (timestamped) next to --output prefix.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


def fetch_via_ytdlp(url: str, dest: Path) -> Path:
    out_template = str(dest / "source.%(ext)s")
    subprocess.run(
        ["yt-dlp", "-o", out_template, url],
        check=True,
    )
    matches = list(dest.glob("source.*"))
    if not matches:
        print("[transcribe] yt-dlp did not produce an output file", file=sys.stderr)
        sys.exit(1)
    return matches[0]


def extract_audio(video_path: Path, dest: Path) -> Path:
    audio_path = dest / "audio.wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(video_path),
            "-ar", "16000", "-ac", "1", "-vn",
            str(audio_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return audio_path


def format_srt_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", help="Local video/audio file path")
    source.add_argument("--url", help="URL yt-dlp can fetch (e.g. an Instagram reel link)")
    parser.add_argument("--output", required=True, help="Output path prefix (writes <prefix>.txt and <prefix>.srt)")
    parser.add_argument("--model", default="small", help="Whisper model size: tiny/base/small/medium/large-v3 (default: small)")
    parser.add_argument("--language", default=None, help="Force a language code (e.g. 'en', 'he'); default auto-detects")
    parser.add_argument("--word-timestamps", action="store_true", help="Also write <output>.words.json with per-word start/end times (needed for exact overlay/cut placement)")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)

        if args.url:
            print(f"[transcribe] Fetching {args.url} via yt-dlp...")
            video_path = fetch_via_ytdlp(args.url, tmp_path)
        else:
            video_path = Path(args.input)
            if not video_path.exists():
                print(f"[transcribe] Input file not found: {video_path}", file=sys.stderr)
                sys.exit(1)

        print("[transcribe] Extracting audio...")
        audio_path = extract_audio(video_path, tmp_path)

        print(f"[transcribe] Loading Whisper model ({args.model})...")
        model = WhisperModel(args.model, device="cpu", compute_type="int8")

        print("[transcribe] Transcribing...")
        segments, info = model.transcribe(
            str(audio_path), language=args.language, word_timestamps=args.word_timestamps
        )
        segments = list(segments)
        print(f"[transcribe] Detected language: {info.language} (p={info.language_probability:.2f})")

    out_prefix = Path(args.output)
    out_prefix.parent.mkdir(parents=True, exist_ok=True)

    with open(f"{out_prefix}.txt", "w") as f:
        for seg in segments:
            f.write(seg.text.strip() + "\n")

    with open(f"{out_prefix}.srt", "w") as f:
        for i, seg in enumerate(segments, start=1):
            f.write(f"{i}\n")
            f.write(f"{format_srt_timestamp(seg.start)} --> {format_srt_timestamp(seg.end)}\n")
            f.write(seg.text.strip() + "\n\n")

    print(f"[transcribe] Wrote {out_prefix}.txt and {out_prefix}.srt")

    if args.word_timestamps:
        import json
        words = []
        for seg in segments:
            if seg.words:
                for w in seg.words:
                    words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
        with open(f"{out_prefix}.words.json", "w") as f:
            json.dump(words, f, indent=2, ensure_ascii=False)
        print(f"[transcribe] Wrote {out_prefix}.words.json ({len(words)} words)")


if __name__ == "__main__":
    main()
