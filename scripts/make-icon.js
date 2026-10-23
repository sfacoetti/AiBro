// Genera build/icon.png (256×256) dallo stesso disegno dell'icona della tray; electron-builder ne ricava l'.ico.
const fs = require('fs');
const path = require('path');
const { trayIcon } = require('../src/icons');

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, trayIcon(256, { badge: null }));
console.log('Icona:', out);
