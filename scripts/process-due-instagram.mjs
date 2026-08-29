import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

const schedulePath = new URL("../docs/schedule.json", import.meta.url);
const composio = process.env.COMPOSIO || `${process.env.HOME}/.composio/composio`;
const igAccount = process.env.IG_ACCOUNT || "aliveawake-main";
const igUserId = process.env.IG_USER_ID || "28033607902927427";
const queue = JSON.parse(process.env.ALIVEAWAKE_QUEUE_JSON || "[]");
const now = Date.now();
const prepareWindowMs = 6 * 60 * 60 * 1000;
const recoveryWindowMs = 6 * 60 * 60 * 1000;
// Bounded retry budget for transient failures before a post is marked failed.
const MAX_ATTEMPTS = 5;
let failed = false;

function execute(tool, payload) {
  const process = spawnSync(composio, ["execute", tool, "--account", igAccount, "-d", JSON.stringify(payload)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const raw = process.stdout.trim();
  if (process.status !== 0 || !raw) {
    throw new Error(`${tool} returned no usable response: ${process.stderr.trim() || `exit ${process.status}`}`);
  }
  const result = JSON.parse(raw);
  if (result.successful === false || result.error) {
    throw new Error(`${tool} failed: ${JSON.stringify(result.error || result)}`);
  }
  return result.data;
}

function normalize(value = "") {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

function timestampNear(item, due) {
  const timestamp = Date.parse(item.timestamp || "");
  return Number.isFinite(timestamp) && Math.abs(timestamp - due) <= recoveryWindowMs;
}

function safeError(error) {
  return String(error?.message || error).replace(/access_token=[^&\s]+/gi, "access_token=[redacted]").slice(0, 500);
}

const schedule = JSON.parse(await fs.readFile(schedulePath, "utf8"));
const candidates = schedule.posts.filter(post => {
  const due = new Date(post.scheduledAt).getTime();
  return post.instagram?.status === "queued_cloud" && !post.instagram.workflowRun && due <= now + prepareWindowMs && due >= now - recoveryWindowMs;
});

for (const post of candidates) {
  const due = new Date(post.scheduledAt).getTime();
  const privatePost = queue.find(item => item.id === post.id);
  if (!privatePost) {
    post.instagram = {...post.instagram, status: "failed", verified: false, lastError: "Private queue payload is missing."};
    post.overall = "needs_attention";
    failed = true;
    continue;
  }

  try {
    let containerId = post.instagram.containerId;
    const containerAge = now - Date.parse(post.instagram.containerCreatedAt || 0);
    const needsContainer = !containerId || !Number.isFinite(containerAge) || containerAge > 22 * 60 * 60 * 1000;
    if (needsContainer) {
      const created = execute("INSTAGRAM_POST_IG_USER_MEDIA", {
        ig_user_id: igUserId,
        video_url: privatePost.videoUrl,
        cover_url: privatePost.coverUrl,
        caption: privatePost.caption,
        media_type: "REELS",
        share_to_feed: true
      });
      containerId = created.id;
      if (!containerId) throw new Error("Instagram did not return a container ID.");
      post.instagram = {
        ...post.instagram,
        status: "queued_cloud",
        verified: false,
        containerId,
        containerCreatedAt: new Date().toISOString(),
        // Preparation succeeded, so earlier transient failures are not part of a
        // continuing problem. Clear the budget or non-consecutive blips would
        // accumulate across days and eventually fail a healthy post.
        attempts: undefined,
        lastError: undefined,
        lastErrorAt: undefined
      };
    }

    if (now < due) continue;

    const recent = execute("INSTAGRAM_GET_IG_USER_MEDIA", {
      ig_user_id: igUserId,
      since: Math.floor((due - recoveryWindowMs) / 1000),
      limit: 100,
      fields: "id,caption,permalink,timestamp,media_product_type"
    }).data || [];
    const prefix = normalize(post.captionMatch);
    const matches = recent.filter(item => normalize(item.caption).startsWith(prefix) && timestampNear(item, due));
    if (matches.length > 1) {
      post.instagram = {...post.instagram, status: "duplicate", verified: false, lastError: "Multiple matching Instagram Reels were found near this slot."};
      post.overall = "needs_attention";
      failed = true;
      continue;
    }
    if (matches.length === 1) {
      post.instagram = {
        ...post.instagram,
        status: "published",
        verified: true,
        mediaId: matches[0].id,
        url: matches[0].permalink,
        verifiedAt: new Date().toISOString(),
        attempts: undefined,
        lastError: undefined,
        lastErrorAt: undefined
      };
      continue;
    }

    const container = execute("INSTAGRAM_GET_POST_STATUS", {creation_id: containerId});
    if (container.status_code !== "FINISHED") {
      throw new Error(`Instagram container is ${container.status_code || "unknown"}, not FINISHED.`);
    }

    const published = execute("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", {
      ig_user_id: igUserId,
      creation_id: containerId,
      max_wait_seconds: 300,
      poll_interval_seconds: 5
    });
    if (!published.id) throw new Error("Instagram publish did not return a media ID.");

    const verified = execute("INSTAGRAM_GET_IG_MEDIA", {
      ig_media_id: published.id,
      fields: "id,caption,media_type,media_product_type,permalink,timestamp,username,is_shared_to_feed"
    });
    if (!verified.permalink || verified.username !== "aliveawake_") {
      throw new Error("Instagram returned a media ID, but public verification failed.");
    }
    post.instagram = {
      ...post.instagram,
      status: "published",
      verified: true,
      mediaId: verified.id,
      url: verified.permalink,
      verifiedAt: new Date().toISOString(),
      attempts: undefined,
      lastError: undefined,
      lastErrorAt: undefined
    };
  } catch (error) {
    // A transient error (network blip, Composio CLI hiccup, Meta 5xx) must NOT
    // permanently remove a post from the queue. The candidate filter above only
    // picks up status === "queued_cloud", so writing "failed" here used to be a
    // one-way door: a single 5-second network fault meant the post was never
    // retried and silently never published. Stay retryable until the attempt
    // budget is spent, then fail loudly so the Telegram alert fires.
    const attempts = (post.instagram.attempts || 0) + 1;
    if (attempts < MAX_ATTEMPTS) {
      post.instagram = {
        ...post.instagram,
        status: "queued_cloud",
        verified: false,
        attempts,
        lastError: safeError(error),
        lastErrorAt: new Date().toISOString()
      };
      console.log(`Attempt ${attempts}/${MAX_ATTEMPTS} failed for ${post.id}; staying queued for retry: ${safeError(error)}`);
    } else {
      post.instagram = {
        ...post.instagram,
        status: "failed",
        verified: false,
        attempts,
        lastError: safeError(error),
        lastErrorAt: new Date().toISOString()
      };
      post.overall = "needs_attention";
      console.log(`Attempt ${attempts}/${MAX_ATTEMPTS} failed for ${post.id}; giving up.`);
    }
    failed = true;
  }
}

schedule.updatedAt = new Date().toISOString();
await fs.writeFile(schedulePath, `${JSON.stringify(schedule, null, 2)}\n`);
console.log(`Processed ${candidates.length} cloud-queued Instagram post(s).`);
if (failed) process.exitCode = 1;
