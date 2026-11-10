// Leaderboard configuration.
// API_BASE is where the leaderboard API lives. '' means "same origin", which is
// right when the game is served by the brick-after-dark Cloudflare Worker
// (GET /api/top, POST /api/score). Set it to a full URL such as
// 'https://brick-after-dark.horrorblaster.workers.dev' if you host the static files
// elsewhere (that also needs CORS on the Worker), or to null to force the
// offline (this-browser-only) leaderboard.
export const API_BASE = '';
