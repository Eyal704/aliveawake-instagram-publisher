// Read-only integrity check: does every upcoming post in the PUBLIC schedule
// have a matching entry in the PRIVATE queue secret?
//
// This exists because ALIVEAWAKE_QUEUE_JSON is a write-only GitHub secret --
// nobody (not the repo owner, not any AI session) can read it back. That made
// a missing entry undetectable until the post failed at publish time, which is
// exactly how the 2026-08-27 10:00 post was lost.
//
// This script NEVER prints secret values -- only post ids and booleans.

import fs from "node:fs/promises";

const schedulePath = new URL("../docs/schedule.json", import.meta.url);

let queue;
try {
  queue = JSON.parse(process.env.ALIVEAWAKE_QUEUE_JSON || "[]");
} catch {
  console.log("FAIL: ALIVEAWAKE_QUEUE_JSON is not valid JSON. The secret is corrupt.");
  process.exit(1);
}
if (!Array.isArray(queue)) {
  console.log("FAIL: ALIVEAWAKE_QUEUE_JSON is not a JSON array.");
  process.exit(1);
}

const schedule = JSON.parse(await fs.readFile(schedulePath, "utf8"));
const now = Date.now();

const isolatedSecrets = {
  "2026-08-28-1500-creator-of-suffering": "CREATOR_OF_SUFFERING_QUEUE",
  "2026-08-28-2000-stop-blaming": "STOP_BLAMING_QUEUE",
  "2026-08-29-1000-changing-reality": "CHANGING_REALITY_QUEUE",
  "2026-08-29-1700-everyone-is-your-mirror": "EVERYONE_IS_YOUR_MIRROR_QUEUE",
  "2026-08-29-2100-way-shows-when-you-walk": "WAY_SHOWS_WHEN_YOU_WALK_QUEUE",
};
const isolatedPayloads = new Map();
for (const [postId, envName] of Object.entries(isolatedSecrets)) {
  try {
    isolatedPayloads.set(postId, JSON.parse(process.env[envName] || "null"));
  } catch {
    console.log(`FAIL: ${envName} is not valid JSON. The dedicated secret is corrupt.`);
    process.exit(1);
  }
}

// Anything not already fully published on Instagram, and not in the past by more
// than a day, still needs its private payload to exist.
const upcoming = schedule.posts.filter(post => {
  const due = new Date(post.scheduledAt).getTime();
  const igDone = post.instagram?.status === "published";
  return !igDone && due >= now - 24 * 60 * 60 * 1000;
});

const byId = new Map(queue.map(item => [item.id, item]));
let problems = 0;

console.log(`Private queue holds ${queue.length} entr${queue.length === 1 ? "y" : "ies"}.`);
console.log(`Checking ${upcoming.length} upcoming/unpublished post(s):\n`);

for (const post of upcoming) {
  const isolated = post.instagram?.status === "queued_isolated";
  const entry = isolated ? isolatedPayloads.get(post.id) : byId.get(post.id);
  if (!entry) {
    console.log(`  MISSING   ${post.scheduledAt}  ${post.id}`);
    console.log(`            -> no ${isolated ? "dedicated" : "shared"} private payload; this post WILL fail at publish time.`);
    problems++;
    continue;
  }
  if (isolated && entry.id && entry.id !== post.id) {
    console.log(`  MISMATCH  ${post.scheduledAt}  ${post.id}`);
    console.log("            -> dedicated private payload has a different id.");
    problems++;
    continue;
  }
  const missingFields = ["videoUrl", "caption"].filter(f => !entry[f] || !String(entry[f]).trim());
  if (missingFields.length) {
    console.log(`  INCOMPLETE ${post.scheduledAt}  ${post.id}`);
    console.log(`            -> payload exists but is missing: ${missingFields.join(", ")}`);
    problems++;
    continue;
  }
  // Caption sanity: captionMatch is used for duplicate-detection, so a payload
  // whose caption doesn't start with it would publish under the wrong text AND
  // defeat duplicate detection. Worth catching before it goes out.
  const norm = v => String(v || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  const captionOk = !post.captionMatch || norm(entry.caption).startsWith(norm(post.captionMatch));
  console.log(`  OK        ${post.scheduledAt}  ${post.id}`);
  console.log(`            -> ${isolated ? "dedicated" : "shared"} payload present (cover: ${entry.coverUrl ? "yes" : "no"}, caption matches schedule: ${captionOk ? "yes" : "NO"})`);
  if (!captionOk) {
    console.log(`            -> WARNING: caption does not start with this post's captionMatch.`);
    problems++;
  }
}

// Orphans: private entries with no corresponding public post. Not fatal, but
// they're how you'd notice a stale/leftover entry or an id typo.
const scheduleIds = new Set(schedule.posts.map(p => p.id));
const orphans = queue.map(i => i.id).filter(id => !scheduleIds.has(id));
if (orphans.length) {
  console.log(`\nPrivate entries with no matching public post (stale or typo'd ids):`);
  for (const id of orphans) console.log(`  ORPHAN    ${id}`);
}

console.log(`\nAll private queue ids currently stored: ${queue.map(i => i.id).join(", ") || "(none)"}`);
for (const [postId, envName] of Object.entries(isolatedSecrets)) {
  console.log(`Dedicated ${postId} payload (${envName}): ${isolatedPayloads.get(postId) ? "present" : "missing"}`);
}

if (problems) {
  console.log(`\nRESULT: ${problems} problem(s) found. Fix before the affected slot arrives.`);
  process.exit(1);
}
console.log(`\nRESULT: every upcoming post has a usable private payload.`);
