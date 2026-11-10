// Brick After Dark — Cloudflare Worker.
// Serves the static game (inlined by scripts/build-assets.mjs into assets.js)
// and the leaderboard API backed by the D1 binding `DB`.
//   GET  /api/top?limit=50
//   POST /api/score   {"name": "...", "score": 123, "distance": 98}
import { ASSETS } from './assets.js';
import { validateName } from '../name.js';

const RATE_WINDOW_MS = 20000;   // one submission per IP per 20 seconds
const MAX_DISTANCE = 500000;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
};

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers }
});

const plausible = (score, distance) => Number.isInteger(score) && Number.isInteger(distance) &&
  distance >= 0 && distance <= MAX_DISTANCE && score >= distance &&
  score <= distance * 5 + 200 && (score - distance) % 25 === 0;

async function hashIp(ip) {
  const bytes = new TextEncoder().encode('brick-after-dark:' + ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function top(env, url) {
  const raw = Number(url.searchParams.get('limit') ?? 50);
  const limit = Math.max(1, Math.min(100, Number.isFinite(raw) ? Math.floor(raw) : 50));
  const { results } = await env.DB.prepare(
    'SELECT name, score, distance, created_at FROM scores ORDER BY score DESC, distance DESC, id ASC LIMIT ?1'
  ).bind(limit).all();
  return json({ ok: true, scores: results });
}

async function submit(request, env) {
  if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) return json({ ok: false, error: 'Send JSON.' }, 415);
  const text = await request.text();
  if (text.length > 1024) return json({ ok: false, error: 'Request too large.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'Invalid JSON.' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Invalid body.' }, 400);
  const v = validateName(body.name);
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  const score = body.score, distance = body.distance;
  if (!plausible(score, distance)) return json({ ok: false, error: 'Score is not plausible for that distance.' }, 422);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipHash = await hashIp(ip);
  const now = Date.now();
  // Atomic throttle: the upsert only succeeds if the last accepted submit is old enough.
  const allowed = await env.DB.prepare(
    `INSERT INTO rate_limits (ip_hash, last_at) VALUES (?1, ?2)
     ON CONFLICT(ip_hash) DO UPDATE SET last_at = excluded.last_at WHERE rate_limits.last_at <= ?3
     RETURNING last_at`
  ).bind(ipHash, now, now - RATE_WINDOW_MS).first();
  if (!allowed) return json({ ok: false, error: 'Slow down: one score every 20 seconds.' }, 429, { 'retry-after': '20' });

  const row = await env.DB.prepare(
    'INSERT INTO scores (name, score, distance) VALUES (?1, ?2, ?3) RETURNING id, created_at'
  ).bind(v.name, score, distance).first();
  // Occasionally prune throttle rows older than a day.
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rate_limits WHERE last_at < ?1').bind(now - 86400000).run();
  return json({ ok: true, id: row?.id ?? null, created_at: row?.created_at ?? null }, 201);
}

async function handleApi(request, env, url) {
  if (url.pathname === '/api/top') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ ok: false, error: 'Use GET.' }, 405, { allow: 'GET' });
    return top(env, url);
  }
  if (url.pathname === '/api/score') {
    if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405, { allow: 'POST' });
    return submit(request, env);
  }
  return json({ ok: false, error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env, url); }
      catch (err) { console.error(err); return json({ ok: false, error: 'Server error.' }, 500); }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = ASSETS[path];
    if (!asset) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: { 'content-type': asset.type, 'cache-control': path === '/index.html' ? 'no-cache' : 'public, max-age=300', ...SECURITY_HEADERS }
    });
  }
};
