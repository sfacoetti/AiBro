// Crea le icone arancioni partendo da quelle blu originali (che restano invariate):
//   aibro_orange.ico     copia di aibro.ico ricolorata: finestra, tray e notifiche
//   build/icon.ico       exe: i fotogrammi di aibro_orange.ico più un 256×256 ritagliato dal logo in aibro_1.jpg
//                        (electron-builder richiede almeno 256px)
//   build/icon-256.png
//   ui/logo.png          logo nella barra del titolo
// Il blu del logo diventa la tinta dell'accento dell'app, il fondo blu notte un grigio scuro neutro.
// Si esegue con Electron per usare nativeImage: npx electron scripts/make-icon.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGO_CROP = { x: 590, y: 78, width: 370, height: 370 }; // la "B" al centro del banner
const HUE = 22; // arancione, vicino a --accent
const SRC_HUE = 212; // blu del logo originale

// Pixel BGRA (nativeImage.toBitmap() su Windows e fotogrammi BMP delle .ico), modificati sul posto.
// Ruota le tinte blu verso HUE (compresse a ±14°) e toglie la saturazione alle zone scure, cioè al fondo.
function recolor(px, start = 0, end = px.length) {
  for (let i = start; i < end; i += 4) {
    const b = px[i] / 255, g = px[i + 1] / 255, r = px[i + 2] / 255;
    const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
    let h = 0;
    if (d) h = 60 * (v === r ? ((g - b) / d) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4);
    const dh = ((h - SRC_HUE + 540) % 360) - 180;
    h = (HUE + Math.max(-14, Math.min(14, dh * 0.5)) + 360) % 360;
    const t = Math.min(1, Math.max(0, (v - 0.28) / 0.2));
    const s = Math.min(1, (v ? d / v : 0) * t * t * (3 - 2 * t) * 1.05);
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [rr, gg, bb] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
    px[i] = Math.round((bb + m) * 255);
    px[i + 1] = Math.round((gg + m) * 255);
    px[i + 2] = Math.round((rr + m) * 255);
  }
  return px;
}

function icoFrames(buf) {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + 16 * i;
    const start = buf.readUInt32LE(e + 12);
    return { entry: Buffer.from(buf.subarray(e, e + 8)), data: Buffer.from(buf.subarray(start, start + buf.readUInt32LE(e + 8))) };
  });
}

// Fotogramma BMP a 32 bit: dopo l'intestazione ci sono i pixel BGRA, poi la maschera AND (lasciata com'è).
function recolorFrame(data) {
  if (data.readUInt32BE(0) === 0x89504e47) {
    const img = nativeImage.createFromBuffer(data);
    const { width, height } = img.getSize();
    return nativeImage.createFromBitmap(recolor(Buffer.from(img.toBitmap())), { width, height }).toPNG();
  }
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2; // l'altezza comprende la maschera
  if (data.readUInt16LE(14) !== 32) throw new Error('Solo fotogrammi a 32 bit');
  recolor(data, headerSize, headerSize + width * height * 4);
  return data;
}

// Fotogramma della .ico come nativeImage: i BMP sono memorizzati dal basso verso l'alto.
function frameImage(data) {
  if (data.readUInt32BE(0) === 0x89504e47) return nativeImage.createFromBuffer(data);
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) data.copy(px, y * width * 4, headerSize + (height - 1 - y) * width * 4, headerSize + (height - y) * width * 4);
  return nativeImage.createFromBitmap(px, { width, height });
}

function writeIco(file, frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + 16 * frames.length;
  const entries = frames.map((f) => {
    const e = Buffer.alloc(16);
    f.entry.copy(e, 0, 0, 8);
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.data.length;
    return e;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
}

app.whenReady().then(() => {
  try { build(); } catch (e) { console.error('make-icon:', e.stack); process.exitCode = 1; }
  app.quit();
});

function build() {
  const frames = icoFrames(fs.readFileSync(path.join(ROOT, 'aibro.ico'))).map((f) => ({ ...f, data: recolorFrame(f.data) }));
  writeIco(path.join(ROOT, 'aibro_orange.ico'), frames);

  // Senza il banner si riusa il 256×256 arancione già generato.
  const banner = path.join(ROOT, 'aibro_1.jpg');
  const prev = path.join(ROOT, 'build', 'icon-256.png');
  let big;
  if (fs.existsSync(banner)) {
    const crop = nativeImage.createFromPath(banner).crop(LOGO_CROP).resize({ width: 256, height: 256, quality: 'best' });
    big = nativeImage.createFromBitmap(recolor(Buffer.from(crop.toBitmap())), { width: 256, height: 256 });
  } else if (fs.existsSync(prev)) {
    big = nativeImage.createFromPath(prev);
  } else {
    throw new Error('Servono aibro_1.jpg oppure build/icon-256.png per il fotogramma 256×256');
  }
  const entry256 = Buffer.from([0, 0, 0, 0, 1, 0, 32, 0]); // 0 = 256px, 1 piano, 32 bpp
  writeIco(path.join(ROOT, 'build', 'icon.ico'), [{ entry: entry256, data: big.toPNG() }, ...frames]);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-256.png'), big.toPNG());
  // Il logo della barra del titolo è il fotogramma più grande della .ico, che ha lo stesso disegno della tray.
  const largest = frames.reduce((a, f) => ((f.entry[0] || 256) > (a.entry[0] || 256) ? f : a));
  fs.writeFileSync(path.join(ROOT, 'ui', 'logo.png'), frameImage(largest.data).toPNG());
  console.log('Icone:', path.join(ROOT, 'aibro_orange.ico'), path.join(ROOT, 'build', 'icon.ico'), path.join(ROOT, 'ui', 'logo.png'));
}
