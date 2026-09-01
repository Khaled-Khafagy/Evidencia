// Cross-platform replacement for the old `mkdir -p … && cp …` copy-assets step,
// which failed on Windows (no `mkdir -p` / `cp`). Copies the renderer/overlay
// static files into dist/ using only Node APIs.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/styles.css', 'dist/renderer/styles.css'],
  ['src/overlay/overlay.html', 'dist/overlay/overlay.html'],
];

for (const [from, to] of files) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

console.log(`copied ${files.length} asset(s) to dist/`);
