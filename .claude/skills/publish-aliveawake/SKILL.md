---
name: publish-aliveawake
description: Edit and publish a video to the AliveAwake Instagram account — trimming clips, burning in text overlays, cutting in supporting photos/video, writing the caption, picking a thumbnail, and triggering the actual Instagram publish via the aliveawake-instagram-publisher GitHub repo. Use this whenever the user sends a raw video for AliveAwake's Instagram, asks to "post this to Instagram," "edit this reel," "make this into an Instagram video," or mentions AliveAwake's Instagram/reels/content in any editing-or-publishing context — even if they only ask for one piece (e.g. just a caption, or just the edit) rather than the full pipeline.
---

# Publish AliveAwake

Runs the full pipeline for one AliveAwake Instagram video: edit → caption → thumbnail → publish. The publish step calls a GitHub Actions workflow that's already built and credentialed — this skill's job is everything upstream of that, plus actually triggering it.

## Why this skill exists, and where its edges are

Instagram's Graph API does not accept file uploads. It fetches the video (and cover image, if used) from a URL you give it — so a local edited file is only useful once it's sitting at a plain, public URL Meta's servers can reach with no login wall. That's a real step every time, not a formality; don't skip straight to triggering the workflow with a local path.

Speech-to-text **is** available (see Transcription below) but it runs on CPU in a fresh cloud sandbox each session — nothing persists between sessions automatically, so the setup step below has to run each time before transcription works. Don't guess at caption/B-roll timing when a real transcript is one setup step away.

## Prerequisites already in place (don't re-set these up)

- Publishing repo: `github.com/Eyal704/aliveawake-instagram-publisher` — Node.js script + GitHub Actions `workflow_dispatch` workflow (`publish.yml`), using the Graph API v26.0. `IG_ACCESS_TOKEN` and `IG_BUSINESS_ACCOUNT_ID` are already stored as repo secrets — never ask the user for the token again or try to read/print it.
- Instagram Business Account ID: `17841462504499664`; Facebook Page ID: `299121263767927` (hardcoded in the workflow, not sensitive).
- Every publish posts to **both Instagram and the Facebook Page**, always — this was an explicit standing choice, not per-video. Don't make it conditional or ask each time.
- Location tagging is supported (`location_query` free-text, or an exact `location_id`) — offer it when the user mentions a place, but it's optional, not required per video.
- ffmpeg is pre-installed in this environment.

## Transcription (speech-to-text)

A bundled script (`scripts/transcribe.py`) does real transcription with timestamps: `yt-dlp` fetches video from a URL (e.g. a public Instagram link) if needed, `ffmpeg` strips it to 16kHz mono audio, and `faster-whisper` (a CPU-friendly Whisper implementation) transcribes it, auto-detecting language (handles English/Hebrew and others without being told which).

**This environment is a fresh cloud sandbox per session** — there's no persistent GPU and no guarantee the Python packages are already installed, unlike a local machine where tools stay installed once set up. Before the first transcription call in a session, check whether it's ready and install if not:

```bash
python3 -c "from faster_whisper import WhisperModel" 2>/dev/null || pip3 install --quiet faster-whisper yt-dlp
which yt-dlp >/dev/null 2>&1 || pip3 install --quiet yt-dlp
```

Then run it:

```bash
# From a local file (e.g. one the user sent in chat):
python3 scripts/transcribe.py --input /path/to/video.mp4 --output /tmp/transcript

# From a URL yt-dlp can fetch (e.g. a public Instagram reel link):
python3 scripts/transcribe.py --url "https://www.instagram.com/reel/XXXX/" --output /tmp/transcript
```

This writes `<output>.txt` (plain text) and `<output>.srt` (timestamped) — read the `.srt` when you need real timestamps for placing text overlays or supporting visuals against specific spoken lines. `--model` defaults to `small` (good speed/accuracy balance on CPU); use `tiny`/`base` for a faster rough pass, or `medium`/`large-v3` when accuracy matters more than speed and the user can wait longer — CPU transcription is noticeably slower than the GPU-accelerated version this pipeline apparently ran elsewhere, so set expectations on timing for longer clips (many minutes for `medium`/`large-v3` on a several-minute video).

With a real transcript in hand, matching captions or B-roll to "where he mentions the price" becomes a normal text-search-plus-timestamp-lookup task instead of a guess — use it whenever the user's request implies knowing what's said and when, rather than asking them to hand-time everything.

If the workflow run ever fails with an auth error, that means the token was rotated/revoked — tell the user to regenerate it in Meta Business Settings → Users → System Users → (their system user) → Generate New Token, with permissions `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`, and update the `IG_ACCESS_TOKEN` repo secret. Don't try to work around a dead token by other means.

## Workflow

This is the user's standing daily process for a batch of raw clips — follow it by default without re-asking each time; only check in for the specific decisions it calls out (combine calls, and the review checkpoint) or when something in a given batch doesn't fit the pattern.

### 1. Get the batch

Videos arrive either sent directly in chat that day, or (when the user is traveling) dropped into a Google Drive folder — ask which, if it's not obvious, and for Drive pull the newest unprocessed clips via the Drive connector (`mcp__Google_Drive__*`: `list_recent_files`/`search_files` to find them, `download_file_content` to fetch). Process each video in the batch through the steps below.

### 2. Transcribe every clip with word-level timestamps

For each raw clip:
```bash
python3 scripts/transcribe.py --input <clip>.mp4 --output <clip> --word-timestamps
```
(Run the setup check from the Transcription section above first if the packages aren't installed yet this session.) This gives `<clip>.words.json` — exact start/end per word — which everything else in this pipeline keys off of: trim points, overlay timing, subtitle cues, and the combine decision below all use it instead of guesses.

### 3. Decide: keep separate, or combine

Default is to treat every clip as its own video. Only combine two *adjacent* clips in the batch when both hold:
- **Content clearly continues** — the first clip's transcript ends mid-thought (no terminal punctuation, trails off grammatically) and the second's opening picks that same thought back up. Read both transcripts to judge this; don't combine just because they're topically similar.
- **Combined duration stays under 1:31** — check actual clip lengths (`ffprobe -v error -show_entries format=duration -of csv=p=0 <clip>.mp4`) before deciding, not an estimate.

When you do combine, say so plainly at the review step ("clips 3 and 4 read as one continuous sentence, combined into a single 78s video — flag it if that's wrong") rather than silently merging — this is exactly the kind of call that's cheap to get wrong and annoying to unwind after the rest of the edit is built on it.

### 4. Edit each resulting video

For each video (combined or standalone):

**Trim dead air**, cross-checked against the transcript so a cut never lands inside a word:
```bash
python3 scripts/detect_silence.py --input <clip>.mp4 --min-duration 0.5
```
This lists silence windows; compare against `<clip>.words.json` to confirm a candidate trim doesn't clip the tail/head of an adjacent word, then cut with the trim/re-encode commands under "Edit with ffmpeg" below. Not every detected silence needs trimming — a natural breath or pause reads fine; trim the ones that drag.

**Insert supporting images/video overlays at the exact word/phrase timestamp** the user specifies (or that you judge fits, watching frames), using `<clip>.words.json` to find the precise second rather than eyeballing it — then the split-and-concat approach under "Edit with ffmpeg" below.

**Color-adjust if needed** — extract a frame grab, look at it, and only then decide brightness/contrast/saturation correction is warranted:
```bash
ffmpeg -i in.mp4 -vf "eq=brightness=0.05:contrast=1.1:saturation=1.15" -c:a copy out.mp4
```
Don't run this blind on every clip — check first whether it's actually needed.

**Burn in subtitles** using the words.json from step 2:
```bash
python3 scripts/build_subtitles.py --words <clip>.words.json --output <clip>.ass
ffmpeg -i <clip>.mp4 -vf "ass=<clip>.ass" -c:a copy <clip>_subtitled.mp4
```
The first video in a batch (or the first ever run) is where the subtitle look gets decided — propose the script's defaults (white text, black outline, bottom-third position) and show it. Once the user approves a look, reuse those exact `--font`/`--size`/`--color`/`--outline-color`/`--margin-v` values for every other video in the batch and in future batches, per their standing instruction that the style repeats — don't quietly redesign it clip to clip.

### 5. Review checkpoint

Show the user each edited video before going further — this is where they catch a trim that's off, an overlay in the wrong spot, or a subtitle style tweak. Iterate on their feedback before treating any clip as final. Only once a video is approved does it move on to captioning/thumbnail/publish below.

### Reference: ffmpeg commands (used by step 4 above)

Work in a scratch directory, keep intermediate files until the user approves the final cut.

**Trim to a range:**
```bash
ffmpeg -i in.mp4 -ss <start> -to <end> -c copy trimmed.mp4
```
`-c copy` is fast (no re-encode) but only cuts cleanly on keyframes, so the trim points can be slightly off. If the user needs frame-accurate trims, drop `-c copy` and let it re-encode:
```bash
ffmpeg -i in.mp4 -ss <start> -to <end> -c:v libx264 -c:a aac trimmed.mp4
```

**Burn in a text overlay for a specific time window:**
```bash
ffmpeg -i in.mp4 -vf "drawtext=text='Your Text Here':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=h-200:enable='between(t,<start_sec>,<end_sec>)'" -c:a copy out.mp4
```
Chain multiple `drawtext` filters (comma-separated in `-vf`) for multiple overlays at different times. Pick font size/position/color to be legible over real footage — check a frame with `ffmpeg -ss <t> -i out.mp4 -frames:v 1 preview.jpg` and look at it before calling it done.

**Cut in a supporting photo or clip at a specific point:**
This is a three-way split-and-concat: the original video up to the insert point, the supporting media (photo held for N seconds, or the clip as-is), then the original video continuing after. Photos need to become short video segments first:
```bash
ffmpeg -loop 1 -i photo.jpg -t 3 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -r 30 -c:v libx264 -pix_fmt yuv420p photo_segment.mp4
```
Then normalize all segments to matching codec/resolution/fps and concatenate with the concat demuxer (build a `filelist.txt` with `file 'segment1.mp4'` lines, then `ffmpeg -f concat -safe 0 -i filelist.txt -c copy final.mp4`). Mismatched resolution/fps/codec between segments is the most common concat failure — normalize first if concat errors out or the result looks wrong.

**Reels format:** if the user wants standard Reels framing and the source isn't already 9:16, use the scale+pad approach above (1080x1920) rather than a hard crop, unless they specifically want cropped-not-padded.

Show the user the result (send the file, or a frame grab plus a description of the edit) before moving on — this is the point where corrections are cheap.

### 6. Get the final video to a public URL

There's no standing public host set up for this — don't assume one exists. Ask the user how they want to get the edited file to a public URL this run (unless they've already told you a standing preference to reuse, e.g. "always use my S3 bucket," in which case use that). Common options to offer: they already have somewhere they host clips (a website, Cloudinary, S3); or set up Vercel Blob storage for this (they're connected to Vercel via MCP — this is plain object storage, not a deploy, so no build step involved despite the word "Vercel"). If they want Vercel Blob and it's not set up yet, that's a one-time setup (create a Blob store in the Vercel dashboard, get a read/write token) — walk them through it rather than assuming it exists.

Do not attempt to publish with a local file path as `video_url` — the workflow will fail because Meta's servers can't fetch it.

### 7. Caption and thumbnail

Write a caption draft and show it to the user for approval before publishing — don't publish on a caption they haven't seen. AliveAwake's voice/tone: ask the user if unsure, or infer from past captions if you have access to them.

For the thumbnail, pick one of:
- `thumb_offset_ms` — a millisecond offset into the video; Instagram grabs that frame itself. Default reasonable choice if the user has no preference: somewhere in the first 2-3 seconds where the frame reads clearly (check a few candidate frames with the `ffmpeg -ss ... -frames:v 1` trick above rather than guessing blind).
- `cover_url` — a separately designed thumbnail image, if the user has one, hosted at a public URL (same hosting-step requirement as the video).

### 8. Scheduling the publish — the current, correct system (read this before anything else in this section)

**As of 2026-08-27, every post goes through a durable scheduling queue, not a one-shot workflow trigger.** The three-tier "trigger the publish" mechanism further below is legacy — it fires *immediately*, has no retry/verification, and should only be used for a genuine right-now publish with no scheduled time. If the user wants a post to go out at a specific future time (the normal case), use this section instead. If you started reading this skill because you "don't have the ability to schedule a post," that's not a real limitation — it means you haven't read this section yet.

**Live dashboard (always check this first):** https://eyal704.github.io/aliveawake-instagram-publisher/ — shows every currently scheduled/published post and the platform-cadence in effect. **Never assume the next chronological slot is empty or guess what's already queued — read `docs/schedule.json` in full first.** A whole day being empty, or a slot you'd expect to be taken being open, has happened more than once; verify, don't assume.

**Current cadence (Europe/Vienna):** 3 Reels/day at **10:00, 15:00, 20:00** through Friday 28 Aug 2026. From **Saturday 29 Aug 2026**: 4 Reels/day at **09:00, 13:00, 17:00, 21:00**. This is documented in `docs/schedule.json`'s `cadence`/`cadenceNote`/`upcomingCadence` fields — check there for the current source of truth rather than trusting this static doc if it's been a while.

**The architecture:**
- `docs/schedule.json` (public, in this repo) — one entry per scheduled post: `id`, `scheduledAt` (ISO with Vienna offset), `title`, `captionMatch` (a unique prefix of the real caption, used for duplicate-detection — must actually match the real caption's start, normalized), `instagram: {status, ...}`, `facebook: {status, videoId, scheduledPostId, ...}`.
- `ALIVEAWAKE_QUEUE_JSON` (a **write-only GitHub Actions secret**) — the actual private data: one array of `{id, videoUrl, coverUrl, caption}` objects, one per post, keyed by the *same* `id` used in `schedule.json`. This is where the real video URL and full caption live; `schedule.json` never contains them.
- Two GitHub Actions workflows do the actual work, woken every 5 minutes by an external Cloudflare Worker (`aliveawake-cron-kicker`, **do not remove or "fix" this** — GitHub's own built-in `schedule:` cron trigger for these workflows is independently known to be unreliable, sometimes not firing for 90+ minutes; the Worker is the actual fix for that, calling `workflow_dispatch` on both workflows every 5 min):
  - `process-due-instagram.yml` — builds the Instagram container from the private queue entry within 6 hours of the due time, and publishes it at the due time.
  - `verify-dashboard.yml` — independently re-verifies both platforms' real state every ~5 min and sends a Telegram alert if a post is more than 15 minutes overdue and still not live anywhere.
- Facebook is scheduled **natively** via Meta's own scheduler (`FACEBOOK_CREATE_VIDEO_POST`-style upload with `published=false` + `scheduled_publish_time`, or `FACEBOOK_RESCHEDULE_POST` to move an existing one) — it does not depend on any of this repo's cron infrastructure, and has been reliable all along.

**To add a new post to the schedule:**
1. Get the video to a public URL (same rule as always — Meta's servers must be able to fetch it with no login wall).
2. Pick a genuinely open slot — read `docs/schedule.json` first, don't assume.
3. Upload/schedule the Facebook side natively (via Composio's `FACEBOOK_CREATE_VIDEO_POST` or equivalent, with the target Vienna time converted to a UTC epoch), and note the resulting `videoId`/`scheduledPostId`.
4. Add a new entry to `docs/schedule.json` with a unique `id` (convention so far: `YYYY-MM-DD-HHMM-short-slug` for the *original* intended date — if a post later gets rescheduled, only change `scheduledAt`, never the `id`; see the write-only-secret warning below for why).
5. Add the matching private entry to `ALIVEAWAKE_QUEUE_JSON` — **read the critical warning immediately below before doing this.**

**Critical warning — `ALIVEAWAKE_QUEUE_JSON` is write-only, permanently, for everyone:** GitHub Actions secrets cannot be read back once set — not by you, not by another AI session, not by the repo owner via the GitHub UI, ever. This secret holds a single JSON array covering *every* currently-queued post's private data. If you call `gh secret set ALIVEAWAKE_QUEUE_JSON` with anything less than the complete, correct current array plus your new entry, **you silently and irrecoverably delete every other post's video URL and caption, with no error and no way to detect or undo it** — the next automated container-build for those posts will fail with "private queue payload is missing."

Because of this:
- **Never** write to this secret unless you have the verified, complete current array in hand — e.g., you personally set every entry currently in it earlier in *this same session*, and you're appending to your own known-correct copy.
- If you don't have that (e.g., a fresh session, or you don't know what a prior session put there), **stop and ask the user** rather than guessing, reconstructing from `schedule.json` alone (it doesn't contain the private fields), or assuming "it's probably just these few posts." A wrong guess is worse than asking.
- Whenever you *do* set this secret, keep your own local copy of exactly what you wrote (a scratch file, or state it plainly in your response) — there is no other way for a future session (yours or another agent's) to recover it later. This project does not currently have a safer alternative to this write-only secret; treat every write as effectively permanent and irreversible for whoever comes after you.

**Verify a secret write instead of trusting it.** `.github/workflows/check-queue-integrity.yml` runs inside CI — the only place a write-only secret can be read — and compares the private queue against every unpublished row in `docs/schedule.json`, printing `OK` / `MISSING` / `INCOMPLETE` per post plus every stored id (ids and booleans only, never secret values). It runs twice daily and on demand:

```bash
gh workflow run check-queue-integrity.yml --repo Eyal704/aliveawake-instagram-publisher --ref main
```

Run it immediately after any write to a queue secret. It is the only way to see what the secret now contains, and it catches a missing or wrong-caption payload hours ahead instead of at the slot. **But a green run is necessary, not sufficient** — it proves the payload exists, not that the publisher can consume it. On 2026-08-27 a post passed the checker while its publisher would still have failed every run, because of the redaction bug below.

**The Composio CLI id-redaction trap — the single worst gotcha here (verified 2026-08-27):** the CLI silently replaces every id-shaped field in its JSON output with the literal string `"<REDACTED>"` whenever it sees `CI=true`. GitHub Actions sets `CI=true` on every job by default. Undocumented — found by decompiling the CLI (`CI_REDACTION_ENABLED` derives from `CI`) and confirmed by reproducing it locally.

It is destructive because `<REDACTED>` is *non-empty*, so it sails past `// empty` and `-z` guards. You never get a clean error — you get a comparison that can never match, or a real API call made with a garbage id:

- `container_id=$(jq -r '.data.id // empty')` becomes `<REDACTED>`, passes the guard, then every status check on it fails forever while each run still creates a real orphaned container.
- A Facebook preflight matching on video id never matches, so the workflow aborts before publishing even though everything is fine. This silently blocked the Instagram half of two slots on 2026-08-26.

**Every workflow calling Composio must set `CI: "false"` in its job `env:`.** All five current ones do (`process-due-instagram`, `verify-dashboard`, `publish-instagram-via-composio`, `update-analytics`, `publish-creator-of-suffering`). Add it when you create a new one, not after it fails. If an id comparison works locally but never matches in CI, check this before hunting a logic bug — and never "fix" it by loosening the comparison, which hides the bug and removes a real safety check.

**Isolated single-post queues.** Because adding to the shared array means rewriting it wholesale, a single post can instead get its own dedicated secret and its own self-contained workflow, with its `schedule.json` status set to something the shared poller ignores (`queued_isolated` rather than `queued_cloud`), and the workflow deleting its own secret after a verified publish. Nothing else can be corrupted. If you use this: the shared poller will never touch that post, so its dedicated workflow owns everything — its own trigger, `CI: "false"`, duplicate check, and verification — and it must be added to the integrity checker or the post becomes invisible to validation.

**Report status honestly:** `registered` → `prepared` → `scheduled` → `published` → `independently verified`. A green run, a built container, or a dashboard row reading "scheduled" is none of those. "Processed N posts" in the poller log usually means it found nothing due. As of 2026-08-27 15:01 Vienna the queue has published unattended exactly once (run `33074655218`); every prior Instagram publication in this project was done manually after automation failed. Posts land 0–5 minutes after their slot because the poller wakes every five minutes — that latency is by design, not a fault.

### 9. Trigger an immediate one-shot publish (only when the user explicitly wants it live *right now*, not scheduled)

Confirm with the user before triggering — this is a real, visible action (it posts to a live Instagram account **and** the Facebook Page), not a reversible draft. Show them the final caption, which thumbnail approach, the video URL you're about to submit, and the location tag if one's being applied.

**How triggering actually works here — three tiers, in order, because the first two are known to fail in most sessions:**

1. **Try the API trigger first** (cheap to attempt, sometimes works if a session's GitHub integration happens to have broader scope):
   ```
   mcp__github__actions_run_trigger
     method: "run_workflow"
     owner: "Eyal704"
     repo: "aliveawake-instagram-publisher"
     workflow_id: "publish.yml"
     ref: "main"
     inputs: { video_url, caption, cover_url, thumb_offset_ms, media_type, location_query, location_id, trial_graduation_strategy }
   ```
   As of the last real test, this reliably fails with `403 Resource not accessible by integration` — the GitHub connection available in these sessions can push commits but isn't granted `Actions: write`. Don't spend more than one attempt confirming this before moving on.

2. **Try the push-triggered fallback**: commit `trigger/run.json` in the repo (same shape as the `inputs` object above) and push — the workflow also fires on a push touching that path (see `.github/workflows/publish.yml`). As of the last real test, **this also got blocked** — not by GitHub, but by this environment's own auto-mode safety classifier, which recognized that this specific push is the mechanism that fires a live post and held it back even after explicit user go-ahead. If it's blocked, don't retry the same push or hunt for a workaround — that's a deliberate guardrail on a consequential action, not a bug to route around. Say so and move to the manual path.

3. **Manual fallback (currently the reliable path):** walk the user through **https://github.com/Eyal704/aliveawake-instagram-publisher/actions/workflows/publish.yml → Run workflow**, giving them every field value to paste in explicitly. **Read every field back to them before they submit** — a blank `trial_graduation_strategy` field silently changes the run from "Trial Reel, non-followers only" to "normal public post to everyone," which happened once already and required a manual delete afterward. Don't assume they'll notice a field is empty; say the value (or "leave blank") for each one.

After triggering (by whichever tier worked), use `mcp__github__actions_list` (`list_workflow_runs`, filtered to this workflow) to find the run, then `mcp__github__actions_get` (`get_workflow_run` / `get_workflow_job`) to check whether it succeeded or failed. If a step's conclusion is `failure`, pull the actual error with `mcp__github__get_job_logs` (`return_content: true`) rather than guessing from the run status alone — report the outcome back to the user either way, including the run URL if it failed, so they (or a future you) can read the logs directly. Video processing can take a couple of minutes; if the run is still in progress, say so rather than assuming success.

**If Instagram succeeds but Facebook fails** with `(#100) No permission to publish the video`: this was the exact failure on the first real run here, and the fix was confirmed working — the System User needs a role on the Facebook Page itself (Business Settings → Accounts → **Pages** → the AliveAwake Page → Assign people → add `instagram-publisher`), separate from the App-role assignment. This is already done for this workspace as of the last real run (verified via `GET /me/accounts?fields=name,tasks` showing `CREATE_CONTENT` in the token's tasks for the Page) — don't redo it, but this is the fix if it ever regresses (e.g., token regenerated, Page re-created).

**Deleting a post:** Instagram's Graph API does support `DELETE /{ig-media-id}` (requires the `instagram_manage_contents` permission), but the current token doesn't have that scope — checking the permission box in Business Settings does *not* retroactively add it to an already-issued token; a new token would need to be generated with it included. Until that's done, deletion is manual: open the post in the Instagram app → ⋯ → Delete. Don't tell the user a post is deleted unless you actually deleted it via a working API call — confirm the mechanism before claiming success.

The run publishes to Instagram and Facebook as two separate calls — check the logs for both outcomes rather than assuming one succeeding means the other did. If the Facebook step fails with a permission error, the likely cause is the System User not yet being assigned a role on the Facebook Page itself in Business Settings → Accounts → Pages (separate from the app-role assignment done for Instagram) — see the repo's README for the exact fix.
