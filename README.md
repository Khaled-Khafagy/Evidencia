# Test Evidence Tool

Capture screen evidence for manual test executions and attach it straight to
**Zephyr Scale** as a **Word document** of click-by-click screenshots. Set the
test case result (Pass / Fail / In Progress) and it updates the Zephyr execution
for you.

Works on **macOS** and **Windows**.

---

## Features

- **Screenshots → Word** — start a recording, then press the **capture hotkey**
  each time you want a screenshot of the region. A ring marks the cursor
  position. The set is exported to a `.docx` (one screenshot per page, named
  after the test case).
- **Configurable capture hotkey** — set it in Settings (default
  `Ctrl/Cmd + Shift + S`). It's reserved globally only while a recording is
  running.
- **Region picker** like the native macOS tool (dimmed screen, live dimensions,
  multi-monitor aware).
- **Floating toolbar** while recording, with pause / resume.
- **Per-screenshot annotate / redact / delete** before uploading — step through
  the captured shots, draw boxes, labels and black-box redactions on each one
  (burned in, so PII never leaves your machine), or drop a shot from the set.
- **Zephyr Scale integration** — creates/updates the execution and attaches the
  evidence; sets Pass / Fail / In Progress.
- **History** of past sessions — reopen to re-upload, or delete (with the option
  to remove the files from disk too).
- Global shortcuts: **⌘⇧R / Ctrl+Shift+R** start/stop, **⌘⇧P** pause/resume,
  **⌘⇧X** cancel.

---

## Prerequisites

| Requirement | macOS | Windows |
|---|---|---|
| **Node.js 18+** | [nodejs.org](https://nodejs.org) (Apple-Silicon build recommended) | [nodejs.org](https://nodejs.org) |
| **ffmpeg** (screenshot grab on Windows, cursor markers, annotations, Word export) | `brew install ffmpeg` | `winget install Gyan.FFmpeg` |
| **Git** | preinstalled | [git-scm.com](https://git-scm.com) |

> The app checks for ffmpeg at startup and shows a banner (with the exact install
> command) if it's missing. On Windows ffmpeg is **required** — the screenshot
> grab itself goes through it.

---

## Getting started

```bash
git clone https://github.com/Khaled-Khafagy/Evidencia.git
cd Evidencia
npm install
npm start
```

`npm start` builds and launches the app in development mode.

### Build a standalone app

```bash
npm run dist       # macOS  → release/mac/Test Evidence Tool.app
npm run dist:win   # Windows → release/  (portable .exe)
```

---

## Configuration — one place for everyone

**There is nothing to edit in the code, and no secrets are stored in the repo.**
Each person enters their own credentials once, in the app's **Settings** tab:

| Field | Where to get it |
|---|---|
| **Jira Base URL** | e.g. `https://yourcompany.atlassian.net` |
| **Jira Email** | your Atlassian account email |
| **Jira API Token** | https://id.atlassian.com/manage-profile/security/api-tokens |
| **Zephyr Scale API Token** | Zephyr Scale → **API Access Tokens** |
| **Output Directory** | where captured evidence is saved locally |

These are saved **per-user** to a local `config.json` in the OS app-data folder
(`~/Library/Application Support/test-evidence-tool` on macOS,
`%APPDATA%\test-evidence-tool` on Windows) — **not** in the project, so your
tokens are never committed to Git.

Other options in Settings: the capture hotkey, the cursor-ring marker, whether to
also attach the individual full-quality screenshots, and keep-window-on-top.

---

## macOS permissions (first run)

Only one permission is needed. Grant it to the app (or to **Electron**, if you
run via `npm start`) under **System Settings ▸ Privacy & Security**:

1. **Screen Recording** — required to capture the screen. macOS prompts for it
   the first time a capture runs.

The capture hotkey uses Electron's global-shortcut API, which needs **no
Accessibility permission**.

> Building a standalone `.app` (`npm run dist`) is recommended: it gets its own
> permission entry that **persists across rebuilds**, unlike the shared "Electron"
> entry used in dev.

---

## Windows notes

- Install **ffmpeg** and make sure it's on `PATH` (`winget install Gyan.FFmpeg`,
  then reopen the terminal).
- Screenshot capture uses ffmpeg's `gdigrab`. The capture hotkey is a global
  shortcut — no extra permission dialog.
- While recording, the capture hotkey is reserved system-wide, so that key combo
  won't reach the app under test until you stop. Pick a combo you don't need in
  the app you're testing.
- Windows support shares the same codebase but has had **less real-world testing**
  than macOS. If something looks off (DPI scaling on high-resolution displays is
  the most likely culprit), open an issue with a screenshot.

---

## How to record

1. **Settings** → fill in Jira + Zephyr credentials (once).
2. **Capture** tab → enter your **Project Key**, click **Load Project**.
3. Pick the **Test Cycle** and **Test Case**.
4. **Select Region** — drag over the area to capture.
5. **Start Recording** → run your test, pressing the **capture hotkey**
   (default `Ctrl/Cmd + Shift + S`) at each step you want documented →
   **Stop & Save** from the floating toolbar.
6. Optionally **Annotate / Redact**.
7. Set **Pass / Fail / In Progress** → it builds the Word document and uploads it
   to the Zephyr execution.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner: *"Cannot record — ffmpeg not installed"* | Install ffmpeg (see Prerequisites) and reopen the terminal/app. |
| *"Couldn't register the capture hotkey"* on Start | Another app owns that combo. Change it in **Settings → Capture hotkey** (e.g. `F8`, `Alt+1`). |
| Nothing captured (macOS) | Grant **Screen Recording** permission, then relaunch. |
| Pressing the hotkey does nothing | It only works while a recording is running. Check the combo in Settings and that another app hasn't grabbed it. |
| Annotation text labels don't appear | Your ffmpeg was built without `libfreetype`. Reinstall a standard build. |
| Region captured is wrong / whole screen | Reselect the region; make sure you're on the latest build (`npm run build`). |
| App icon missing in Dock (dev) | Cosmetic in dev; the packaged app (`npm run dist`) has a proper icon. |

---

## Development

```
src/
  main/        Electron main process (windows, capture orchestration, hotkey, IPC)
  renderer/    UI (Capture / History / Settings tabs)
  overlay/     Region-select overlay
  services/    capture (per-platform), image/word helpers, Zephyr/Jira APIs
scripts/       icon generation, cross-platform build helpers
```

- `npm run build` — compile TypeScript + copy assets + generate icons.
- `npm start` — build and run.
- `npm run dist` / `dist:win` — package a distributable.
