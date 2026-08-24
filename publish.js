import { readFileSync, existsSync } from 'node:fs';

// Load .env for local runs. In GitHub Actions, env vars come from secrets/inputs instead.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const GRAPH_VERSION = 'v26.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ACCESS_TOKEN = requireEnv('IG_ACCESS_TOKEN');
const IG_BUSINESS_ACCOUNT_ID = requireEnv('IG_BUSINESS_ACCOUNT_ID');
const FB_PAGE_ID = requireEnv('FB_PAGE_ID');
const VIDEO_URL = requireEnv('VIDEO_URL');
const CAPTION = process.env.CAPTION ?? '';
const COVER_URL = process.env.COVER_URL || undefined;
const THUMB_OFFSET = process.env.THUMB_OFFSET || undefined;
const MEDIA_TYPE = process.env.MEDIA_TYPE || 'REELS'; // REELS (recommended) or VIDEO (legacy feed video)
const LOCATION_QUERY = process.env.LOCATION_QUERY || undefined; // free-text place name to look up
const LOCATION_ID = process.env.LOCATION_ID || undefined; // exact Facebook Place ID, skips lookup if set

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[publish] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function graphRequest(path, method, params) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: ACCESS_TOKEN });

  const res = method === 'GET'
    ? await fetch(`${url}?${body.toString()}`)
    : await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

  const json = await res.json();
  if (!res.ok || json.error) {
    console.error(`[publish] Graph API error on ${method} ${path}:`, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

async function resolveLocationId() {
  if (LOCATION_ID) return LOCATION_ID;
  if (!LOCATION_QUERY) return undefined;

  console.log(`[publish] Looking up location for "${LOCATION_QUERY}"...`);
  const { data } = await graphRequest('pages/search', 'GET', {
    q: LOCATION_QUERY,
    type: 'place',
    fields: 'name,location',
  });
  if (!data || data.length === 0) {
    console.error(`[publish] No location found for "${LOCATION_QUERY}" — proceeding without a location tag.`);
    return undefined;
  }
  console.log(`[publish] Using location: ${data[0].name} (${data[0].id})`);
  return data[0].id;
}

async function createContainer(locationId) {
  const params = {
    media_type: MEDIA_TYPE,
    video_url: VIDEO_URL,
    caption: CAPTION,
  };
  if (COVER_URL) params.cover_url = COVER_URL;
  else if (THUMB_OFFSET) params.thumb_offset = THUMB_OFFSET;
  if (locationId) params.location_id = locationId;

  console.log('[publish] Creating Instagram media container...');
  const { id } = await graphRequest(`${IG_BUSINESS_ACCOUNT_ID}/media`, 'POST', params);
  console.log(`[publish] Container created: ${id}`);
  return id;
}

async function waitForContainerReady(containerId, { maxAttempts = 30, delayMs = 10_000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { status_code, status } = await graphRequest(
      containerId,
      'GET',
      { fields: 'status_code,status' }
    );
    console.log(`[publish] Poll ${attempt}/${maxAttempts}: status_code=${status_code}`);

    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR') {
      console.error('[publish] Container processing failed:', status);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.error('[publish] Timed out waiting for video processing to finish.');
  process.exit(1);
}

async function publishToInstagram(locationId) {
  const containerId = await createContainer(locationId);
  await waitForContainerReady(containerId);
  console.log('[publish] Publishing Instagram container...');
  const { id } = await graphRequest(`${IG_BUSINESS_ACCOUNT_ID}/media_publish`, 'POST', {
    creation_id: containerId,
  });
  console.log(`[publish] Instagram done. Media ID: ${id} — https://www.instagram.com/p/${id}/ (permalink may take a moment to resolve)`);
  return id;
}

async function publishToFacebookPage(locationId) {
  console.log('[publish] Publishing to the Facebook Page...');
  const params = {
    file_url: VIDEO_URL,
    description: CAPTION,
  };
  if (locationId) params.place = locationId;

  const { id } = await graphRequest(`${FB_PAGE_ID}/videos`, 'POST', params);
  console.log(`[publish] Facebook done. Video ID: ${id}`);
  return id;
}

async function main() {
  const locationId = await resolveLocationId();

  // Instagram first: if this fails, graphRequest exits before Facebook is attempted.
  await publishToInstagram(locationId);

  // Facebook is a separate, independent publish call — a failure here is reported
  // on its own and does not retroactively hide the Instagram success already logged above.
  await publishToFacebookPage(locationId);

  console.log('[publish] Done — posted to both Instagram and Facebook.');
}

main().catch((err) => {
  console.error('[publish] Unexpected error:', err);
  process.exit(1);
});
