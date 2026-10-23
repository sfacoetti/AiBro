// Crea build/icon.ico per l'exe: i fotogrammi 16/32/48 di aibro.ico più un 256×256 ritagliato dal logo in
// aibro_1.jpg (electron-builder richiede almeno 256px). Si esegue con Electron per usare nativeImage.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGO_CROP = { x: 590, y: 78, width: 370, height: 370 }; // la "B" al centro del banner

function icoFrames(buf) {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + 16 * i;
    return { entry: buf.subarray(e, e + 8), data: buf.subarray(buf.readUInt32LE(e + 12), buf.readUInt32LE(e + 12) + buf.readUInt32LE(e + 8)) };
  });
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

app.whenReady().then(() => {
  const big = nativeImage.createFromPath(path.join(ROOT, 'aibro_1.jpg')).crop(LOGO_CROP).resize({ width: 256, height: 256, quality: 'best' });
  const entry256 = Buffer.from([0, 0, 0, 0, 1, 0, 32, 0]); // 0 = 256px, 1 piano, 32 bpp
  const frames = [{ entry: entry256, data: big.toPNG() }, ...icoFrames(fs.readFileSync(path.join(ROOT, 'aibro.ico')))];
  const out = path.join(ROOT, 'build', 'icon.ico');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeIco(out, frames);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon-256.png'), big.toPNG());
  console.log('Icona:', out);
  app.quit();
});
