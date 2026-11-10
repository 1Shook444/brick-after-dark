// Pluggable leaderboard: submitScore(name, score, distance) and fetchTop(limit).
// Talks to the Cloudflare Worker API (same origin by default). If the API is
// unreachable or broken (network error, 404, 5xx), it falls back to a
// localStorage leaderboard that only this browser can see.
import { API_BASE } from './config.js';
import { validateName } from './name.js';

const LOCAL_KEY = 'brickAfterDark.localLeaderboard.v1';
const MAX_DISTANCE = 500000;

export const apiEnabled = () => API_BASE !== null && API_BASE !== undefined;

// Mirrors the server check: score = distance + 25 per pickup, and pickups are
// physically limited to 3 per 24m wave, so score can never exceed ~4.2x distance.
export function plausible(score, distance) {
  return Number.isInteger(score) && Number.isInteger(distance) &&
    distance >= 0 && distance <= MAX_DISTANCE && score >= distance &&
    score <= distance * 5 + 200 && (score - distance) % 25 === 0;
}

const api = (path) => String(API_BASE || '').replace(/\/+$/, '') + path;
const readLocal = () => {
  try { const rows = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(rows) ? rows : []; } catch { return []; }
};
const order = (a, b) => b.score - a.score || b.distance - a.distance || String(a.created_at).localeCompare(String(b.created_at));
const clean = (r) => ({ name: String(r.name ?? '').slice(0, 16), score: Math.floor(Number(r.score) || 0), distance: Math.floor(Number(r.distance) || 0), created_at: String(r.created_at ?? '') });
const saveLocal = (row) => {
  const rows = readLocal();
  rows.push({ ...row, created_at: new Date().toISOString() });
  rows.sort(order);
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(rows.slice(0, 100))); } catch { /* storage full or blocked */ }
};
// A "client" error (bad name, rate limited...) is a real answer from the API, not an outage.
class ApiAnswer extends Error {}

export async function submitScore(name, score, distance) {
  const v = validateName(name);
  if (!v.ok) throw new Error(v.error);
  score = Math.floor(Number(score)); distance = Math.floor(Number(distance));
  if (!plausible(score, distance)) throw new Error('Score failed the sanity check.');
  const row = { name: v.name, score, distance };
  if (apiEnabled()) {
    try {
      const res = await fetch(api('/api/score'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) return { mode: 'online' };
      if (res.status === 400 || res.status === 422 || res.status === 429) throw new ApiAnswer(data.error || 'The leaderboard rejected the score.');
      throw new Error('HTTP ' + res.status);
    } catch (err) {
      if (err instanceof ApiAnswer) throw err;
      // API down/unreachable: keep the score locally instead.
    }
  }
  saveLocal(row);
  return { mode: 'offline' };
}

export async function fetchTop(limit = 50) {
  limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  if (apiEnabled()) {
    try {
      const res = await fetch(api('/api/top?limit=' + limit), { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (res.ok && Array.isArray(data.scores)) return { mode: 'online', rows: data.scores.map(clean) };
    } catch { /* fall through to local */ }
  }
  return { mode: 'offline', rows: readLocal().map(clean).sort(order).slice(0, limit) };
}
