const GRAPH_VERSION = 'v26.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const token = process.env.IG_ACCESS_TOKEN;
const pageId = process.env.FB_PAGE_ID;

if (!token || !pageId) {
  console.error('Missing IG_ACCESS_TOKEN or FB_PAGE_ID');
  process.exit(1);
}

async function inspect(label, path, fields) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  url.searchParams.set('access_token', token);
  if (fields) url.searchParams.set('fields', fields);

  const response = await fetch(url);
  const body = await response.json();
  if (body && typeof body === 'object' && 'access_token' in body) {
    body.has_page_access_token = Boolean(body.access_token);
    delete body.access_token;
  }
  if (Array.isArray(body?.data)) {
    body.data = body.data.map((item) => {
      if (!item || typeof item !== 'object' || !('access_token' in item)) return item;
      const safe = {...item, has_page_access_token: Boolean(item.access_token)};
      delete safe.access_token;
      return safe;
    });
  }

  console.log(`\n[diagnostic] ${label} (HTTP ${response.status})`);
  console.log(JSON.stringify(body, null, 2));
}

await inspect('Token identity', 'me', 'id,name');
await inspect('Granted permissions', 'me/permissions');
await inspect('Target Page visibility and tasks', pageId, 'id,name,tasks,access_token');
await inspect('Pages available through /me/accounts', 'me/accounts', 'id,name,tasks,access_token');

