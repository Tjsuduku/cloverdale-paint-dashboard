// Sync Metricool scheduler posts into Supabase content_calendar.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Node 20, no dependencies.

const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing env vars: ' + missing.join(', '));
  process.exit(1);
}
const E = process.env;
const TZ = 'America/Vancouver';
const DAYS_BACK = 90;
const DAYS_AHEAD = 60;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

// Convert a local wall-clock time ("YYYY-MM-DDTHH:mm:ss" in tz) to a UTC ISO string.
function localToIso(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(asUtc));
  const g = (t) => +parts.find((p) => p.type === t).value;
  const shown = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

async function fetchPosts() {
  const now = Date.now();
  const q = new URLSearchParams({
    userId: E.METRICOOL_USER_ID,
    blogId: E.METRICOOL_BRAND_ID,
    start: fmt(new Date(now - DAYS_BACK * 864e5)),
    end: fmt(new Date(now + DAYS_AHEAD * 864e5)),
    timezone: TZ,
    extendedRange: 'false',
  });
  const url = `https://app.metricool.com/api/v2/scheduler/posts?${q}`;
  const res = await fetch(url, { headers: { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Metricool ${res.status}: ${body.slice(0, 500)}`);
  const json = JSON.parse(body);
  const list = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(list)) throw new Error('Unexpected Metricool response: ' + body.slice(0, 500));
  return list;
}

function toRows(posts) {
  const rows = new Map();
  const syncedAt = new Date().toISOString();
  for (const p of posts) {
    const pd = p.publicationDate || {};
    const iso = localToIso(pd.dateTime, pd.timezone || TZ);
    if (!iso) continue;
    const type = (p.instagramData && p.instagramData.type) || (p.facebookData && p.facebookData.type) || 'POST';
    const caption = (p.text || '').trim() || `[${type.toLowerCase()}]`;
    for (const pr of p.providers || []) {
      const network = (pr.network || '').toLowerCase();
      if (!network) continue;
      let status = (pr.status || 'scheduled').toLowerCase();
      if (p.draft) status = 'draft';
      const id = `${p.uuid || p.id}-${network}`;
      rows.set(id, {
        external_id: id,
        platform: network,
        caption,
        publication_date: iso,
        status,
        public_url: pr.publicUrl || null,
        synced_at: syncedAt,
      });
    }
  }
  return [...rows.values()];
}

async function upsert(rows) {
  const key = E.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${E.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/content_calendar?on_conflict=external_id`;
  for (let i = 0; i < rows.length; i += 200) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

(async () => {
  const posts = await fetchPosts();
  console.log(`Metricool returned ${posts.length} posts`);
  const rows = toRows(posts);
  console.log(`Upserting ${rows.length} rows`);
  if (rows.length) await upsert(rows);
  console.log('Done');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
