import fs from "node:fs/promises";

const schedulePath = new URL("../docs/schedule.json", import.meta.url);
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const schedule = JSON.parse(await fs.readFile(schedulePath, "utf8"));
const now = Date.now();

if (!token || !chatId) {
  console.log("Telegram alerts are not configured; add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID repository secrets.");
  process.exit(0);
}

for (const post of schedule.posts) {
  const due = new Date(post.scheduledAt).getTime();
  if (now < due + 15 * 60 * 1000) continue;
  const problem = [post.instagram.status, post.facebook.status, post.overall]
    .some(status => ["failed", "missing", "duplicate", "needs_attention", "not_scheduled"].includes(status));
  if (!problem) continue;

  const alertKey = `${post.instagram.status}:${post.facebook.status}:${post.overall}`;
  if (post.alert?.lastKey === alertKey) continue;
  const message = [
    `⚠️ AliveAwake publishing alert`,
    post.title,
    `Expected: ${post.scheduledAt} (${schedule.timezone})`,
    `Instagram: ${post.instagram.status}`,
    `Facebook: ${post.facebook.status}`,
    `Dashboard: https://eyal704.github.io/aliveawake-instagram-publisher/`
  ].join("\n");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({chat_id: chatId, text: message, disable_web_page_preview: true})
  });
  if (!response.ok) throw new Error(`Telegram alert failed with HTTP ${response.status}.`);
  post.alert = {lastKey: alertKey, sentAt: new Date().toISOString()};
}

await fs.writeFile(schedulePath, `${JSON.stringify(schedule, null, 2)}\n`);
