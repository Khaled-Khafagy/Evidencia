import { app, BrowserWindow, ipcMain, screen, dialog, shell, globalShortcut, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  captureFrame as platformCaptureFrame,
  checkCapabilities,
  ffmpegInstallHint,
  Capabilities,
} from '../services/capture';
import { buildAnnotationFilter, applyFilterToImage, optimizeForDocument, stampClickMarker, drawTextAvailable, isBinaryAvailable, Annotation } from '../services/images';
import { exportScreenshotsToWord } from '../services/word';
import { ZephyrService } from '../services/zephyr';
import { AppConfig, CaptureRegion, TestSession } from '../services/types';

// Disable GPU acceleration to avoid crashes on some systems
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let recordingActive = false;
let recordingPaused = false;
let currentSession: TestSession | null = null;
let currentExecution: { id: number; key: string } | null = null;
let sessionFrames: string[] = [];
let frameIndex = 0;
let preRecordBounds: Electron.Rectangle | null = null;

// The global-shortcut accelerator currently registered for capture, so it can be
// unregistered again when the recording stops.
let activeCaptureHotkey: string | null = null;
const DEFAULT_CAPTURE_HOTKEY = 'CommandOrControl+Shift+S';

const TOOLBAR_WIDTH = 560;
const TOOLBAR_HEIGHT = 88;

// Shrinks the main window into a compact always-on-top toolbar at the top
// of the screen while recording, so it stays out of the captured region.
function enterToolbarMode(): void {
  if (!mainWindow) return;
  preRecordBounds = mainWindow.getBounds();
  const { width } = screen.getPrimaryDisplay().workArea;
  mainWindow.setMinimumSize(TOOLBAR_WIDTH, TOOLBAR_HEIGHT);
  mainWindow.setBounds({
    x: Math.round((width - TOOLBAR_WIDTH) / 2),
    y: 0,
    width: TOOLBAR_WIDTH,
    height: TOOLBAR_HEIGHT,
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // Exclude the toolbar from screenshots so it never shows in the evidence
  mainWindow.setContentProtection(true);
  mainWindow.webContents.send('toolbar-mode', true);
}

function exitToolbarMode(): void {
  if (!mainWindow) return;
  mainWindow.setContentProtection(false);
  mainWindow.setMinimumSize(800, 600);
  if (preRecordBounds) mainWindow.setBounds(preRecordBounds);
  preRecordBounds = null;
  // Stay floating above the app under test, so the evidence panel is visible
  // straight away instead of vanishing behind the browser.
  mainWindow.setAlwaysOnTop(config.keepOnTop !== false, 'floating');
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  mainWindow.webContents.send('toolbar-mode', false);
}

// Captures one frame of the current region and appends it to the session.
// When `markCursor` is set, a ring is composited around wherever the mouse
// pointer is at the moment of capture (the actual cursor is already in the
// image thanks to screencapture -C / gdigrab -draw_mouse).
// Serialised via `captureInFlight`: mashing the hotkey would otherwise let two
// captures claim the same frameIndex and clobber each other's file.
let captureInFlight = false;
async function captureOnce(markCursor = false): Promise<void> {
  if (!currentSession?.framesDir || captureInFlight) return;
  captureInFlight = true;
  const framePath = path.join(currentSession.framesDir, `frame_${String(frameIndex).padStart(4, '0')}.png`);
  try {
    await captureFrame(currentSession.region, framePath);

    if (markCursor) {
      // Convert the cursor's screen position into pixel coords inside the frame.
      // The frame is captured at native resolution, so scale by the display factor.
      const cursor = screen.getCursorScreenPoint();
      const region = currentSession.region;
      const scale = scaleFactorFor(region);
      const px = (cursor.x - region.x) * scale;
      const py = (cursor.y - region.y) * scale;
      const inRegion = px >= 0 && py >= 0 && px <= region.width * scale && py <= region.height * scale;
      if (inRegion) {
        try {
          stampClickMarker(framePath, getClickRingPath(), px, py);
        } catch (err) {
          console.error('Could not stamp cursor marker:', err);
        }
      }
    }

    sessionFrames.push(framePath);
    frameIndex++;
    mainWindow?.webContents.send('frame-captured', { count: sessionFrames.length });
  } catch (err) {
    console.error('Capture error:', err);
  } finally {
    captureInFlight = false;
  }
}

// The DPI factor of the display the region actually lives on — displays can have
// different scale factors (Retina laptop + non-Retina external), so assuming the
// primary display's factor would capture the wrong resolution on a second screen.
function scaleFactorFor(region: CaptureRegion): number {
  return screen.getDisplayNearestPoint({
    x: Math.round(region.x + region.width / 2),
    y: Math.round(region.y + region.height / 2),
  }).scaleFactor;
}

// ── Capture hotkey ─────────────────────────────────────────────────────────────
// While a recording is running, one global shortcut is registered that grabs a
// single screenshot each time it's pressed. It's registered only for the take
// (so the combo stays usable in other apps the rest of the time) and torn down
// on stop. Electron's globalShortcut needs no OS permission on Windows/Linux and
// only Screen Recording (for the capture itself) on macOS.
// The app's own always-registered shortcuts — the capture hotkey must not be
// one of these, or unregistering it on stop would kill that control too.
const RESERVED_SHORTCUTS = ['CommandOrControl+Shift+R', 'CommandOrControl+Shift+P', 'CommandOrControl+Shift+X'];

function startCaptureHotkey(): { ok: true } | { error: string } {
  const accelerator = (config.captureHotkey || DEFAULT_CAPTURE_HOTKEY).trim();
  if (RESERVED_SHORTCUTS.some(s => s.toLowerCase() === accelerator.toLowerCase())) {
    return { error: `"${accelerator}" is reserved by the tool (start/stop, pause, cancel). Pick a different capture hotkey in Settings.` };
  }
  try {
    const registered = globalShortcut.register(accelerator, () => {
      if (recordingPaused || !currentSession) return;
      void captureOnce(config.markCursor !== false);
    });
    if (!registered) {
      return { error: `Couldn't register the capture hotkey "${accelerator}" — it may be in use by another app. Pick a different one in Settings.` };
    }
    activeCaptureHotkey = accelerator;
    console.log('[capture] hotkey registered:', accelerator);
    return { ok: true };
  } catch (err: any) {
    return { error: `Invalid capture hotkey "${accelerator}": ${err?.message || err}` };
  }
}

function stopCaptureHotkey(): void {
  if (!activeCaptureHotkey) return;
  try { globalShortcut.unregister(activeCaptureHotkey); } catch {}
  activeCaptureHotkey = null;
}

let config: AppConfig = {} as AppConfig;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  const defaults: AppConfig = {
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraApiToken: '',
    zephyrApiToken: '',
    outputDir: path.join(os.homedir(), 'Desktop', 'test-evidence'),
    markCursor: true,
    captureHotkey: DEFAULT_CAPTURE_HOTKEY,
    keepOnTop: true,
  };
  try {
    if (fs.existsSync(configPath)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
    }
  } catch {}
  return defaults;
}

function saveConfig(cfg: AppConfig): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2));
  config = cfg;
}

// ── Project cache ──────────────────────────────────────────────────────────────
// Test cases and cycles are slow to fetch (full pagination), so the last loaded
// set is cached per project and restored on startup. "Load Project" refreshes it.
function getCachePath(projectKey: string): string {
  return path.join(app.getPath('userData'), `project-${sanitize(projectKey)}.json`);
}

function loadProjectCache(projectKey: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(projectKey), 'utf-8'));
  } catch {
    return null;
  }
}

function saveProjectCache(projectKey: string, testCases: any[], testCycles: any[]): void {
  try {
    fs.writeFileSync(
      getCachePath(projectKey),
      JSON.stringify({ projectKey, testCases, testCycles, cachedAt: Date.now() }, null, 2)
    );
  } catch (err) {
    console.error('Could not cache project:', err);
  }
}

// ── Persistent history ─────────────────────────────────────────────────────────
// Sessions survive restarts so the user can re-open a past capture and
// re-upload it. Stored as a JSON list in the output directory.
function getHistoryPath(): string {
  return path.join(config.outputDir || app.getPath('userData'), 'history.json');
}

function loadHistory(): any[] {
  try {
    return JSON.parse(fs.readFileSync(getHistoryPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistoryEntry(entry: any): void {
  try {
    const history = loadHistory();
    history.unshift(entry);
    fs.mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
    // Keep the newest 200 sessions; drop older ones to bound the file.
    fs.writeFileSync(getHistoryPath(), JSON.stringify(history.slice(0, 200), null, 2));
  } catch (err) {
    console.error('Could not persist history:', err);
  }
}

// The icon lives outside dist/, so resolve it relative to the app root in dev
// and to the resources dir once packaged.
function getIconPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'icon.png'), // dev (dist/main → root)
    path.join(process.resourcesPath || '', 'assets', 'icon.png'), // packaged
  ];
  return candidates.find(p => p && fs.existsSync(p)) || '';
}

function getClickRingPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'click-ring.png'),
    path.join(process.resourcesPath || '', 'assets', 'click-ring.png'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || '';
}

function createMainWindow(): void {
  const iconPath = getIconPath();
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
}

// One overlay per display, like the native macOS picker — a single overlay on
// the primary display means you simply cannot select anything on a second
// monitor, which is the bug this replaces. Whichever overlay the user drags on
// wins; its window position converts the local drag into global screen coords.
let overlayWindows: BrowserWindow[] = [];

function closeOverlays(): void {
  for (const w of overlayWindows) {
    if (!w.isDestroyed()) w.close();
  }
  overlayWindows = [];
  overlayWindow = null;
  ipcMain.removeAllListeners('region-selected');
  ipcMain.removeAllListeners('region-cancelled');
}

function createOverlayWindow(): Promise<CaptureRegion> {
  return new Promise((resolve, reject) => {
    closeOverlays();

    for (const display of screen.getAllDisplays()) {
      const { x, y, width, height } = display.bounds;
      const win = new BrowserWindow({
        x, y, width, height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        enableLargerThanScreen: true,
        webPreferences: {
          preload: path.join(__dirname, '..', 'main', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      // Float above the menu bar and Dock, then force the bounds again: macOS
      // otherwise pushes a frameless window below the menu bar, which would make
      // every selection off by the menu bar height.
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setBounds({ x, y, width, height });
      win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
      win.setIgnoreMouseEvents(false);
      overlayWindows.push(win);
    }

    overlayWindow = overlayWindows[0] ?? null;
    console.log(`[region] overlay open on ${overlayWindows.length} display(s)`);

    ipcMain.once('region-selected', (event, region: CaptureRegion) => {
      // Translate the drag (local to whichever overlay it happened on) into
      // global screen coordinates using that window's ACTUAL position.
      const src = BrowserWindow.fromWebContents(event.sender);
      const b = src?.getBounds() ?? { x: 0, y: 0 };
      const screenRegion: CaptureRegion = {
        x: Math.round(region.x + b.x),
        y: Math.round(region.y + b.y),
        width: Math.round(region.width),
        height: Math.round(region.height),
      };
      console.log('[region] local', region, '+ display origin', { x: b.x, y: b.y }, '=> screen', screenRegion);
      closeOverlays();
      resolve(screenRegion);
    });

    ipcMain.once('region-cancelled', () => {
      closeOverlays();
      reject(new Error('cancelled'));
    });
  });
}

// Delegates to the platform capture layer (macOS: screencapture, Windows/Linux:
// ffmpeg gdigrab/x11grab). Both produce a region × scaleFactor pixel image, so
// downstream pixel maths is identical on every platform.
async function captureFrame(region: CaptureRegion, outputPath: string): Promise<void> {
  await platformCaptureFrame(region, outputPath, scaleFactorFor(region));
}

// Global hotkeys work even while the window is a compact toolbar or in the
// background, so the user can drive a recording without clicking the toolbar.
// The renderer owns the recording state, so each shortcut just forwards an
// intent and the renderer decides start vs. stop / pause vs. resume.
function registerShortcuts(): void {
  globalShortcut.register('CommandOrControl+Shift+R', () =>
    mainWindow?.webContents.send('shortcut', 'record'));
  globalShortcut.register('CommandOrControl+Shift+P', () =>
    mainWindow?.webContents.send('shortcut', 'pause'));
  globalShortcut.register('CommandOrControl+Shift+X', () =>
    mainWindow?.webContents.send('shortcut', 'cancel'));
}

// Checked once at startup so the user finds out immediately — not halfway
// through a recording when a capture silently fails.
let capabilities: Capabilities = {
  platform: process.platform, ffmpeg: true, ffmpegRequired: false, canRecord: true, problems: [],
};

function verifyDependencies(): void {
  capabilities = checkCapabilities(isBinaryAvailable('ffmpeg'));
  if (capabilities.problems.length === 0) {
    console.log('[deps] all dependencies present');
    return;
  }
  for (const p of capabilities.problems) console.warn('[deps]', p);

  // Fatal on Windows/Linux (nothing can be captured) → tell the user up front.
  if (!capabilities.canRecord) {
    dialog.showMessageBox({
      type: 'error',
      title: 'ffmpeg is required',
      message: 'ffmpeg is not installed (or not on PATH)',
      detail: `${capabilities.problems[0]}\n\n${ffmpegInstallHint()}`,
      buttons: ['Quit', 'Continue anyway'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      if (response === 0) app.quit();
    });
  }
}

app.whenReady().then(() => {
  config = loadConfig();
  verifyDependencies();
  // In development the Dock shows the generic Electron tile, because the app
  // isn't packaged with an icon. Set it explicitly so it's always recognisable.
  const iconPath = getIconPath();
  if (process.platform === 'darwin' && app.dock && iconPath) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (img.isEmpty()) {
        console.error('[icon] nativeImage could not decode', iconPath);
      } else {
        app.dock.setIcon(img);
        console.log('[icon] dock icon set from', iconPath, img.getSize());
      }
    } catch (err) {
      console.error('[icon] Could not set dock icon:', err);
    }
  } else {
    console.error('[icon] no icon found (looked for assets/icon.png)');
  }
  app.setName('Test Evidence Tool');
  createMainWindow();
  registerShortcuts();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
app.on('will-quit', () => globalShortcut.unregisterAll());

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => config);

ipcMain.handle('save-config', (_e, cfg: AppConfig) => {
  // Merge, don't replace: the Settings form only carries its own fields, and a
  // wholesale overwrite would wipe side-channel state (lastProjectKey, evidence
  // format) that lives in the same config file.
  saveConfig({ ...config, ...cfg });
  // Apply the always-on-top preference right away, not on next launch.
  if (mainWindow && !preRecordBounds) {
    mainWindow.setAlwaysOnTop(config.keepOnTop !== false, 'floating');
  }
  return true;
});

// Brings the window back after region selection: visible, focused, and floating
// above other apps so it never gets lost behind the browser being tested.
function restoreMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // 'floating' keeps it above normal windows but below the capture overlay.
  mainWindow.setAlwaysOnTop(config.keepOnTop !== false, 'floating');
  mainWindow.focus();
  // On macOS the app itself must be activated, or show() alone leaves it behind
  // whichever app currently owns the menu bar.
  if (process.platform === 'darwin') app.focus({ steal: true });
}

ipcMain.handle('select-region', async () => {
  // hide() rather than minimize(): a minimised window disappears into the Dock,
  // which is exactly where it becomes impossible to find again.
  mainWindow?.hide();
  await new Promise(r => setTimeout(r, 250));
  try {
    const region = await createOverlayWindow();
    restoreMainWindow();
    return region;
  } catch {
    restoreMainWindow();
    return null;
  }
});

ipcMain.handle('start-recording', async (_e, session: TestSession) => {
  if (recordingActive) return { error: 'already recording' };
  // Fail loudly up front rather than producing an empty/broken session.
  if (!capabilities.canRecord) {
    return { error: `ffmpeg is required on ${process.platform} to capture. ${ffmpegInstallHint()}` };
  }
  // The Word export (screenshot optimise + cursor markers) needs ffmpeg even on macOS.
  if (!capabilities.ffmpeg) {
    return { error: `The Word export needs ffmpeg. ${ffmpegInstallHint()}` };
  }

  currentSession = session;
  currentExecution = null;
  sessionFrames = [];

  // Create the execution in Zephyr right away with status In Progress, so
  // the test case shows as being executed while recording. Non-fatal: the
  // recording proceeds even if Zephyr is unreachable (a new execution will
  // then be created at upload time instead).
  try {
    const zephyr = new ZephyrService(config);
    currentExecution = await zephyr.createTestExecution({
      testCaseKey: session.testCaseKey,
      testCycleKey: session.testCycleKey,
      projectKey: session.projectKey,
      status: 'In Progress',
      comment: session.notes || 'Execution started by test-evidence-tool',
    });
    mainWindow?.webContents.send('status-update', `Recording… (execution ${currentExecution.key} set to In Progress)`);
  } catch (err) {
    console.error('Could not create In Progress execution:', err);
    mainWindow?.webContents.send('status-update', 'Recording… (could not mark In Progress in Zephyr)');
  }

  const sessionDir = path.join(config.outputDir, sanitize(session.testCaseKey), Date.now().toString());
  fs.mkdirSync(sessionDir, { recursive: true });
  session.framesDir = sessionDir;
  currentSession = session;

  frameIndex = 0;
  recordingPaused = false;
  recordingActive = true;

  // Register the capture hotkey for the duration of the take. If it can't be
  // registered, bail out cleanly so the user isn't left in a recording with no
  // way to capture.
  const hk = startCaptureHotkey();
  if ('error' in hk) {
    recordingActive = false;
    currentSession = null;
    if (currentExecution) {
      const zephyr = new ZephyrService(config);
      zephyr.updateTestExecution({
        executionIdOrKey: currentExecution.id,
        testCaseKey: session.testCaseKey,
        testCycleKey: session.testCycleKey,
        status: 'Not Executed',
        comment: 'Recording aborted (hotkey registration failed)',
      }).catch(() => {});
      currentExecution = null;
    }
    return { error: hk.error };
  }

  enterToolbarMode();

  const hotkeyLabel = (config.captureHotkey || DEFAULT_CAPTURE_HOTKEY);
  mainWindow?.webContents.send('status-update', `Recording… press ${hotkeyLabel} to capture a screenshot`);

  // No screenshot is taken until the user presses the capture hotkey.
  return { ok: true, sessionDir };
});

ipcMain.handle('pause-recording', () => {
  recordingPaused = true;
  return { ok: true };
});

ipcMain.handle('resume-recording', () => {
  recordingPaused = false;
  return { ok: true };
});

// The recording is stopped in two ways now: 'save' finishes the take and
// returns evidence so the user can pick a result in the restored window;
// 'abort' discards and resets the In Progress execution.
ipcMain.handle('stop-recording', async (_e, action: 'save' | 'abort') => {
  recordingActive = false;
  recordingPaused = false;
  stopCaptureHotkey();
  exitToolbarMode();

  // A "save" that captured nothing is a failure, not a silent no-op — say so.
  const savedNothing = action === 'save' && currentSession && sessionFrames.length === 0;
  if (savedNothing) {
    console.warn('[capture] Stop & Save with 0 frames captured');
  }

  if (action === 'abort' || !currentSession || sessionFrames.length === 0) {
    // Discarded: mark the In Progress execution back to Not Executed
    if (currentExecution && currentSession) {
      const zephyr = new ZephyrService(config);
      zephyr.updateTestExecution({
        executionIdOrKey: currentExecution.id,
        testCaseKey: currentSession.testCaseKey,
        testCycleKey: currentSession.testCycleKey,
        status: 'Not Executed',
        comment: 'Recording discarded',
      }).catch(err => console.error('Could not reset discarded execution:', err));
    }
    currentSession = null;
    currentExecution = null;
    sessionFrames = [];
    if (savedNothing) {
      return {
        error: `No screenshots were captured — press ${config.captureHotkey || DEFAULT_CAPTURE_HOTKEY} during the recording to capture one.`,
      };
    }
    return { ok: true };
  }

  // Screenshots go straight into the Word document at upload time — nothing to
  // compile here.
  const session = {
    ...currentSession,
    // result is chosen by the user after the window is restored
    result: undefined,
    frames: sessionFrames,
    executionId: currentExecution?.id,
    executionKey: currentExecution?.key,
  };
  currentSession = null;
  currentExecution = null;
  sessionFrames = [];
  return { ok: true, session };
});

ipcMain.handle('upload-evidence', async (_e, sessionData: {
  testCaseKey: string;
  testCaseName?: string;
  testCycleKey: string;
  projectKey: string;
  result: 'pass' | 'fail' | 'wip';
  frames: string[];
  notes: string;
  executionId?: number;
  executionKey?: string;
  // One shape list per screenshot, aligned to `frames` by index.
  annotationsByFrame?: Annotation[][];
}) => {
  const zephyr = new ZephyrService(config);
  const uploadLog: string[] = [];
  const status =
    sessionData.result === 'pass' ? 'Pass' :
    sessionData.result === 'fail' ? 'Fail' : 'In Progress';

  try {
    let execution: { id: number; key: string };
    if (sessionData.executionId) {
      // Execution was already created (In Progress) when recording started
      mainWindow?.webContents.send('status-update', `Setting execution to ${status}…`);
      execution = { id: sessionData.executionId, key: sessionData.executionKey || String(sessionData.executionId) };
      await zephyr.updateTestExecution({
        executionIdOrKey: sessionData.executionId,
        testCaseKey: sessionData.testCaseKey,
        testCycleKey: sessionData.testCycleKey,
        status,
        comment: sessionData.notes || `Evidence captured by test-evidence-tool`,
      });
      uploadLog.push(`✓ Execution ${execution.key} set to ${status}`);
    } else {
      mainWindow?.webContents.send('status-update', 'Creating test execution…');
      execution = await zephyr.createTestExecution({
        testCaseKey: sessionData.testCaseKey,
        testCycleKey: sessionData.testCycleKey,
        projectKey: sessionData.projectKey,
        status,
        comment: sessionData.notes || `Evidence captured by test-evidence-tool`,
      });
      uploadLog.push(`✓ Created execution: ${execution.key}`);
    }

    {
      // Burn annotations/redactions in first (so nothing sensitive reaches the
      // document), then downscale + JPEG-encode so the Word file stays small.
      mainWindow?.webContents.send('status-update', 'Optimising screenshots…');
      const shots = sessionData.frames.map((frame, i) => {
        // Full-quality PNG (redacted if needed) — what gets attached raw.
        let source = frame;
        const frameFilter = buildAnnotationFilter(sessionData.annotationsByFrame?.[i] || []);
        if (frameFilter) {
          source = frame.replace(/\.png$/i, '_annotated.png');
          applyFilterToImage(frame, source, frameFilter);
        }
        // Compressed copy — what goes inside the Word document.
        let embed = source;
        const optimised = frame.replace(/\.png$/i, '_doc.jpg');
        try {
          optimizeForDocument(source, optimised);
          embed = optimised;
        } catch (err) {
          console.error('Could not optimise screenshot, embedding original:', err);
        }
        const size = nativeImage.createFromPath(embed).getSize();
        return { path: embed, source, width: size.width, height: size.height };
      });

      // One screenshot per page, in a Word file named after the test case.
      mainWindow?.webContents.send('status-update', 'Building Word document…');
      const docName = sanitize(sessionData.testCaseName || sessionData.testCaseKey);
      const docxPath = path.join(path.dirname(sessionData.frames[0]), `${docName}.docx`);
      const title = sessionData.testCaseName
        ? `${sessionData.testCaseKey} — ${sessionData.testCaseName}`
        : sessionData.testCaseKey;
      await exportScreenshotsToWord(shots, docxPath, title);

      mainWindow?.webContents.send('status-update', 'Uploading Word document…');
      await zephyr.attachFileToExecution(execution.id, docxPath);
      const docMb = (fs.statSync(docxPath).size / (1024 * 1024)).toFixed(2);
      uploadLog.push(`✓ Word document attached: ${path.basename(docxPath)} (${shots.length} page${shots.length === 1 ? '' : 's'}, ${docMb} MB)`);

      // Optionally also attach the raw, full-quality screenshots alongside.
      if (config.attachScreenshotsIndividually) {
        for (const shot of shots) {
          await zephyr.attachFileToExecution(execution.id, shot.source);
        }
        uploadLog.push(`✓ ${shots.length} full-quality screenshots also attached`);
      }
    }

    // Persist the completed session so it survives restarts (History tab).
    saveHistoryEntry({
      timestamp: Date.now(),
      testCaseKey: sessionData.testCaseKey,
      testCycleKey: sessionData.testCycleKey,
      projectKey: sessionData.projectKey,
      result: sessionData.result,
      frames: sessionData.frames,
      framesDir: sessionData.frames?.[0] ? path.dirname(sessionData.frames[0]) : undefined,
      executionId: execution.id,
      executionKey: execution.key,
    });

    mainWindow?.webContents.send('status-update', 'Upload complete!');
    return { ok: true, log: uploadLog, executionKey: execution.key };
  } catch (err: any) {
    return { error: err.message, log: uploadLog };
  }
});

ipcMain.handle('fetch-test-cases', async (_e, projectKey: string) => {
  const zephyr = new ZephyrService(config);
  try {
    return await zephyr.getTestCases(projectKey);
  } catch (err: any) {
    return { error: err.message };
  }
});

ipcMain.handle('fetch-test-cycles', async (_e, projectKey: string) => {
  const zephyr = new ZephyrService(config);
  try {
    return await zephyr.getTestCycles(projectKey);
  } catch (err: any) {
    return { error: err.message };
  }
});

ipcMain.handle('fetch-cycle-test-cases', async (_e, testCycleKey: string) => {
  const zephyr = new ZephyrService(config);
  try {
    return await zephyr.getTestCasesInCycle(testCycleKey);
  } catch (err: any) {
    return { error: err.message };
  }
});

ipcMain.handle('get-project-cache', (_e, projectKey: string) => loadProjectCache(projectKey));

ipcMain.handle('save-project-cache', (_e, data: { projectKey: string; testCases: any[]; testCycles: any[] }) => {
  saveProjectCache(data.projectKey, data.testCases, data.testCycles);
  return { ok: true };
});

ipcMain.handle('save-project-key', (_e, key: string) => {
  saveConfig({ ...config, lastProjectKey: key });
  return { ok: true };
});

// Annotations are burned into the screenshots at upload time; here we just burn
// a preview of one shot (previewIndex) so the renderer can show the result
// outside the editor. Returns a cache-busting stamp so the <img> reloads.
ipcMain.handle('annotate-evidence', async (_e, data: {
  frames: string[];
  annotationsByFrame: Annotation[][];
  previewIndex?: number;
}) => {
  try {
    const idx = Math.min(Math.max(data.previewIndex ?? 0, 0), (data.frames?.length ?? 1) - 1);
    const filter = buildAnnotationFilter(data.annotationsByFrame?.[idx] || []);
    let previewPath: string | undefined;
    if (filter && data.frames?.[idx]) {
      previewPath = data.frames[idx].replace(/\.png$/i, '_preview.png');
      applyFilterToImage(data.frames[idx], previewPath, filter);
    }
    return { ok: true, previewPath, previewIndex: idx, stamp: Date.now() };
  } catch (err: any) {
    return { error: err.message };
  }
});

// Removes one captured screenshot from the current session's folder. Only ever
// touches files inside the configured output directory, and only .png frames.
ipcMain.handle('delete-frame', (_e, framePath: string) => {
  try {
    const outputDir = path.resolve(config.outputDir || '');
    const target = path.resolve(framePath);
    const safe = !!outputDir
      && target.startsWith(outputDir + path.sep)
      && /frame_\d+\.png$/i.test(target);
    if (!safe) return { error: 'Refused to delete a file outside the output directory.' };
    for (const p of [target,
      target.replace(/\.png$/i, '_annotated.png'),
      target.replace(/\.png$/i, '_doc.jpg'),
      target.replace(/\.png$/i, '_preview.png'),
      target.replace(/\.png$/i, '_marked.png')]) {
      try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch {}
    }
    return { ok: true };
  } catch (err: any) {
    return { error: err.message };
  }
});

ipcMain.handle('ffmpeg-caps', () => ({
  drawText: capabilities.ffmpeg && drawTextAvailable(),
  ...capabilities,
  installHint: ffmpegInstallHint(),
  appName: app.getName(),
  captureHotkey: config.captureHotkey || DEFAULT_CAPTURE_HOTKEY,
}));

ipcMain.handle('get-history', () => loadHistory());

// Removes a session from the history list, optionally deleting its captured
// files from disk. Destructive, so it always asks first — and only ever deletes
// inside the configured output directory.
ipcMain.handle('delete-history-entry', async (_e, timestamp: number) => {
  const history = loadHistory();
  const entry = history.find((h: any) => h.timestamp === timestamp);
  if (!entry) return { error: 'Session not found' };

  const folder = entry.framesDir;
  const outputDir = path.resolve(config.outputDir || '');
  // Only offer on-disk deletion for folders that really live under outputDir.
  const canDeleteFiles = !!folder
    && !!outputDir
    && path.resolve(folder).startsWith(outputDir + path.sep)
    && fs.existsSync(folder);

  const buttons = canDeleteFiles
    ? ['Cancel', 'Remove from list only', 'Delete files too']
    : ['Cancel', 'Remove from list'];

  const { response } = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons,
    defaultId: 1,
    cancelId: 0,
    message: `Delete evidence for ${entry.testCaseKey}?`,
    detail: canDeleteFiles
      ? `Captured ${new Date(entry.timestamp).toLocaleString()}.\n\n"Delete files too" permanently removes the screenshots and the Word document from:\n${folder}`
      : `Captured ${new Date(entry.timestamp).toLocaleString()}.\n\nThe files are not in the output directory, so only the history entry will be removed.`,
  });

  if (response === 0) return { cancelled: true };

  const deleteFiles = canDeleteFiles && response === 2;
  if (deleteFiles) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (err: any) {
      return { error: `Could not delete files: ${err.message}` };
    }
  }

  const remaining = history.filter((h: any) => h.timestamp !== timestamp);
  fs.writeFileSync(getHistoryPath(), JSON.stringify(remaining, null, 2));
  return { ok: true, deletedFiles: deleteFiles };
});

ipcMain.handle('open-folder', (_e, folderPath: string) => {
  shell.openPath(folderPath);
});

ipcMain.handle('show-save-dialog', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.filePaths[0] ?? null;
});

function sanitize(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_');
}
