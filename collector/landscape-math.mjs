// Shared competitor-landscape maths. Used by the weekly email and inlined into the dashboard,
// so both always show the same numbers. Plain JS, no dependencies.

// What counts as one "engagement" on each channel (the industry-standard public counts).
export const ENG_RULE = {
  facebook: 'reactions + comments + shares',
  instagram: 'likes + comments',
  youtube: 'likes + comments',
  x: 'likes + reposts + replies',
};
export function engOf(ch, e) {
  e = e || {};
  if (ch === 'facebook') return (e.likes || 0) + (e.comments || 0) + (e.shares || 0);
  if (ch === 'x') return (e.likes || 0) + (e.reposts || 0) + (e.replies || 0);
  return (e.likes || 0) + (e.comments || 0);
}

export function lsAddDays(day, n) {
  const t = new Date(day + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function lsDaysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
}

// Follower count on a given day: the last snapshot on or before it, else the earliest one we have.
// With strict set, returns null when there is no snapshot on or before that day.
export function followersAt(series, day, strict) {
  if (!series || !series.length) return null;
  let v = null;
  for (const [d, c] of series) { if (d <= day) v = c; else break; }
  return v == null ? (strict ? null : series[0][1]) : v;
}

// Channels with competitor data. A channel more than 3 days behind the freshest one counts as paused,
// so one stalled feed never holds the whole landscape back.
export function dataChannels(db) {
  return Object.keys(db.channels || {}).filter(c => (db.channels[c] || {}).state === 'live' && (db.channels[c] || {}).through);
}
export function liveChannels(db) {
  const all = dataChannels(db);
  const newest = all.map(c => db.channels[c].through).sort().pop();
  const fresh = all.filter(c => db.channels[c].through >= lsAddDays(newest, -3));
  return fresh.length ? fresh : all;
}
export function isPaused(db, c) {
  return dataChannels(db).includes(c) && !liveChannels(db).includes(c);
}

// The last day covered by the live channels.
export function dataThrough(db, chans) {
  const ds = (chans || liveChannels(db)).map(c => (db.channels[c] || {}).through).filter(Boolean).sort();
  return ds.length ? ds[0] : null;
}

// Summarise the landscape between two dates (inclusive, local days).
export function summarize(db, chans, from, to) {
  const brands = db.brands || [];
  const rows = brands.map(b => ({ id: b.id, name: b.name, short: b.short || b.name, focus: !!b.focus,
    followers: 0, followersStart: 0, hasFollowers: false, posts: 0, eng: 0, rateSum: 0, rateN: 0, best: null, byCh: {} }));
  const R = Object.fromEntries(rows.map(r => [r.id, r]));
  for (const c of chans) {
    const fs = (db.followers || {})[c] || {};
    for (const r of rows) {
      const s = fs[r.id];
      const end = followersAt(s, to), start = followersAt(s, lsAddDays(from, -1), true);
      if (end != null) { r.followers += end; r.hasFollowers = true; }
      if (start != null) r.followersStart += start; else if (end != null) r.noStart = true;
      r.byCh[c] = { followers: end, posts: 0, eng: 0 };
    }
  }
  const posts = [];
  for (const p of db.posts || []) {
    if (!chans.includes(p.c)) continue;
    const d = p.t.slice(0, 10);
    if (d < from || d > to) continue;
    const r = R[p.b];
    if (!r) continue;
    const e = engOf(p.c, p.e);
    const f = followersAt(((db.followers || {})[p.c] || {})[p.b], d);
    r.posts++; r.eng += e;
    r.byCh[p.c].posts++; r.byCh[p.c].eng += e;
    if (f) { r.rateSum += e / f; r.rateN++; }
    const q = { ...p, eng: e, rate: f ? e / f : null, brand: r };
    posts.push(q);
    if (!r.best || e > r.best.eng) r.best = q;
  }
  const total = rows.reduce((a, r) => a + r.eng, 0);
  for (const r of rows) {
    r.perPost = r.posts ? r.eng / r.posts : 0;
    r.rate = r.rateN ? r.rateSum / r.rateN : 0;          // average engagement per post as a share of followers
    r.share = total ? r.eng / total : 0;                   // share of all engagement in the landscape
    const okStart = r.followersStart && !r.noStart;
    r.growth = okStart ? (r.followers - r.followersStart) : null;
    r.growthPct = okStart ? (r.followers - r.followersStart) / r.followersStart : null;
    r.perWeek = r.posts / Math.max(1, (lsDaysBetween(from, to) + 1) / 7);
  }
  const rank = (key) => {
    rows.forEach(r => { r.rank = r.rank || {}; r.rank[key] = null; });
    const s = rows.filter(r => r[key] != null && isFinite(r[key])).sort((a, b) => b[key] - a[key]);
    s.forEach((r, i) => { r.rank[key] = i + 1; });
  };
  ['share', 'rate', 'eng', 'posts', 'followers', 'perPost', 'growthPct'].forEach(rank);
  posts.sort((a, b) => b.eng - a.eng);
  const focus = rows.find(r => r.focus) || rows[0];
  const others = rows.filter(r => r !== focus);
  const avg = (arr, k) => arr.length ? arr.reduce((a, r) => a + (r[k] || 0), 0) / arr.length : 0;
  return {
    from, to, chans, rows, posts, total, focus, others,
    landscapeAvg: { eng: avg(rows, 'eng'), share: rows.length ? 1 / rows.length : 0, rate: avg(rows, 'rate'), posts: avg(rows, 'posts'), perPost: avg(rows, 'perPost') },
    competitorAvg: { eng: avg(others, 'eng'), rate: avg(others, 'rate'), posts: avg(others, 'posts'), perPost: avg(others, 'perPost'), followers: avg(others, 'followers') },
    leader: rows.slice().sort((a, b) => b.eng - a.eng)[0],
    rateLeader: rows.slice().sort((a, b) => b.rate - a.rate)[0],
  };
}

// Each brand's normal (median) engagement per post on a channel, over all the data we hold.
export function brandMedians(db) {
  const g = {};
  for (const p of db.posts || []) { const k = p.c + '|' + p.b; (g[k] = g[k] || []).push(engOf(p.c, p.e)); }
  const m = {};
  for (const k in g) { const a = g[k].sort((x, y) => x - y); m[k] = a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0; }
  return m;
}

// Plain-language content themes, spotted from the post text.
export const THEMES = [
  { id: 'coty', name: 'Colour of the Year', re: /colou?r of the year|colou?rof(the)?year|\bcoty\b|20\d\d colou?r trends/i },
  { id: 'promo', name: 'Sales and offers', re: /\d+\s?% off|save \d+|\bsale\b|offer valid|discount|promo|spend & win|\bwin\b|prize|giveaway|contest/i },
  { id: 'question', name: 'Questions to followers', re: /\?|tell us|comment below|in the comments|guess|which one|respond to/i },
  { id: 'howto', name: 'Tips and how-to', re: /\btips?\b|how to|learn about|undertones|expert|guide|step[- ]by[- ]step/i },
  { id: 'palette', name: 'Colour palettes', re: /palette|colou?r (combo|pairing|scheme)|pairs? (with|as)|hues|shades/i },
  { id: 'local', name: 'Canadian pride', re: /canad|since 1933|made in canada|buy canadian/i },
  { id: 'event', name: 'Events and in-store', re: /\bevent\b|design show|visit us|join us|saturday|register|in-store|fan club/i },
];
export function themesOf(text) {
  const t = text || '';
  return THEMES.filter(th => th.re.test(t)).map(th => th.id);
}

// How each theme performed against each brand's own normal. lift 2 = twice the usual engagement.
export function themeLift(db, chans, from, to, only) {
  const focusId = ((db.brands || []).find(b => b.focus) || {}).id;
  const med = brandMedians(db);
  const out = THEMES.map(th => ({ ...th, n: 0, lifts: [], brands: new Set(), best: null }));
  let withText = 0;
  for (const p of db.posts || []) {
    if (!chans.includes(p.c) || !p.x) continue;
    if (only === 'focus' && p.b !== focusId) continue;
    if (only === 'others' && p.b === focusId) continue;
    const d = p.t.slice(0, 10);
    if (d < from || d > to) continue;
    withText++;
    const m = med[p.c + '|' + p.b];
    if (!m) continue;
    const e = engOf(p.c, p.e), lift = e / m;
    for (const id of themesOf(p.x)) {
      const o = out.find(x => x.id === id);
      o.n++; o.lifts.push(lift); o.brands.add(p.b);
      if (!o.best || lift > o.best.lift) o.best = { ...p, eng: e, lift };
    }
  }
  for (const o of out) {
    const a = o.lifts.sort((x, y) => x - y);
    o.lift = a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
    o.brands = [...o.brands];
  }
  return { withText, themes: out.filter(o => o.n >= 2).sort((a, b) => b.lift - a.lift) };
}

// Posts that did at least twice as well as that brand normally does.
export function breakouts(db, chans, from, to, min = 2) {
  const med = brandMedians(db);
  const res = [];
  for (const p of db.posts || []) {
    if (!chans.includes(p.c)) continue;
    const d = p.t.slice(0, 10);
    if (d < from || d > to) continue;
    const m = med[p.c + '|' + p.b], e = engOf(p.c, p.e);
    if (m && e >= Math.max(10, m * min)) res.push({ ...p, eng: e, lift: e / m, median: m });
  }
  return res.sort((a, b) => b.lift - a.lift);
}

// ---------- plain-language wording ----------
export function lsPct(v, d) {
  if (v == null || !isFinite(v)) return '–';
  const p = v * 100;
  const dd = d != null ? d : (p >= 10 ? 0 : p >= 1 ? 1 : p >= 0.1 ? 2 : 3);
  return p.toFixed(dd) + '%';
}
export function lsOrd(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
export function lsPer1k(rate) { const v = (rate || 0) * 1000; return v >= 10 ? String(Math.round(v)) : v >= 1 ? v.toFixed(1).replace(/\.0$/, '') : v >= 0.1 ? v.toFixed(2).replace(/0$/, '') : v.toFixed(3).replace(/0+$/, ''); }
export function lsTimes(r) { return r >= 10 ? Math.round(r) + '×' : r.toFixed(1).replace(/\.0$/, '') + '×'; }

// One headline plus up to three supporting lines, written for someone with no marketing background.
export function headline(S, P) {
  const f = S.focus, n = S.rows.length;
  if (!S.total) return { title: 'No posts in this period yet', lines: [] };
  const lines = [];
  const title = `${f.short} earned ${lsPct(f.share)} of all engagement across the ${n} brands`;
  if (S.leader !== f) lines.push(`That ranks ${lsOrd(f.rank.share)} of ${n}. ${S.leader.short} had the most, ${lsPct(S.leader.share)}, helped by ${S.leader.followers >= f.followers * 10 ? 'an audience ' + lsTimes(S.leader.followers / Math.max(1, f.followers)) + ' larger' : 'more activity'}.`);
  else lines.push(`That's the biggest share of the ${n} brands.`);
  const ca = S.competitorAvg.rate;
  if (f.posts && ca) {
    const r = f.rate / ca;
    lines.push(`Adjusted for audience size, each post got about ${lsPer1k(f.rate)} engagements per 1,000 followers, ${r >= 1 ? lsTimes(r) + ' the competitor average' : lsPct(r, 0) + ' of the competitor average'} (${lsOrd(f.rank.rate)} of ${n}).`);
  }
  if (P && P.total) {
    const d = (f.share - P.focus.share) * 100;
    if (Math.abs(d) >= 0.5) lines.push(`Share ${d > 0 ? 'rose' : 'fell'} ${Math.abs(d).toFixed(1)} points from the period before.`);
    else lines.push('Share held steady against the period before.');
  }
  return { title, lines };
}
