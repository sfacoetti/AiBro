// Genera le icone della tray come PNG in memoria (nessun file binario nel repo).
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Disco con un "occhio" centrale; badge opzionale in alto a destra.
function trayIcon(size, { color = [217, 119, 87], badge = null } = {}) {
  const c = size / 2;
  const R = size * 0.44;
  const inner = size * 0.17;
  const bR = size * 0.2;
  const bx = size - bR - 0.5;
  const by = bR + 0.5;
  const cover = (d, r) => Math.max(0, Math.min(1, r - d + 0.5));
  return encodePng(size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    if (badge) {
      const db = Math.hypot(x - bx, y - by);
      const a = cover(db, bR);
      if (a > 0) return [...badge, Math.round(255 * a)];
    }
    const disk = cover(d, R);
    if (disk === 0) return [0, 0, 0, 0];
    const hole = cover(d, inner);
    const [r, g, b] = hole > 0 ? [255, 255, 255].map((v, i) => Math.round(v * hole + color[i] * (1 - hole))) : color;
    return [r, g, b, Math.round(255 * disk)];
  });
}

module.exports = { trayIcon };
