#!/usr/bin/env node
// Builds the weekly competitor summary email from data/landscape.json and prints it
// as a ready-to-send message (MIME). The workflow pipes it to curl's SMTP upload.
// Env: MAIL_FROM, MAIL_TO (comma separated). Flag: --html writes just the HTML body.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as L from './landscape-math.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(await readFile(path.join(HERE, 'config.json'), 'utf8'));
const DATA = process.env.LANDSCAPE_OUT || path.join(HERE, '..', 'data', 'landscape.json');
const db = JSON.parse(await readFile(DATA, 'utf8'));

const chans = L.liveChannels(db);
const to = L.dataThrough(db, chans);
if (!chans.length || !to) { console.error('No live channels yet; nothing to send.'); process.exit(3); }
const from = L.lsAddDays(to, -6);
const S = L.summarize(db, chans, from, to);
const P = L.summarize(db, chans, L.lsAddDays(from, -7), L.lsAddDays(to, -7));
const H = L.headline(S, P);
const CH = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X' };
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = d => `${M[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const range = `${dm(from)} – ${dm(to)}, ${to.slice(0, 4)}`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = n => Math.round(n).toLocaleString('en-US');
const K = n => n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : nf(n);
const delta = (a, b, pts) => {
  if (b == null || !isFinite(b)) return '';
  const d = pts ? (a - b) * 100 : (b ? (a - b) / b * 100 : null);
  if (d == null || !isFinite(d)) return '';
  const c = Math.abs(d) < 0.05 ? '#6b7076' : d > 0 ? '#12723F' : '#B3261E';
  return `<span style="color:${c};font-size:12px">${d > 0 ? '▲' : d < 0 ? '▼' : ''} ${Math.abs(d).toFixed(1)}${pts ? ' pts' : '%'}</span>`;
};
const f = S.focus, pf = P.focus;
const ACC = '#E4032E', INK = '#15171A', MUT = '#6b7076', LINE = '#E3E5E3';
const tile = (label, big, sub, d) => `<td width="25%" valign="top" style="padding:14px 12px;border:1px solid ${LINE};border-radius:10px">
  <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUT}">${label}</div>
  <div style="font-size:26px;font-weight:700;color:${INK};margin:4px 0 2px">${big}</div>
  <div style="font-size:12px;color:${MUT};line-height:1.4">${sub}</div>${d ? `<div style="margin-top:4px">${d}</div>` : ''}</td>`;
const rows = S.rows.slice().sort((a, b) => b.eng - a.eng).map(r => `<tr style="${r.focus ? `background:#FDF0F2;` : ''}">
  <td style="padding:9px 10px;border-top:1px solid ${LINE};font-weight:${r.focus ? 700 : 500};color:${r.focus ? ACC : INK}">${esc(r.name)}</td>
  <td align="right" style="padding:9px 10px;border-top:1px solid ${LINE}">${K(r.followers)}</td>
  <td align="right" style="padding:9px 10px;border-top:1px solid ${LINE}">${r.posts}</td>
  <td align="right" style="padding:9px 10px;border-top:1px solid ${LINE}">${nf(r.eng)}</td>
  <td align="right" style="padding:9px 10px;border-top:1px solid ${LINE}">${L.lsPct(r.rate)}</td>
  <td align="right" style="padding:9px 10px;border-top:1px solid ${LINE};font-weight:600">${L.lsPct(r.share)}</td></tr>`).join('');
const postCard = (title, p) => p ? `<td width="50%" valign="top" style="padding:14px;border:1px solid ${LINE};border-radius:10px">
  <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUT}">${title}</div>
  <div style="font-size:13px;font-weight:600;margin:6px 0 2px;color:${INK}">${esc(p.brand.name)} · ${CH[p.c]} · ${dm(p.t.slice(0, 10))}</div>
  <div style="font-size:13px;color:#3d4146;line-height:1.45;margin:6px 0">${esc((p.x || '').split('\n')[0].slice(0, 150))}${(p.x || '').length > 150 ? '…' : ''}</div>
  <div style="font-size:13px;color:${INK}"><b>${nf(p.eng)}</b> engagements · <b>${L.lsPct(p.rate)}</b> of followers</div>
  ${p.u ? `<a href="${esc(p.u)}" style="font-size:12px;color:${ACC}">Open post</a>` : ''}</td>` : '<td></td>';
const worked = L.themeLift(db, chans, L.lsAddDays(to, -27), to, 'others').themes.filter(t => t.lift >= 1.15).slice(0, 3);
const breaks = L.breakouts(db, chans, from, to).slice(0, 3);
const dash = CFG.dashboardUrl || '#';

const html = `<!doctype html><html><body style="margin:0;background:#F1F2F1;font-family:Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F2F1"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border-radius:14px">
<tr><td style="padding:26px 28px 6px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${MUT}">Weekly competitor summary · ${range}</div>
  <div style="font-size:22px;font-weight:700;line-height:1.3;margin:10px 0 8px">${esc(H.title)}</div>
  ${H.lines.map(l => `<div style="font-size:14px;line-height:1.55;color:#3d4146;margin:0 0 6px">${esc(l)}</div>`).join('')}
</td></tr>
<tr><td style="padding:14px 22px"><table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
  ${tile('Share of engagement', L.lsPct(f.share), `${L.lsOrd(f.rank.share)} of ${S.rows.length} · average ${L.lsPct(S.landscapeAvg.share)}`, delta(f.share, pf.share, true))}
  ${tile('Per follower', L.lsPct(f.rate), `${L.lsOrd(f.rank.rate)} of ${S.rows.length} · about ${L.lsPer1k(f.rate)} per 1,000 followers`, delta(f.rate, pf.rate))}
  ${tile('Posts', String(f.posts), `competitor average ${S.competitorAvg.posts.toFixed(1)}`, delta(f.posts, pf.posts))}
  ${tile('Audience', K(f.followers), f.growth != null ? `${f.growth >= 0 ? '+' : ''}${nf(f.growth)} this week` : '', '')}
</tr></table></td></tr>
<tr><td style="padding:6px 28px 4px"><div style="font-size:15px;font-weight:700;margin:6px 0 8px">The landscape</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
<tr style="color:${MUT};font-size:11px;text-transform:uppercase;letter-spacing:.05em"><td style="padding:6px 10px">Brand</td><td align="right" style="padding:6px 10px">Audience</td><td align="right" style="padding:6px 10px">Posts</td><td align="right" style="padding:6px 10px">Engagement</td><td align="right" style="padding:6px 10px">Per follower</td><td align="right" style="padding:6px 10px">Share</td></tr>
${rows}</table></td></tr>
<tr><td style="padding:18px 22px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
  ${postCard('Your best post', f.best)}${postCard('Best post in the landscape', S.posts[0])}
</tr></table></td></tr>
${worked.length || breaks.length ? `<tr><td style="padding:14px 28px 4px"><div style="font-size:15px;font-weight:700;margin:4px 0 8px">Worth knowing</div>
${breaks.filter(b => b.b !== f.id).slice(0, 2).map(b => `<div style="font-size:13.5px;line-height:1.5;margin:0 0 8px">• ${esc(S.rows.find(r => r.id === b.b).name)} had a standout post on ${dm(b.t.slice(0, 10))}: ${L.lsTimes(b.lift)} their usual engagement. <span style="color:${MUT}">"${esc((b.x || '').split('\n')[0].slice(0, 90))}"</span></div>`).join('')}
${breaks.filter(b => b.b === f.id).slice(0, 1).map(b => `<div style="font-size:13.5px;line-height:1.5;margin:0 0 8px">• Your ${CH[b.c]} post on ${dm(b.t.slice(0, 10))} did ${L.lsTimes(b.lift)} your usual engagement. <span style="color:${MUT}">"${esc((b.x || '').split('\n')[0].slice(0, 90))}"</span></div>`).join('')}
${worked.map(t => `<div style="font-size:13.5px;line-height:1.5;margin:0 0 8px">• Competitor posts about <b>${esc(t.name.toLowerCase())}</b> got ${L.lsTimes(t.lift)} their usual engagement over the last 4 weeks (${t.n} posts).</div>`).join('')}
</td></tr>` : ''}
<tr><td style="padding:16px 28px 26px">
  <a href="${esc(dash)}" style="display:inline-block;background:${INK};color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:9px">Open the dashboard</a>
  <div style="font-size:12px;color:${MUT};line-height:1.5;margin-top:16px">Channels included: ${chans.map(c => CH[c]).join(', ')}. Engagement is ${chans.map(c => `${CH[c]}: ${L.ENG_RULE[c]}`).join('; ')}. "Per follower" is engagement per post divided by the brand's followers, so big and small brands can be compared fairly.</div>
</td></tr></table></td></tr></table></body></html>`;

if (process.argv.includes('--html')) { process.stdout.write(html); process.exit(0); }
const fromAddr = process.env.MAIL_FROM || 'dashboard@localhost';
const toAddr = (process.env.MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean).join(', ');
const subject = `Competitor summary · ${range}`;
const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
const msg = [
  `From: Cloverdale Paint dashboard <${fromAddr}>`,
  `To: ${toAddr}`,
  `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
  `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64(html),
].join('\r\n');
process.stdout.write(msg + '\r\n');
