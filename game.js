// Brick After Dark — standalone port of the Canvas Page prototype.
// Game rules, difficulty, rendering, controls, shops and power timers are a
// line-for-line port; the UI layer is plain DOM instead of React.
import { validateName } from './name.js';
import * as leaderboard from './leaderboard.js';

// ---------------------------------------------------------------- rules ----
const POWER_SHOP = [
  { id: 'shield', name: 'Shield', cost: 5, duration: 15, detail: '15 seconds or one hit, whichever comes first. Absorbing a hit adds 0.6s recovery immunity.' },
  { id: 'magnet', name: 'Brick magnet', cost: 5, duration: 20, detail: '20 seconds: auto-collect within 12m ahead and one lane sideways.' },
  { id: 'double', name: 'Double bricks', cost: 8, duration: 30, detail: '30 seconds: future pickups earn 2 wallet bricks each. Earlier earnings and +25 pickup score stay unchanged.' }
];
const isPower = (p) => p === 'shield' || p === 'magnet' || p === 'double';
const powerName = (power) => POWER_SHOP.find((offer) => offer.id === power)?.name ?? 'None';
// Independent uniform whole-meter gaps, freshly sampled for every milestone/run.
const speedGap = () => 200 + Math.floor(Math.random() * 101);
const fresh = () => ({ mode: 'ready', distance: 0, speed: 22, nextSpeed: speedGap(), speedFlash: 0, lane: 0, target: 0, jump: -1, slide: 0, time: 0, bricks: 0, earned: 0, banked: false, power: null, pendingPower: null, powerUsed: false, powerUntil: 0, shield: false, immuneUntil: 0, items: [], waves: [], next: 65, safe: 0, seed: 7193, reason: '', submitted: false, dropH: null, dropV: 0, rollQueued: false, landFx: 0 });
const powerRemaining = (g) => Math.max(0, g.powerUntil - g.time);
const powerActive = (g, power) => g.power === power && powerRemaining(g) > 0;
const activatePower = (g, power) => {
  const offer = POWER_SHOP.find((item) => item.id === power);
  if (!offer) return;
  g.power = power; g.powerUntil = g.time + offer.duration;
  g.shield = power === 'shield'; g.powerUsed = true; g.pendingPower = null;
};
const expirePower = (g) => { if (g.power !== null && powerRemaining(g) <= 0) { g.power = null; g.shield = false; } };
const claimPausedPower = (g, account, power) => {
  const offer = POWER_SHOP.find((item) => item.id === power);
  if (g.mode !== 'paused' || g.powerUsed || g.pendingPower !== null || !offer || account.wallet < offer.cost) return false;
  account.wallet -= offer.cost; g.pendingPower = power; g.powerUsed = true; return true;
};
const resumeRun = (g) => {
  if (g.mode !== 'paused') return;
  if (g.pendingPower !== null) activatePower(g, g.pendingPower);
  g.mode = 'run';
};
const collectBrick = (g, o) => {
  if (g.mode !== 'run' || o.done || o.kind !== 'brick') return;
  o.done = true; g.bricks++; g.earned += powerActive(g, 'double') ? 2 : 1;
};
const bankRun = (g, account) => {
  if (g.mode !== 'over' || g.banked) return;
  account.wallet += g.earned; g.banked = true;
  g.power = null; g.pendingPower = null; g.powerUntil = 0; g.shield = false; g.immuneUntil = 0;
};
const claimPower = (g, account, power) => {
  const offer = POWER_SHOP.find((item) => item.id === power);
  if (g.mode !== 'over' || !g.banked || account.nextPower !== null || !offer || account.wallet < offer.cost) return false;
  account.wallet -= offer.cost; account.nextPower = power; return true;
};
const magnetActive = (g) => powerActive(g, 'magnet');
const powerStatus = (g) => g.pendingPower !== null ? powerName(g.pendingPower) + ' purchased · activates on Resume' : g.immuneUntil > g.time ? 'Shield saved you · recovery ' + Math.max(0, g.immuneUntil - g.time).toFixed(1) + 's' : g.power !== null && powerRemaining(g) > 0 ? powerName(g.power) + ' · ' + Math.ceil(powerRemaining(g)) + 's left' + (g.shield ? ' · 1 hit' : '') : g.powerUsed ? 'Power finished · this run’s slot is used' : 'No active power · Pause & Shop to equip one';
const advanceSpeed = (g) => {
  if (g.mode !== 'run') return;
  while (g.nextSpeed !== null && g.distance >= g.nextSpeed) {
    const milestone = g.nextSpeed;
    const previous = g.speed;
    g.speed = Math.min(36, g.speed + 2);
    if (g.speed > previous) g.speedFlash = 1.8;
    g.nextSpeed = g.speed < 36 ? milestone + speedGap() : null;
  }
};
const jumpHeight = (t) => t < 0 ? 0 : Math.sin(Math.PI * Math.min(1, t / 0.88)) * 1.55;
// Fast drop: pressing down mid-jump replaces the jump arc with a hard fall.
const FAST_DROP_V = 9, FAST_DROP_G = 70, SLIDE_TIME = 0.9;
const heightOf = (g) => g.dropH !== null ? g.dropH : jumpHeight(g.jump);
const isMonster = (kind) => kind === 'zombie' || kind === 'clown' || kind === 'alien';
const isLow = (kind) => ['low', 'rubble', 'fence', 'coffin'].includes(kind);
const isHigh = (kind) => ['high', 'pipe', 'sign'].includes(kind);
const blocked = (kind, h, sliding) => isMonster(kind) || kind === 'van' || kind === 'crates' || (isLow(kind) && h < 0.6) || (isHigh(kind) && !sliding);
// Ambush pairs wait until 40m to read the player's lane, then lunge without
// indicators and settle at 26m (0.72s before impact at maximum speed).
const monsterLane = (o, z) => {
  if (o.moveTo === undefined) return o.lane;
  const t = Math.max(0, Math.min(1, (40 - z) / 14));
  return o.lane + (o.moveTo - o.lane) * t * t * (3 - 2 * t);
};
const rand = (g) => { g.seed = (Math.imul(g.seed, 1664525) + 1013904223) >>> 0; return g.seed / 4294967296; };
const spawn = (g) => {
  while (g.next < g.distance + 145) {
    // Authored six-beat sequence: dodge, jump, ambush, dodge, slide, ambush.
    const beat = Math.round((g.next - 65) / 24) % 6;
    const routes = [-1, 0, 1].filter((n) => Math.abs(n - g.safe) === 1);
    g.safe = routes[Math.floor(rand(g) * routes.length)];
    const ambush = beat === 2 || beat === 5;
    const action = beat === 1 ? 'jump' : beat === 4 ? 'slide' : 'none';
    g.waves.push({ at: g.next, safe: g.safe, locked: !ambush, ambush, action });
    const monsters = ['zombie', 'clown', 'alien'];
    const lows = ['low', 'rubble', 'fence', 'coffin'];
    const highs = ['high', 'pipe', 'sign'];
    for (let lane = -1; lane <= 1; lane++) {
      let kind;
      if (lane === g.safe) {
        if (action === 'none') continue;
        const choices = action === 'jump' ? lows : highs;
        kind = choices[Math.floor(rand(g) * choices.length)];
      } else {
        kind = ambush || rand(g) < 0.78 ? monsters[Math.floor(rand(g) * 3)] : rand(g) < 0.5 ? 'van' : 'crates';
      }
      g.items.push({ at: g.next, lane, kind, done: false, waveAt: g.next });
    }
    for (let j = 0; j < 3; j++) g.items.push({ at: g.next - 12 + j * 4, lane: g.safe, kind: 'brick', done: false, waveAt: g.next });
    g.next += 24;
  }
};
const targetAmbushes = (g) => {
  let previousSafe = 0;
  for (let i = 0; i < g.waves.length; i++) {
    const wave = g.waves[i];
    if (wave.ambush && !wave.locked && wave.at - g.distance <= 40) {
      const playerLane = Math.max(-1, Math.min(1, Math.round(g.lane)));
      const nextRoute = g.waves[i + 1]?.safe ?? 0;
      const reachable = [-1, 0, 1].filter((n) => Math.abs(n - previousSafe) <= 1 && Math.abs(n - nextRoute) <= 1);
      const intercept = reachable.filter((n) => n !== playerLane);
      const choices = intercept.length ? intercept : reachable;
      wave.safe = choices[Math.floor(rand(g) * choices.length)];
      const destinations = [-1, 0, 1].filter((n) => n !== wave.safe);
      const pair = g.items.filter((o) => o.waveAt === wave.at && isMonster(o.kind)).sort((a, b) => a.lane - b.lane);
      pair.forEach((o, index) => { o.moveTo = destinations[index]; });
      wave.locked = true;
    }
    previousSafe = wave.safe;
  }
};
const runScore = (g) => Math.floor(g.distance) + g.bricks * 25;

// ---------------------------------------------------------- persistence ----
const KEYS = { wallet: 'brickAfterDark.wallet.v1', name: 'brickAfterDark.name.v1', best: 'brickAfterDark.best.v1', next: 'brickAfterDark.nextPower.v1' };
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch { /* private mode */ } }
};
const wholeOr0 = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };
const savedNext = store.get(KEYS.next);
const account = { wallet: wholeOr0(store.get(KEYS.wallet)), nextPower: isPower(savedNext) ? savedNext : null };
let best = wholeOr0(store.get(KEYS.best));
const savedName = validateName(store.get(KEYS.name) ?? '');
let playerName = savedName.ok ? savedName.name : '';
const saveAccount = () => { store.set(KEYS.wallet, account.wallet); store.set(KEYS.next, account.nextPower); };

// ---------------------------------------------------------------- state ----
let model = fresh();
let submitState = { text: '', kind: '' };
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const c = canvas.getContext('2d');
let raf = 0, last = 0, hud = 0;

// ------------------------------------------------------------- drawing -----
const poly = (pts, fill) => { c.fillStyle = fill; c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.fill(); };
const rect = (x, y, w, h, fill) => { c.fillStyle = fill; c.fillRect(x, y, w, h); };
const circle = (x, y, r, fill) => { c.fillStyle = fill; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); };
const line = (x, y, xx, yy, color, width = 1) => { c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x, y); c.lineTo(xx, yy); c.stroke(); };
const project = (lane, z) => { const s = 1 / (1 + Math.max(-2, z) / 18); return { x: 210 + lane * 100 * s, y: 207 + 315 * s, s }; };
const oval = (x, y, rx, ry, color) => { c.fillStyle = color; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fill(); };
const rounded = (x, y, w, h, radius, color) => {
  const r = Math.min(radius, w / 2, h / 2); c.fillStyle = color; c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath(); c.fill();
};
const softShadow = (x, y, rx, ry) => {
  c.save(); c.globalAlpha *= 0.14; oval(x + 5, y + 2, rx * 1.3, ry * 1.45, '#08131e'); c.globalAlpha *= 1.7; oval(x + 2, y + 1, rx, ry, '#08131e'); oval(x, y, rx * 0.65, ry * 0.7, '#08131e'); c.restore();
};
const warmGlow = (x, y, rx, ry) => {
  c.save(); c.globalAlpha *= 0.055; oval(x, y, rx * 1.6, ry * 1.6, '#f4b56d'); c.globalAlpha *= 1.8; oval(x, y, rx, ry, '#f4b56d'); oval(x, y, rx * 0.5, ry * 0.5, '#ffd799'); c.restore();
};
const box = (x, y, w, h, color, top) => {
  rect(x - w / 2, y - h, w, h, color);
  poly([[x - w / 2, y - h], [x - w / 2 + w * 0.15, y - h - w * 0.14], [x + w / 2 + w * 0.15, y - h - w * 0.14], [x + w / 2, y - h]], top);
  poly([[x + w * 0.32, y - h], [x + w / 2, y - h], [x + w / 2, y], [x + w * 0.32, y]], '#0c182b32');
  line(x - w / 2 + 1, y - h + 1, x + w / 2 - 1, y - h + 1, '#e0d4bc42', 0.8);
  line(x - w / 2 + 1, y - 1, x + w / 2 - 1, y - 1, '#10192765', 1);
};
const PLASTICS = [
  { front: '#efc521', side: '#ba8b13', top: '#ffe04b', stud: '#ffe768', rim: '#fff3ac' },
  { front: '#d93635', side: '#922329', top: '#f45b4e', stud: '#ff7766', rim: '#ffc2a6' },
  { front: '#2874d4', side: '#194987', top: '#4b99ec', stud: '#75b6fa', rim: '#c1e6ff' },
  { front: '#2ba65c', side: '#196d42', top: '#51c47b', stud: '#77da93', rim: '#c6f2c8' }
];

// Forward roll seen from behind: the boy is tucked into a ball, and his hair,
// backpack and sneakers tumble over the top of the ball (rotation about the
// lateral axis) while a dashed motion ring spins. Hitbox = normal slide.
const drawRoll = (g) => {
  const prog = Math.max(0, Math.min(1, 1 - g.slide / SLIDE_TIME));
  const theta = prog * Math.PI * 4; // two full forward rolls per slide
  const r = 30, cy = -32;
  c.save(); c.translate(0, cy); c.scale(1.06, 0.96);
  // Spinning motion ring.
  c.save(); c.setLineDash([10, 9]); c.lineDashOffset = -theta * 18; c.strokeStyle = '#d2f3e980'; c.lineWidth = 2.5;
  c.beginPath(); c.arc(0, 0, r + 8, 0, Math.PI * 2); c.stroke(); c.restore();
  // Tucked hoodie ball with a soft key light.
  const ball = c.createRadialGradient(-10, -12, 4, 0, 0, r + 4); ball.addColorStop(0, '#45a3a5'); ball.addColorStop(0.55, '#247b82'); ball.addColorStop(1, '#0f4655');
  c.fillStyle = ball; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
  // Features at angle phi around the roll axis; cos>0 faces the camera.
  const feature = (phi, drawFn) => {
    const a = theta + phi, depth = Math.cos(a);
    if (depth <= 0.05) return;
    c.save(); c.globalAlpha *= Math.min(1, depth * 1.6); c.translate(0, -Math.sin(a) * r * 0.78); c.scale(1, 0.35 + 0.65 * depth); drawFn(); c.restore();
  };
  // Seam band rotating around the ball (strong roll cue).
  for (const phi of [0.5, Math.PI + 0.5]) {
    const a = theta + phi; const y = -Math.sin(a) * r * 0.85, ry = Math.abs(Math.cos(a)) * r * 0.28 + 1;
    c.save(); c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.clip();
    c.strokeStyle = '#0f3d4a'; c.lineWidth = 3; c.beginPath(); c.ellipse(0, y, r * Math.sqrt(Math.max(0.05, 1 - (y / r) ** 2)), ry, 0, 0, Math.PI * 2); c.stroke(); c.restore();
  }
  feature(0, () => { rounded(-15, -14, 30, 28, 8, '#243a4b'); rounded(-12, -11, 24, 22, 7, '#3a5060'); line(-9, 6, 9, 6, '#b39469', 1.2); });
  feature(Math.PI / 2, () => { for (let i = 0; i < 9; i++) { const a = i * 2.4, rr = 4 + (i % 3) * 5; circle(Math.cos(a) * rr, Math.sin(a) * rr * 0.6, 6.5, i % 3 === 0 ? '#3c322c' : '#242528'); } });
  feature(-Math.PI / 2, () => { rounded(-21, -6, 18, 12, 5, '#c97e4e'); rounded(3, -6, 18, 12, 5, '#d38a52'); line(-18, 4, -6, 4, '#d5d6cb', 2); line(6, 4, 18, 4, '#d5d6cb', 2); });
  feature(Math.PI, () => { rounded(-17, -8, 14, 16, 6, '#303940'); rounded(3, -8, 14, 16, 6, '#252d34'); });
  // Hands hugging the knees stay at the sides.
  oval(-r + 3, 4, 6, 8, '#a16e4e'); oval(r - 3, 4, 6, 8, '#a16e4e');
  c.restore();
};
const draw = (g) => {
  c.setTransform(2, 0, 0, 2, 0, 0);
  const sky = c.createLinearGradient(0, 0, 0, 580); sky.addColorStop(0, '#1e2333'); sky.addColorStop(0.35, '#555264'); sky.addColorStop(0.6, '#637b80'); sky.addColorStop(1, '#1b303b');
  c.fillStyle = sky; c.fillRect(0, 0, 420, 580);
  c.save(); c.globalAlpha = 0.07; oval(332, 67, 53, 53, '#d9e3e2'); oval(332, 67, 36, 36, '#d9e3e2'); c.restore();
  circle(332, 67, 23, '#b7bcc5'); circle(341, 61, 23, '#353b4c');
  for (let i = 0; i < 32; i++) circle((i * 97 + 13) % 420, (i * 37) % 155, i % 4 === 0 ? 1.3 : 0.65, '#a39bb7');
  // Original carnival silhouettes, distant and decorative.
  c.strokeStyle = '#332a48'; c.lineWidth = 3; c.beginPath(); c.arc(274, 166, 40, 0, Math.PI * 2); c.stroke();
  for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5; line(274, 166, 274 + Math.cos(a) * 40, 166 + Math.sin(a) * 40, '#332a48', 2); circle(274 + Math.cos(a) * 40, 166 + Math.sin(a) * 40, 2, '#dba26d'); }
  line(274, 166, 251, 219, '#332a48', 5); line(274, 166, 297, 219, '#332a48', 5);
  poly([[126, 195], [147, 153], [168, 195]], '#39304f');
  circle(147, 142, 10, '#b1a0a2'); poly([[133, 137], [147, 113], [159, 137]], '#633f7c');
  circle(144, 141, 2, '#292239'); circle(151, 141, 2, '#292239'); line(142, 148, 153, 147, '#743c50', 2);
  const float = Math.sin(g.time * 1.2) * 4;
  c.save(); c.translate(82, 78 + float); c.rotate(-0.14);
  c.fillStyle = '#172b42'; c.beginPath(); c.ellipse(0, 0, 33, 15, 0, 0, Math.PI * 2); c.fill();
  for (let i = 0; i < 5; i++) { c.strokeStyle = '#285365'; c.lineWidth = 3; c.beginPath(); c.moveTo(-24 + i * 12, 7); c.quadraticCurveTo(-32 + i * 12, 29, -20 + i * 12, 36 + i % 2 * 8); c.stroke(); }
  circle(-12, -2, 4, '#64e6e0'); circle(11, -2, 4, '#64e6e0'); c.restore();
  // Perspective road.
  poly([[190, 207], [230, 207], [420, 580], [0, 580]], '#243843');
  const offset = g.distance % 5;
  const palette = ['#424c50', '#465255', '#4c4d53', '#39464c', '#525257'];
  for (let row = 29; row >= 0; row--) {
    const z = row * 5 - offset;
    if (z < -2) continue;
    for (let col = -3; col <= 3; col++) {
      const a = project(col * 0.5 - 0.25, z), b = project(col * 0.5 + 0.25, z), d = project(col * 0.5 - 0.25, z + 4.8), e = project(col * 0.5 + 0.25, z + 4.8);
      const worldRow = row + Math.floor(g.distance / 5);
      poly([[a.x + 0.6, a.y], [b.x - 0.6, b.y], [e.x - 0.6, e.y], [d.x + 0.6, d.y]], palette[(col + 3 + worldRow) % 5]);
      if (z < 65 && (worldRow + col + 30) % 3 === 0) {
        const q = project(col * 0.5, z + 1.5), r = project(col * 0.5 + 0.12, z + 3.1);
        line(q.x - 6 * q.s, q.y, q.x + 2 * q.s, q.y - 3 * q.s, '#202f3760', 0.8);
        line(q.x + 2 * q.s, q.y - 3 * q.s, r.x, r.y, '#202f3760', 0.7);
        line(a.x + 5 * a.s, a.y - 1, b.x - 7 * b.s, b.y - 1, '#b5bbc217', 1);
      }
    }
  }
  for (const lane of [-1.5, -0.5, 0.5, 1.5]) {
    const a = project(lane, 0), b = project(lane, 145); line(a.x, a.y + 58, b.x, b.y, lane === -1.5 || lane === 1.5 ? '#81919370' : '#c0c1bd25', 1);
  }
  // Six stable world-indexed facades beyond the street edge.
  const houseOffset = g.distance % 20;
  const blockIndex = Math.floor(g.distance / 20);
  for (let i = 8; i >= 0; i--) {
    const z = i * 20 - houseOffset;
    if (z < -3) continue;
    for (const side of [-1, 1]) {
      const p = project(side * 2.5, z), s = p.s;
      const type = (i + blockIndex + (side > 0 ? 3 : 0)) % 6;
      c.save(); c.translate(p.x, p.y); c.scale(s, s);
      const win = (x, y, w = 16, h = 27) => {
        warmGlow(x + w / 2, y + h / 2, w * 1.2, h * 0.75);
        rect(x - 2, y - 2, w + 4, h + 4, '#182932');
        const glass = c.createLinearGradient(x, y, x + w, y + h); glass.addColorStop(0, '#f3cb8b'); glass.addColorStop(0.55, '#cd9256'); glass.addColorStop(1, '#8f643f'); c.fillStyle = glass; c.fillRect(x, y, w, h);
        line(x + w / 2, y, x + w / 2, y + h, '#574840', 2); line(x, y + h * 0.55, x + w, y + h * 0.55, '#574840', 2);
        rect(x - 3, y + h + 1, w + 6, 3, '#9a948080');
      };
      if (type === 0) {
        box(0, 0, 88, 174, '#36555c', '#4e7376');
        poly([[-48, -174], [-34, -174], [-34, -189], [-20, -189], [-20, -204], [0, -219], [20, -204], [20, -189], [34, -189], [34, -174], [48, -174]], '#373753');
        rect(24, -216, 12, 37, '#614c59');
        for (let floor = 0; floor < 3; floor++) for (const x of [-29, 12]) win(x, -153 + floor * 44);
        rect(-10, -35, 20, 35, '#1e323d'); circle(5, -16, 2, '#e4b375');
      } else if (type === 1) {
        box(0, 0, 100, 120, '#70604f', '#97805e');
        rect(-44, -111, 88, 24, '#273c49');
        c.fillStyle = '#f1c987'; c.font = '700 12px sans-serif'; c.textAlign = 'center'; c.fillText('ODD GOODS', 0, -94);
        win(-43, -62, 28, 42); win(15, -62, 28, 42); rect(-10, -58, 20, 58, '#263e48');
        for (let j = 0; j < 8; j++) { rect(-52 + j * 13, -83, 13, 19, j % 2 ? '#b57b55' : '#cec79c'); circle(-45.5 + j * 13, -64, 6.5, j % 2 ? '#b57b55' : '#cec79c'); }
        box(-37, -2, 18, 16, '#527b6c', '#80a07a');
      } else if (type === 2) {
        box(0, 0, 62, 220, '#515165', '#777185');
        rect(-38, -227, 76, 13, '#80738c');
        poly([[-42, -227], [0, -268], [42, -227]], '#3f3454');
        circle(0, -190, 23, '#a99576'); circle(0, -190, 19, '#e4c38a');
        for (let j = 0; j < 12; j++) { const a = j * Math.PI / 6; circle(Math.sin(a) * 15, -190 - Math.cos(a) * 15, 1.5, '#514653'); }
        line(0, -190, 0, -204, '#443b4a', 3); line(0, -190, 11, -185, '#443b4a', 3);
        win(-9, -146, 18, 38); win(-9, -88, 18, 38); rect(-12, -30, 24, 30, '#283543');
      } else if (type === 3) {
        box(0, 0, 104, 126, '#3f5d60', '#628583');
        poly([[-54, -126], [-54, -143], [-18, -159], [-18, -138], [18, -154], [18, -134], [54, -150], [54, -126]], '#29434e');
        for (const x of [-42, -7, 28]) win(x, -116, 15, 17);
        rect(-31, -72, 62, 72, '#263c48');
        for (let j = 0; j < 9; j++) line(-30, -69 + j * 8, 30, -69 + j * 8, '#688082', 2);
        for (const x of [-47, 39]) rect(x, -76, 8, 76, '#bd9657');
        box(-37, 0, 22, 20, '#735242', '#aa7a50');
      } else if (type === 4) {
        box(0, 0, 100, 168, '#4d405b', '#72607f');
        poly([[-55, -168], [0, -214], [55, -168]], '#263f4c');
        for (const x of [-34, 34]) {
          rect(x - 13, -202, 26, 202, '#5f526b');
          poly([[x - 19, -202], [x, -243], [x + 19, -202]], '#294954');
          win(x - 7, -185, 14, 26); win(x - 7, -126, 14, 26); win(x - 7, -67, 14, 26);
        }
        circle(0, -171, 11, '#e9ad68'); line(-8, -179, 8, -163, '#5a4762', 3);
        rect(-14, -45, 28, 45, '#242d3c'); line(-16, -40, 16, -14, '#936b4e', 8);
        for (let j = 0; j < 6; j++) circle(-47 + j * 3, -8 - j * 16, 7, '#3d6355');
      } else {
        box(0, 0, 104, 103, '#563f68', '#805a86');
        poly([[-57, -103], [0, -170], [57, -103]], '#65447f');
        for (const x of [-45, -15, 15, 45]) poly([[0, -170], [x - 9, -103], [x + 9, -103]], '#9b7b55');
        line(0, -170, 0, -191, '#96a4a0', 2); poly([[0, -191], [23, -184], [0, -178]], '#be7963');
        rect(-48, -100, 96, 23, '#2a3348');
        c.fillStyle = '#f2cb83'; c.font = '700 13px sans-serif'; c.textAlign = 'center'; c.fillText('MOON FAIR', 0, -84);
        for (let j = 0; j < 9; j++) circle(-44 + j * 11, -103, 2.7, '#efbd70');
        rect(-17, -57, 34, 57, '#212e40'); circle(0, -56, 17, '#212e40');
        win(-44, -58, 17, 31); win(27, -58, 17, 31);
      }
      c.save(); c.globalAlpha = 0.18;
      for (let course = 0; course < 7; course++) {
        const yy = -8 - course * 19; line(-28, yy, 28, yy, '#172b35', 0.8);
        const xx = course % 2 ? -10 : 10; line(xx, yy, xx, yy - 17, '#152b36', 0.8);
      }
      c.restore();
      rounded(-side * 45 - 10, -13, 20, 13, 3, '#44554b');
      c.restore();
      const lamp = project(side * 1.8, z + 7);
      warmGlow(lamp.x, lamp.y - 86 * lamp.s, 22 * lamp.s, 27 * lamp.s);
      warmGlow(lamp.x - side * 12 * lamp.s, lamp.y - 1, 52 * lamp.s, 12 * lamp.s);
      line(lamp.x, lamp.y, lamp.x, lamp.y - 85 * lamp.s, '#1c303b', 3 * lamp.s);
      rounded(lamp.x - 5 * lamp.s, lamp.y - 92 * lamp.s, 10 * lamp.s, 12 * lamp.s, 2 * lamp.s, '#cfae7a');
      line(lamp.x - 6 * lamp.s, lamp.y - 94 * lamp.s, lamp.x + 6 * lamp.s, lamp.y - 94 * lamp.s, '#27343e', 2 * lamp.s);
    }
  }
  const fog = c.createLinearGradient(0, 175, 0, 350); fog.addColorStop(0, '#91a4aa35'); fog.addColorStop(0.35, '#91a4aa55'); fog.addColorStop(1, '#91a4aa00'); c.fillStyle = fog; c.fillRect(0, 175, 420, 175);
  const visible = g.items.filter((o) => !o.done && o.at - g.distance > -1).sort((a, b) => b.at - a.at);
  for (const o of visible) {
    const z = o.at - g.distance;
    const p = project(monsterLane(o, z), z), s = p.s;
    c.save(); c.translate(p.x, p.y); c.scale(s, s);
    softShadow(0, 1, o.kind === 'brick' ? 22 : 31, o.kind === 'brick' ? 6 : 9);
    if (o.kind === 'brick') {
      // 2x4 toy brick: three solid faces and eight raised cylindrical studs.
      c.translate(0, -24 - Math.sin(g.time * 5 + o.at) * 3);
      const plastic = PLASTICS[(Math.floor(o.at / 4) + o.lane + 1) % PLASTICS.length];
      c.fillStyle = '#0d243c88'; c.beginPath(); c.ellipse(1, 9, 23, 5, 0, 0, Math.PI * 2); c.fill();
      poly([[-23, -20], [-11, -8], [-11, 8], [-23, -4]], plastic.side);
      const plasticFace = c.createLinearGradient(-11, -18, 23, 8); plasticFace.addColorStop(0, plastic.top); plasticFace.addColorStop(0.38, plastic.front); plasticFace.addColorStop(1, plastic.side);
      c.fillStyle = plasticFace; c.beginPath(); c.moveTo(-11, -8); c.lineTo(25, -20); c.lineTo(25, -4); c.lineTo(-11, 8); c.closePath(); c.fill();
      poly([[-23, -20], [13, -32], [25, -20], [-11, -8]], plastic.top);
      line(-22, -20, 13, -31.6, plastic.rim, 0.9);
      line(-11, -8, 24, -19.7, plastic.rim, 1);
      line(-10, 6, 24, -5.2, plastic.side, 1);
      const studs = [];
      for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) {
        const u = (col + 0.5) / 4, v = (row + 0.5) / 2;
        studs.push({ x: -23 + 36 * u + 12 * v, y: -20 - 12 * u + 12 * v });
      }
      studs.sort((a, b) => a.y - b.y);
      for (const stud of studs) {
        c.fillStyle = plastic.side; c.beginPath(); c.ellipse(stud.x, stud.y, 3.35, 2.1, 0, 0, Math.PI * 2); c.fill();
        rect(stud.x - 3.35, stud.y - 3.4, 6.7, 3.4, plastic.front);
        c.fillStyle = plastic.stud; c.beginPath(); c.ellipse(stud.x, stud.y - 3.4, 3.35, 2.1, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = plastic.rim; c.lineWidth = 0.7; c.beginPath(); c.ellipse(stud.x, stud.y - 3.4, 2.8, 1.6, 0, Math.PI, Math.PI * 1.85); c.stroke();
      }
    } else if (o.kind === 'low') {
      box(0, 0, 68, 31, '#86695a', '#b8a18b');
      for (const y of [-10, -21]) line(-33, y, 32, y, '#443e3d', 1);
      for (const x of [-22, 0, 22]) line(x, -10, x, -1, '#443e3d', 1);
      for (const x of [-12, 12]) line(x, -30, x, -21, '#443e3d', 1);
    } else if (o.kind === 'rubble') {
      poly([[-37, 0], [-29, -15], [-16, -19], [-5, -5], [-2, 0]], '#777d7a');
      poly([[-18, -9], [-9, -30], [10, -34], [18, -9]], '#a6a49a');
      poly([[2, 0], [13, -22], [30, -20], [37, -3]], '#626d70');
      line(-9, -28, 4, -23, '#d1c5b1', 2); line(16, -17, 30, -8, '#a0aaa5', 1.5);
    } else if (o.kind === 'fence') {
      for (const x of [-28, -14, 0, 14, 28]) { rect(x - 4, -30, 8, 30, '#be844b'); poly([[x - 4, -30], [x, -36], [x + 4, -30]], '#e5ac68'); }
      rect(-34, -21, 68, 7, '#e0a15a'); line(-30, -28, 28, -8, '#80543b', 4);
    } else if (o.kind === 'coffin') {
      poly([[-29, -3], [-36, -17], [-24, -31], [23, -31], [35, -17], [28, -3]], '#714644');
      poly([[-29, -11], [-36, -25], [-24, -38], [23, -38], [35, -25], [28, -11]], '#bd8550');
      line(-7, -24, 12, -24, '#edc581', 3); line(2, -32, 2, -16, '#edc581', 3);
    } else if (o.kind === 'pipe') {
      rect(-35, -109, 8, 109, '#426f76'); rect(27, -109, 8, 109, '#426f76');
      rect(-38, -100, 76, 24, '#69a0a3'); rect(-38, -100, 76, 5, '#acd1c5'); rect(-38, -81, 76, 5, '#34616d');
      for (const x of [-23, 20]) { rect(x, -103, 7, 30, '#ac9d71'); circle(x + 3, -89, 2, '#555e60'); }
    } else if (o.kind === 'sign') {
      rect(-36, -126, 7, 126, '#52456b'); rect(29, -126, 7, 126, '#52456b');
      line(-25, -124, -25, -109, '#ada798', 2); line(25, -124, 25, -109, '#ada798', 2);
      box(0, -66, 71, 43, '#83499c', '#b47ac1');
      c.fillStyle = '#ffe3a0'; c.font = '700 14px sans-serif'; c.textAlign = 'center'; c.fillText('FAIR', 0, -81);
      for (let j = 0; j < 6; j++) circle(-29 + j * 12, -103, 2, '#f0b977');
    } else if (o.kind === 'van') {
      circle(-24, -9, 10, '#162a34'); circle(24, -9, 10, '#162a34');
      rounded(-35.5, -100, 71, 91, 13, '#a15d55');
      oval(-11, -95, 20, 4, '#c68977');
      rounded(-28, -89, 56, 28, 5, '#243f4e');
      poly([[-25, -86], [3, -86], [-7, -64], [-25, -64]], '#91aaae36');
      line(-25, -65, 25, -83, '#759ba4', 2);
      line(-30, -54, 30, -54, '#dca18a66', 1);
      rect(-31, -49, 62, 31, '#bb6555'); rect(-33, -22, 66, 8, '#a8b4a8');
      rect(-27, -42, 12, 8, '#f5d18a'); rect(15, -42, 12, 8, '#f5d18a'); rect(-9, -29, 18, 6, '#263c46');
    } else if (o.kind === 'crates') {
      const crate = (x, y, w, h) => { box(x, y, w, h, '#8f6249', '#bc9566'); line(x - w / 2 + 4, y - h + 4, x + w / 2 - 4, y - 4, '#e0bd83', 4); line(x + w / 2 - 4, y - h + 4, x - w / 2 + 4, y - 4, '#e0bd83', 4); };
      crate(-17, 0, 36, 40); crate(19, 0, 36, 40); crate(-3, -40, 42, 43); crate(4, -83, 30, 31);
    } else if (o.kind === 'high') {
      rect(-34, -106, 8, 106, '#4d6078'); rect(26, -106, 8, 106, '#4d6078'); box(0, -63, 76, 37, '#7750a2', '#aa78c6');
      for (let i = 0; i < 4; i++) poly([[-32 + i * 17, -94], [-24 + i * 17, -94], [-35 + i * 17, -68], [-43 + i * 17, -68]], '#b7c5c1');
    } else if (o.kind === 'clown') {
      // Original "Moon Fair" carnival clown: crooked patched top hat, teal
      // tufted hair, diamond eye paint, plum striped suit, oversized shoes.
      // The red balloon string still ends in the raised gloved hand.
      const bx = 33 + Math.sin(g.time * 2.1 + o.at) * 6;
      const by = -151 + Math.sin(g.time * 2.8 + o.at) * 3;
      c.strokeStyle = '#eadac1'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(29, -65); c.quadraticCurveTo(bx - 9, -110, bx, by + 20); c.stroke();
      const balloon = c.createRadialGradient(bx - 6, by - 8, 1, bx, by, 23); balloon.addColorStop(0, '#ff8a78'); balloon.addColorStop(0.35, '#db3945'); balloon.addColorStop(1, '#741a32');
      c.fillStyle = balloon; c.beginPath(); c.ellipse(bx, by, 15, 20, -0.12, 0, Math.PI * 2); c.fill();
      poly([[bx, by + 17], [bx - 4, by + 24], [bx + 4, by + 24]], '#aa263d');
      c.fillStyle = '#ffb0a3'; c.beginPath(); c.ellipse(bx - 5, by - 7, 3, 6, -0.35, 0, Math.PI * 2); c.fill();
      // Plum/black striped stockings and long green shoes.
      rounded(-18, -36, 14, 32, 6, '#5b3a63'); rounded(5, -36, 14, 32, 6, '#664270');
      for (const x of [-18, 5]) for (let j = 0; j < 4; j++) rect(x, -33 + j * 8, 14, 3, '#231c29');
      rounded(-32, -12, 33, 12, 6, '#3f6b47'); rounded(1, -12, 32, 12, 6, '#3f6b47');
      line(-28, -10, -6, -10, '#7fae7f', 2); line(6, -10, 28, -10, '#7fae7f', 2);
      // Baggy plum jacket with vertical pinstripes and big brass buttons.
      rounded(-22, -78, 44, 45, 12, '#6a3f6e');
      for (const x of [-14, -7, 7, 14]) line(x, -75, x, -36, '#3b2440', 1.4);
      oval(-12, -64, 5, 13, '#82558a'); oval(15, -60, 5, 14, '#4c2b52');
      for (let j = 0; j < 3; j++) { circle(0, -68 + j * 12, 4.4, '#d9ad3f'); circle(-1, -69 + j * 12, 1.6, '#f6dc8a'); }
      rect(-21, -40, 42, 5, '#2b1f31');
      // Sleeves and white gloves; the right hand holds the balloon string.
      line(-22, -68, -35, -48, '#6f4374', 12); line(-35, -49, -35, -43, '#3b2440', 8); circle(-35, -42, 6, '#eee9db');
      line(20, -70, 29, -66, '#6f4374', 12); circle(29, -65, 6, '#f0ebdf');
      // Yellow polka-dot bow tie instead of a ruff.
      poly([[0, -82], [-18, -91], [-18, -73]], '#d6b03e'); poly([[0, -82], [18, -91], [18, -73]], '#d6b03e');
      for (const [x, y] of [[-12, -85], [-11, -78], [12, -85], [11, -78]]) circle(x, y, 1.6, '#7a3c66');
      circle(0, -82, 4, '#b5902e');
      // Round cream face with teal hair tufts poking out at the sides.
      for (const side of [-1, 1]) for (let j = 0; j < 4; j++) circle(side * (19 + (j % 2) * 4), -114 + j * 6, 6.5, j % 2 ? '#2f7a73' : '#3f978d');
      c.fillStyle = '#e6dccb'; c.beginPath(); c.ellipse(0, -107, 19, 22, 0, 0, Math.PI * 2); c.fill();
      oval(-6, -114, 7, 8, '#f3ece0');
      for (const side of [-1, 1]) {
        // Black diamond eye paint with sickly yellow eyes.
        poly([[side * 8, -125], [side * 13, -112], [side * 8, -99], [side * 3, -112]], '#1f1b24');
        circle(side * 8, -112, 2.6, '#d8cf6a'); circle(side * 8, -112, 1.1, '#1f1b24');
      }
      circle(0, -103, 3.6, '#b8423b');
      // Wide stitched grin.
      c.strokeStyle = '#2a1f2a'; c.lineWidth = 2; c.beginPath(); c.moveTo(-12, -96); c.quadraticCurveTo(0, -88, 12, -96); c.stroke();
      for (const x of [-8, -3, 2, 7]) line(x, -95, x + 1, -90, '#2a1f2a', 1);
      // Crooked, patched top hat.
      c.save(); c.translate(-2, -127); c.rotate(-0.22);
      rect(-17, -2, 34, 5, '#2a2430'); rect(-11, -26, 22, 25, '#2f2836');
      rect(-11, -8, 22, 5, '#a8433a'); rect(2, -22, 6, 7, '#5d4f39');
      line(2, -22, 8, -15, '#9a8a66', 0.8);
      c.restore();
    } else if (o.kind === 'alien') {
      const sway = Math.sin(g.time * 3 + o.at) * 4;
      for (const side of [-1, 1]) {
        line(side * 11, -36, side * 21, -5, '#397c83', 11); oval(side * 22, -4, 12, 6, '#305969');
        c.strokeStyle = '#5fc9b8'; c.lineWidth = 5; c.beginPath(); c.moveTo(side * 18, -73); c.quadraticCurveTo(side * 42, -53, side * 28 + sway, -26); c.stroke();
        for (let j = 0; j < 3; j++) line(side * 28 + sway, -27, side * (27 + j * 5) + sway, -17 + j * 2, '#5fc9b8', 2);
      }
      oval(0, -55, 19, 28, '#365969'); oval(-7, -60, 7, 20, '#60898a');
      for (let rib = 0; rib < 3; rib++) line(-11, -65 + rib * 9, 11, -62 + rib * 9, '#213d51', 2);
      circle(0, -58, 5, '#84c6bb'); circle(0, -58, 2, '#28495a');
      const skull = c.createRadialGradient(-9, -113, 2, 3, -103, 34); skull.addColorStop(0, '#a3c8ab'); skull.addColorStop(0.5, '#6b9f91'); skull.addColorStop(1, '#2b5864');
      c.fillStyle = skull; c.beginPath(); c.ellipse(0, -102, 23, 31, 0, 0, Math.PI * 2); c.fill();
      for (const side of [-1, 1]) { c.save(); c.translate(side * 11, -106); c.rotate(side * -0.35); c.fillStyle = '#112e43'; c.beginPath(); c.ellipse(0, 0, 7, 12, 0, 0, Math.PI * 2); c.fill(); circle(-1, -3, 2, '#a6f2de'); c.restore(); }
      line(-5, -84, 5, -84, '#345e65', 2);
      line(-9, -130, -15, -145, '#73bba5', 3); line(9, -130, 15, -145, '#73bba5', 3); circle(-15, -146, 4, '#7ae8d5'); circle(15, -146, 4, '#7ae8d5');
    } else {
      // Human zombie silhouette.
      line(-10, -36, -18, -6, '#343b44', 13); line(10, -36, 20, -5, '#3c4349', 13);
      rounded(-28, -10, 23, 10, 4, '#28323c'); rounded(11, -10, 23, 10, 4, '#28323c');
      rounded(-22, -76, 44, 44, 13, '#5f5365'); oval(-12, -63, 7, 18, '#776a71');
      line(-21, -68, -35, -49, '#706278', 12); line(-35, -49, -28, -36, '#72806b', 9);
      line(21, -65, 36, -57, '#62556b', 12); line(36, -57, 39, -39, '#72806b', 9);
      oval(-27, -34, 6, 8, '#8c997d'); oval(39, -37, 6, 8, '#89977b');
      oval(1, -94, 19, 25, '#7b8973'); oval(-6, -99, 8, 15, '#a0a38a');
      poly([[-17, -108], [-12, -121], [9, -120], [19, -107], [10, -110], [2, -116], [-6, -109]], '#353c39');
      oval(-7, -97, 5, 4, '#303c3b'); oval(9, -97, 5, 4, '#303c3b'); circle(-7, -97, 1.8, '#c1bb80'); circle(9, -97, 1.8, '#c1bb80');
      line(-6, -83, 10, -81, '#3d4140', 3); line(5, -92, 3, -87, '#596958', 2); line(12, -109, 16, -102, '#67554d', 1.5);
      for (const y of [-55, -44]) line(-13, y, 9, y + 3, '#2d37404d', 2);
    }
    c.restore();
  }
  // Back-view runner: curly dark perm, teal hoodie, backpack, orange sneakers.
  const p = project(g.lane, 0), jump = heightOf(g) * 53;
  softShadow(p.x, 525, 29 - jump * 0.09, 9 - jump * 0.025);
  c.save(); c.translate(p.x, 522 - jump);
  if (g.shield || g.immuneUntil > g.time) {
    c.strokeStyle = g.shield ? '#8de6e1' : '#f7dda3'; c.lineWidth = 2.5;
    c.beginPath(); if (g.slide > 0) c.ellipse(0, -31, 42, 42, 0, 0, Math.PI * 2); else c.ellipse(0, -60, 43, 82, 0, 0, Math.PI * 2); c.stroke();
  }
  if ((g.time < 2.8 || g.immuneUntil > g.time) && g.mode === 'run') c.globalAlpha = 0.65 + Math.sin(g.time * 14) * 0.2;
  if (g.slide > 0) drawRoll(g); else {
  const stride = g.mode === 'run' && g.jump < 0 ? Math.sin(g.distance * 0.85) * 9 : 0;
  rounded(-19, -43, 16, 39 + stride, 6, '#252d34'); rounded(4, -43, 16, 39 - stride, 6, '#303940');
  line(-16, -34, -14, -12 + stride, '#65707770', 2); line(8, -30, 9, -12 - stride, '#65707760', 2);
  line(-18, -18 + stride, -6, -21 + stride, '#151f2960', 2); line(7, -17 - stride, 17, -20 - stride, '#151f2960', 2);
  rounded(-25, -9 + stride, 25, 15, 6, '#c97e4e'); rounded(2, -9 - stride, 25, 15, 6, '#d38a52');
  line(-22, -7 + stride, -6, -7 + stride, '#edbd8e', 2); line(6, -7 - stride, 22, -7 - stride, '#edbd8e', 2);
  rounded(-25, 2 + stride, 25, 5, 2, '#d5d6cb'); rounded(2, 2 - stride, 25, 5, 2, '#d5d6cb');
  for (const x of [-17, 12]) { line(x, -5, x + 6, -3, '#e7cfaa', 1); line(x, -1, x + 6, 0, '#e7cfaa', 1); }
  const hoodie = c.createLinearGradient(-28, -90, 29, -40); hoodie.addColorStop(0, '#399094'); hoodie.addColorStop(0.48, '#247b82'); hoodie.addColorStop(1, '#124f60');
  c.fillStyle = hoodie; c.beginPath(); c.moveTo(-18, -96); c.quadraticCurveTo(-28, -91, -28, -79); c.lineTo(-24, -43); c.quadraticCurveTo(0, -34, 24, -43); c.lineTo(28, -79); c.quadraticCurveTo(27, -91, 17, -96); c.closePath(); c.fill();
  line(-26, -82, -29, -53 - stride * 0.5, '#2c858a', 13); line(26, -82, 29, -53 + stride * 0.5, '#175e6b', 13);
  oval(-29, -47 - stride * 0.5, 6, 8, '#a16e4e'); oval(29, -47 + stride * 0.5, 6, 8, '#a16e4e');
  oval(-31, -49 - stride * 0.5, 2, 4, '#d09a6b'); oval(27, -49 + stride * 0.5, 2, 4, '#d09a6b');
  line(-25, -61, -18, -64, '#82b1ac55', 1.5); line(18, -54, 25, -58, '#0e3c514f', 2); line(-21, -43, 20, -42, '#103b4a', 2);
  oval(0, -101, 23, 21, '#256d77'); oval(-5, -102, 17, 14, '#3a9292');
  rounded(-15, -120, 30, 23, 9, '#a37353'); oval(-14, -110, 4, 7, '#c49064'); oval(14, -110, 4, 7, '#a87756');
  for (let i = 0; i < 22; i++) {
    const a = i * 2.4, r = 7 + (i % 3) * 6, hx = Math.cos(a) * r, hy = -124 + Math.sin(a) * r * 0.65;
    circle(hx, hy, 7.3, i % 3 === 0 ? '#3c322c' : '#242528');
    c.strokeStyle = '#70604a55'; c.lineWidth = 1; c.beginPath(); c.arc(hx - 1, hy - 1, 4, 3.4, 5.7); c.stroke();
  }
  line(-17, -91, -18, -45, '#182e3b', 5); line(17, -91, 18, -45, '#182e3b', 5);
  rounded(-19, -88, 38, 45, 9, '#243a4b'); rounded(-16, -85, 31, 37, 8, '#3a5060');
  rounded(-13, -64, 27, 17, 4, '#2c4154'); line(-11, -63, 12, -63, '#b39469', 1.2);
  line(-14, -79, -15, -69, '#a7b7b14f', 1); line(15, -79, 15, -52, '#0e243568', 2);
  line(-12, -48, 12, -48, '#6d827e65', 1); rounded(6, -81, 5, 5, 1, '#bd965b'); circle(11, -60, 1.5, '#d0a875');
  }
  c.restore();
  // Fast-drop streaks and a landing dust puff.
  if (g.dropH !== null) {
    c.save(); c.globalAlpha = 0.55;
    for (const x of [-22, 0, 22]) line(p.x + x, 522 - jump - 150 - Math.abs(x), p.x + x, 522 - jump - 112 - Math.abs(x) * 0.5, '#d2f3e9', 2.5);
    c.restore();
  }
  if (g.landFx > 0) {
    c.save(); c.globalAlpha = Math.min(1, g.landFx / 0.25) * 0.5; const k = 1 - g.landFx / 0.25;
    for (const side of [-1, 1]) oval(p.x + side * (26 + k * 24), 520 - k * 6, 14 + k * 8, 6 + k * 2, '#b9c3c4');
    c.restore();
  }
  if (g.mode === 'run' && g.time < 3) { c.fillStyle = '#d2f3e9'; c.font = '600 14px sans-serif'; c.textAlign = 'center'; c.fillText('Find your lane. Keep moving.', 210, 330); }
  if (g.speedFlash > 0 && g.mode === 'run') {
    rect(123, 24, 174, 34, '#172d3c');
    c.fillStyle = '#ffe1a0'; c.font = '700 16px sans-serif'; c.textAlign = 'center';
    c.fillText('Speed up · ' + g.speed + ' m/s', 210, 46);
  }
  rect(0, 568, 420, 12, '#122732');
};

// ------------------------------------------------------------------ UI -----
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const els = { score: $('hud-score'), dist: $('hud-dist'), speed: $('hud-speed'), run: $('hud-run'), wallet: $('hud-wallet'), best: $('hud-best'), status: $('power-status'), overlay: $('overlay'), card: $('overlay-card'), pause: $('btn-pause'), who: $('hud-name') };
let overlayKey = '';

const shopButtons = (context, v) => POWER_SHOP.map((offer) => {
  const locked = context === 'paused' ? v.powerUsed : v.equipped !== null;
  const off = locked || v.wallet < offer.cost;
  const tag = context === 'paused'
    ? (v.pendingPower === offer.id ? ' · Ready' : !v.powerUsed && v.wallet < offer.cost ? ' · Need ' + (offer.cost - v.wallet) + ' more' : '')
    : (v.equipped === offer.id ? ' · Equipped' : !v.equipped && v.wallet < offer.cost ? ' · Need ' + (offer.cost - v.wallet) + ' more' : '');
  return `<button class="btn shop" data-act="claim:${offer.id}" ${off ? 'disabled' : ''}><span class="shop-title">${esc(offer.name)} · ${offer.cost} bricks · ${offer.duration}s${tag}</span><span class="shop-detail">${esc(offer.detail)}</span></button>`;
}).join('');

const nameLine = () => playerName
  ? `<p class="who">Running as <strong>${esc(playerName)}</strong> · <button class="link" data-ui="name">change</button></p>`
  : `<p class="who">Pick a runner name for the leaderboard before your first run.</p>`;

const renderOverlay = (v) => {
  const key = JSON.stringify([v, playerName, submitState]);
  if (key === overlayKey) return;
  overlayKey = key;
  els.overlay.hidden = v.mode === 'run';
  if (v.mode === 'run') return;
  let html = '';
  if (v.mode === 'ready') {
    html = `<h2>Outrun the night.</h2>
      <p class="muted">No safe lane to camp in. Dodge late monster lunges, jump and roll through packed obstacle waves. Collect colorful toy bricks and outrun the night.</p>
      ${nameLine()}
      ${v.equipped ? `<p>Equipped for this run: <strong>${esc(powerName(v.equipped))}</strong></p>` : ''}
      <p class="muted small">Wallet ${v.wallet} bricks · Best ${v.best}</p>
      <button class="btn primary" data-act="start">${playerName ? 'Start running' : 'Choose name & start'}</button>
      <button class="btn" data-ui="board">Leaderboard</button>`;
  } else if (v.mode === 'paused') {
    html = `<h2>Paused · Power shop</h2>
      <p class="muted">Everything is frozen. Spend banked bricks for this run, then Resume to activate your power.</p>
      <section class="left" aria-label="Paused current-run power shop">
        <p>Banked wallet: <strong>${v.wallet}</strong> bricks. This run’s ${v.earned} earned bricks are not banked yet.</p>
        <p class="muted small" role="status">${v.pendingPower ? esc(powerName(v.pendingPower)) + ' is paid for and ready. Its countdown begins only on Resume.' : v.powerUsed ? 'One power per run: your slot is already used, even if that power expired or its shield was consumed. You can still resume.' : 'Choose one power for the CURRENT run, or resume without buying. All countdowns pause with the game.'}</p>
        <div class="grid">${shopButtons('paused', v)}</div>
      </section>
      <button class="btn primary" data-act="pause">Resume run</button>`;
  } else {
    html = `<h2>The night caught up.</h2>
      <p class="muted">${esc(v.reason)}</p>
      <p class="big">Score ${v.score} · ${v.distance} m</p>
      <p class="muted small">${v.bricks} pickups · +${v.earned} bricks banked · Wallet ${v.wallet}</p>
      ${nameLine()}
      ${submitState.text ? `<p class="submit ${submitState.kind}" role="status">${esc(submitState.text)}</p>` : ''}
      <button class="btn" data-ui="board">Leaderboard</button>
      <section class="left shop-block" aria-label="Next-run brick shop">
        <h3>Next-run powers</h3>
        <p class="muted small">Wallet: ${v.wallet} bricks · Earned this run: ${v.earned}. One power for the next run only. Earned game currency, no real money.</p>
        ${v.equipped ? `<p role="status">Equipped: ${esc(powerName(v.equipped))}. Already paid — activates when your next run starts.</p>` : '<p class="muted small">Choose one, or save your bricks and retry normally.</p>'}
        <div class="grid">${shopButtons('over', v)}</div>
      </section>
      <button class="btn primary" data-act="start">${v.equipped ? 'Start next run · ' + esc(powerName(v.equipped)) : 'Run again · save bricks'}</button>`;
  }
  els.card.innerHTML = html;
};

const viewOf = (g) => ({ mode: g.mode, distance: Math.floor(g.distance), bricks: g.bricks, earned: g.earned, wallet: account.wallet, equipped: account.nextPower, pendingPower: g.pendingPower, powerUsed: g.powerUsed, powerStatus: powerStatus(g), score: runScore(g), speed: g.speed, reason: g.reason, best });

const sync = () => {
  const g = model;
  const score = runScore(g);
  if (score > best) { best = score; store.set(KEYS.best, best); }
  const v = viewOf(g);
  els.score.textContent = v.score; els.dist.textContent = v.distance; els.speed.textContent = v.speed;
  els.run.textContent = v.earned; els.wallet.textContent = v.wallet; els.best.textContent = v.best;
  els.who.textContent = playerName || 'no name yet';
  els.status.hidden = !(v.mode === 'run' || v.mode === 'paused');
  els.status.textContent = v.powerStatus;
  els.pause.disabled = v.mode === 'ready' || v.mode === 'over';
  els.pause.textContent = v.mode === 'paused' ? 'Resume run' : 'Pause & Shop';
  document.querySelectorAll('.controls .btn').forEach((b) => { b.disabled = v.mode !== 'run'; });
  renderOverlay(v);
};

const submitRun = (g) => {
  // Client-side anti-spam: exactly one submission attempt per run.
  if (g.submitted) return;
  g.submitted = true;
  const score = runScore(g), distance = Math.floor(g.distance);
  if (!playerName || score <= 0) { submitState = { text: '', kind: '' }; return; }
  submitState = { text: 'Submitting score…', kind: '' };
  leaderboard.submitScore(playerName, score, distance)
    .then((r) => { if (model === g) submitState = r.mode === 'online' ? { text: 'Score posted to the worldwide leaderboard.', kind: 'ok' } : { text: 'Saved to the offline leaderboard (this browser only).', kind: 'ok' }; })
    .catch((err) => { if (model === g) submitState = { text: 'Score not submitted: ' + (err?.message || 'network error'), kind: 'err' }; })
    .finally(() => { if (model === g) sync(); });
};

const action = (name) => {
  let g = model;
  if (name.startsWith('claim:')) {
    const power = name.slice(6);
    if (isPower(power)) {
      const ok = g.mode === 'paused' ? claimPausedPower(g, account, power) : claimPower(g, account, power);
      if (ok) saveAccount();
    }
    sync(); return;
  }
  if (name === 'start') {
    if (g.mode !== 'ready' && g.mode !== 'over') return;
    model = fresh(); g = model; submitState = { text: '', kind: '' };
    if (account.nextPower !== null) activatePower(g, account.nextPower);
    account.nextPower = null; saveAccount(); g.mode = 'run';
    last = 0; spawn(g); sync(); return;
  }
  if (name === 'pause') { if (g.mode === 'run') g.mode = 'paused'; else if (g.mode === 'paused' && !document.hidden) { resumeRun(g); last = 0; } sync(); return; }
  if (g.mode !== 'run') return;
  if (name === 'left') g.target = Math.max(-1, g.target - 1);
  if (name === 'right') g.target = Math.min(1, g.target + 1);
  if (name === 'jump' && g.jump < 0 && g.slide <= 0) g.jump = 0;
  if (name === 'slide') {
    if (g.dropH !== null) g.rollQueued = true;                                     // already dropping: roll on landing
    else if (g.jump >= 0) { g.dropH = jumpHeight(g.jump); g.dropV = FAST_DROP_V; g.rollQueued = false; } // fast drop
    else if (g.slide <= 0) g.slide = SLIDE_TIME;                                    // roll on the ground
  }
};

// ------------------------------------------------------- name + board -----
const nameDialog = $('name-dialog'), nameInput = $('name-input'), nameError = $('name-error');
const boardDialog = $('board-dialog');
let afterName = null;
const anyDialogOpen = () => !nameDialog.hidden || !boardDialog.hidden;
const openName = (then = null) => {
  afterName = then;
  if (model.mode === 'run') action('pause');
  nameInput.value = playerName; nameError.textContent = '';
  nameDialog.hidden = false; nameInput.focus(); nameInput.select();
};
const closeName = () => { nameDialog.hidden = true; afterName = null; };
const saveName = () => {
  const v = validateName(nameInput.value);
  if (!v.ok) { nameError.textContent = v.error; nameInput.focus(); return; }
  playerName = v.name; store.set(KEYS.name, playerName);
  const then = afterName; closeName(); overlayKey = ''; sync();
  if (then) then();
};
$('name-form').addEventListener('submit', (e) => { e.preventDefault(); saveName(); });
$('name-cancel').addEventListener('click', closeName);
nameInput.addEventListener('input', () => { nameError.textContent = ''; });

const openBoard = async () => {
  if (model.mode === 'run') action('pause');
  boardDialog.hidden = false;
  const body = $('board-body'), note = $('board-note');
  body.innerHTML = '<tr><td colspan="4" class="muted">Loading…</td></tr>';
  note.textContent = 'Loading leaderboard…'; note.className = 'muted small';
  $('board-close').focus();
  try {
    const { rows, mode } = await leaderboard.fetchTop(50);
    note.textContent = mode === 'online' ? 'Worldwide leaderboard · Top 50' : 'Offline leaderboard · scores saved in this browser only';
    note.className = mode === 'online' ? 'muted small' : 'offline small';
    if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="muted">No scores yet. Be the first!</td></tr>'; return; }
    const me = playerName.toLowerCase();
    let highlighted = false;
    body.innerHTML = rows.map((r, i) => {
      const mine = !highlighted && me && r.name.toLowerCase() === me;
      if (mine) highlighted = true;
      return `<tr class="${mine ? 'mine' : ''}"><td>${i + 1}</td><td>${esc(r.name)}${mine ? ' <span class="you">your best</span>' : ''}</td><td>${r.score}</td><td>${r.distance} m</td></tr>`;
    }).join('');
    if (me && !highlighted) note.textContent += ' · your best is not in the Top 50 yet';
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="err">${esc(err?.message || 'Could not load the leaderboard.')}</td></tr>`;
  }
};
$('board-close').addEventListener('click', () => { boardDialog.hidden = true; });
boardDialog.addEventListener('click', (e) => { if (e.target === boardDialog) boardDialog.hidden = true; });
nameDialog.addEventListener('click', (e) => { if (e.target === nameDialog) closeName(); });

const startFlow = () => { if (!playerName) openName(() => action('start')); else action('start'); };

// Delegated clicks for overlay/header/controls buttons.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-ui]');
  if (!el || el.disabled) return;
  const act = el.dataset.act, ui = el.dataset.ui;
  if (ui === 'name') openName();
  else if (ui === 'board') openBoard();
  else if (act === 'start') startFlow();
  else if (act === 'slide' && el === slideBtn && performance.now() - slidePointerAt < 1500) return; // already fired on pointerdown
  else if (act) action(act);
});

// ------------------------------------------------------------ controls -----
// "Down held" sources, used to chain a fast drop straight into a roll.
const held = { key: false, button: false, finger: false };
const downHeld = () => held.key || held.button || held.finger;
window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (k === 'arrowdown' || k === 's') held.key = false; });
window.addEventListener('blur', () => { held.key = held.button = held.finger = false; });
const slideBtn = document.querySelector('.controls [data-act="slide"]');
let slidePointerAt = 0;
slideBtn.addEventListener('pointerdown', (e) => { if (slideBtn.disabled) return; e.preventDefault(); held.button = true; slidePointerAt = performance.now(); action('slide'); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) slideBtn.addEventListener(ev, () => { held.button = false; });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && anyDialogOpen()) { closeName(); boardDialog.hidden = true; return; }
  if (anyDialogOpen()) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const k = e.key.toLowerCase();
  const mapped = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'jump', w: 'jump', ' ': 'jump', arrowdown: 'slide', s: 'slide', p: 'pause', escape: 'pause' };
  const name = mapped[k];
  if (!name || (model.mode !== 'run' && model.mode !== 'paused')) return;
  e.preventDefault();
  if (name === 'slide') held.key = true;
  if (!e.repeat) action(name);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && model.mode === 'run') { model.mode = 'paused'; sync(); } last = 0; });
let gesture = null;
canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); gesture = { x: e.clientX, y: e.clientY, fired: false }; try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
// A downward swipe while airborne fast-drops immediately (no need to lift the
// finger); keeping the finger down until landing chains into a roll.
canvas.addEventListener('pointermove', (e) => {
  if (!gesture || gesture.fired) return;
  const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
  if (dy >= 18 && dy > Math.abs(dx) && model.mode === 'run' && model.jump >= 0 && model.dropH === null) { gesture.fired = true; held.finger = true; action('slide'); }
});
canvas.addEventListener('pointerup', (e) => {
  e.preventDefault(); const start = gesture; gesture = null; held.finger = false; if (!start || start.fired) return;
  const dx = e.clientX - start.x, dy = e.clientY - start.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
  action(Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'jump' : 'slide');
});
canvas.addEventListener('pointercancel', () => { gesture = null; held.finger = false; });
// Stop iOS rubber-banding / pull-to-refresh while swiping on the game.
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// --------------------------------------------------------------- loop ------
const frame = (now) => {
  const dt = last ? Math.min(0.04, (now - last) / 1000) : 0; last = now;
  const g = model;
  if (g.mode === 'run') {
    const previous = g.distance;
    g.time += dt; expirePower(g); g.speedFlash = Math.max(0, g.speedFlash - dt);
    g.distance += g.speed * dt;
    advanceSpeed(g);
    g.lane += (g.target - g.lane) * Math.min(1, dt * 16);
    g.landFx = Math.max(0, g.landFx - dt);
    if (g.dropH !== null) {
      g.dropV += FAST_DROP_G * dt; g.dropH -= g.dropV * dt;
      if (g.dropH <= 0) {
        g.dropH = null; g.dropV = 0; g.jump = -1; g.landFx = 0.25;
        // Down still held (key, Slide button or finger) or pressed again mid-drop: roll on landing.
        if (g.rollQueued || downHeld()) g.slide = SLIDE_TIME;
        g.rollQueued = false;
      }
    } else if (g.jump >= 0) { g.jump += dt; if (g.jump >= 0.88) g.jump = -1; }
    g.slide = Math.max(0, g.slide - dt);
    spawn(g);
    targetAmbushes(g);
    if (magnetActive(g)) {
      for (const o of g.items) if (o.kind === 'brick' && !o.done && o.at - g.distance >= 0 && o.at - g.distance <= 12 && Math.abs(g.lane - o.lane) <= 1.05) collectBrick(g, o);
    }
    for (const o of g.items) {
      if (!o.done && o.at > previous && o.at <= g.distance) {
        const inLane = Math.abs(g.lane - monsterLane(o, o.at - g.distance)) < 0.48;
        if (o.kind === 'brick') { if (inLane) collectBrick(g, o); else o.done = true; continue; }
        o.done = true;
        if (inLane) {
          if (g.time > 2.8 && g.immuneUntil <= g.time && blocked(o.kind, heightOf(g), g.slide > 0)) {
            if (g.shield) { g.shield = false; g.power = null; g.immuneUntil = g.time + 0.6; sync(); continue; }
            g.mode = 'over';
            g.reason = isMonster(o.kind) ? (o.kind === 'clown' ? 'The balloon clown' : o.kind === 'alien' ? 'An alien' : 'A zombie') + ' caught your lane. Switch lanes to dodge monsters — jumping and rolling will not clear them.' : isLow(o.kind) ? 'You hit a low obstacle. Jump walls, rubble, fences and coffins, or switch lanes.' : isHigh(o.kind) ? 'You hit an overhead obstacle. Roll under gates, pipes and signs, or switch lanes.' : 'That van or tall crate stack blocks the full lane. Dodge it — jumping and rolling will not clear it.';
            bankRun(g, account); saveAccount(); submitRun(g); sync(); break;
          }
        }
      }
    }
    g.items = g.items.filter((o) => o.at > g.distance - 4);
    g.waves = g.waves.filter((wave) => wave.at > g.distance - 80);
    hud += dt; if (hud > 0.1) { sync(); hud = 0; }
  }
  draw(g);
  raf = requestAnimationFrame(frame);
};
sync();
raf = requestAnimationFrame(frame);

// Small hook for automated smoke tests; harmless in production.
window.__brickAfterDark = { get state() { return model; }, action, get account() { return account; } };
