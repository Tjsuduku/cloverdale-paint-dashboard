// Pulls daily social metrics (followers, reach, interactions, posts) from Metricool's
// analytics timeline API and upserts them into Supabase social_metrics_daily.
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Node 20, no dependencies.

const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing env vars: ' + missing.join(', '));
  process.exit(1);
}
const E = process.env;
const DAYS_BACK = 35;

// platform -> metric -> Metricool Data Studio field id
const METRICS = [
  { platform: 'instagram', metric: 'followers', fieldId: 'IGEV01', label: 'Followers' },
  { platform: 'instagram', metric: 'reach', fieldId: 'IGEV06', label: 'Reach' },
  { platform: 'instagram', metric: 'interactions', fieldId: 'IGEV09', label: 'Interactions' },
  { platform: 'instagram', metric: 'posts', fieldId: 'IGEV37', label: 'Posts' },

  { platform: 'facebook', metric: 'followers', fieldId: 'FBEV17', label: 'Followers' },
  { platform: 'facebook', metric: 'reach', fieldId: 'FBEV11', label: 'Reach' },
  { platform: 'facebook', metric: 'interactions', fieldId: 'FBEV10', label: 'Interactions' },
  { platform: 'facebook', metric: 'posts', fieldId: 'FBEV33', label: 'Posts' },

  { platform: 'linkedin', metric: 'followers', fieldId: 'LIEV01', label: 'Followers' },
  { platform: 'linkedin', metric: 'reach', fieldId: 'LIEV22', label: 'Impressions (used as reach)' },
  { platform: 'linkedin', metric: 'interactions', fieldId: 'LIEV28', label: 'Interactions' },
  { platform: 'linkedin', metric: 'posts', fieldId: 'LIEV27', label: 'Posts' },

  { platform: 'youtube', metric: 'followers', fieldId: 'YTEV01', label: 'Subscribers' },
  { platform: 'youtube', metric: 'reach', fieldId: 'YTEV02', label: 'Views (used as reach)' },
  { platform: 'youtube', metric: 'interactions', fieldId: 'YTEV14', label: 'Likes (used as interactions)' },
  { platform: 'youtube', metric: 'posts', fieldId: 'YTEV04', label: 'Videos' },
];

const pad = (n) => String(n).padStart(2, '0');
const toYYYYMMDD = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const toISODate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

async function fetchTimeline(fieldId, start, end) {
  const params = new URLSearchParams({
    start,
    end,
    blogId: E.METRICOOL_BRAND_ID,
    userId: E.METRICOOL_USER_ID,
  });
  const url = `https://app.metricool.com/api/stats/timeline/${fieldId}?${params}`;
  const res = await fetch(url, { headers: { 'X-Mc-Auth': E.METRICOOL_API_TOKEN, Accept: 'application/json' } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Metricool ${res.status} for ${fieldId}: ${body.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Non-JSON response for ${fieldId}: ${body.slice(0, 300)}`);
  }
  return json;
}

// Metricool's timeline response shape hasn't been confirmed against a live token yet.
// Handle the plausible shapes defensively and log whatever we actually got on the
// first metric so a real run's Action log tells us immediately if this needs adjusting.
function extractPoints(json, fieldId, logSample) {
  let list = null;
  if (Array.isArray(json)) list = json;
  else if (Array.isArray(json?.data)) list = json.data;
  else if (Array.isArray(json?.values)) list = json.values;
  else if (Array.isArray(json?.rows)) list = json.rows;

  if (logSample) console.log(`Sample response for ${fieldId}:`, JSON.stringify(json).slice(0, 500));
  if (!list) return [];

  const points = [];
  for (const row of list) {
    let date, value;
    if (Array.isArray(row)) {
      // [value, ..., "YYYYMMDD"] (data-studio style) or [date, value]
      const last = row[row.length - 1];
      if (typeof last === 'string' && /^\d{8}$/.test(last)) {
        date = toISODate(last);
        value = row[0];
      } else {
        [date, value] = row;
      }
    } else if (row && typeof row === 'object') {
      date = row.date || row.day || row.timestamp;
      value = row.value ?? row.count ?? row.total;
      if (typeof date === 'string' && /^\d{8}$/.test(date)) date = toISODate(date);
    }
    if (!date || value === null || value === undefined || value === '') continue;
    const num = Number(value);
    if (Number.isNaN(num)) continue;
    points.push({ date: String(date).slice(0, 10), value: num });
  }
  return points;
}

async function upsert(rows) {
  const key = E.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${E.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/social_metrics_daily?on_conflict=platform,metric,date`;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

(async () => {
  const now = new Date();
  const start = toYYYYMMDD(new Date(now.getTime() - DAYS_BACK * 864e5));
  const end = toYYYYMMDD(now);
  const syncedAt = now.toISOString();

  const allRows = [];
  let first = true;
  for (const m of METRICS) {
    try {
      const json = await fetchTimeline(m.fieldId, start, end);
      const points = extractPoints(json, m.fieldId, first);
      first = false;
      console.log(`${m.platform}/${m.metric} (${m.fieldId}): ${points.length} points`);
      for (const p of points) {
        allRows.push({
          platform: m.platform,
          metric: m.metric,
          metric_label: m.label,
          date: p.date,
          value: p.value,
          synced_at: syncedAt,
        });
      }
    } catch (e) {
      console.error(`Failed ${m.platform}/${m.metric} (${m.fieldId}): ${e.message}`);
    }
  }

  console.log(`Upserting ${allRows.length} rows total`);
  if (allRows.length) await upsert(allRows);
  console.log('Done');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
