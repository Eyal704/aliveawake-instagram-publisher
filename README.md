# AliveAwake Instagram Publisher

Publishes a video (with caption, thumbnail, and optional location tag) to the AliveAwake Instagram Business account **and** the linked Facebook Page, via the Graph API.

## How it works

The Graph API fetches the video itself from a URL you give it — it does not accept file uploads. So `VIDEO_URL` (and `COVER_URL`, if used) must be a plain public link with no login/auth wall, reachable by Meta's servers.

Flow: (optional) resolve a location name to a Place ID → create an Instagram media container (`/media`) → poll until Instagram finishes processing the video (`status_code=FINISHED`) → publish it (`/media_publish`) → separately publish the same video to the Facebook Page (`/{page-id}/videos`). Instagram and Facebook are independent publish calls — a Facebook failure is reported on its own and doesn't retroactively hide a successful Instagram publish that already happened.

## Run it from GitHub Actions (recommended)

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add:
   - `IG_ACCESS_TOKEN` — the System User access token
   - `IG_BUSINESS_ACCOUNT_ID` — `17841462504499664`

   (`FB_PAGE_ID` is not a secret — it's hardcoded in the workflow as `299121263767927`, AliveAwake's Facebook Page ID, since it isn't sensitive.)

2. **One-time check:** the System User needs to be an assigned admin/task-holder on the Facebook Page itself (separate from the app-role assignment done for Instagram) for the Facebook publish call to succeed. In Business Settings → **Accounts → Pages** → the AliveAwake Page → **Assign people** → assign the `instagram-publisher` System User a role there. If the first run's Facebook publish step fails with a permission error, this is the first thing to check.
3. Go to the **Actions** tab → **Publish to Instagram** workflow → **Run workflow**.
4. Fill in `video_url` (required), `caption`, optionally `cover_url`/`thumb_offset_ms` for the thumbnail, and optionally `location_query` (e.g. "Tel Aviv, Israel") or an exact `location_id` for a location tag.
5. Run it — logs show the location lookup (if used), Instagram container creation and processing status, the Instagram publish confirmation, and then the Facebook publish confirmation.

For recovery after one platform already succeeded, set `publish_target` to `INSTAGRAM` or `FACEBOOK`. This prevents duplicate posts. Facebook publishing resolves and uses the Page access token returned by `/me/accounts`; the System User token remains the stored root credential.

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

## Location tagging

- **`LOCATION_QUERY`** — a free-text place name (e.g. "Tel Aviv, Israel"); the script looks up the top match via the Graph API's place search and uses its Page ID. If nothing matches, publishing proceeds without a location tag rather than failing the whole run.
- **`LOCATION_ID`** — an exact Facebook Place ID, if you already know it. Skips the lookup and takes priority over `LOCATION_QUERY`.
- The resolved location is applied to both the Instagram post and the Facebook video post.
- Location tagging on Facebook video posts specifically hasn't been confirmed against a live post yet — if `place` is silently ignored there, Instagram's tag will still apply correctly; flag it if you notice Facebook isn't picking it up.

## Token lifetime

The token is a Meta **System User** access token — unlike a personal user token it does not expire after 60 days. If it's ever revoked/rotated, generate a new one in Business Settings → Users → System Users → (your system user) → Generate New Token, with permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`.
