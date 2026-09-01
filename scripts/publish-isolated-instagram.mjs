import {executeComposioCli} from "./lib/composio.mjs";

const account = process.env.IG_ACCOUNT || "aliveawake-main";
const userId = process.env.IG_USER_ID || "28033607902927427";
const payload = JSON.parse(process.env.QUEUE_JSON || "null");
const due = Number(process.env.PUBLISH_AT_EPOCH || 0) * 1000;
const sixHours = 6 * 60 * 60 * 1000;

if (!payload || !due) {
  console.log(JSON.stringify({ok: true, outcome: "NO_PAYLOAD"}));
  process.exit(0);
}

const normalize = value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
const prefix = normalize(payload.caption).slice(0, 80);
const execute = async (tool, data) => (await executeComposioCli(tool, account, data)).data;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function matchingRecent() {
  const response = await execute("INSTAGRAM_GET_IG_USER_MEDIA", {
    ig_user_id: userId,
    since: Math.floor((due - sixHours) / 1000),
    limit: 100,
    fields: "id,caption,permalink,timestamp,username,media_product_type"
  });
  const rows = response?.data;
  if (!Array.isArray(rows)) throw new Error("Instagram recent-media response has no data array.");
  return rows.filter(row => normalize(row.caption).startsWith(prefix));
}

const now = Date.now();
if (now < due - sixHours) {
  console.log(JSON.stringify({ok: true, outcome: "TOO_EARLY"}));
  process.exit(0);
}
if (now > due + sixHours) throw new Error("Outside the bounded six-hour recovery window; refusing late publication.");

let matches = await matchingRecent();
if (matches.length > 1) throw new Error("Multiple matching Instagram Reels found; refusing duplicate publication.");
if (matches.length === 1) {
  console.log(JSON.stringify({ok: true, outcome: "ALREADY_PUBLISHED", instagram: {media_id: matches[0].id, url: matches[0].permalink}}));
  process.exit(0);
}

const created = await execute("INSTAGRAM_POST_IG_USER_MEDIA", {
  ig_user_id: userId,
  video_url: payload.videoUrl,
  cover_url: payload.coverUrl,
  caption: payload.caption,
  media_type: "REELS",
  share_to_feed: true
});
const containerId = created?.id;
if (!containerId || containerId === "<REDACTED>") throw new Error("Instagram did not return a usable container ID.");
for (let attempt = 1; attempt <= 40; attempt++) {
  const status = await execute("INSTAGRAM_GET_POST_STATUS", {creation_id: containerId});
  if (status?.status_code === "FINISHED") break;
  if (["ERROR", "EXPIRED"].includes(status?.status_code)) throw new Error(`Instagram container entered ${status.status_code}.`);
  if (attempt === 40) throw new Error("Instagram container did not reach FINISHED.");
  await sleep(15_000);
}
if (Date.now() < due) await sleep(due - Date.now());

matches = await matchingRecent();
if (matches.length > 1) throw new Error("Multiple matching Instagram Reels found immediately before publish.");
if (matches.length === 1) {
  console.log(JSON.stringify({ok: true, outcome: "RECONCILED", instagram: {media_id: matches[0].id, url: matches[0].permalink}}));
  process.exit(0);
}

const published = await execute("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", {
  ig_user_id: userId,
  creation_id: containerId,
  max_wait_seconds: 300,
  poll_interval_seconds: 5
});
if (!published?.id || published.id === "<REDACTED>") throw new Error("Instagram publish returned no usable media ID.");
const verified = await execute("INSTAGRAM_GET_IG_MEDIA", {
  ig_media_id: published.id,
  fields: "id,caption,media_type,media_product_type,permalink,timestamp,username,is_shared_to_feed"
});
if (!verified?.permalink || verified.username !== "aliveawake_") throw new Error("Instagram publication could not be independently verified.");
console.log(JSON.stringify({ok: true, outcome: "PUBLISHED_VERIFIED", instagram: {media_id: verified.id, url: verified.permalink}}));
