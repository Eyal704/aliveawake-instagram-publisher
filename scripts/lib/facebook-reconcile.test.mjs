import assert from "node:assert/strict";
import test from "node:test";
import { resolveFacebookVideo } from "./facebook-reconcile.mjs";

const due = Date.parse("2026-09-03T16:00:00Z");

function video({id, description, publishTime = "2026-09-03T16:00:14+0000", ready = true, published = true}) {
  return {
    id,
    description,
    permalink_url: `/reel/${id}/`,
    status: {
      video_status: ready ? "ready" : "processing",
      publishing_phase: {publish_status: published ? "published" : "draft", publish_time: publishTime}
    }
  };
}

const caption = "responsibility for your life is not self-blame. whether you're in pain or in joy";
const live = video({id: "1095132296499239", description: "Responsibility for your life is not self-blame.\n\nWhether you're in pain or in joy, you had a hand in it."});

test("uses the recorded video ID when it is live", () => {
  const result = resolveFacebookVideo({videoId: "1095132296499239", captionMatch: caption, videos: [live], due});
  assert.equal(result.outcome, "published");
  assert.equal(result.videoId, "1095132296499239");
});

test("heals a stale ID by matching the caption inside the window", () => {
  // The real 2026-09-03 failure: the scheduled post's permalink handed back the
  // page-post ID, so the recorded videoId never existed as a video object.
  const result = resolveFacebookVideo({videoId: "1360990329448501", captionMatch: caption, videos: [live], due});
  assert.equal(result.outcome, "published");
  assert.equal(result.videoId, "1095132296499239");
  assert.equal(result.video.permalink_url, "/reel/1095132296499239/");
});

test("reports duplicate when two live videos share the caption prefix", () => {
  const twin = video({id: "999", description: live.description});
  const result = resolveFacebookVideo({videoId: "missing", captionMatch: caption, videos: [live, twin], due});
  assert.equal(result.outcome, "duplicate");
  assert.equal(result.videoId, null);
});

test("does not match a video published far outside the slot window", () => {
  const stale = video({...live, publishTime: "2026-08-20T16:00:00+0000"});
  const result = resolveFacebookVideo({videoId: "missing", captionMatch: caption, videos: [stale], due});
  assert.equal(result.outcome, "none");
});

test("does not match a video that is not finished publishing", () => {
  const pending = video({id: "1095132296499239", description: live.description, published: false});
  const result = resolveFacebookVideo({videoId: "1095132296499239", captionMatch: caption, videos: [pending], due});
  assert.equal(result.outcome, "none");
});

test("reports none when nothing matches", () => {
  const other = video({id: "42", description: "A completely different Reel."});
  const result = resolveFacebookVideo({videoId: "missing", captionMatch: caption, videos: [other], due});
  assert.equal(result.outcome, "none");
});

test("tolerates a raw, unnormalized captionMatch", () => {
  const result = resolveFacebookVideo({
    videoId: "missing",
    captionMatch: "Responsibility for your life is not self-blame.\n\nWhether you're in pain",
    videos: [live],
    due
  });
  assert.equal(result.outcome, "published");
});

test("never matches on an empty caption", () => {
  const result = resolveFacebookVideo({videoId: "missing", captionMatch: "", videos: [live], due});
  assert.equal(result.outcome, "none");
});
