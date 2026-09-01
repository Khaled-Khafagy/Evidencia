// Generates the app icon (assets/icon.png) with no external dependencies:
// raw RGBA pixels → PNG via Node's built-in zlib. Run: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// Palette matches the app's UI.
const BG_TOP = [26, 26, 46];      // --bg
const BG_BOT = [15, 52, 96];      // --surface2
const RED = [230, 0, 0];          // --red
const WHITE = [255, 255, 255];

const RADIUS = SIZE * 0.22;       // rounded-square corner radius (macOS-ish)

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Signed distance to a rounded rectangle, used for antialiased edges.
function roundedRectAlpha(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2;
  const hw = SIZE / 2 - 1, hh = SIZE / 2 - 1;
  const dx = Math.abs(x - cx) - (hw - RADIUS);
  const dy = Math.abs(y - cy) - (hh - RADIUS);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const dist = outside + Math.min(Math.max(dx, dy), 0) - RADIUS;
  return Math.min(Math.max(0.5 - dist, 0), 1); // 1px antialias band
}

function circleAlpha(x, y, cx, cy, r) {
  return Math.min(Math.max(r - Math.hypot(x - cx, y - cy) + 0.5, 0), 1);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // PNG filter type 0 (None) per scanline
  for (let x = 0; x < SIZE; x++) {
    // Vertical gradient background
    let col = mix(BG_TOP, BG_BOT, y / SIZE);

    // Camera "viewfinder" corner brackets in red
    const m = SIZE * 0.18, len = SIZE * 0.16, th = SIZE * 0.035;
    const nearL = x > m && x < m + len, nearR = x < SIZE - m && x > SIZE - m - len;
    const nearT = y > m && y < m + len, nearB = y < SIZE - m && y > SIZE - m - len;
    const onVert = (Math.abs(x - m) < th && (nearT || nearB)) || (Math.abs(x - (SIZE - m)) < th && (nearT || nearB));
    const onHorz = (Math.abs(y - m) < th && (nearL || nearR)) || (Math.abs(y - (SIZE - m)) < th && (nearL || nearR));
    if (onVert || onHorz) col = RED;

    // Central record dot: white ring + red fill
    const cx = SIZE / 2, cy = SIZE / 2;
    const ring = circleAlpha(x, y, cx, cy, SIZE * 0.20);
    const dot = circleAlpha(x, y, cx, cy, SIZE * 0.155);
    if (ring > 0) col = mix(col, WHITE, ring);
    if (dot > 0) col = mix(col, RED, dot);

    const a = Math.round(roundedRectAlpha(x, y) * 255);
    raw[p++] = col[0];
    raw[p++] = col[1];
    raw[p++] = col[2];
    raw[p++] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png);
console.log('wrote assets/icon.png', SIZE + 'x' + SIZE, (png.length / 1024).toFixed(1) + ' KB');

// ── Click marker ──────────────────────────────────────────────────────────────
// Stamped onto screenshots at the click position, so the evidence shows WHERE
// the user clicked without having to wait for an on-screen animation to paint
// (which would mean capturing after the page already started loading).
// Sized for Retina frames (2x), so it reads as ~80pt on screen.
const RING = 160;
function buildClickRing() {
  const r = RING / 2;
  const raw = Buffer.alloc(RING * (RING * 4 + 1));
  let q = 0;
  for (let y = 0; y < RING; y++) {
    raw[q++] = 0;
    for (let x = 0; x < RING; x++) {
      const d = Math.hypot(x - r + 0.5, y - r + 0.5);
      // Red ring with a white halo on the outside for contrast on any UI.
      const outer = Math.min(Math.max(r - 4 - d + 0.5, 0), 1);   // white edge
      const ring = Math.min(Math.max(6 - Math.abs(d - (r - 14)), 0), 1); // red band
      const halo = Math.min(Math.max(3 - Math.abs(d - (r - 6)), 0), 1);  // white band
      let col = [255, 255, 255];
      let a = 0;
      if (halo > 0) { col = [255, 255, 255]; a = Math.max(a, halo * 0.9); }
      if (ring > 0) { col = [230, 0, 0]; a = Math.max(a, ring); }
      // Soft translucent red fill inside the ring
      // Keep the interior nearly transparent so the clicked element stays legible.
      const fill = Math.min(Math.max((r - 18) - d + 0.5, 0), 1);
      if (fill > 0 && ring === 0 && halo === 0) { col = [230, 0, 0]; a = Math.max(a, fill * 0.10); }
      void outer;
      raw[q++] = col[0];
      raw[q++] = col[1];
      raw[q++] = col[2];
      raw[q++] = Math.round(Math.min(a, 1) * 255);
    }
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(RING, 0);
  ih.writeUInt32BE(RING, 4);
  ih[8] = 8; ih[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const ringPng = buildClickRing();
fs.writeFileSync(path.join(out, 'click-ring.png'), ringPng);
console.log('wrote assets/click-ring.png', RING + 'x' + RING, (ringPng.length / 1024).toFixed(1) + ' KB');

// ── macOS .icns ───────────────────────────────────────────────────────────────
// Packaging needs a real .icns (a PNG won't give a Dock/Finder icon in a bundle).
// Built from the PNG with the OS's own tools; skipped silently off macOS.
if (process.platform === 'darwin') {
  const { execSync } = require('child_process');
  const iconset = path.join(require('os').tmpdir(), 'TestEvidence.iconset');
  try {
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset, { recursive: true });
    const src = path.join(out, 'icon.png');
    for (const s of [16, 32, 128, 256, 512]) {
      execSync(`sips -z ${s} ${s} "${src}" --out "${iconset}/icon_${s}x${s}.png"`, { stdio: 'ignore' });
      execSync(`sips -z ${s * 2} ${s * 2} "${src}" --out "${iconset}/icon_${s}x${s}@2x.png"`, { stdio: 'ignore' });
    }
    execSync(`iconutil -c icns "${iconset}" -o "${path.join(out, 'icon.icns')}"`, { stdio: 'ignore' });
    fs.rmSync(iconset, { recursive: true, force: true });
    console.log('wrote assets/icon.icns');
  } catch (err) {
    console.warn('could not build icon.icns:', err.message);
  }
}
