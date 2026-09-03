/**
 * Facebook publish reconciliation.
 *
 * The video ID captured when a Reel is scheduled is a hint, not an anchor.
 * Facebook can publish a scheduled Reel as a different video object than the one
 * the scheduled post reported, and the scheduled post's permalink sometimes
 * carries the page-post ID rather than a video ID. Both were observed live:
 * "Stop Being A Copy" (2026-08-30) and "Responsibility Is Not Self-Blame"
 * (2026-09-03) each published on time, yet verification anchored on the recorded
 * ID, found nothing, and reported them missing -- firing false Telegram alerts
 * that stayed stuck on needs_attention.
 *
 * So try the recorded ID first (exact and cheap), then fall back to the same
 * caption + time-window match Instagram already relies on, and report the ID
 * actually found so the caller can heal the stored record.
 */

const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

export function normalize(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

export function isLiveVideo(video) {
  return video?.status?.video_status === "ready"
    && video?.status?.publishing_phase?.publish_status === "published";
}

/**
 * @returns {{outcome: "published"|"duplicate"|"none", video: object|null, videoId: string|null}}
 */
export function resolveFacebookVideo({videoId, captionMatch, videos = [], due, windowMs = MATCH_WINDOW_MS}) {
  const recorded = videos.find(video => String(video.id) === String(videoId));
  if (isLiveVideo(recorded)) return {outcome: "published", video: recorded, videoId: String(recorded.id)};

  const prefix = normalize(captionMatch);
  if (!prefix) return {outcome: "none", video: null, videoId: null};

  const matches = videos.filter(video => {
    if (!isLiveVideo(video)) return false;
    if (!normalize(video.description).startsWith(prefix)) return false;
    const publishedAt = Date.parse(video.status?.publishing_phase?.publish_time || "");
    return Number.isFinite(publishedAt) && Math.abs(publishedAt - due) <= windowMs;
  });

  if (matches.length > 1) return {outcome: "duplicate", video: null, videoId: null};
  if (matches.length === 1) return {outcome: "published", video: matches[0], videoId: String(matches[0].id)};
  return {outcome: "none", video: null, videoId: null};
}
