import { exec } from 'child_process';
import { promisify } from 'util';
import { CaptureRegion } from './types';

const execAsync = promisify(exec);

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';

export interface Capabilities {
  platform: string;
  ffmpeg: boolean;
  // On Windows/Linux the screenshot grab itself goes through ffmpeg (gdigrab /
  // x11grab), so without it the tool cannot capture at all. On macOS the OS
  // provides `screencapture`, so ffmpeg is only needed for the click markers,
  // annotations/redaction and the Word export — degraded, but not fatal.
  ffmpegRequired: boolean;
  canRecord: boolean;
  problems: string[];
}

export function checkCapabilities(hasFfmpeg: boolean): Capabilities {
  const ffmpegRequired = !isMac;
  const problems: string[] = [];

  if (!hasFfmpeg) {
    if (ffmpegRequired) {
      problems.push(
        'ffmpeg is not installed or not on PATH. On this platform the screenshot ' +
        'capture goes through ffmpeg, so it cannot start.'
      );
    } else {
      problems.push(
        'ffmpeg is not installed. Screenshots still work, but click markers, ' +
        'annotations/redaction and the Word export are unavailable.'
      );
    }
  }

  return {
    platform: process.platform,
    ffmpeg: hasFfmpeg,
    ffmpegRequired,
    canRecord: hasFfmpeg || !ffmpegRequired,
    problems,
  };
}

// How to install the missing dependency, per platform.
export function ffmpegInstallHint(): string {
  if (isWindows) return 'Install with:  winget install Gyan.FFmpeg\n(then reopen your terminal so PATH updates)';
  if (isMac) return 'Install with:  brew install ffmpeg';
  return 'Install with:  sudo apt install ffmpeg';
}

// Region as the OS capture tool wants it.
//  - macOS `screencapture -R` takes LOGICAL POINTS and writes the file at the
//    display's native (Retina) resolution, so we pass points straight through.
//  - Windows `gdigrab` takes PHYSICAL PIXELS, so we scale by the DPI factor.
// Either way the resulting image is region × scaleFactor pixels, which keeps
// downstream pixel maths (click markers, annotations) identical on both.
function toDeviceRect(region: CaptureRegion, scaleFactor: number) {
  const f = isWindows ? scaleFactor : 1;
  return {
    x: Math.round(region.x * f),
    y: Math.round(region.y * f),
    // gdigrab + libx264/yuv420p require even dimensions.
    w: Math.round((region.width * f) / 2) * 2,
    h: Math.round((region.height * f) / 2) * 2,
  };
}

// ── Screenshots ────────────────────────────────────────────────────────────────
export async function captureFrame(
  region: CaptureRegion,
  outputPath: string,
  scaleFactor: number
): Promise<void> {
  const r = toDeviceRect(region, scaleFactor);

  if (isMac) {
    // -x no shutter sound, -C include the mouse cursor
    await execAsync(`screencapture -x -C -R${r.x},${r.y},${r.w},${r.h} "${outputPath}"`);
    return;
  }

  if (isWindows) {
    // gdigrab grabs the desktop; -draw_mouse 1 is the equivalent of macOS -C.
    await execAsync(
      `ffmpeg -y -f gdigrab -draw_mouse 1 -offset_x ${r.x} -offset_y ${r.y} ` +
      `-video_size ${r.w}x${r.h} -i desktop -frames:v 1 "${outputPath}"`
    );
    return;
  }

  // Linux (X11) — best effort, same shape as the Windows path.
  await execAsync(
    `ffmpeg -y -f x11grab -draw_mouse 1 -video_size ${r.w}x${r.h} ` +
    `-i :0.0+${r.x},${r.y} -frames:v 1 "${outputPath}"`
  );
}
