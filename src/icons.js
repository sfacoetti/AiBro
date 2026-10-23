// Disegna il badge di stato (cerchio colorato in alto a destra) sopra l'icona dell'app nella tray.
// Lavora sui pixel BGRA restituiti da nativeImage.toBitmap() su Windows.
function overlayBadge(bgra, size, [r, g, b]) {
  const out = Buffer.from(bgra);
  const bR = size * 0.24;
  const ring = Math.max(1, size / 16); // bordo scuro per staccare il badge dal logo
  const cx = size - bR - 0.5;
  const cy = bR + 0.5;
  const cover = (d, radius) => Math.max(0, Math.min(1, radius - d + 0.5));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const outer = cover(d, bR + ring);
      if (!outer) continue;
      const inner = cover(d, bR);
      // Colore del badge sopra un anello quasi nero, poi fuso con il logo sottostante.
      const color = [b, g, r].map((c, i) => c * inner + [20, 16, 12][i] * (1 - inner));
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) out[o + i] = Math.round(color[i] * outer + out[o + i] * (1 - outer));
      out[o + 3] = Math.round(255 * outer + out[o + 3] * (1 - outer));
    }
  }
  return out;
}

module.exports = { overlayBadge };
