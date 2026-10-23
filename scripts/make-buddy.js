// Crea gli asset del buddy in ui/buddy da buddy/aibro.mp4 e dalle facce buddy/aibro_*.png.
// Il video (come la GIF, che ne è la versione a 256 colori) ha la scacchiera della "trasparenza" stampata nei
// pixel: qui la si toglie e si ricava l'alpha vero. La scacchiera dentro la bolla non è allineata a quella esterna,
// quindi non si sottrae un modello fisso ma la sua frequenza (demodulazione locale, indipendente dalla fase):
// l'ampiezza residua dice quanto la bolla è trasparente, il resto è il colore.
// Si esegue con Electron (decodifica video e codifica WebP di Chromium): npx electron scripts/make-buddy.js
// Con --faces rigenera solo le facce (pochi secondi invece di qualche minuto).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'buddy');
const OUT = path.join(ROOT, 'ui', 'buddy');
const FACES = ['neutro', 'happy', 'nap', 'quest'];

const OPTS = {
  video: pathToFileURL(path.join(SRC, 'aibro.mp4')).href,
  faces: Object.fromEntries(FACES.map((f) => [f, pathToFileURL(path.join(SRC, `aibro_${f}.png`)).href])),
  facesOnly: process.argv.includes('--faces'),
  // Faccia "al lavoro": gli occhi di neutro senza la bocca (fascia y delle facce 763×763), i caratteri li disegna la UI.
  // midX separa i due occhi: eye-left/eye-right servono a muoverli uno alla volta (espressione perplessa).
  eyes: { from: 'neutro', clearY: 410, clearH: 190, midX: 378 },
  fps: 25,
  frames: 125,
  still: 22, // il fotogramma con l'acqua più ferma: è il buddy a riposo
  cols: 16,
  size: 256, // lato di un fotogramma nello sprite (2× la finestra del buddy)
  crop: { x: 52, y: 50, s: 666 }, // quadrato attorno alla bolla nel video 768×768
  faceCrop: { x: 50, y: 48, s: 666 }, // stesso quadrato nelle facce 763×763
  // Scacchiera misurata fuori dalla bolla: lato del quadrato in px e bolla (centro, raggio)
  p: 11.73, cx: 385, cy: 383, r: 322, bgMean: 212.5,
  fog: 0.6, // < 1 schiarisce il vetro vuoto, che altrimenti risulta lattiginoso sugli sfondi scuri
};

// Gira nella pagina: restituisce { sheet, faces } come data URL.
async function build(o) {
  const toDataUrl = async (canvas, type, quality) => {
    const blob = await canvas.convertToBlob({ type, quality });
    return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  };
  const faces = {};
  const drawFace = async (name, img) => {
    const c = new OffscreenCanvas(o.size, o.size);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, o.faceCrop.x, o.faceCrop.y, o.faceCrop.s, o.faceCrop.s, 0, 0, o.size, o.size);
    faces[name] = await toDataUrl(c, 'image/png');
  };
  for (const [name, url] of Object.entries(o.faces)) {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    await drawFace(name, img);
    if (name === o.eyes.from) {
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      x.clearRect(0, o.eyes.clearY, img.width, o.eyes.clearH);
      await drawFace('eyes', c);
      for (const [side, from, to] of [['eye-left', o.eyes.midX, img.width], ['eye-right', 0, o.eyes.midX]]) {
        const e = new OffscreenCanvas(img.width, img.height);
        const ex = e.getContext('2d');
        ex.drawImage(c, 0, 0);
        ex.clearRect(from, 0, to - from, img.height);
        await drawFace(side, e);
      }
    }
  }
  if (o.facesOnly) return { faces };

  const N = 768;
  const v = document.createElement('video');
  v.muted = true;
  v.src = o.video;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video non leggibile')); });
  const vc = new OffscreenCanvas(N, N);
  const vx = vc.getContext('2d', { willReadFrequently: true });
  const frame = async (i) => {
    v.currentTime = (i + 0.5) / o.fps;
    await new Promise((res) => { v.onseeked = res; });
    vx.drawImage(v, 0, 0, N, N);
    return vx.getImageData(0, 0, N, N).data;
  };

  // Media mobile separabile su una finestra lunga due quadrati (frazionaria): annulla la scacchiera e le armoniche.
  const box1 = (src, L, horiz) => {
    const out = new Float32Array(N * N), h = L / 2, pre = new Float64Array(N + 1);
    for (let l = 0; l < N; l++) {
      for (let k = 0; k < N; k++) pre[k + 1] = pre[k] + src[horiz ? l * N + k : k * N + l];
      const at = (u) => { u = Math.min(N, Math.max(0, u)); const i = Math.floor(u); return i >= N ? pre[N] : pre[i] + (u - i) * (pre[i + 1] - pre[i]); };
      for (let k = 0; k < N; k++) {
        const a = Math.max(0, k + 0.5 - h), b = Math.min(N, k + 0.5 + h);
        out[horiz ? l * N + k : k * N + l] = (at(b) - at(a)) / (b - a);
      }
    }
    return out;
  };
  const lp = (s) => box1(box1(s, 2 * o.p, true), 2 * o.p, false);
  const maxf = (src, R) => {
    const pass = (s, horiz) => {
      const out = new Float32Array(N * N);
      for (let l = 0; l < N; l++) for (let k = 0; k < N; k++) {
        let m = 0;
        for (let j = Math.max(0, k - R); j <= Math.min(N - 1, k + R); j++) { const x = s[horiz ? l * N + j : j * N + l]; if (x > m) m = x; }
        out[horiz ? l * N + k : k * N + l] = m;
      }
      return out;
    };
    return pass(pass(src, true), false);
  };

  // Armoniche della scacchiera (fondamentale e terze) come onde piane cos/sin.
  const w = Math.PI / o.p;
  const harm = [[1, 1], [1, -1], [3, 1], [3, -1], [1, 3], [1, -3], [3, 3], [3, -3]].map(([kx, ky]) => {
    const c = new Float32Array(N * N), s = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const t = w * (kx * x + ky * y); c[y * N + x] = Math.cos(t); s[y * N + x] = Math.sin(t); }
    return [c, s];
  });

  const decheck = (d) => {
    const D = [0, 1, 2].map(() => new Float32Array(N * N)), amp = new Float32Array(N * N), blur = [];
    for (let ch = 0; ch < 3; ch++) {
      const P = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) P[i] = d[i * 4 + ch];
      D[ch].set(P);
      harm.forEach(([c, s], h) => {
        const re = new Float32Array(N * N), im = new Float32Array(N * N);
        for (let i = 0; i < N * N; i++) { re[i] = P[i] * c[i]; im[i] = -P[i] * s[i]; }
        const R = lp(re), I = lp(im);
        for (let i = 0; i < N * N; i++) {
          D[ch][i] -= 2 * (R[i] * c[i] - I[i] * s[i]);
          if (h < 2) amp[i] += Math.hypot(R[i], I[i]) / 3;
        }
      });
      blur.push(lp(lp(P)));
    }
    return { D, amp, blur };
  };

  let A0 = null; // ampiezza della scacchiera dove non c'è nulla davanti (alpha 0)
  const matte = (d) => {
    const { D, amp, blur } = decheck(d);
    if (A0 == null) { let s = 0, n = 0; for (let y = 200; y < 560; y++) for (let x = 5; x < 50; x++) { s += amp[y * N + x]; n++; } A0 = s / n; }
    // Dove cambia la fase della scacchiera interna l'ampiezza crolla: il massimo locale riempie quelle cuciture.
    const A = lp(maxf(amp, 8));
    const out = new ImageData(N, N), Bm = o.bgMean;
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = (i / N) | 0, r = Math.hypot(x - o.cx, y - o.cy);
      // Nelle zone senza dettagli veri si usa la versione sfocata (niente residui); sul bordo della bolla mai.
      let dev = 0;
      for (let ch = 0; ch < 3; ch++) dev = Math.max(dev, Math.abs(D[ch][i] - blur[ch][i]));
      const t = Math.max(Math.min(1, Math.max(0, (r - (o.r - 30)) / 12)), Math.min(1, Math.max(0, (dev - 10) / 14)));
      const k = t * t * (3 - 2 * t);
      const col = [0, 1, 2].map((ch) => blur[ch][i] + k * (D[ch][i] - blur[ch][i]));
      // alpha dall'ampiezza, ma mai meno di quanto serve a spiegare un colore lontano dal grigio di fondo
      let a = 1 - A[i] / A0;
      for (const c of col) a = Math.max(a, c > Bm ? (c - Bm) / (255 - Bm) : (Bm - c) / Bm);
      a = Math.min(1, Math.max(0, a));
      a = a * (o.fog + (1 - o.fog) * a) * Math.min(1, Math.max(0, o.r - r));
      out.data[i * 4 + 3] = Math.round(a * 255);
      if (a < 1 / 255) continue;
      for (let ch = 0; ch < 3; ch++) out.data[i * 4 + ch] = Math.round(Math.min(255, Math.max(0, (col[ch] - (1 - a) * Bm) / a)));
    }
    return out;
  };

  const rows = Math.ceil(o.frames / o.cols);
  const sheet = new OffscreenCanvas(o.cols * o.size, rows * o.size);
  const sx = sheet.getContext('2d');
  sx.imageSmoothingQuality = 'high';
  const full = new OffscreenCanvas(N, N);
  // Prima il fotogramma a riposo: calibra A0 su quello.
  const order = [o.still, ...Array.from({ length: o.frames }, (_, i) => i).filter((i) => i !== o.still)];
  for (const i of order) {
    full.getContext('2d').putImageData(matte(await frame(i)), 0, 0);
    sx.drawImage(full, o.crop.x, o.crop.y, o.crop.s, o.crop.s, (i % o.cols) * o.size, Math.floor(i / o.cols) * o.size, o.size, o.size);
    console.log(`fotogramma ${i}`);
  }
  return { sheet: await toDataUrl(sheet, 'image/webp', 0.9), faces };
}

app.whenReady().then(async () => {
  const blank = path.join(os.tmpdir(), 'aibro-make-buddy.html');
  fs.writeFileSync(blank, '<!doctype html><meta charset="utf-8">');
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => console.log(e.message));
  try {
    await win.loadFile(blank);
    const res = await win.webContents.executeJavaScript(`(${build})(${JSON.stringify(OPTS)})`);
    fs.mkdirSync(OUT, { recursive: true });
    const write = (name, dataUrl) => fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    if (res.sheet) write('water.webp', res.sheet);
    for (const [name, url] of Object.entries(res.faces)) write(`face-${name}.png`, url);
    console.log('Buddy:', OUT);
  } catch (e) {
    console.error('make-buddy:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(blank, { force: true });
    app.quit();
  }
});
