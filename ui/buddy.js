// Il buddy: la bolla d'acqua (sprite da scripts/make-buddy.js) con la faccia dell'umore corrente.
// A riposo mostra il fotogramma con l'acqua ferma; trascinandolo l'acqua si muove e poi torna calma.
const FRAMES = 125;
const COLS = 16;
const STILL = 22; // deve coincidere con `still` in scripts/make-buddy.js
const FPS = 25;
const SIZE = 256;
const SETTLE_MS = 2500; // quanto continua a muoversi l'acqua dopo che il buddy si è fermato
const HIT_RADIUS = 0.48; // frazione del lato: fuori dal cerchio i clic passano alle finestre sotto
const LAG_MAX = 0.12; // spostamento massimo della faccia, in frazione del lato
const LAG_GAIN = 0.00016; // spostamento per px/s di velocità, in frazione del lato

const $ = (id) => document.getElementById(id);
const buddy = $('buddy');
const ctx = $('water').getContext('2d');
const face = $('face');
const sheet = new Image();
sheet.src = 'buddy/water.webp';

const water = { f: STILL, dir: 1, energy: 0, rate: 1, moving: false };
const lag = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 }; // la faccia "galleggia" in ritardo rispetto alla bolla
let raf = 0;
let last = 0;

function drawFrame(i, alpha) {
  ctx.globalAlpha = alpha;
  ctx.drawImage(sheet, (i % COLS) * SIZE, Math.floor(i / COLS) * SIZE, SIZE, SIZE, 0, 0, SIZE, SIZE);
}

function draw() {
  if (!sheet.complete) return;
  ctx.clearRect(0, 0, SIZE, SIZE);
  drawFrame(STILL, 1);
  // Il fotogramma animato sfuma su quello fermo mentre l'acqua si calma.
  const k = Math.min(1, water.energy * 2.5);
  if (k > 0) drawFrame(Math.round(water.f), k * k * (3 - 2 * k));
  ctx.globalAlpha = 1;
}

function step(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (water.moving) water.energy = 1;
  else water.energy = Math.max(0, water.energy - dt * 1000 / SETTLE_MS);
  if (water.energy > 0) {
    // Avanti e indietro: il video non è un loop continuo.
    water.f += water.dir * dt * FPS * water.rate;
    if (water.f >= FRAMES - 1) { water.f = FRAMES - 1; water.dir = -1; }
    if (water.f <= 0) { water.f = 0; water.dir = 1; }
    if (!water.moving) water.rate = Math.max(0.6, water.rate - dt);
  } else {
    water.rate = 1;
    water.f = STILL;
    water.dir = 1;
  }

  // Molla smorzata verso lo spostamento opposto alla velocità del trascinamento.
  lag.vx += (120 * (lag.tx - lag.x) - 6 * lag.vx) * dt;
  lag.vy += (120 * (lag.ty - lag.y) - 6 * lag.vy) * dt;
  lag.x += lag.vx * dt;
  lag.y += lag.vy * dt;
  face.style.transform = `translate(${lag.x.toFixed(2)}px, ${lag.y.toFixed(2)}px)`;

  draw();
  const busy = water.energy > 0 || Math.abs(lag.x) + Math.abs(lag.y) + Math.abs(lag.vx) + Math.abs(lag.vy) > 0.05;
  raf = busy ? requestAnimationFrame(step) : 0;
}

function wake() {
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(step);
}

sheet.onload = draw;

aibro.onBuddyMotion(({ vx, vy, moving }) => {
  const speed = Math.hypot(vx, vy);
  water.moving = moving && speed > 20;
  // Più lo si scuote, più velocemente si arriva alla parte agitata del video (gocce e schizzi dopo il fotogramma 80).
  if (water.moving) water.rate = Math.max(water.rate, 1 + Math.min(2, speed / 600));
  const max = innerWidth * LAG_MAX;
  const clamp = (v) => Math.max(-max, Math.min(max, v * innerWidth * LAG_GAIN));
  lag.tx = moving ? clamp(-vx) : 0;
  lag.ty = moving ? clamp(-vy) : 0;
  wake();
});

const GLYPHS = '01';
const CHARS_LEN = 3;
const CHARS_MS = 110;
let charsTimer = null;

function scramble() {
  let s = '';
  for (let i = 0; i < CHARS_LEN; i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  $('chars').textContent = s;
}

// Al lavoro ogni tanto è perplesso: in media ogni PERPLEX_EVERY_MS, per PERPLEX_MS.
const PERPLEX_EVERY_MS = 10 * 1000;
const PERPLEX_MS = 1800;
let perplexTimer = null;

function schedulePerplex() {
  perplexTimer = setTimeout(() => {
    const side = Math.random() < 0.5 ? 'left' : 'right';
    $('eyes').dataset.brow = side; // prima la posizione, poi la comparsa
    $('eyes').dataset.squint = side;
    perplexTimer = setTimeout(() => { delete $('eyes').dataset.squint; schedulePerplex(); }, PERPLEX_MS);
  }, PERPLEX_EVERY_MS * (0.6 + Math.random() * 0.8));
}

function setMood(mood) {
  buddy.dataset.mood = mood;
  for (const el of document.querySelectorAll('.mood > [data-mood]')) el.classList.toggle('on', el.dataset.mood === mood);
  clearInterval(charsTimer);
  clearTimeout(perplexTimer);
  charsTimer = perplexTimer = null;
  delete $('eyes').dataset.squint;
  if (mood === 'work') { scramble(); charsTimer = setInterval(scramble, CHARS_MS); schedulePerplex(); }
}
aibro.onBuddyMood(setMood);
aibro.buddyMood().then(setMood);

// ---------- Mouse ----------

let dragging = false;
let ignoring = false;

buddy.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  buddy.setPointerCapture(e.pointerId);
  buddy.classList.add('dragging');
  aibro.buddyDrag(true);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  buddy.classList.remove('dragging');
  aibro.buddyDrag(false);
}
buddy.addEventListener('pointerup', endDrag);
buddy.addEventListener('lostpointercapture', endDrag);

buddy.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  aibro.openMain();
});
buddy.addEventListener('dblclick', () => aibro.toggleMain());

window.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const r = Math.hypot(e.clientX - innerWidth / 2, e.clientY - innerHeight / 2);
  const outside = r > innerWidth * HIT_RADIUS;
  if (outside !== ignoring) { ignoring = outside; aibro.buddyIgnoreMouse(outside); }
});
