# Brick After Dark

A third-person endless runner through a haunted neighborhood. Plain HTML/CSS/JS, no framework.
Live: https://brick-after-dark.horrorblaster.workers.dev

## How it's hosted
One Cloudflare Worker (`brick-after-dark`) serves the game files and the leaderboard API,
backed by the D1 database `brick-after-dark-scores` (binding `DB`). Both are on the free plan.

- `GET  /api/top?limit=50` → `{ ok, scores: [{ name, score, distance, created_at }] }` (limit 1–100)
- `POST /api/score` with JSON `{ name, score, distance }` → `201 { ok, id, created_at }`
  - 400 bad JSON/name · 422 implausible score · 429 rate limited (1 submit per IP per 20 s) · 415 not JSON

## Files
- `index.html`, `style.css` — page and mobile layout
- `game.js` — game rules, rendering, controls, shops, power timers, name flow, UI
- `name.js` — display-name validation (2–16 chars, letters/numbers/space/_/-, basic profanity filter), shared by browser and Worker
- `leaderboard.js` — `submitScore(name, score, distance)` / `fetchTop(limit)`; calls the same-origin API, falls back to localStorage if the API is unreachable
- `config.js` — `API_BASE` ('' = same origin, null = offline only)
- `worker/index.js` — Worker: static files + API + validation + per-IP rate limit (salted SHA-256 IP hash stored in D1)
- `worker/assets.js` — generated: the static files inlined for the Worker
- `scripts/build-assets.mjs` — regenerates `worker/assets.js`
- `schema.sql` — D1 tables (`scores`, `rate_limits`), CHECK constraints and score index
- `wrangler.toml` — Worker + D1 config

## Run locally (offline leaderboard)
```
python3 -m http.server 8000   # open http://localhost:8000
```
With no `/api` there, the game automatically uses the offline leaderboard.

Full local stack with the API:
```
node scripts/build-assets.mjs
npx wrangler d1 execute brick-after-dark-scores --local --file=schema.sql
npx wrangler dev
```

## Deploy changes
```
node scripts/build-assets.mjs        # after editing any game file
npx wrangler deploy
```
Schema changes: `npx wrangler d1 execute brick-after-dark-scores --remote --file=schema.sql`

## Anti-cheat (basic)
- Client: one submit per run, name and score sanity checks.
- Worker: name rules and profanity filter, and the score must equal distance + 25 per pickup, at most about 4.2× distance (capped at distance × 5 + 200), with distance ≤ 500 km. One submit per IP every 20 s.
- D1: CHECK constraints enforce the same bounds.
A static game can't fully stop someone posting believable fake numbers straight to the API.

## Moderation
Remove a score: `npx wrangler d1 execute brick-after-dark-scores --remote --command "DELETE FROM scores WHERE id = 123"`
