import fs from "node:fs/promises";
import { executeComposioTool } from "./lib/composio.mjs";

const schedulePath = new URL("../docs/schedule.json", import.meta.url);
const igAccount = process.env.IG_ACCOUNT || "aliveawake-main";
const igConnectedAccountId = process.env.IG_CONNECTED_ACCOUNT_ID;
const igUserId = process.env.IG_USER_ID || "28033607902927427";
const fbAccount = process.env.FB_ACCOUNT || "facebook_urushi-influx";
const fbConnectedAccountId = process.env.FB_CONNECTED_ACCOUNT_ID;
const fbPageId = process.env.FB_PAGE_ID || "299121263767927";

async function execute(tool, account, connectedAccountId, payload) {
  const result = await executeComposioTool(tool, account, connectedAccountId, payload);
  if (!Array.isArray(result.data?.data)) {
    throw new Error(`${tool} returned no data.data array.`);
  }
  return result.data.data;
}

function normalize(value = "") {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

function deriveOverall(post, now) {
  const due = new Date(post.scheduledAt).getTime();
  if (post.instagram.status === "published" && post.facebook.status === "published") return "published";
  if ([post.instagram.status, post.facebook.status].includes("not_scheduled")) return "needs_attention";
  if ([post.instagram.status, post.facebook.status].some(s => ["failed", "missing", "duplicate"].includes(s))) return "needs_attention";
  if (now > due + 15 * 60 * 1000 && [post.instagram.status, post.facebook.status].some(s => s !== "published")) return "needs_attention";
  if ([post.instagram.status, post.facebook.status].includes("queued_local")) return "scheduled_with_risk";
  if (now >= due) return "publishing";
  return "scheduled";
}

const schedule = JSON.parse(await fs.readFile(schedulePath, "utf8"));
const now = Date.now();
const relevant = schedule.posts.filter(post => {
  const due = new Date(post.scheduledAt).getTime();
  return due >= now - 7 * 24 * 60 * 60 * 1000 && due <= now + 14 * 24 * 60 * 60 * 1000;
});

const earliest = Math.floor(Math.min(...relevant.map(post => new Date(post.scheduledAt).getTime())) / 1000) - 3600;
const igMedia = await execute("INSTAGRAM_GET_IG_USER_MEDIA", igAccount, igConnectedAccountId, {
  ig_user_id: igUserId,
  since: earliest,
  limit: 100,
  fields: "id,caption,permalink,timestamp,media_product_type"
});
const fbScheduled = await execute("FACEBOOK_GET_SCHEDULED_POSTS", fbAccount, fbConnectedAccountId, {
  page_id: fbPageId,
  limit: 100,
  fields: "id,message,scheduled_publish_time,is_published"
});
const fbVideos = await execute("FACEBOOK_GET_PAGE_VIDEOS", fbAccount, fbConnectedAccountId, {
  page_id: fbPageId,
  limit: 100,
  fields: "id,created_time,description,status,permalink_url"
});

for (const post of relevant) {
  const due = new Date(post.scheduledAt).getTime();
  const captionMatch = normalize(post.captionMatch);

  if (captionMatch) {
    const igMatches = igMedia.filter(item => {
      const timestamp = Date.parse(item.timestamp || "");
      return normalize(item.caption).startsWith(captionMatch) && Number.isFinite(timestamp) && Math.abs(timestamp - due) <= 6 * 60 * 60 * 1000;
    });
    if (igMatches.length > 1) {
      post.instagram.status = "duplicate";
      post.instagram.verified = false;
    } else if (igMatches.length === 1) {
      const ig = igMatches[0];
      post.instagram = {
        ...post.instagram,
        status: "published",
        verified: true,
        mediaId: ig.id,
        url: ig.permalink,
        verifiedAt: new Date().toISOString()
      };
    } else if (now >= due && post.instagram.status !== "published") {
      post.instagram.status = now > due + 15 * 60 * 1000 ? "missing" : "publishing";
      post.instagram.verified = false;
    }
  }

  if (post.facebook.videoId) {
    const video = fbVideos.find(item => item.id === post.facebook.videoId);
    const ready = video?.status?.video_status === "ready";
    const published = video?.status?.publishing_phase?.publish_status === "published";
    if (video && ready && published) {
      post.facebook = {
        ...post.facebook,
        status: "published",
        verified: true,
        url: video.permalink_url || `https://www.facebook.com/reel/${post.facebook.videoId}/`,
        verifiedAt: new Date().toISOString()
      };
    } else if (now < due) {
      // Match on scheduledPostId alone, not also the exact epoch: Facebook's own
      // scheduler can shift an object's reported scheduled_publish_time by a few
      // seconds, and an unpublished post already uniquely identified by its post
      // ID doesn't need a second, brittle equality check to confirm it's real.
      const scheduled = fbScheduled.find(item => item.id === post.facebook.scheduledPostId && item.is_published === false);
      if (scheduled) post.facebook.status = "scheduled";
    } else if (post.facebook.status !== "published") {
      post.facebook.status = now > due + 15 * 60 * 1000 ? "missing" : "publishing";
      post.facebook.verified = false;
    }
  }

  post.overall = deriveOverall(post, now);
}

schedule.lastCheckedAt = new Date().toISOString();
schedule.updatedAt = new Date().toISOString();
await fs.writeFile(schedulePath, `${JSON.stringify(schedule, null, 2)}\n`);
console.log(`Verified ${relevant.length} scheduled posts.`);
