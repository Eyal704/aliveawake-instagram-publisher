import fs from "node:fs/promises";

const analyticsPath = new URL("../docs/analytics.json", import.meta.url);
const historyPath = new URL("../docs/analytics-history.json", import.meta.url);

const composio = process.env.COMPOSIO || `${process.env.HOME}/.composio/composio`;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const igAccount = process.env.IG_ACCOUNT || "aliveawake-main";
const igConnectedAccountId = process.env.IG_CONNECTED_ACCOUNT_ID;
const igUserId = process.env.IG_USER_ID || "28033607902927427";
const fbAccount = process.env.FB_ACCOUNT || "facebook_urushi-influx";
const fbConnectedAccountId = process.env.FB_CONNECTED_ACCOUNT_ID;
const fbPageId = process.env.FB_PAGE_ID || "299121263767927";

const HISTORY_CAP = 400;
const IG_REEL_METRICS = [
  "views", "reach", "likes", "comments", "shares", "saved",
  "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time",
];

// --- Composio execution (same dual-path pattern as scripts/verify-dashboard.mjs) ---
async function callRaw(tool, account, connectedAccountId, payload) {
  if (composioApiKey && connectedAccountId) {
    const response = await fetch(`https://backend.composio.dev/api/v3.1/tools/execute/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": composioApiKey },
      body: JSON.stringify({ connected_account_id: connectedAccountId, version: "latest", arguments: payload }),
    });
    const raw = await response.text();
    if (!response.ok || !raw) throw new Error(`${tool} API request failed (HTTP ${response.status}): ${raw || "empty output"}`);
    const result = JSON.parse(raw);
    if (result.successful === false || result.error) throw new Error(`${tool} failed: ${JSON.stringify(result.error || result)}`);
    return result.data;
  }

  const { spawnSync } = await import("node:child_process");
  const proc = spawnSync(composio, ["execute", tool, "--account", account, "-d", JSON.stringify(payload)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const raw = proc.stdout.trim();
  if (proc.status !== 0 || !raw) throw new Error(`${tool} returned no usable JSON (exit ${proc.status}): ${proc.stderr.trim() || "empty output"}`);
  const result = JSON.parse(raw);
  if (result.successful === false || result.error) throw new Error(`${tool} failed: ${JSON.stringify(result.error || result)}`);
  return result.data;
}

const asList = (raw) => raw?.data ?? [];
const asObject = (raw) => raw ?? {};

function normalize(value = "") {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

function deriveTitle(text) {
  const firstLine = (text || "").split(/\n+/).map((s) => s.trim()).find(Boolean) || "Untitled Reel";
  return firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}…` : firstLine;
}

function groupKeyFor(text) {
  return normalize((text || "").slice(0, 60));
}

function metricValue(metricsByName, name) {
  const entry = metricsByName[name];
  const value = entry?.values?.[0]?.value;
  return typeof value === "number" ? { available: true, value } : { available: false, reason: "Not returned by Instagram for this Reel (no qualifying activity, or metric unsupported for this media)." };
}

const UNAVAILABLE_FOLLOWERS = {
  available: false,
  reason: "Meta does not attribute new followers to an individual Reel or video post — this is a platform limitation, not a permissions gap.",
};

// --- Instagram: account + per-Reel ---
async function fetchInstagram() {
  const info = asObject(await callRaw("INSTAGRAM_GET_USER_INFO", igAccount, igConnectedAccountId, { ig_user_id: "me" }));
  const account = {
    username: info.username ?? null,
    followers: typeof info.followers_count === "number" ? info.followers_count : null,
    profileUrl: info.username ? `https://www.instagram.com/${info.username}/` : null,
  };

  const media = asList(await callRaw("INSTAGRAM_GET_IG_USER_MEDIA", igAccount, igConnectedAccountId, {
    ig_user_id: igUserId,
    limit: 100,
    fields: "id,caption,permalink,timestamp,media_product_type",
  })).filter((item) => item.media_product_type === "REELS");

  const reels = [];
  for (const item of media) {
    let thumbnailUrl = null;
    try {
      const detail = asObject(await callRaw("INSTAGRAM_GET_IG_MEDIA", igAccount, igConnectedAccountId, {
        ig_media_id: item.id,
        fields: "thumbnail_url",
      }));
      thumbnailUrl = detail.thumbnail_url ?? null;
    } catch (err) {
      console.warn(`[analytics] Instagram thumbnail lookup failed for ${item.id}: ${err.message}`);
    }

    let metricsByName = {};
    try {
      const insights = asList(await callRaw("INSTAGRAM_GET_IG_MEDIA_INSIGHTS", igAccount, igConnectedAccountId, {
        ig_media_id: item.id,
        metric: IG_REEL_METRICS,
      }));
      metricsByName = Object.fromEntries(insights.map((m) => [m.name, m]));
    } catch (err) {
      console.warn(`[analytics] Instagram insights failed for ${item.id}: ${err.message}`);
    }

    const totalInteractions = metricValue(metricsByName, "total_interactions");
    const reach = metricValue(metricsByName, "reach");
    const engagementRate = totalInteractions.available && reach.available && reach.value > 0
      ? { available: true, value: Math.round((totalInteractions.value / reach.value) * 1000) / 10 }
      : { available: false, reason: "Needs both total interactions and reach greater than zero." };

    reels.push({
      groupKey: groupKeyFor(item.caption),
      platform: "instagram",
      id: item.id,
      title: deriveTitle(item.caption),
      caption: item.caption ?? "",
      publishedAt: item.timestamp,
      permalink: item.permalink,
      thumbnailUrl,
      metrics: {
        views: metricValue(metricsByName, "views"),
        reach,
        likes: metricValue(metricsByName, "likes"),
        comments: metricValue(metricsByName, "comments"),
        shares: metricValue(metricsByName, "shares"),
        saved: metricValue(metricsByName, "saved"),
        avgWatchTimeMs: metricValue(metricsByName, "ig_reels_avg_watch_time"),
        totalWatchTimeMs: metricValue(metricsByName, "ig_reels_video_view_total_time"),
        newFollowers: UNAVAILABLE_FOLLOWERS,
      },
      engagementRate,
    });
  }

  return { account, reels };
}

// --- Facebook: account + per-Reel ---
function extractVideoIdFromReelPermalink(url) {
  const match = /\/reel\/(\d+)\/?/.exec(url || "");
  return match ? match[1] : null;
}

async function fetchFacebook() {
  const details = asObject(await callRaw("FACEBOOK_GET_PAGE_DETAILS", fbAccount, fbConnectedAccountId, {
    page_id: fbPageId,
    fields: "id,name,followers_count,fan_count,link",
  }));
  const account = {
    name: details.name ?? null,
    followers: typeof details.followers_count === "number" ? details.followers_count : (details.fan_count ?? null),
    profileUrl: details.link ?? `https://www.facebook.com/${fbPageId}`,
  };

  // Composio's Facebook video/post list tools silently return an empty array (HTTP 200,
  // successful:true) instead of an error once the combined field list gets too wide across
  // ~20+ items — confirmed empirically (16 fields=ok, 17 fields+ silently empties). Fetching
  // each field group separately and merging by id avoids that cliff entirely.
  const [videoCoreRaw, videoPictureRaw, videoEngagementRaw] = await Promise.all([
    callRaw("FACEBOOK_GET_PAGE_VIDEOS", fbAccount, fbConnectedAccountId, {
      page_id: fbPageId, limit: 100, fields: "id,created_time,description,status,permalink_url,views",
    }),
    callRaw("FACEBOOK_GET_PAGE_VIDEOS", fbAccount, fbConnectedAccountId, {
      page_id: fbPageId, limit: 100, fields: "id,picture",
    }),
    callRaw("FACEBOOK_GET_PAGE_VIDEOS", fbAccount, fbConnectedAccountId, {
      page_id: fbPageId, limit: 100, fields: "id,likes.summary(true),comments.summary(true)",
    }),
  ]);
  const videoCore = asList(videoCoreRaw);
  const pictureById = new Map(asList(videoPictureRaw).map((v) => [v.id, v.picture]));
  const engagementById = new Map(asList(videoEngagementRaw).map((v) => [v.id, v]));
  const videos = videoCore
    .map((v) => ({ ...v, picture: pictureById.get(v.id), likes: engagementById.get(v.id)?.likes, comments: engagementById.get(v.id)?.comments }))
    .filter((v) => v?.status?.publishing_phase?.publish_status === "published");

  const [postsCoreRaw, postsEngagementRaw] = await Promise.all([
    callRaw("FACEBOOK_GET_PAGE_POSTS", fbAccount, fbConnectedAccountId, {
      page_id: fbPageId, limit: 100, fields: "id,message,created_time,permalink_url,shares",
    }),
    callRaw("FACEBOOK_GET_PAGE_POSTS", fbAccount, fbConnectedAccountId, {
      page_id: fbPageId, limit: 100, fields: "id,reactions.summary(true),comments.summary(true)",
    }),
  ]);
  const postsCore = asList(postsCoreRaw);
  const postEngagementById = new Map(asList(postsEngagementRaw).map((p) => [p.id, p]));
  const posts = postsCore.map((p) => ({ ...p, reactions: postEngagementById.get(p.id)?.reactions, comments: postEngagementById.get(p.id)?.comments }));
  const postsByVideoId = new Map();
  for (const post of posts) {
    const videoId = extractVideoIdFromReelPermalink(post.permalink_url);
    if (videoId) postsByVideoId.set(videoId, post);
  }

  const reels = videos.map((video) => {
    const post = postsByVideoId.get(video.id);
    const reactions = post?.reactions?.summary?.total_count ?? video?.likes?.summary?.total_count;
    const comments = post?.comments?.summary?.total_count ?? video?.comments?.summary?.total_count ?? 0;
    const shares = post?.shares?.count;
    const views = typeof video.views === "number" ? video.views : null;

    const reactionsAvail = typeof reactions === "number";
    const engagementNumerator = reactionsAvail ? reactions + comments + (typeof shares === "number" ? shares : 0) : null;
    const engagementRate = engagementNumerator !== null && views
      ? { available: true, value: Math.round((engagementNumerator / views) * 1000) / 10 }
      : { available: false, reason: "Needs both reactions and view count greater than zero." };

    return {
      groupKey: groupKeyFor(video.description || post?.message),
      platform: "facebook",
      id: video.id,
      title: deriveTitle(video.description || post?.message),
      caption: video.description || post?.message || "",
      publishedAt: video.created_time,
      permalink: post?.permalink_url || `https://www.facebook.com/reel/${video.id}/`,
      thumbnailUrl: video.picture ?? null,
      metrics: {
        views: views !== null ? { available: true, value: views } : { available: false, reason: "Facebook did not return a view count for this video." },
        reach: { available: false, reason: "Facebook's video API doesn't expose a unique-reach metric like Instagram's — only a view count, which isn't deduplicated per viewer." },
        likes: reactionsAvail ? { available: true, value: reactions } : { available: false, reason: "No reaction count returned." },
        comments: { available: true, value: comments },
        shares: typeof shares === "number" ? { available: true, value: shares } : { available: false, reason: "Facebook omits the shares field entirely when the count is 0 or unsupported for this post — shown as unavailable rather than guessing." },
        saved: { available: false, reason: "Facebook has no equivalent to Instagram's Saves for video/Reel posts." },
        avgWatchTimeMs: { available: false, reason: "Facebook's Graph API does not expose average watch time for Page videos." },
        totalWatchTimeMs: { available: false, reason: "Facebook's Graph API does not expose total watch time for Page videos." },
        newFollowers: UNAVAILABLE_FOLLOWERS,
      },
      engagementRate,
    };
  });

  return { account, reels };
}

// --- Follower history snapshot (durable, independent of Meta's own lookback window) ---
async function loadJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

async function updateHistory(igFollowers, fbFollowers) {
  const history = await loadJson(historyPath, { snapshots: [] });
  const snapshots = history.snapshots ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const alreadyToday = snapshots.some((s) => s.capturedAt?.slice(0, 10) === today);

  if (!alreadyToday && (igFollowers !== null || fbFollowers !== null)) {
    snapshots.push({ capturedAt: new Date().toISOString(), instagramFollowers: igFollowers, facebookFollowers: fbFollowers });
  } else if (alreadyToday) {
    const last = snapshots[snapshots.length - 1];
    if (igFollowers !== null) last.instagramFollowers = igFollowers;
    if (fbFollowers !== null) last.facebookFollowers = fbFollowers;
  }

  const trimmed = snapshots.slice(-HISTORY_CAP);
  await fs.writeFile(historyPath, `${JSON.stringify({ snapshots: trimmed }, null, 2)}\n`);
}

async function main() {
  const previous = await loadJson(analyticsPath, {});
  const now = new Date().toISOString();

  const stale = { instagram: false, facebook: false };
  const staleReason = { instagram: null, facebook: null };
  let instagram = previous.account?.instagram ? { account: previous.account.instagram, reels: (previous.reels || []).filter((r) => r.platform === "instagram") } : null;
  let facebook = previous.account?.facebook ? { account: previous.account.facebook, reels: (previous.reels || []).filter((r) => r.platform === "facebook") } : null;

  try {
    instagram = await fetchInstagram();
  } catch (err) {
    console.error(`[analytics] Instagram fetch failed, keeping last verified data: ${err.message}`);
    stale.instagram = true;
    staleReason.instagram = err.message;
  }

  try {
    facebook = await fetchFacebook();
  } catch (err) {
    console.error(`[analytics] Facebook fetch failed, keeping last verified data: ${err.message}`);
    stale.facebook = true;
    staleReason.facebook = err.message;
  }

  if (!instagram && !facebook) {
    console.error("[analytics] Both platforms failed with no prior data available. Aborting without writing a file.");
    process.exit(1);
  }

  if (!stale.instagram || !stale.facebook) {
    await updateHistory(
      stale.instagram ? null : instagram?.account?.followers ?? null,
      stale.facebook ? null : facebook?.account?.followers ?? null,
    );
  }

  const anySucceeded = !stale.instagram || !stale.facebook;

  const output = {
    generatedAt: now,
    lastAttemptedAt: now,
    lastSuccessfulUpdateAt: anySucceeded ? now : (previous.lastSuccessfulUpdateAt ?? null),
    timezone: "Europe/Vienna",
    stale,
    staleReason,
    account: {
      instagram: instagram?.account ?? null,
      facebook: facebook?.account ?? null,
    },
    engagementFormula: {
      instagram: "Engagement rate = (likes + comments + shares + saves) ÷ reach × 100 — using Instagram's own total_interactions metric as the numerator.",
      facebook: "Engagement rate = (reactions + comments + shares) ÷ views × 100. Facebook's view count is total plays, not unique reach, so this rate isn't directly comparable to the Instagram rate above.",
    },
    reels: [...(instagram?.reels ?? []), ...(facebook?.reels ?? [])].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    ),
  };

  await fs.writeFile(analyticsPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Analytics updated. Instagram stale=${stale.instagram}, Facebook stale=${stale.facebook}. Reels tracked: ${output.reels.length}.`);
}

main().catch((err) => {
  console.error("[analytics] Unexpected error:", err);
  process.exit(1);
});
