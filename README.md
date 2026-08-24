# AliveAwake Instagram Publisher

Publishes a video (with caption + thumbnail) to the AliveAwake Instagram Business account via the Instagram Graph API.

## How it works

Instagram's API fetches the video itself from a URL you give it — it does not accept file uploads. So `VIDEO_URL` (and `COVER_URL`, if used) must be a plain public link with no login/auth wall, reachable by Meta's servers.

Flow: create a media container (`/media`) → poll until Instagram finishes processing the video (`status_code=FINISHED`) → publish it (`/media_publish`).

## Run it from GitHub Actions (recommended)

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add:
   - `IG_ACCESS_TOKEN` — the System User access token
   - `IG_BUSINESS_ACCOUNT_ID` — `17841462504499664`
2. Go to the **Actions** tab → **Publish to Instagram** workflow → **Run workflow**.
3. Fill in `video_url` (required), `caption`, and optionally `cover_url` or `thumb_offset_ms` for thumbnail selection.
4. Run it — logs show container creation, processing status polling, and the final publish confirmation.

## Run it locally

```bash
cp .env.example .env
# fill in .env
npm run publish
```

## Thumbnail selection

- **`THUMB_OFFSET`** (milliseconds) — Instagram grabs a frame from within the video itself at that timestamp. Simplest option, no extra hosting needed.
- **`COVER_URL`** — a separately designed thumbnail image (public URL). Takes priority over `THUMB_OFFSET` if both are set.
- Neither set — Instagram auto-selects a frame.

## Token lifetime

The token is a Meta **System User** access token — unlike a personal user token it does not expire after 60 days. If it's ever revoked/rotated, generate a new one in Business Settings → Users → System Users → (your system user) → Generate New Token, with permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`.
