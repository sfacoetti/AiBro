// Crea le icone dell'exe partendo da quelle disegnate in build/ (che restano invariate):
//   build/icon.ico       32×32
//   build/icon-256.ico   il disegno grande: finestra, tray e notifiche (APP_ICON)
// e genera:
//   build/exe.ico        exe: il disegno grande portato a 256×256 (electron-builder richiede almeno 256px) più il 32×32
//   ui/logo.png          logo nella barra del titolo
// Si esegue con Electron per usare nativeImage: npx electron scripts/make-icon.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function icoFrames(buf) {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + 16 * i;
    const start = buf.readUInt32LE(e + 12);
    return { entry: Buffer.from(buf.subarray(e, e + 8)), data: Buffer.from(buf.subarray(start, start + buf.readUInt32LE(e + 8))) };
  });
}

// Fotogramma della .ico come nativeImage: i BMP sono memorizzati dal basso verso l'alto, in BGRA a 32 bit.
function frameImage(data) {
  if (data.readUInt32BE(0) === 0x89504e47) return nativeImage.createFromBuffer(data);
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2; // l'altezza comprende la maschera
  if (data.readUInt16LE(14) !== 32) throw new Error('Solo fotogrammi a 32 bit');
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
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
}

const largest = (frames) => frames.reduce((a, f) => ((f.entry[0] || 256) > (a.entry[0] || 256) ? f : a));

app.whenReady().then(() => {
  try { build(); } catch (e) { console.error('make-icon:', e.stack); process.exitCode = 1; }
  app.quit();
});

function build() {
  const small = icoFrames(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico')));
  const big = frameImage(largest(icoFrames(fs.readFileSync(path.join(ROOT, 'build', 'icon-256.ico')))).data);
  const png256 = big.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  const entry256 = Buffer.from([0, 0, 0, 0, 1, 0, 32, 0]); // 0 = 256px, 1 piano, 32 bpp
  writeIco(path.join(ROOT, 'build', 'exe.ico'), [{ entry: entry256, data: png256 }, ...small]);
  fs.writeFileSync(path.join(ROOT, 'ui', 'logo.png'), big.toPNG());
  console.log('Icone:', path.join(ROOT, 'build', 'exe.ico'), path.join(ROOT, 'ui', 'logo.png'));
}
