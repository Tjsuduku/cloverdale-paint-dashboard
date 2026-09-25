#!/usr/bin/env node
// Daily competitor collector for the Cloverdale Paint dashboard.
// Pulls public numbers for every brand in config.json and updates data/landscape.json.
// Node 20+, no dependencies. Keys come from environment variables (GitHub repo secrets):
//   IG_USER_ID, IG_ACCESS_TOKEN   Instagram (Business Discovery, public business profiles)
//   YT_API_KEY                    YouTube Data API v3
//   X_BEARER_TOKEN                X API (optional, paid per request)
//   FB_LANDSCAPE_API, FB_LANDSCAPE_TOKEN, FB_LANDSCAPE_USER, FB_LANDSCAPE_BRAND   Facebook pages feed
// Flags: --check (show what would run, no network)  --dry (collect but don't write)  --force-x

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = process.env.LANDSCAPE_OUT ? path.resolve(process.env.LANDSCAPE_OUT) : path.join(ROOT, 'data', 'landscape.json');
const CFG = JSON.parse(await readFile(path.join(HERE, 'config.json'), 'utf8'));
const env = process.env;
const ARGS = new Set(process.argv.slice(2));
const TZ = CFG.timezone || 'America/Vancouver';
const SECRETS = [env.IG_ACCESS_TOKEN, env.YT_API_KEY, env.X_BEARER_TOKEN, env.FB_LANDSCAPE_TOKEN].filter(s => s && s.length > 5);
const scrub = s => SECRETS.reduce((a, t) => a.split(t).join('***'), String(s));
const log = (...a) => console.log(scrub(a.join(' ')));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- dates in the brand's time zone ----------
function parts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
const localDay = d => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const localStamp = d => { const p = parts(d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const addDays = (day, n) => { const t = new Date(day + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const TODAY = localDay(new Date());
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts(new Date()).weekday);

// ---------- http ----------
async function request(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (i === tries - 1) throw new Error('network error: ' + e.message); await sleep(1500 * (i + 1)); continue; }
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* not JSON */ }
    if (r.ok) return j ?? txt;
    const msg = j?.error?.message || j?.errors?.[0]?.message || j?.detail || j?.title || j?.message || txt.slice(0, 160);
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(3000 * (i + 1)); continue; }
    const err = new Error(`${r.status} ${scrub(msg)}`);
    err.status = r.status; err.code = j?.error?.code;
    throw err;
  }
}

const clip = (s, n = 420) => (s || '').replace(/\s+\n/g, '\n').trim().slice(0, n);
const num = v => (v == null || v === '' || isNaN(+v)) ? 0 : Math.round(+v);

// ---------- Instagram: Business Discovery (public business and creator profiles) ----------
async function instagram() {
  const c = CFG.channels.instagram || {};
  if (c.enabled === false) return { state: 'off' };
  if (!env.IG_USER_ID || !env.IG_ACCESS_TOKEN) return { state: 'setup', note: 'Add IG_USER_ID and IG_ACCESS_TOKEN to start' };
  const ver = CFG.graphVersion || 'v25.0', n = c.posts || 30;
  const FULL = 'id,caption,like_count,comments_count,view_count,timestamp,permalink,media_type,media_product_type';
  const LITE = 'id,caption,like_count,comments_count,timestamp,permalink,media_type';
  const res = { posts: [], followers: {}, errors: [] };
  for (const b of CFG.brands) {
    if (!b.instagram) continue;
    let data = null;
    for (const mf of [FULL, LITE]) {
      const fields = `business_discovery.username(${b.instagram}){username,name,followers_count,media_count,media.limit(${n}){${mf}}}`;
      const url = `https://graph.facebook.com/${ver}/${env.IG_USER_ID}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(env.IG_ACCESS_TOKEN)}`;
      try { data = (await request(url)).business_discovery; break; }
      catch (e) {
        if (mf === FULL && e.status === 400 && e.code === 100 && /field/i.test(e.message)) continue;
        res.errors.push(`${b.name}: ${e.message}`);
        if (e.code === 190) res.fatal = 'The Instagram key has expired or was revoked';
        break;
      }
    }
    if (!data) { if (res.fatal) break; continue; }
    res.followers[b.id] = num(data.followers_count);
    const media = data.media?.data || [];
    if (media.length >= n) { const oldest = media.map(m => localDay(new Date(m.timestamp))).sort()[0]; if (!res.coverage || oldest > res.coverage) res.coverage = oldest; }
    for (const m of media) {
      const code = (m.permalink || '').replace(/\/+$/, '').split('/').pop() || m.id;
      const kind = m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type === 'VIDEO' ? 'video' : 'image';
      const e = { likes: num(m.like_count), comments: num(m.comments_count) };
      if (m.view_count != null) e.views = num(m.view_count);
      res.posts.push({ b: b.id, c: 'instagram', id: 'ig_' + code, t: localStamp(new Date(m.timestamp)), k: kind, x: clip(m.caption), u: m.permalink, e });
    }
    log(`  instagram  ${b.name.padEnd(18)} ${String(data.followers_count).padStart(9)} followers  ${(data.media?.data || []).length} posts`);
  }
  return res;
}

// ---------- YouTube Data API v3 ----------
function seconds(iso) { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; }
async function youtube() {
  const c = CFG.channels.youtube || {};
  if (c.enabled === false) return { state: 'off' };
  if (!env.YT_API_KEY) return { state: 'setup', note: 'Add YT_API_KEY to start' };
  const key = encodeURIComponent(env.YT_API_KEY), n = Math.min(50, c.videos || 15);
  const API = 'https://www.googleapis.com/youtube/v3';
  const res = { posts: [], followers: {}, errors: [] };
  for (const b of CFG.brands) {
    if (!b.youtube) continue;
    try {
      const handle = b.youtube.startsWith('@') ? b.youtube : '@' + b.youtube;
      const ch = await request(`${API}/channels?part=statistics,contentDetails&forHandle=${encodeURIComponent(handle)}&key=${key}`);
      const item = ch.items?.[0];
      if (!item) throw new Error(`channel ${handle} not found`);
      if (!item.statistics.hiddenSubscriberCount) res.followers[b.id] = num(item.statistics.subscriberCount);
      const up = item.contentDetails?.relatedPlaylists?.uploads;
      const pl = up ? await request(`${API}/playlistItems?part=contentDetails&maxResults=${n}&playlistId=${up}&key=${key}`) : { items: [] };
      const ids = (pl.items || []).map(i => i.contentDetails.videoId).filter(Boolean);
      if (ids.length) {
        const v = await request(`${API}/videos?part=snippet,statistics,contentDetails&id=${ids.join(',')}&key=${key}`);
        if (ids.length >= n) { const oldest = (v.items || []).map(x => localDay(new Date(x.snippet.publishedAt))).sort()[0]; if (oldest && (!res.coverage || oldest > res.coverage)) res.coverage = oldest; }
        for (const x of v.items || []) {
          res.posts.push({
            b: b.id, c: 'youtube', id: 'yt_' + x.id, t: localStamp(new Date(x.snippet.publishedAt)),
            k: seconds(x.contentDetails?.duration) <= 60 ? 'short' : 'video', x: clip(x.snippet.title, 200),
            u: 'https://www.youtube.com/watch?v=' + x.id,
            e: { likes: num(x.statistics.likeCount), comments: num(x.statistics.commentCount), views: num(x.statistics.viewCount) },
          });
        }
      }
      log(`  youtube    ${b.name.padEnd(18)} ${String(item.statistics.subscriberCount).padStart(9)} subscribers  ${ids.length} videos`);
    } catch (e) {
      res.errors.push(`${b.name}: ${e.message}`);
      if (e.status === 400 && /API key/i.test(e.message)) { res.fatal = 'The YouTube key is not valid'; break; }
    }
  }
  return res;
}

// ---------- X API v2 (optional, paid per request) ----------
async function xapi() {
  const c = CFG.channels.x || {};
  if (!c.enabled) return { state: 'off', note: 'Switched off in config' };
  if (!env.X_BEARER_TOKEN) return { state: 'setup', note: 'Add X_BEARER_TOKEN to start' };
  if (c.weekday != null && c.weekday !== WEEKDAY && !ARGS.has('--force-x')) return { state: 'keep', note: 'X updates once a week to keep costs low' };
  const H = { headers: { Authorization: 'Bearer ' + env.X_BEARER_TOKEN } };
  const brands = CFG.brands.filter(b => b.x);
  const res = { posts: [], followers: {}, errors: [] };
  if (!brands.length) return { state: 'setup', note: 'No X handles in config' };
  const users = await request(`https://api.x.com/2/users/by?usernames=${brands.map(b => b.x).join(',')}&user.fields=public_metrics`, H);
  for (const u of users.data || []) {
    const b = brands.find(x => x.x.toLowerCase() === u.username.toLowerCase());
    if (!b) continue;
    res.followers[b.id] = num(u.public_metrics?.followers_count);
    try {
      const tw = await request(`https://api.x.com/2/users/${u.id}/tweets?max_results=${Math.max(5, Math.min(100, c.posts || 10))}&exclude=retweets,replies&tweet.fields=created_at,public_metrics`, H);
      for (const t of tw.data || []) {
        const m = t.public_metrics || {};
        res.posts.push({ b: b.id, c: 'x', id: 'x_' + t.id, t: localStamp(new Date(t.created_at)), k: 'post', x: clip(t.text, 280),
          u: `https://x.com/${u.username}/status/${t.id}`, e: { likes: num(m.like_count), reposts: num(m.retweet_count), replies: num(m.reply_count), quotes: num(m.quote_count) } });
      }
      log(`  x          ${b.name.padEnd(18)} ${String(u.public_metrics?.followers_count ?? '').padStart(9)} followers  ${(tw.data || []).length} posts`);
    } catch (e) { res.errors.push(`${b.name}: ${e.message}`); }
  }
  for (const e of users.errors || []) res.errors.push(`${e.value || '?'}: ${e.detail || e.title}`);
  return res;
}

// ---------- Facebook pages feed (competitor page posts) ----------
function parseCSV(text) {
  const src = text.replace(/^﻿/, '');
  const first = src.split('\n')[0] || '';
  const delim = (first.split(';').length > first.split(',').length) ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return { head, rows: rows.filter(r => r.some(c => c !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))) };
}
function pick(o, res) { for (const re of res) for (const k of Object.keys(o)) if (re.test(k)) return o[k]; return undefined; }
function fbStamp(v) {
  const s = String(v || '').trim();
  if (/^\d{14}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}`;
  if (/^\d{13}$/.test(s)) return localStamp(new Date(+s));
  if (/^\d{10}$/.test(s)) return localStamp(new Date(+s * 1000));
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (m) return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? localStamp(new Date(s)) : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]?(\d{1,2})?:?(\d{2})?/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${(m[4] || '12').padStart(2, '0')}:${m[5] || '00'}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s + 'T12:00';
  return null;
}
async function facebook() {
  const c = CFG.channels.facebook || {};
  if (c.enabled === false) return { state: 'off' };
  const { FB_LANDSCAPE_API: api, FB_LANDSCAPE_TOKEN: tok, FB_LANDSCAPE_USER: user, FB_LANDSCAPE_BRAND: brand } = env;
  if (!api || !tok || !user || !brand) return { state: 'keep', note: 'Facebook feed keys not added; keeping the saved data' };
  const byPage = Object.fromEntries(CFG.brands.filter(b => b.facebookPageId).map(b => [String(b.facebookPageId), b]));
  const days = c.refreshDays || 35;
  const q = `from=${addDays(TODAY, -days)}T00:00:00&to=${TODAY}T23:59:59&timezone=${encodeURIComponent(TZ)}&userId=${encodeURIComponent(user)}&blogId=${encodeURIComponent(brand)}`;
  const H = { 'X-Mc-Auth': tok };
  const base = api.replace(/\/+$/, '');
  const res = { posts: [], followers: {}, errors: [] };

  const sum = await request(`${base}/v2/analytics/competitors/facebook?${q}&limit=50`, { headers: { ...H, Accept: 'application/json' } });
  for (const r of sum?.data || []) {
    const b = byPage[String(r.providerId)] || CFG.brands.find(x => [r.displayName, r.screenName].some(n => n && n.toLowerCase().replace(/[^a-z]/g, '') === x.name.toLowerCase().replace(/[^a-z]/g, '')));
    if (b && r.followers) res.followers[b.id] = num(r.followers);
  }

  const raw = await request(`${base}/v2/analytics/competitors/facebook/posts?${q}&limit=3000`, { headers: { ...H, Accept: 'text/csv, application/json' } });
  let recs = [], head = [];
  if (typeof raw === 'string') ({ head, rows: recs } = parseCSV(raw));
  else if (Array.isArray(raw?.data)) { recs = raw.data; head = Object.keys(recs[0] || {}); }
  else if (Array.isArray(raw)) { recs = raw; head = Object.keys(recs[0] || {}); }
  for (const o of recs) {
    let id = String(pick(o, [/^post ?id$/i, /postid/i, /^id$/i]) || '');
    const link = String(pick(o, [/link|url|permalink/i]) || '');
    if (!/_/.test(id)) { const m = /facebook\.com\/(\d+)\/posts\/(\d+)/.exec(link); if (m) id = `${m[1]}_${m[2]}`; }
    const page = id.split('_')[0];
    const b = byPage[page];
    const t = fbStamp(pick(o, [/published with time/i, /published/i, /date|time|created|timestamp/i]));
    if (!b || !t) continue;
    res.posts.push({ b: b.id, c: 'facebook', id, t, k: 'post', x: clip(pick(o, [/^text$/i, /message|content|caption|description/i])),
      u: `https://www.facebook.com/${page}/posts/${id.split('_')[1]}`,
      e: { likes: num(pick(o, [/reaction/i, /^likes?$/i])), comments: num(pick(o, [/comment/i])), shares: num(pick(o, [/share/i])) } });
  }
  if (recs.length && !res.posts.length) throw new Error('Could not read the posts file. Columns seen: ' + head.join(', '));
  const per = {}; res.posts.forEach(p => per[p.b] = (per[p.b] || 0) + 1);
  for (const b of CFG.brands) log(`  facebook   ${b.name.padEnd(18)} ${String(res.followers[b.id] ?? '-').padStart(9)} followers  ${per[b.id] || 0} posts (last ${days} days)`);
  return res;
}

// ---------- merge into the saved file ----------
function load(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}
function dump(db) {
  const { posts, ...head } = db;
  return JSON.stringify(head).slice(0, -1) + ',\n"posts":[\n' + posts.map(p => JSON.stringify(p)).join(',\n') + '\n]}\n';
}
function upsertSeries(series, day, value) {
  const i = series.findIndex(([d]) => d === day);
  if (i >= 0) series[i][1] = value; else { series.push([day, value]); series.sort((a, b) => a[0] < b[0] ? -1 : 1); }
}
function merge(db, ch, res) {
  db.channels[ch] = db.channels[ch] || {};
  const C = db.channels[ch];
  if (res.state === 'keep') { if (res.note) C.info = res.note; return 'kept'; }
  if (res.state === 'off' || res.state === 'setup') {
    if (C.state !== 'live') { C.state = res.state; C.note = res.note || ''; }
    else C.note = `Not updated since ${C.through}. ${res.note || ''}`.trim();
    return res.state;
  }
  const brandsWithData = new Set([...Object.keys(res.followers), ...res.posts.map(p => p.b)]);
  if (!brandsWithData.size) {
    C.error = res.fatal || (res.errors || []).join('; ') || 'No data came back';
    C.errorAt = TODAY;
    return 'failed';
  }
  db.followers[ch] = db.followers[ch] || {};
  for (const [b, v] of Object.entries(res.followers)) {
    db.followers[ch][b] = db.followers[ch][b] || [];
    if (v) upsertSeries(db.followers[ch][b], TODAY, v);
  }
  const idx = new Map(db.posts.map((p, i) => [p.c + '|' + p.id, i]));
  let added = 0, updated = 0;
  for (const p of res.posts) {
    const k = p.c + '|' + p.id;
    if (idx.has(k)) {
      const old = db.posts[idx.get(k)];
      const merged = { ...old, ...p, x: p.x || old.x };
      delete merged.tq;
      db.posts[idx.get(k)] = merged; updated++;
    } else { idx.set(k, db.posts.length); db.posts.push(p); added++; }
  }
  const wasLive = C.state === 'live';
  const all = CFG.brands.every(b => brandsWithData.has(b.id));
  const focus = CFG.brands.find(b => b.focus);
  const competitorsIn = CFG.brands.filter(b => !b.focus && brandsWithData.has(b.id)).length;
  C.state = competitorsIn >= 1 ? 'live' : (C.state || 'setup');
  if (C.state === 'live') {
    // "since" = first day every brand is fully covered. Newest-N feeds only reach back so far on day one;
    // after that, each daily run adds to the history, so the start date never moves later.
    const first = db.posts.filter(p => p.c === ch).map(p => p.t.slice(0, 10)).sort()[0] || TODAY;
    const cover = res.coverage && res.coverage > first ? res.coverage : first;
    C.since = wasLive && C.since ? (C.since < cover ? C.since : cover) : cover;
    C.through = addDays(TODAY, -1);   // last complete day
    delete C.note;
  } else C.note = `${focus ? focus.name : 'Focus brand'} only so far`;
  C.updated = new Date().toISOString();
  C.missing = all ? undefined : CFG.brands.filter(b => !brandsWithData.has(b.id)).map(b => b.name);
  if (res.errors?.length) { C.warnings = res.errors.slice(0, 8); } else delete C.warnings;
  delete C.error; delete C.errorAt;
  return `${added} new, ${updated} refreshed`;
}

// ---------- main ----------
const jobs = { facebook, instagram, youtube, x: xapi };

if (ARGS.has('--check')) {
  log(`Today ${TODAY} (${TZ}), weekday ${WEEKDAY}`);
  log(`Instagram: ${env.IG_USER_ID && env.IG_ACCESS_TOKEN ? 'ready' : 'missing IG_USER_ID / IG_ACCESS_TOKEN'}`);
  log(`YouTube:   ${env.YT_API_KEY ? 'ready' : 'missing YT_API_KEY'}`);
  log(`X:         ${CFG.channels.x?.enabled ? (env.X_BEARER_TOKEN ? 'ready' : 'missing X_BEARER_TOKEN') : 'off in config'}`);
  log(`Facebook:  ${env.FB_LANDSCAPE_API && env.FB_LANDSCAPE_TOKEN && env.FB_LANDSCAPE_USER && env.FB_LANDSCAPE_BRAND ? 'ready' : 'keys not added (keeps saved data)'}`);
  log(`Brands:    ${CFG.brands.map(b => b.name).join(', ')}`);
  process.exit(0);
}

let db = null;
try { db = load(await readFile(OUT, 'utf8')); } catch { /* first run */ }
db = db || { schema: 1, channels: {}, followers: {}, posts: [] };
db.schema = 1; db.tz = TZ;
db.channels = db.channels || {}; db.followers = db.followers || {}; db.posts = db.posts || [];
db.brands = CFG.brands.map(({ id, name, short, focus }) => ({ id, name, short: short || name, ...(focus ? { focus: true } : {}) }));
if (!db.channels.tiktok) db.channels.tiktok = { state: 'none', note: 'TikTok has no public data access for brands' };

log(`Collecting for ${TODAY} (${TZ})`);
let failures = 0;
for (const [ch, fn] of Object.entries(jobs)) {
  let res;
  try { res = await fn(); }
  catch (e) { res = { posts: [], followers: {}, errors: [scrub(e.message)] }; }
  const out = merge(db, ch, res);
  if (out === 'failed') failures++;
  log(`${ch.padEnd(10)} ${out}${res.errors?.length ? '  (' + res.errors.join('; ') + ')' : ''}`);
}

// keep the file a sensible size
const cut = addDays(TODAY, -(CFG.keepDays || 400));
db.posts = db.posts.filter(p => p.t.slice(0, 10) >= cut).sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : a.b < b.b ? -1 : 1);
for (const ch in db.followers) for (const b in db.followers[ch]) db.followers[ch][b] = db.followers[ch][b].filter(([d]) => d >= cut);
db.generated = new Date().toISOString();

if (ARGS.has('--dry')) { log(`Dry run: ${db.posts.length} posts in total, nothing written`); }
else {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, dump(db));
  log(`Saved ${path.relative(ROOT, OUT)} with ${db.posts.length} posts`);
}
if (failures) { log(`${failures} channel(s) failed; the dashboard will show a notice`); }
