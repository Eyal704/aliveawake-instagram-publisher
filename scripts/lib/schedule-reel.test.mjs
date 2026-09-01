import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/schedule-reel.mjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

async function setup({occupied = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aliveawake-schedule-test-"));
  const repo = path.join(root, "repo");
  const output = path.join(root, "output");
  await fs.mkdir(path.join(repo, "docs"), {recursive: true});
  await fs.mkdir(path.join(repo, "config"), {recursive: true});
  await fs.mkdir(path.join(repo, ".github", "workflows"), {recursive: true});
  await fs.mkdir(output);
  const files = {master: "master-bytes", thumbnail: "thumbnail-bytes", caption: "A precise approved caption.\n\n#aliveawake"};
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(output, name), content);
  const slot = "2026-09-02T09:00:00+02:00";
  const schedule = {timezone: "Europe/Vienna", posts: occupied ? [{id: "other-reel", scheduledAt: slot, captionMatch: "other", instagram: {}, facebook: {}}] : []};
  await fs.writeFile(path.join(repo, "docs", "schedule.json"), JSON.stringify(schedule));
  await fs.writeFile(path.join(repo, "config", "isolated-queues.json"), "{}\n");
  await fs.writeFile(path.join(repo, ".github", "workflows", "check-queue-integrity.yml"), "jobs:\n  check:\n    env:\n    steps:\n");
  const job = {
    version: 2, reel_id: "fixture-reel-one", state: "approved",
    drive: {file_id: "drive-1", original_name: "IMG_0001.mov", source_timestamp: "2026-09-01T07:00:00+02:00", current_name: "AA__READY__20260901-070000__IMG_0001.mov"},
    creative: {title: "Fixture Reel"},
    outputs: {
      master_path: path.join(output, "master"), thumbnail_path: path.join(output, "thumbnail"), caption_path: path.join(output, "caption"),
      public_video_url: "https://example.com/reel.mp4", public_thumbnail_url: "https://example.com/cover.png"
    },
    approval: {publishing_approved: true, approved_at: "2026-09-01T08:00:00+02:00", platforms: ["instagram", "facebook"], vienna_slot: slot, artifact_sha256: {master: hash(files.master), thumbnail: hash(files.thumbnail), caption: hash(files.caption)}},
    publishing: {vienna_slot: slot, instagram: {status: "not_registered"}, facebook: {status: "not_registered", video_id: "", post_id: ""}, transaction: {}}
  };
  const jobPath = path.join(output, "reel-job.json");
  await fs.writeFile(jobPath, JSON.stringify(job));
  const fixture = {
    assets: {video: {status: 200, content_type: "video/mp4", content_length: 100001}, thumbnail: {status: 200, content_type: "image/png", content_length: 10001}},
    schedule,
    composio: {
      FACEBOOK_CREATE_VIDEO_POST: {id: "fb-video-1"},
      FACEBOOK_GET_SCHEDULED_POSTS: {data: [{id: "fb-post-1", message: files.caption, scheduled_publish_time: 1788332400, is_published: false}]},
      FACEBOOK_GET_PAGE_VIDEOS: {data: [{id: "fb-video-1", description: files.caption, status: {video_status: "ready"}}]},
      GOOGLEDRIVE_GET_FILE_METADATA: {id: "drive-1", name: job.drive.current_name},
      GOOGLEDRIVE_UPDATE_FILE_PUT: {id: "drive-1"}
    },
    worker: {}, workflows: {"check-queue-integrity.yml": {id: 1, conclusion: "success"}, "send-scheduled.yml": {id: 2, conclusion: "success"}}
  };
  const fixturePath = path.join(root, "fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture));
  return {root, repo, jobPath, fixturePath};
}

test("fixture execution completes every scheduling checkpoint without live operations", async t => {
  const paths = await setup();
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  const result = spawnSync(process.execPath, [script, paths.jobPath, "--execute", "--fixture", paths.fixturePath, "--repo", paths.repo], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.platforms.instagram.registration_verified, true);
  assert.equal(output.platforms.facebook.verified, true);
  const job = JSON.parse(await fs.readFile(paths.jobPath, "utf8"));
  assert.equal(job.state, "scheduled");
  assert.equal(job.publishing.transaction.last_completed_step, "telegram");
  assert.equal(job.publishing.queue_integrity_verified, true);
  assert.equal((JSON.parse(await fs.readFile(path.join(paths.repo, "docs", "schedule.json"), "utf8"))).posts.length, 1);
});

test("occupied slot stops before any mutation", async t => {
  const paths = await setup({occupied: true});
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  const before = await fs.readFile(paths.jobPath, "utf8");
  const result = spawnSync(process.execPath, [script, paths.jobPath, "--execute", "--fixture", paths.fixturePath, "--repo", paths.repo], {encoding: "utf8"});
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.stopped_safely, true);
  assert.match(output.error, /slot occupied/);
  assert.equal(await fs.readFile(paths.jobPath, "utf8"), before);
});

test("verification keeps Drive scheduled when only Instagram is independently live", async t => {
  const paths = await setup();
  t.after(() => fs.rm(paths.root, {recursive: true, force: true}));
  const job = JSON.parse(await fs.readFile(paths.jobPath, "utf8"));
  job.state = "scheduled";
  job.drive.current_name = "AA__SCHEDULED__20260902-0900-VIENNA__20260901-070000__IMG_0001.mov";
  job.publishing.instagram = {status: "queued_isolated", workflow: ".github/workflows/publish-fixture-reel-one.yml"};
  await fs.writeFile(paths.jobPath, JSON.stringify(job));
  const fixture = JSON.parse(await fs.readFile(paths.fixturePath, "utf8"));
  fixture.schedule.posts = [{
    id: job.reel_id, scheduledAt: job.publishing.vienna_slot,
    instagram: {status: "published", verified: true, mediaId: "ig-1", url: "https://instagram.example/ig-1", workflow: job.publishing.instagram.workflow},
    facebook: {status: "scheduled", verified: true, videoId: "fb-video-1"}
  }];
  fixture.composio.GOOGLEDRIVE_GET_FILE_METADATA.name = job.drive.current_name;
  await fs.writeFile(paths.fixturePath, JSON.stringify(fixture));
  const result = spawnSync(process.execPath, [script, paths.jobPath, "--phase", "verify", "--execute", "--fixture", paths.fixturePath, "--repo", paths.repo], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.both_independently_verified, false);
  const after = JSON.parse(await fs.readFile(paths.jobPath, "utf8"));
  assert.equal(after.state, "scheduled");
  assert.equal(after.drive.current_name, job.drive.current_name);
  assert.equal(after.publishing.instagram.verified, true);
  assert.equal(after.publishing.facebook.verified, true);
});
