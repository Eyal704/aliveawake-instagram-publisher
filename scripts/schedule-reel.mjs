#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {executeComposioCli} from "./lib/composio.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepo = path.resolve(here, "..");
const steps = ["assets", "queue", "facebook", "private_queue", "public_queue", "worker", "integrity", "drive", "telegram"];

function parseArgs(argv) {
  const args = {phase: "schedule", execute: false, repo: defaultRepo, fixture: null};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!args.job && !value.startsWith("--")) args.job = path.resolve(value);
    else if (value === "--execute") args.execute = true;
    else if (value === "--phase") args.phase = argv[++i];
    else if (value === "--repo") args.repo = path.resolve(argv[++i]);
    else if (value === "--fixture") args.fixture = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.job) throw new Error("Usage: schedule-reel.mjs JOB [--phase schedule|verify] [--execute] [--fixture FILE]");
  if (!["schedule", "verify"].includes(args.phase)) throw new Error("--phase must be schedule or verify");
  if (args.fixture && !args.execute) throw new Error("--fixture is only meaningful with --execute");
  return args;
}

const normalize = value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
const compactError = error => String(error?.message || error).replace(/access_token=[^&\s]+/gi, "access_token=[redacted]").slice(0, 500);
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, file);
}
async function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: options.cwd, input: options.input, encoding: "utf8", stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"]});
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ""} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout.trim();
}

function preflightCapabilities(repo) {
  run("gh", ["auth", "status"], {cwd: repo});
  run("security", ["find-generic-password", "-a", "eyalshoval", "-s", "cloudflare-api-token"]);
  const checks = [
    ["FACEBOOK_GET_SCHEDULED_POSTS", process.env.FB_ACCOUNT || "facebook_urushi-influx", {page_id: process.env.FB_PAGE_ID || "299121263767927", limit: 1, fields: "id"}],
    ["INSTAGRAM_GET_IG_USER_MEDIA", process.env.IG_ACCOUNT || "aliveawake-main", {ig_user_id: process.env.IG_USER_ID || "28033607902927427", limit: 1, fields: "id"}],
    ["GOOGLEDRIVE_GET_FILE_METADATA", process.env.DRIVE_ACCOUNT || "aliveawake-drive", {fileId: "capability-preflight-placeholder", fields: "id,name"}]
  ];
  for (const [tool, account, payload] of checks) run(process.env.COMPOSIO || "composio", ["execute", tool, "--account", account, "-d", JSON.stringify(payload), "--dry-run"], {cwd: repo});
}

function validateJob(job, phase) {
  const errors = [];
  if (job.version !== 2) errors.push("version must be 2");
  if (!/^[a-z0-9][a-z0-9-]{5,127}$/.test(job.reel_id || "")) errors.push("invalid reel_id");
  if (!job.drive?.file_id || !job.drive?.original_name || !job.drive?.source_timestamp || !job.drive?.current_name) errors.push("complete Drive identity is required");
  if (phase === "schedule") {
    if (job.approval?.publishing_approved !== true) errors.push("publishing approval is absent");
    if (JSON.stringify([...(job.approval?.platforms || [])].sort()) !== JSON.stringify(["facebook", "instagram"])) errors.push("approval must name both platforms");
    if (!job.approval?.approved_at || job.approval?.vienna_slot !== job.publishing?.vienna_slot) errors.push("approved slot is absent or inconsistent");
    if (!job.outputs?.public_video_url || !job.outputs?.public_thumbnail_url) errors.push("stable public asset URLs are required");
    if (!["approved", "scheduling", "scheduled"].includes(job.state)) errors.push("state must be approved, scheduling, or scheduled");
  }
  if (errors.length) throw new Error(`job_invalid:${errors.join("; ")}`);
}

async function verifyArtifacts(job, fixture) {
  const files = {master: job.outputs.master_path, thumbnail: job.outputs.thumbnail_path, caption: job.outputs.caption_path};
  const actual = {};
  for (const [name, file] of Object.entries(files)) {
    if (!file) throw new Error(`missing local ${name} path`);
    actual[name] = await sha256(file);
    if (actual[name] !== job.approval.artifact_sha256?.[name]) throw new Error(`${name} changed after approval`);
  }
  const urls = [
    ["video", job.outputs.public_video_url, "video/", 100_000],
    ["thumbnail", job.outputs.public_thumbnail_url, "image/", 10_000]
  ];
  const remote = {};
  for (const [name, rawUrl, contentPrefix, minimum] of urls) {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || [...url.searchParams.keys()].some(key => /token|signature|expires|x-amz/i.test(key))) throw new Error(`${name} URL is not stable HTTPS`);
    if (fixture) {
      remote[name] = fixture.assets?.[name] || {status: 200, content_type: `${contentPrefix}fixture`, content_length: minimum + 1};
    } else {
      const response = await fetch(url, {method: "HEAD", redirect: "follow"});
      remote[name] = {status: response.status, content_type: response.headers.get("content-type") || "", content_length: Number(response.headers.get("content-length") || 0)};
    }
    if (remote[name].status < 200 || remote[name].status >= 300 || !remote[name].content_type.startsWith(contentPrefix) || remote[name].content_length < minimum) throw new Error(`${name} public asset verification failed`);
  }
  return {hashes: actual, remote};
}

function auditQueue(schedule, job, captionText) {
  const target = Date.parse(job.publishing.vienna_slot);
  if (!Number.isFinite(target)) throw new Error("invalid Vienna slot");
  const idMatches = schedule.posts.filter(post => post.id === job.reel_id);
  const slotMatches = schedule.posts.filter(post => Date.parse(post.scheduledAt) === target);
  const caption = normalize(captionText.slice(0, 80));
  const captionMatches = caption ? schedule.posts.filter(post => normalize(post.captionMatch).startsWith(caption) || caption.startsWith(normalize(post.captionMatch))) : [];
  if (idMatches.length > 1 || slotMatches.length > 1) throw new Error("queue contains duplicate IDs or slots");
  if (slotMatches.length === 1 && slotMatches[0].id !== job.reel_id) throw new Error(`slot occupied by ${slotMatches[0].id}`);
  if (captionMatches.some(post => post.id !== job.reel_id)) throw new Error("caption appears registered under another ID");
  if (idMatches.length === 1 && Date.parse(idMatches[0].scheduledAt) !== target) throw new Error("existing ID has a different slot");
  return {existing: idMatches[0] || null, slot: job.publishing.vienna_slot, posts_scanned: schedule.posts.length};
}

function secretName(reelId) {
  const value = `${reelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_QUEUE`;
  if (value.length > 90) throw new Error("reel_id is too long for a dedicated secret name");
  return value;
}
function workflowName(reelId) { return `publish-${reelId}.yml`; }
function renderWorkflow(job, secret) {
  const epoch = Math.floor(Date.parse(job.publishing.vienna_slot) / 1000);
  return `name: Publish ${job.creative.title} (Instagram, isolated)\n\non:\n  schedule:\n    - cron: "*/5 * * * *"\n  workflow_dispatch:\n\nconcurrency:\n  group: publish-${job.reel_id}\n  cancel-in-progress: false\n\npermissions:\n  contents: read\n\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    timeout-minutes: 360\n    env:\n      CI: "false"\n      COMPOSIO_API_KEY: \${{ secrets.COMPOSIO_API_KEY }}\n      COMPOSIO: /home/runner/.composio/composio\n      IG_ACCOUNT: aliveawake-main\n      IG_USER_ID: "28033607902927427"\n      QUEUE_JSON: \${{ secrets.${secret} }}\n      PUBLISH_AT_EPOCH: "${epoch}"\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: main\n      - name: Install and authenticate Composio CLI\n        run: |\n          for attempt in 1 2 3; do\n            curl -fsSL https://composio.dev/install | COMPOSIO_INSTALL_SHELL=none sh && break\n            sleep 10\n          done\n          test -x "$COMPOSIO"\n          "$COMPOSIO" login --user-api-key "$COMPOSIO_API_KEY" -y --no-skill-install\n      - name: Publish with bounded duplicate reconciliation\n        run: node scripts/publish-isolated-instagram.mjs\n`;
}

async function checkpoint(jobFile, job, step) {
  job.publishing.transaction.last_completed_step = step;
  job.publishing.transaction.error = "";
  await writeJson(jobFile, job);
}

async function composio(tool, account, payload, fixture) {
  if (fixture) {
    const value = fixture.composio?.[tool];
    if (!value) throw new Error(`fixture missing ${tool}`);
    return value;
  }
  return (await executeComposioCli(tool, account, payload)).data;
}

async function facebookSchedule(job, captionText, fixture) {
  const account = process.env.FB_ACCOUNT || "facebook_urushi-influx";
  const pageId = process.env.FB_PAGE_ID || "299121263767927";
  const epoch = Math.floor(Date.parse(job.publishing.vienna_slot) / 1000);
  let videoId = job.publishing.facebook.video_id;
  let postId = job.publishing.facebook.post_id;
  const prefix = normalize(captionText).slice(0, 80);
  const readScheduled = async () => {
    const response = await composio("FACEBOOK_GET_SCHEDULED_POSTS", account, {page_id: pageId, limit: 100, fields: "id,message,scheduled_publish_time,is_published"}, fixture);
    return (response.data || response).filter(row => Number(row.scheduled_publish_time) === epoch && normalize(row.message).startsWith(prefix) && row.is_published === false);
  };
  let scheduled = await readScheduled();
  if (scheduled.length > 1) throw new Error("Facebook preflight found multiple exact scheduled matches");
  if (scheduled.length === 1) {
    if (postId && String(postId) !== String(scheduled[0].id)) throw new Error("Facebook scheduled-post ID conflicts with platform state");
    postId = String(scheduled[0].id);
    const videosResponse = await composio("FACEBOOK_GET_PAGE_VIDEOS", account, {page_id: pageId, limit: 100, fields: "id,description,title,status"}, fixture);
    const videos = (videosResponse.data || videosResponse).filter(row => normalize(row.description).startsWith(prefix));
    if (videoId) {
      const exact = videos.filter(row => String(row.id) === String(videoId));
      if (exact.length !== 1) throw new Error("Facebook exact video ID did not match the scheduled caption object");
    } else {
      if (videos.length !== 1) throw new Error(`Facebook scheduled object exists but exact video reconciliation found ${videos.length} matches`);
      videoId = String(videos[0].id);
    }
  } else if (videoId || postId) {
    throw new Error("job records a Facebook object that the exact platform preflight did not find");
  }
  if (!videoId) {
    const created = await composio("FACEBOOK_CREATE_VIDEO_POST", account, {
      page_id: pageId, file_url: job.outputs.public_video_url, title: job.creative.title,
      description: captionText, published: false, scheduled_publish_time: epoch
    }, fixture);
    videoId = created.id || created.video_id;
    if (!videoId || videoId === "<REDACTED>") throw new Error("Facebook returned no usable video ID");
    scheduled = await readScheduled();
    if (scheduled.length !== 1) throw new Error(`Facebook post-create verification found ${scheduled.length} exact matches`);
    postId = String(scheduled[0].id);
  }
  return {status: "scheduled", video_id: String(videoId), post_id: String(postId), scheduled_epoch: epoch, verified: true};
}

async function registerFiles(repo, schedule, job, captionText, facebook, secret) {
  const workflow = workflowName(job.reel_id);
  const workflowPath = path.join(repo, ".github", "workflows", workflow);
  const captionMatch = normalize(captionText).slice(0, 80);
  const row = {
    id: job.reel_id, scheduledAt: job.publishing.vienna_slot, title: job.creative.title, captionMatch,
    overall: "scheduled", instagram: {status: "queued_isolated", verified: true, workflow: `.github/workflows/${workflow}`},
    facebook: {status: "scheduled", verified: true, videoId: facebook.video_id, scheduledPostId: facebook.post_id, scheduledPublishTime: facebook.scheduled_epoch}
  };
  const existingIndex = schedule.posts.findIndex(post => post.id === job.reel_id);
  if (existingIndex >= 0) {
    const existing = schedule.posts[existingIndex];
    if (existing.facebook?.videoId && existing.facebook.videoId !== facebook.video_id) throw new Error("public queue Facebook ID conflicts with verified object");
    schedule.posts[existingIndex] = {...existing, ...row};
  } else schedule.posts.push(row);
  schedule.posts.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  schedule.updatedAt = new Date().toISOString();
  await writeJson(path.join(repo, "docs", "schedule.json"), schedule);
  await fs.writeFile(workflowPath, renderWorkflow(job, secret));

  const configPath = path.join(repo, "config", "isolated-queues.json");
  const config = await readJson(configPath);
  const collision = Object.entries(config).find(([id, value]) => id !== job.reel_id && value === secret);
  if (collision) throw new Error(`private secret name already belongs to ${collision[0]}`);
  if (config[job.reel_id] && config[job.reel_id] !== secret) throw new Error("existing Reel ID maps to a different private secret");
  config[job.reel_id] = secret;
  await writeJson(configPath, Object.fromEntries(Object.entries(config).sort()));
  const integrityPath = path.join(repo, ".github", "workflows", "check-queue-integrity.yml");
  let integrity = await fs.readFile(integrityPath, "utf8");
  const envLine = `      ${secret}: \${{ secrets.${secret} }}\n`;
  if (!integrity.includes(envLine.trim())) {
    const marker = "    steps:\n";
    if (!integrity.includes(marker)) throw new Error("integrity workflow env insertion marker missing");
    integrity = integrity.replace(marker, `${envLine}${marker}`);
    await fs.writeFile(integrityPath, integrity);
  }
  return {workflow, paths: ["docs/schedule.json", `.github/workflows/${workflow}`, "config/isolated-queues.json", ".github/workflows/check-queue-integrity.yml"]};
}

async function updateWorkerAllowlist(workflow, fixture, action = "add") {
  if (fixture) {
    if (fixture.worker?.inconsistent) throw new Error("fixture Worker state is inconsistent");
    return {verified: true, workflow, action, etag: "fixture"};
  }
  const token = run("security", ["find-generic-password", "-a", "eyalshoval", "-s", "cloudflare-api-token", "-w"]);
  const headers = {Authorization: `Bearer ${token}`};
  const accounts = await fetch("https://api.cloudflare.com/client/v4/accounts", {headers}).then(response => response.json());
  const accountId = accounts.result?.[0]?.id;
  if (!accountId) throw new Error("Cloudflare account unavailable");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/services/aliveawake-cron-kicker/environments/production`;
  const response = await fetch(`${base}/content`, {headers});
  if (!response.ok) throw new Error(`Worker read failed: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
  const multipart = await response.text();
  const match = boundary && /name="worker\.js"\r?\n(?:Content-Type:[^\n]+\r?\n)?\r?\n([\s\S]*?)\r?\n--/.exec(multipart);
  if (!match) throw new Error("Worker module could not be extracted safely");
  let source = match[1];
  const arrayMatch = /var ISOLATED_ONE_OFFS = \[([\s\S]*?)\];/.exec(source);
  if (!arrayMatch) throw new Error("Worker allowlist marker missing");
  const values = [...arrayMatch[1].matchAll(/"([^"]+\.yml)"/g)].map(row => row[1]);
  if (action === "add" && !values.includes(workflow)) values.push(workflow);
  if (action === "remove") values.splice(0, values.length, ...values.filter(value => value !== workflow));
  const rendered = `\n${values.sort().map(value => `  "${value}"`).join(",\n")}\n`;
  source = source.replace(arrayMatch[0], `var ISOLATED_ONE_OFFS = [${rendered}];`);
  const form = new FormData();
  form.append("worker.js", new Blob([source], {type: "application/javascript+module"}), "worker.js");
  form.append("metadata", new Blob([JSON.stringify({main_module: "worker.js", compatibility_date: "2026-08-26", bindings: [{name: "GH_PAT", type: "secret_text"}]})], {type: "application/json"}), "metadata.json");
  const uploaded = await fetch(base, {method: "PUT", headers, body: form});
  if (!uploaded.ok) throw new Error(`Worker update failed: HTTP ${uploaded.status}`);
  const verify = await fetch(`${base}/content`, {headers}).then(row => row.text());
  const present = verify.includes(`"${workflow}"`);
  if ((action === "add" && !present) || (action === "remove" && present)) throw new Error("Worker allowlist readback failed");
  return {verified: true, workflow, action};
}

async function waitWorkflow(repo, workflow, fields, fixture) {
  if (fixture) {
    const outcome = fixture.workflows?.[workflow] || {conclusion: "success", id: 1};
    if (outcome.conclusion !== "success") throw new Error(`${workflow} fixture failed`);
    return outcome;
  }
  run("gh", ["workflow", "run", workflow, "--ref", "main", ...fields.flatMap(([key, value]) => ["-f", `${key}=${value}`])], {cwd: repo});
  await new Promise(resolve => setTimeout(resolve, 3000));
  const runs = JSON.parse(run("gh", ["run", "list", "--workflow", workflow, "--limit", "1", "--json", "databaseId,status,conclusion"], {cwd: repo}));
  if (!runs[0]?.databaseId) throw new Error(`${workflow} dispatch was not observed`);
  run("gh", ["run", "watch", String(runs[0].databaseId), "--exit-status"], {cwd: repo});
  return {id: runs[0].databaseId, conclusion: "success"};
}

function statusDriveName(job, status) {
  const slot = new Date(job.publishing.vienna_slot);
  const format = new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(slot);
  const part = type => format.find(value => value.type === type).value;
  const source = job.drive.source_timestamp.replace(/[-:T+]/g, "").slice(0, 14);
  return `AA__${status}__${part("year")}${part("month")}${part("day")}-${part("hour")}${part("minute")}-VIENNA__${source.slice(0, 8)}-${source.slice(8)}__${job.drive.original_name}`;
}

async function renameDrive(job, fixture, status = "SCHEDULED") {
  const account = process.env.DRIVE_ACCOUNT || "aliveawake-drive";
  const before = await composio("GOOGLEDRIVE_GET_FILE_METADATA", account, {fileId: job.drive.file_id, fields: "id,name"}, fixture);
  if (before.name !== job.drive.current_name) throw new Error(`Drive name differs from job state: ${before.name}`);
  const name = statusDriveName(job, status);
  await composio("GOOGLEDRIVE_UPDATE_FILE_PUT", account, {fileId: job.drive.file_id, name, supports_all_drives: true}, fixture);
  const after = fixture ? {...before, name} : await composio("GOOGLEDRIVE_GET_FILE_METADATA", account, {fileId: job.drive.file_id, fields: "id,name"}, fixture);
  if (after.name !== name) throw new Error("Drive rename readback failed");
  return name;
}

async function verifyPhase(args, job, fixture) {
  const schedulePath = path.join(args.repo, "docs", "schedule.json");
  if (args.execute && !fixture) {
    run("git", ["pull", "--ff-only", "origin", "main"], {cwd: args.repo});
    await waitWorkflow(args.repo, "verify-dashboard.yml", [], null);
    run("git", ["pull", "--ff-only", "origin", "main"], {cwd: args.repo});
  }
  const schedule = fixture?.schedule || await readJson(schedulePath);
  const row = schedule.posts.find(post => post.id === job.reel_id);
  if (!row) throw new Error("reel is absent from public queue");
  const result = {
    instagram: {status: row.instagram?.status, verified: row.instagram?.verified === true, media_id: row.instagram?.mediaId || "", url: row.instagram?.url || ""},
    facebook: {status: row.facebook?.status, verified: row.facebook?.verified === true, video_id: row.facebook?.videoId || "", url: row.facebook?.url || ""}
  };
  const bothVerified = result.instagram.status === "published" && result.instagram.verified && result.facebook.status === "published" && result.facebook.verified;
  if (args.execute) {
    job.publishing.instagram = result.instagram;
    job.publishing.facebook = result.facebook;
    if (bothVerified) {
      const workflow = path.basename(job.publishing.instagram.workflow || row.instagram?.workflow || "");
      if (!workflow) throw new Error("verified Instagram row has no registered workflow for Worker cleanup");
      await updateWorkerAllowlist(workflow, fixture, "remove");
      job.publishing.worker_allowlist_verified = false;
      job.drive.current_name = await renameDrive(job, fixture, "DONE");
      job.publishing.drive_status_verified = true;
      job.state = "done";
    }
    await writeJson(args.job, job);
  }
  return {ok: true, phase: "verify", mutating: args.execute, reel_id: job.reel_id, platforms: result, both_independently_verified: bothVerified, final_state: args.execute && bothVerified ? "done" : job.state};
}

async function schedulePhase(args, job, fixture) {
  const schedulePath = path.join(args.repo, "docs", "schedule.json");
  const schedule = fixture?.schedule || await readJson(schedulePath);
  const captionText = await fs.readFile(job.outputs.caption_path, "utf8");
  const assets = await verifyArtifacts(job, fixture);
  const queue = auditQueue(schedule, job, captionText);
  const plan = {ok: true, phase: "schedule", mutating: args.execute, reel_id: job.reel_id, state: job.state, checks: {assets: "verified", queue: "consistent"}, platforms: {instagram: {status: queue.existing?.instagram?.status || "not_registered"}, facebook: {status: queue.existing?.facebook?.status || "not_registered"}}, actions: steps};
  if (!args.execute) return plan;

  job.state = "scheduling";
  job.publishing.transaction = job.publishing.transaction || {};
  job.publishing.transaction.id ||= crypto.randomUUID();
  job.publishing.transaction.started_at ||= new Date().toISOString();
  await checkpoint(args.job, job, "assets");
  await checkpoint(args.job, job, "queue");
  if (queue.existing) {
    const existingFacebook = queue.existing.facebook || {};
    if (job.publishing.facebook.video_id && job.publishing.facebook.video_id !== existingFacebook.videoId) throw new Error("job and public queue disagree on Facebook video ID");
    if (job.publishing.facebook.post_id && job.publishing.facebook.post_id !== existingFacebook.scheduledPostId) throw new Error("job and public queue disagree on Facebook post ID");
    job.publishing.facebook.video_id = existingFacebook.videoId || "";
    job.publishing.facebook.post_id = existingFacebook.scheduledPostId || "";
  }
  const facebook = await facebookSchedule(job, captionText, fixture);
  job.publishing.facebook = facebook;
  await checkpoint(args.job, job, "facebook");
  const secret = secretName(job.reel_id);
  const privatePayload = JSON.stringify({id: job.reel_id, videoUrl: job.outputs.public_video_url, coverUrl: job.outputs.public_thumbnail_url, caption: captionText});
  if (!fixture) run("gh", ["secret", "set", secret, "--body", privatePayload], {cwd: args.repo});
  await checkpoint(args.job, job, "private_queue");
  const registration = await registerFiles(args.repo, schedule, job, captionText, facebook, secret);
  if (!fixture) {
    run("git", ["add", ...registration.paths], {cwd: args.repo});
    run("git", ["commit", "-m", `Schedule ${job.creative.title}`], {cwd: args.repo});
    run("git", ["pull", "--rebase", "origin", "main"], {cwd: args.repo});
    run("git", ["push", "origin", "HEAD:main"], {cwd: args.repo});
  }
  job.publishing.instagram = {status: "queued_isolated", workflow: `.github/workflows/${registration.workflow}`, media_id: "", url: ""};
  await checkpoint(args.job, job, "public_queue");
  await updateWorkerAllowlist(registration.workflow, fixture);
  job.publishing.worker_allowlist_verified = true;
  await checkpoint(args.job, job, "worker");
  await waitWorkflow(args.repo, "check-queue-integrity.yml", [], fixture);
  job.publishing.queue_integrity_verified = true;
  await checkpoint(args.job, job, "integrity");
  const driveName = await renameDrive(job, fixture);
  job.drive.current_name = driveName;
  job.publishing.drive_status_verified = true;
  await checkpoint(args.job, job, "drive");
  await waitWorkflow(args.repo, "send-scheduled.yml", [["reel_title", job.creative.title], ["scheduled_slot", job.publishing.vienna_slot], ["video_url", job.outputs.public_video_url]], fixture);
  job.publishing.telegram_status_verified = true;
  job.state = "scheduled";
  await checkpoint(args.job, job, "telegram");
  return {...plan, state: "scheduled", platforms: {instagram: {status: "queued_isolated", registration_verified: true}, facebook: {status: facebook.status, video_id: facebook.video_id, post_id: facebook.post_id, verified: facebook.verified}}, checks: {...plan.checks, private_queue: "verified_by_ci", worker: "verified", drive: "verified", telegram: "verified"}};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const job = await readJson(args.job);
  validateJob(job, args.phase);
  const fixture = args.fixture ? await readJson(args.fixture) : null;
  if (args.execute && !fixture) {
    const dirty = run("git", ["status", "--porcelain"], {cwd: args.repo});
    if (dirty) throw new Error("publishing repo has uncommitted changes; refusing live workflow");
    run("git", ["fetch", "origin", "main"], {cwd: args.repo});
    const local = run("git", ["rev-parse", "HEAD"], {cwd: args.repo});
    const remote = run("git", ["rev-parse", "origin/main"], {cwd: args.repo});
    if (local !== remote) throw new Error("publishing repo is not exactly at origin/main; sync before live execution");
    preflightCapabilities(args.repo);
  }
  return args.phase === "verify" ? verifyPhase(args, job, fixture) : schedulePhase(args, job, fixture);
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  console.log(JSON.stringify({ok: false, error: compactError(error), stopped_safely: true}));
  process.exitCode = 2;
}
