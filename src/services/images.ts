import * as fs from 'fs';
import { execSync } from 'child_process';

export interface Annotation {
  type: 'redact' | 'box' | 'text';
  // Coordinates are in ORIGINAL frame pixels (the renderer converts from the
  // scaled preview before sending).
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
}

// Builds an ffmpeg filter fragment from annotation shapes. Redactions are
// filled black boxes; boxes are red outlines; text is a yellow caption chip.
export function buildAnnotationFilter(shapes: Annotation[]): string {
  const parts: string[] = [];
  for (const s of shapes) {
    if (s.type === 'redact') {
      parts.push(`drawbox=x=${Math.round(s.x)}:y=${Math.round(s.y)}:w=${Math.round(s.w || 0)}:h=${Math.round(s.h || 0)}:color=black@1:t=fill`);
    } else if (s.type === 'box') {
      parts.push(`drawbox=x=${Math.round(s.x)}:y=${Math.round(s.y)}:w=${Math.round(s.w || 0)}:h=${Math.round(s.h || 0)}:color=red@1:t=5`);
    } else if (s.type === 'text' && s.text && drawTextAvailable()) {
      parts.push(
        `drawtext=fontfile=${fontFile()}:text='${escapeDrawText(s.text)}'` +
        `:x=${Math.round(s.x)}:y=${Math.round(s.y)}:fontcolor=yellow:fontsize=30:box=1:boxcolor=black@0.6:boxborderw=8`
      );
    }
  }
  return parts.join(',');
}

// Composites a click marker onto a screenshot at (x, y) in image pixels.
// This is why we can grab the frame the instant the mouse goes down — the click
// indicator is drawn onto the image afterwards, instead of us having to wait for
// an on-screen animation to paint (by which time the page has already navigated).
export function stampClickMarker(
  imagePath: string,
  ringPath: string,
  x: number,
  y: number
): void {
  if (!isBinaryAvailable('ffmpeg')) return;
  if (!fs.existsSync(ringPath)) return;
  const tmp = imagePath.replace(/\.png$/i, '_marked.png');
  // overlay places the ring's top-left corner, so offset by half its size to
  // centre it on the click. overlay clamps off-screen coords safely.
  execSync(
    `ffmpeg -y -i "${imagePath}" -i "${ringPath}" -filter_complex ` +
    `"[1:v]scale=iw:ih[r];[0:v][r]overlay=x=${Math.round(x)}-overlay_w/2:y=${Math.round(y)}-overlay_h/2" "${tmp}"`,
    { stdio: 'pipe' }
  );
  fs.renameSync(tmp, imagePath);
}

// Prepares a screenshot for embedding in a document: downscales it to a sane
// resolution and encodes it as high-quality JPEG. Retina PNGs are ~2560px wide
// and several MB each, which makes a multi-page Word file enormous — but the
// page only renders them ~930px wide, so the extra pixels are pure bloat.
// DOC_MAX_WIDTH keeps ~2x the rendered size so text stays crisp when zoomed.
export const DOC_MAX_WIDTH = 1600;

export function optimizeForDocument(
  inputPath: string,
  outputPath: string,
  maxWidth = DOC_MAX_WIDTH
): void {
  if (!isBinaryAvailable('ffmpeg')) throw new Error('ffmpeg is required to optimise screenshots');
  // -q:v 2 is JPEG's near-lossless end; lanczos keeps small UI text legible.
  execSync(
    `ffmpeg -y -i "${inputPath}" -vf "scale='min(${maxWidth},iw)':-2:flags=lanczos" -q:v 2 "${outputPath}"`,
    { stdio: 'pipe' }
  );
}

// Burns an annotation filter into a single image (used for redacting the raw
// screenshots so PII never leaves in the individual frames).
export function applyFilterToImage(inputPath: string, outputPath: string, filter: string): void {
  if (!isBinaryAvailable('ffmpeg')) throw new Error('ffmpeg is required to apply annotations');
  execSync(`ffmpeg -y -i "${inputPath}" -vf "${filter}" "${outputPath}"`, { stdio: 'pipe' });
}

// Escapes text for use inside an ffmpeg drawtext filter value.
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

// `which` doesn't exist on Windows — it's `where`. Result is cached because
// this is called on every capture/annotate operation.
const binCache = new Map<string, boolean>();
export function isBinaryAvailable(bin: string): boolean {
  const cached = binCache.get(bin);
  if (cached !== undefined) return cached;
  const probe = process.platform === 'win32' ? `where ${bin}` : `which ${bin}`;
  let ok = false;
  try {
    execSync(probe, { stdio: 'ignore' });
    ok = true;
  } catch {
    ok = false;
  }
  binCache.set(bin, ok);
  return ok;
}

// drawtext needs a real font file, and the path differs per platform. ffmpeg
// wants forward slashes and an escaped drive colon on Windows.
function fontFile(): string {
  if (process.platform === 'win32') {
    for (const f of ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']) {
      if (fs.existsSync(f)) return f.replace(':', '\\:');
    }
    return 'C\\:/Windows/Fonts/arial.ttf';
  }
  if (process.platform === 'darwin') return '/System/Library/Fonts/Helvetica.ttc';
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
}

// Some ffmpeg builds ship without libfreetype, so the drawtext filter is
// missing and using it crashes the whole command. We probe once and cache it,
// then skip all text fragments when it's unavailable.
let _drawTextAvailable: boolean | null = null;
export function drawTextAvailable(): boolean {
  if (_drawTextAvailable !== null) return _drawTextAvailable;
  try {
    const out = execSync('ffmpeg -hide_banner -filters', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    _drawTextAvailable = /\bdrawtext\b/.test(out);
  } catch {
    _drawTextAvailable = false;
  }
  return _drawTextAvailable;
}
