import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const schedulePath = new URL("../docs/schedule.json", import.meta.url);
const composio = process.env.COMPOSIO || `${process.env.HOME}/.composio/composio`;
const igAccount = process.env.IG_ACCOUNT || "aliveawake-main";
const igUserId = process.env.IG_USER_ID || "28033607902927427";
const fbAccount = process.env.FB_ACCOUNT || "facebook_urushi-influx";
const fbPageId = process.env.FB_PAGE_ID || "299121263767927";

function execute(tool, account, payload) {
  const raw = execFileSync(composio, ["execute", tool, "--account", account, "-d", JSON.stringify(payload)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = JSON.parse(raw);
  if (result.successful === false || result.error) {
    throw new Error(`${tool} failed: ${JSON.stringify(result.error || result)}`);
  }
  return result.data?.data || [];
}

function normalize(value = "") {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

function deriveOverall(post, now) {
  const due = new Date(post.scheduledAt).getTime();
  if (post.instagram.status === "published" && post.facebook.status === "published") return "published";
  if ([post.instagram.status, post.facebook.status].includes("not_scheduled")) return "needs_attention";
  if (now > due + 30 * 60 * 1000 && [post.instagram.status, post.facebook.status].some(s => s !== "published")) return "needs_attention";
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
const igMedia = execute("INSTAGRAM_GET_IG_USER_MEDIA", igAccount, {
  ig_user_id: igUserId,
  since: earliest,
  limit: 100,
  fields: "id,caption,permalink,timestamp,media_product_type"
});
const fbScheduled = execute("FACEBOOK_GET_SCHEDULED_POSTS", fbAccount, {
  page_id: fbPageId,
  limit: 100,
  fields: "id,message,scheduled_publish_time,is_published"
});
const fbVideos = execute("FACEBOOK_GET_PAGE_VIDEOS", fbAccount, {
  page_id: fbPageId,
  limit: 100,
  fields: "id,created_time,description,status,permalink_url"
});

for (const post of relevant) {
  const due = new Date(post.scheduledAt).getTime();
  const captionMatch = normalize(post.captionMatch);

  if (captionMatch) {
    const ig = igMedia.find(item => normalize(item.caption).startsWith(captionMatch));
    if (ig) {
      post.instagram = {
        ...post.instagram,
        status: "published",
        verified: true,
        mediaId: ig.id,
        url: ig.permalink,
        verifiedAt: new Date().toISOString()
      };
    } else if (now >= due && post.instagram.status !== "published") {
      post.instagram.status = now > due + 30 * 60 * 1000 ? "missing" : "publishing";
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
      const scheduled = fbScheduled.find(item => item.id === post.facebook.scheduledPostId && Number(item.scheduled_publish_time) === Math.floor(due / 1000));
      if (scheduled) post.facebook.status = "scheduled";
    } else if (post.facebook.status !== "published") {
      post.facebook.status = now > due + 30 * 60 * 1000 ? "missing" : "publishing";
      post.facebook.verified = false;
    }
  }

  post.overall = deriveOverall(post, now);
}

schedule.lastCheckedAt = new Date().toISOString();
schedule.updatedAt = new Date().toISOString();
await fs.writeFile(schedulePath, `${JSON.stringify(schedule, null, 2)}\n`);
console.log(`Verified ${relevant.length} scheduled posts.`);
