// Pulls ad campaign data (currently: Meta/Facebook Ads) from Metricool and upserts it into
// Supabase ad_campaigns (campaign_id, platform, name, status, spend, impressions, clicks,
// conversions, start_date, end_date). Mirrors scripts/sync-analytics.js's structure and
// failure-handling rules: never upsert on a response that doesn't look like real campaign
// data, log the raw shape so a wrong guess is visible in the Action log (not a silent zero-row
// "success" -- see MISTAKES-AND-FIXES.md #2).
//
// IMPORTANT / open item for whoever runs this first (see the hand-off notes):
// Metricool's advertising endpoint is not in the same official v2 docs as the other syncs
// (/api/v2/analytics/timelines). The endpoint below (GET /facebookads/campaigns on
// api.metricool.com/v1, auth via X-Auth-Token + X-Auth-UserId) is confirmed only against a
// third-party, independently-published API client -- not Metricool's own documentation -- so
// it has NOT been proven against this account yet. This workflow is wired as workflow_dispatch
// ONLY (no cron) for exactly that reason: run it once by hand, read the Action log, and if the
// request/response shape needs adjusting the log will show the raw body to fix it against,
// the same way sync-analytics.js's endpoint and metric names were debugged.
//
// Env: METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BRAND_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const need = ['METRICOOL_API_TOKEN', 'METRICOOL_USER_ID', 'METRICOOL_BRAND_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }
const E = process.env;
const DAYS_BACK = 120; // match sync-analytics.js's window

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const H = { 'X-Auth-Token': E.METRICOOL_API_TOKEN, 'X-Auth-UserId': E.METRICOOL_USER_ID, Accept: 'application/json' };

async function get(url) {
  const res = await fetch(url, { headers: H });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// Metricool's campaign objects have been seen under a few different key names depending on
// the surface (direct REST vs MCP connector). Pick the first present key so a reasonable
// shape change doesn't silently break the sync.
const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

function deriveStatus(startISO, endISO, today) {
  // Metricool's campaigns connector does not expose an active/paused/ended field (confirmed by
  // scanning all 317 available metaads metrics -- zero "status" matches). Approximate from dates:
  // "paused" cannot be detected this way and is never produced here.
  if (endISO && endISO < today) return 'ended';
  if (startISO && startISO > today) return 'scheduled';
  return 'active';
}

function normalizeCampaign(raw, platform, today) {
  const id = pick(raw, 'id', 'campaign_id', 'campaignId');
  const name = pick(raw, 'name', 'campaign_name', 'campaignName');
  if (!id || !name) return null; // doesn't look like a campaign object -- skip, don't guess
  const start = (pick(raw, 'start_time', 'start_date', 'startDate', 'init_date') || '').slice(0, 10) || null;
  const end = (pick(raw, 'stop_time', 'end_date', 'endDate', 'finish_date') || '').slice(0, 10) || null;
  return {
    campaign_id: String(id),
    platform,
    name: String(name),
    status: deriveStatus(start, end, today),
    spend: num(pick(raw, 'spend', 'spent', 'cost')),
    impressions: num(pick(raw, 'impressions')),
    clicks: num(pick(raw, 'clicks', 'inline_link_clicks')),
    conversions: num(pick(raw, 'conversions', 'results') || 0),
    start_date: start,
    end_date: end,
    synced_at: new Date().toISOString(),
  };
}

async function fetchPlatformCampaigns(platform, path, from, to) {
  const base = 'https://api.metricool.com/v1';
  const q = new URLSearchParams({ blog_id: E.METRICOOL_BRAND_ID, init_date: iso(from), end_date: iso(to) });
  const r = await get(`${base}${path}?${q}`);
  console.log(`${platform}: HTTP ${r.status}, body starts: ${r.body.slice(0, 300)}`);
  if (!r.ok) return [];
  let json; try { json = JSON.parse(r.body); } catch { console.log(`${platform}: non-JSON response, skipping`); return []; }
  // Response shape isn't confirmed yet -- try the common container keys, else treat a bare array as the list.
  const list = Array.isArray(json) ? json : pick(json, 'campaigns', 'data', 'results') || [];
  if (!Array.isArray(list)) { console.log(`${platform}: no array of campaigns found in response`); return []; }
  return list;
}

async function upsert(rows) {
  const key = E.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${E.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ad_campaigns?on_conflict=platform,campaign_id`;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(url, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

(async () => {
  const now = new Date();
  const from = new Date(now.getTime() - DAYS_BACK * 864e5);
  const today = iso(now);
  const rows = [];

  const metaRaw = await fetchPlatformCampaigns('meta', '/facebookads/campaigns', from, now);
  for (const r of metaRaw) { const c = normalizeCampaign(r, 'meta', today); if (c) rows.push(c); }
  console.log(`meta: ${metaRaw.length} raw records, ${rows.length} normalized so far`);

  // Google Ads isn't connected for this brand yet (see getBrandSettings) -- left out until it is;
  // adding it later is the same fetchPlatformCampaigns('google', '/googleads/campaigns', ...) call.

  if (!rows.length) {
    console.log('No campaigns normalized -- nothing to upsert. This is treated as "nothing live yet", not an error; check the HTTP status/body logged above if campaigns were expected.');
    process.exit(0); // exit 0: don't flag a red X for "not connected yet", only for a hard failure below
  }

  console.log(`Upserting ${rows.length} campaign rows`);
  await upsert(rows);
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
