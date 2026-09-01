/* eslint-disable @typescript-eslint/no-explicit-any */

// Injected by preload via contextBridge. Note: must not be named `api` —
// contextBridge defines window.api as a non-configurable global, and a
// top-level `const api` collides with it and kills the whole script.
const rendererApi = (window as any).api as {
  getConfig: () => Promise<any>;
  saveConfig: (cfg: any) => Promise<boolean>;
  selectRegion: () => Promise<any>;
  startRecording: (session: any) => Promise<any>;
  stopRecording: (result: string) => Promise<any>;
  pauseRecording: () => Promise<any>;
  resumeRecording: () => Promise<any>;
  uploadEvidence: (data: any) => Promise<any>;
  saveProjectKey: (key: string) => Promise<any>;
  getProjectCache: (projectKey: string) => Promise<any>;
  saveProjectCache: (data: any) => Promise<any>;
  fetchTestCases: (projectKey: string) => Promise<any>;
  fetchTestCycles: (projectKey: string) => Promise<any>;
  fetchCycleTestCases: (testCycleKey: string) => Promise<any>;
  getHistory: () => Promise<any[]>;
  deleteHistoryEntry: (timestamp: number) => Promise<any>;
  annotateEvidence: (data: any) => Promise<any>;
  deleteFrame: (framePath: string) => Promise<any>;
  ffmpegCaps: () => Promise<any>;
  openFolder: (path: string) => void;
  showSaveDialog: () => Promise<string | null>;
  onFrameCaptured: (cb: (d: { count: number }) => void) => void;
  onStatusUpdate: (cb: (msg: string) => void) => void;
  onToolbarMode: (cb: (active: boolean) => void) => void;
  onShortcut: (cb: (action: string) => void) => void;
};

// ── State ─────────────────────────────────────────────────────────────────────
let selectedRegion: any = null;
let allTestCases: { key: string; name: string }[] = [];
let allTestCycles: { key: string; name: string }[] = [];
let isRecording = false;
let lastSession: any = null;
let captureHotkeyLabel = 'CommandOrControl+Shift+S';
// Assigned inside initApp so persisted history can be refreshed from anywhere
// (e.g. right after an upload writes a new entry).
let refreshHistoryView: (() => void) | null = null;

// ── Elements ─────────────────────────────────────────────────────────────────
const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) console.warn(`❌ Element #${id} not found`);
  return el!;
};

// ── Helpers (define early so they're available to init) ────────────────────────
function setStatus(msg: string): void {
  const bar = $('statusBar');
  if (bar) bar.textContent = msg;
}

// Turns an Electron accelerator ("CommandOrControl+Shift+S") into something
// friendlier for the status bar ("Ctrl+Shift+S", or ⌘⇧S on macOS).
function prettyHotkey(accelerator: string): string {
  const mac = navigator.platform.toLowerCase().includes('mac');
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl/gi, mac ? 'Cmd' : 'Ctrl')
    .replace(/\bCommand\b|\bCmd\b/gi, 'Cmd')
    .replace(/\bControl\b/gi, 'Ctrl');
}

// Set when a required dependency (ffmpeg) is missing — recording is impossible,
// so the button must stay disabled regardless of the form state.
let recordingBlocked = false;

function updateRecordButton(): void {
  const testCaseSelected = (($('testCase') as HTMLSelectElement)?.value || '').length > 0;
  const regionSelected = !!selectedRegion;
  const btn = $('btnRecord') as HTMLButtonElement;
  if (btn) btn.disabled = recordingBlocked || !(testCaseSelected && regionSelected);
}

// Rebuild the test case dropdown, either with the full project list or with
// the cases belonging to the selected test cycle. Preserves the current
// selection if the case is still in the list.
function populateTestCases(cycleCases?: { key: string; name: string }[] | null): void {
  const tcSel = $('testCase') as HTMLSelectElement;
  if (!tcSel) return;
  const previous = tcSel.value;
  const cases = cycleCases ?? allTestCases;
  tcSel.innerHTML = '<option value="">— select —</option>';
  cases.forEach(tc => {
    const o = document.createElement('option');
    o.value = tc.key;
    o.textContent = tc.name === tc.key ? tc.key : `${tc.key} — ${tc.name}`;
    tcSel.appendChild(o);
  });
  if (previous && cases.some(tc => tc.key === previous)) tcSel.value = previous;
  updateRecordButton();
}

// Rebuild the test cycle dropdown, restricted to cycles whose key or name
// matches the filter text. The currently selected cycle always stays listed
// so filtering can't silently clear an active selection.
function populateTestCycles(filterText?: string): void {
  const cycleSel = $('testCycle') as HTMLSelectElement;
  if (!cycleSel) return;
  const previous = cycleSel.value;
  const needle = (filterText || '').trim().toLowerCase();
  const cycles = allTestCycles.filter(tc =>
    !needle ||
    tc.key === previous ||
    tc.key.toLowerCase().includes(needle) ||
    tc.name.toLowerCase().includes(needle)
  );
  cycleSel.innerHTML = '<option value="">— select —</option>';
  cycles.forEach(tc => {
    const o = document.createElement('option');
    o.value = tc.key;
    o.textContent = `${tc.key} — ${tc.name}`;
    cycleSel.appendChild(o);
  });
  if (previous && cycles.some(tc => tc.key === previous)) cycleSel.value = previous;
}

function addToSessionHistory(_session: any): void {
  // History is now persisted by the main process on upload; just refresh the
  // view from disk so the newest entry shows up.
  refreshHistoryView?.();
}

// ── Main Init ─────────────────────────────────────────────────────────────────
function initApp(): void {

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
    return;
  }


  // ── Tabs ─────────────────────────────────────────────────────────────────────
  function switchTab(tabName: string): void {
    document.querySelectorAll('.tab').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
    const tabContent = document.getElementById(`tab-${tabName}`);
    if (tabBtn) {
      tabBtn.classList.add('active');
    }
    if (tabContent) {
      tabContent.classList.add('active');
    }
  }

  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((btn: Element) => {
    const tabName = (btn as HTMLElement).dataset.tab;
    btn.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (tabName) switchTab(tabName);
    });
  });

  // ── Settings ──────────────────────────────────────────────────────────────────
  async function loadSettings(): Promise<void> {
    try {
      const cfg = await rendererApi.getConfig();
      const baseUrl = $('jiraBaseUrl') as HTMLInputElement;
      const email = $('jiraEmail') as HTMLInputElement;
      const apiToken = $('jiraApiToken') as HTMLInputElement;
      const zephyrToken = $('zephyrApiToken') as HTMLInputElement;
      const outDir = $('outputDir') as HTMLInputElement;
      const attachScreen = $('attachScreenshots') as HTMLInputElement;

      if (baseUrl) baseUrl.value = cfg.jiraBaseUrl || '';
      if (email) email.value = cfg.jiraEmail || '';
      if (apiToken) apiToken.value = cfg.jiraApiToken || '';
      if (zephyrToken) zephyrToken.value = cfg.zephyrApiToken || '';
      if (outDir) outDir.value = cfg.outputDir || '';
      if (attachScreen) attachScreen.checked = !!cfg.attachScreenshotsIndividually;
      const markCursor = $('markCursor') as HTMLInputElement;
      if (markCursor) markCursor.checked = cfg.markCursor !== false;
      captureHotkeyLabel = cfg.captureHotkey || 'CommandOrControl+Shift+S';
      const hotkey = $('captureHotkey') as HTMLInputElement;
      if (hotkey) hotkey.value = captureHotkeyLabel;
      const onTop = $('keepOnTop') as HTMLInputElement;
      if (onTop) onTop.checked = cfg.keepOnTop !== false;
      // Restore the last-used project key so it persists across restarts.
      const projKey = $('projectKey') as HTMLInputElement;
      if (projKey && cfg.lastProjectKey && !projKey.value) projKey.value = cfg.lastProjectKey;
    } catch (err) {
      console.error('Error loading settings:', err);
    }
  }

  const btnSaveSettings = $('btnSaveSettings');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      const cfg = {
        jiraBaseUrl: (($('jiraBaseUrl') as HTMLInputElement)?.value || '').trim(),
        jiraEmail: (($('jiraEmail') as HTMLInputElement)?.value || '').trim(),
        jiraApiToken: (($('jiraApiToken') as HTMLInputElement)?.value || '').trim(),
        zephyrApiToken: (($('zephyrApiToken') as HTMLInputElement)?.value || '').trim(),
        outputDir: (($('outputDir') as HTMLInputElement)?.value || '').trim(),
        attachScreenshotsIndividually: (($('attachScreenshots') as HTMLInputElement)?.checked || false),
        markCursor: (($('markCursor') as HTMLInputElement)?.checked ?? true),
        captureHotkey: ((($('captureHotkey') as HTMLInputElement)?.value || '').trim() || 'CommandOrControl+Shift+S'),
        keepOnTop: (($('keepOnTop') as HTMLInputElement)?.checked ?? true),
      };
      await rendererApi.saveConfig(cfg);
      const saved = $('settingsSaved') as HTMLElement;
      if (saved) {
        saved.style.display = 'block';
        setTimeout(() => { saved.style.display = 'none'; }, 2000);
      }
    });
  }

  const btnChooseDir = $('btnChooseDir');
  if (btnChooseDir) {
    btnChooseDir.addEventListener('click', async () => {
      const dir = await rendererApi.showSaveDialog();
      if (dir) {
        const outDir = $('outputDir') as HTMLInputElement;
        if (outDir) outDir.value = dir;
      }
    });
  }

  // ── Load test data ────────────────────────────────────────────────────────────
  const btnLoadData = $('btnLoadData');
  if (btnLoadData) {
    btnLoadData.addEventListener('click', async () => {
      const projectKey = (($('projectKey') as HTMLInputElement)?.value || '').trim().toUpperCase();
      if (!projectKey) return setStatus('Enter a project key first.');
      rendererApi.saveProjectKey(projectKey);
      setStatus('Loading…');

      try {
        const [cases, cycles] = await Promise.all([
          rendererApi.fetchTestCases(projectKey),
          rendererApi.fetchTestCycles(projectKey),
        ]);


        const tcSel = $('testCase') as HTMLSelectElement;
        if (tcSel) {
          tcSel.innerHTML = '<option value="">— select —</option>';
          if (cases?.error) {
            setStatus(`❌ Error: ${cases.error}`);
            console.error('Cases error:', cases.error);
            return;
          } else if (Array.isArray(cases) && cases.length > 0) {
            allTestCases = cases;
            populateTestCases();
          } else {
            setStatus(`⚠️ No test cases found. Check Jira credentials.`);
            return;
          }

          const cycleSel = $('testCycle') as HTMLSelectElement;
          if (cycleSel) {
            allTestCycles = (!cycles?.error && Array.isArray(cycles)) ? cycles : [];
            const cycleSearch = $('testCycleSearch') as HTMLInputElement;
            if (cycleSearch) cycleSearch.value = '';
            populateTestCycles();

            // Cache the loaded project so it's ready instantly next launch.
            rendererApi.saveProjectCache({
              projectKey,
              testCases: allTestCases,
              testCycles: allTestCycles,
            });

            setStatus(`✓ Loading completed — ${allTestCases.length} test cases, ${allTestCycles.length} cycles`);
            updateRecordButton();
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`❌ Exception: ${msg}`);
        console.error('Load data error:', err);
      }
    });
  }

  // Persist the project key whenever it changes, so it survives restarts.
  ($('projectKey') as HTMLInputElement)?.addEventListener('change', e => {
    const key = (e.target as HTMLInputElement).value.trim().toUpperCase();
    if (key) rendererApi.saveProjectKey(key);
  });

  // ── Region selection ──────────────────────────────────────────────────────────
  const btnSelectRegion = $('btnSelectRegion');
  if (btnSelectRegion) {
    btnSelectRegion.addEventListener('click', async () => {
      const region = await rendererApi.selectRegion();
      if (region) {
        selectedRegion = region;
        const display = $('regionDisplay');
        if (display) {
          display.textContent = `x:${region.x}  y:${region.y}  ${region.width} × ${region.height} px`;
          display.classList.add('has-region');
        }
        updateRecordButton();
      }
    });
  }

  // ── Test case selection ────────────────────────────────────────────────────────
  const testCaseSelect = $('testCase') as HTMLSelectElement;
  if (testCaseSelect) {
    testCaseSelect.addEventListener('change', () => {
      updateRecordButton();
    });
  }

  // ── Test cycle search: instant suggestions dropdown while typing ──────────────
  const testCycleSearch = $('testCycleSearch') as HTMLInputElement;
  const cycleSuggestions = $('cycleSuggestions') as HTMLElement;

  function hideSuggestions(): void {
    cycleSuggestions?.classList.remove('open');
  }

  function selectCycle(key: string, labelText: string): void {
    const cycleSel = $('testCycle') as HTMLSelectElement;
    populateTestCycles(); // ensure the option exists even if filtered out
    if (cycleSel) {
      cycleSel.value = key;
      cycleSel.dispatchEvent(new Event('change'));
    }
    if (testCycleSearch) testCycleSearch.value = labelText;
    hideSuggestions();
  }

  // Renders the suggestion dropdown. An empty query lists every cycle (up to
  // 100), so the ▾ caret behaves like a normal dropdown; typing filters live.
  function renderSuggestions(): void {
    if (!cycleSuggestions || !testCycleSearch) return;
    const needle = testCycleSearch.value.trim().toLowerCase();
    const matches = (needle
      ? allTestCycles.filter(tc =>
          tc.key.toLowerCase().includes(needle) ||
          tc.name.toLowerCase().includes(needle))
      : allTestCycles
    ).slice(0, 100);

    cycleSuggestions.innerHTML = '';
    if (allTestCycles.length === 0) {
      cycleSuggestions.innerHTML = '<div class="suggestion-empty">No cycles loaded — load a project first</div>';
    } else if (matches.length === 0) {
      cycleSuggestions.innerHTML = '<div class="suggestion-empty">No matching cycles</div>';
    } else {
      matches.forEach(tc => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.innerHTML = `<span class="sug-key">${tc.key}</span>${tc.name}`;
        // mousedown fires before the input's blur, so the click always lands
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          selectCycle(tc.key, `${tc.key} — ${tc.name}`);
        });
        cycleSuggestions.appendChild(item);
      });
    }
    cycleSuggestions.classList.add('open');
    populateTestCycles(testCycleSearch.value);
  }

  if (testCycleSearch) {
    testCycleSearch.addEventListener('input', renderSuggestions);
    testCycleSearch.addEventListener('focus', renderSuggestions);
    testCycleSearch.addEventListener('blur', hideSuggestions);
    testCycleSearch.addEventListener('keydown', e => {
      if (e.key === 'Escape') hideSuggestions();
      if (e.key === 'Enter') {
        const first = cycleSuggestions?.querySelector('.suggestion-item') as HTMLElement | null;
        if (first) first.dispatchEvent(new MouseEvent('mousedown'));
      }
    });
  }

  // ▾ caret toggles the full cycle list open/closed
  $('cycleCaret')?.addEventListener('mousedown', e => {
    e.preventDefault();
    if (cycleSuggestions?.classList.contains('open')) {
      hideSuggestions();
    } else {
      testCycleSearch?.focus();
      renderSuggestions();
    }
  });

  // ── Test cycle selection: filter test cases to the chosen cycle ───────────────
  const testCycleSelect = $('testCycle') as HTMLSelectElement;
  if (testCycleSelect) {
    testCycleSelect.addEventListener('change', async () => {
      const cycleKey = testCycleSelect.value;
      if (!cycleKey) {
        populateTestCases();
        setStatus('');
        return;
      }
      setStatus('Loading test cases in cycle…');
      const cycleCases = await rendererApi.fetchCycleTestCases(cycleKey);
      if (cycleCases?.error) {
        setStatus(`❌ Error: ${cycleCases.error}`);
        populateTestCases();
        return;
      }
      if (Array.isArray(cycleCases)) {
        populateTestCases(cycleCases);
        setStatus(cycleCases.length === 0
          ? `⚠️ ${cycleKey} contains no test cases.`
          : `✓ ${cycleKey}: ${cycleCases.length} test case${cycleCases.length === 1 ? '' : 's'}`);
      } else {
        // null → API can't list cycle contents (cloud); keep all cases
        populateTestCases();
        setStatus('');
      }
    });
  }

  // ── Recording ─────────────────────────────────────────────────────────────────
  async function startRecording(): Promise<void> {
    const projectKey = (($('projectKey') as HTMLInputElement)?.value || '').trim().toUpperCase();
    const testCaseKey = (($('testCase') as HTMLSelectElement)?.value || '');
    const testCycleKey = (($('testCycle') as HTMLSelectElement)?.value || '');

    if (!testCaseKey) { setStatus('Select a test case first.'); return; }
    if (!selectedRegion) { setStatus('Select a capture region first.'); return; }

    const session = {
      projectKey,
      testCaseKey,
      testCaseName: allTestCases.find(tc => tc.key === testCaseKey)?.name || '',
      testCycleKey,
      region: selectedRegion,
      notes: '',
    };
    const result = await rendererApi.startRecording(session);
    if (result?.error) { setStatus(`Error: ${result.error}`); return; }

    isRecording = true;
    const btn = $('btnRecord');
    if (btn) {
      btn.textContent = '⏺ Recording…';
      btn.classList.add('recording');
    }
    const counter = $('frameCounter');
    if (counter) counter.style.display = 'flex';
    // Result buttons appear only after the recording is stopped & saved.
    const resultBtns = $('resultButtons');
    if (resultBtns) resultBtns.style.display = 'none';
    const resultPrompt = $('resultPrompt');
    if (resultPrompt) resultPrompt.style.display = 'none';
    const uploadPanel = $('uploadPanel');
    if (uploadPanel) uploadPanel.style.display = 'none';
    setStatus(`Recording — press ${prettyHotkey(captureHotkeyLabel)} to capture a screenshot.`);
  }

  const btnRecord = $('btnRecord');
  if (btnRecord) {
    btnRecord.addEventListener('click', async () => {
      if (!isRecording) await startRecording();
    });
  }

  function resetRecordButton(): void {
    isRecording = false;
    const btn = $('btnRecord');
    if (btn) {
      btn.textContent = '⏺ Start Recording';
      btn.classList.remove('recording');
    }
    const counter = $('frameCounter');
    if (counter) counter.style.display = 'none';
  }

  // Stop & Save: end the take, restore the window, then present the result
  // buttons so the user picks Pass/Fail/In Progress.
  async function finishRecording(): Promise<void> {
    resetRecordButton();
    setStatus('Processing…');
    const res = await rendererApi.stopRecording('save');
    if (res?.error) { setStatus(`Error: ${res.error}`); return; }

    lastSession = res.session;
    if (res.session) {
      showUploadPanel(res.session);
      // Reveal the result buttons; nothing is pushed to Zephyr until one is picked.
      const resultPrompt = $('resultPrompt');
      if (resultPrompt) resultPrompt.style.display = 'block';
      const resultBtns = $('resultButtons');
      if (resultBtns) resultBtns.style.display = 'flex';
      setStatus('Recording saved — set the result.');
    }
  }

  async function discardRecording(): Promise<void> {
    resetRecordButton();
    const resultBtns = $('resultButtons');
    if (resultBtns) resultBtns.style.display = 'none';
    const resultPrompt = $('resultPrompt');
    if (resultPrompt) resultPrompt.style.display = 'none';
    const uploadPanel = $('uploadPanel');
    if (uploadPanel) uploadPanel.style.display = 'none';
    await rendererApi.stopRecording('abort');
    setStatus('Recording discarded.');
  }

  // Result chosen after the recording is saved: set the execution status,
  // add to history, and upload the evidence.
  async function applyResult(result: string): Promise<void> {
    if (!lastSession) return;
    lastSession.result = result;
    const resultBtns = $('resultButtons');
    if (resultBtns) resultBtns.style.display = 'none';
    const resultPrompt = $('resultPrompt');
    if (resultPrompt) resultPrompt.style.display = 'none';
    updateUploadSummary(lastSession);
    addToSessionHistory(lastSession);
    await uploadEvidence();
  }

  const resultByButton: Record<string, string> = {
    btnPass: 'pass',
    btnFail: 'fail',
    btnWip: 'wip',
  };
  Object.keys(resultByButton).forEach(id => {
    $(id)?.addEventListener('click', () => applyResult(resultByButton[id]));
  });

  $('btnTbStop')?.addEventListener('click', finishRecording);
  $('btnTbCancel')?.addEventListener('click', discardRecording);

  // ── Pause / resume ────────────────────────────────────────────────────────────
  let isPaused = false;
  const btnTbPause = $('btnTbPause');

  function resetPauseState(): void {
    isPaused = false;
    if (btnTbPause) btnTbPause.textContent = '⏸ Pause';
  }

  btnTbPause?.addEventListener('click', async () => {
    if (isPaused) {
      await rendererApi.resumeRecording();
      isPaused = false;
      btnTbPause.textContent = '⏸ Pause';
    } else {
      await rendererApi.pauseRecording();
      isPaused = true;
      btnTbPause.textContent = '▶ Resume';
    }
  });

  rendererApi.onToolbarMode((active: boolean) => {
    document.body.classList.toggle('toolbar-mode', active);
    if (active) resetPauseState();
  });

  function updateUploadSummary(session: any): void {
    const summary = $('uploadSummary');
    if (!summary) return;
    const count = session.frames?.length || 0;
    const unit = `${count} screenshot${count === 1 ? '' : 's'} → ${count} page${count === 1 ? '' : 's'}`;
    const resultText = session.result ? `${String(session.result).toUpperCase()} · ` : '';
    summary.textContent = `Word document · ${unit} · ${resultText}${session.testCaseKey}`;
  }

  function showUploadPanel(session: any): void {
    const uploadPanel = $('uploadPanel');
    if (uploadPanel) uploadPanel.style.display = 'flex';
    renderPreview();
    updateUploadSummary(session);
    const btnOpen = $('btnOpenFolder');
    if (btnOpen) {
      btnOpen.onclick = () => {
        if (session.framesDir) rendererApi.openFolder(session.framesDir);
      };
    }
    setStatus('');
  }

  // Preview shows the first screenshot; the full set goes into the Word document.
  function renderPreview(): void {
    const wrap = $('gifPreviewWrap');
    if (!wrap || !lastSession) return;
    const stamp = Date.now();
    if (lastSession.frames?.length) {
      const shot = lastSession.previewPath || lastSession.frames[0];
      wrap.innerHTML = `<img src="file://${shot}?t=${stamp}" alt="Screenshot preview">`;
    } else {
      wrap.innerHTML = '<p style="color:var(--text-muted);font-size:12px">Preview unavailable</p>';
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────────────
  const btnUpload = $('btnUpload');

  async function uploadEvidence(): Promise<void> {
    if (!lastSession) return;
    if (btnUpload) {
      btnUpload.textContent = 'Uploading…';
      (btnUpload as HTMLButtonElement).disabled = true;
    }
    const log = $('uploadLog');
    if (log) {
      log.style.display = 'block';
      log.textContent = '';
    }

    const res = await rendererApi.uploadEvidence({
      testCaseKey: lastSession.testCaseKey,
      testCaseName: lastSession.testCaseName,
      testCycleKey: lastSession.testCycleKey,
      projectKey: lastSession.projectKey || (($('projectKey') as HTMLInputElement)?.value || '').trim().toUpperCase(),
      result: lastSession.result,
      frames: lastSession.frames,
      notes: lastSession.notes,
      executionId: lastSession.executionId,
      executionKey: lastSession.executionKey,
      annotationsByFrame: lastSession.annotationsByFrame || [],
    });

    if (log) {
      log.textContent = (res.log as string[] | undefined)?.join('\n') ?? '';
      if (res.error) {
        log.style.color = 'var(--fail)';
        log.textContent += `\n✗ ${res.error}`;
      } else {
        log.style.color = 'var(--pass)';
        setStatus(`Uploaded! Execution: ${res.executionKey}`);
      }
    }

    if (btnUpload) {
      btnUpload.textContent = '⬆ Upload to Zephyr Scale';
      (btnUpload as HTMLButtonElement).disabled = false;
    }
  }

  if (btnUpload) {
    btnUpload.addEventListener('click', uploadEvidence);
  }

  // ── Annotation / Redaction editor ─────────────────────────────────────────────
  // The editor works one screenshot at a time. `annoShapes` holds the CURRENT
  // screenshot's shapes in CANVAS (display) coordinates; `annoPixelByFrame` is
  // the persisted store, one list of ORIGINAL-PIXEL shapes per screenshot,
  // aligned to lastSession.frames by index.
  type AnnoShape = { type: 'redact' | 'box' | 'text'; x: number; y: number; w: number; h: number; text?: string };
  type PixelShape = { type: 'redact' | 'box' | 'text'; x: number; y: number; w: number; h: number; text?: string };
  const annoModal = $('annotateModal') as HTMLElement;
  const annoCanvas = $('annoCanvas') as HTMLCanvasElement;
  const annoTextInput = $('annoText') as HTMLInputElement;
  let annoShapes: AnnoShape[] = [];
  let annoPixelByFrame: PixelShape[][] = [];
  let annoIndex = 0;
  let annoTool: 'redact' | 'box' | 'text' = 'redact';
  let annoBaseImg: HTMLImageElement | null = null;
  let annoScale = 1; // originalPixels / canvasPixels
  let annoDrawing = false;
  let annoStart = { x: 0, y: 0 };
  let annoCurrent: AnnoShape | null = null;

  const shapesToPixels = (): PixelShape[] => annoShapes.map(s => ({
    type: s.type,
    x: Math.round(s.x * annoScale),
    y: Math.round(s.y * annoScale),
    w: Math.round(s.w * annoScale),
    h: Math.round(s.h * annoScale),
    text: s.text,
  }));
  const pixelsToShapes = (arr: PixelShape[]): AnnoShape[] => (arr || []).map(a => ({
    type: a.type,
    x: a.x / annoScale, y: a.y / annoScale,
    w: (a.w || 0) / annoScale, h: (a.h || 0) / annoScale,
    text: a.text,
  }));
  // Write the current canvas shapes back into the per-frame store.
  function commitCurrentFrame(): void {
    if (annoPixelByFrame.length) annoPixelByFrame[annoIndex] = shapesToPixels();
  }

  function updateAnnoNav(): void {
    const total = lastSession?.frames?.length || 0;
    const counter = $('annoCounter');
    if (counter) counter.textContent = `${total ? annoIndex + 1 : 0} / ${total}`;
    ($('btnAnnoPrev') as HTMLButtonElement).disabled = annoIndex <= 0;
    ($('btnAnnoNext') as HTMLButtonElement).disabled = annoIndex >= total - 1;
    ($('btnAnnoDelete') as HTMLButtonElement).disabled = total <= 1;
  }

  // Loads screenshot `i` into the canvas and restores its saved shapes.
  function loadAnnoFrame(i: number): void {
    if (!lastSession?.frames?.length) return;
    annoIndex = Math.min(Math.max(i, 0), lastSession.frames.length - 1);
    const img = new Image();
    img.onload = () => {
      annoBaseImg = img;
      const displayW = Math.min(img.naturalWidth, 1000);
      annoCanvas.width = displayW;
      annoCanvas.height = Math.round(displayW * img.naturalHeight / img.naturalWidth);
      annoScale = img.naturalWidth / annoCanvas.width;
      annoShapes = pixelsToShapes(annoPixelByFrame[annoIndex] || []);
      redrawAnno();
      updateAnnoNav();
    };
    img.src = `file://${lastSession.frames[annoIndex]}?t=${Date.now()}`;
  }

  function redrawAnno(): void {
    const ctx = annoCanvas.getContext('2d');
    if (!ctx || !annoBaseImg) return;
    ctx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
    ctx.drawImage(annoBaseImg, 0, 0, annoCanvas.width, annoCanvas.height);
    const all = annoCurrent ? [...annoShapes, annoCurrent] : annoShapes;
    for (const s of all) {
      if (s.type === 'redact') {
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.fillRect(s.x, s.y, s.w, s.h);
      } else if (s.type === 'box') {
        ctx.strokeStyle = '#ff2d55';
        ctx.lineWidth = 3;
        ctx.strokeRect(s.x, s.y, s.w, s.h);
      } else if (s.type === 'text') {
        ctx.font = '600 20px -apple-system, sans-serif';
        const label = s.text || '';
        const w = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(s.x - 4, s.y - 22, w + 12, 28);
        ctx.fillStyle = 'yellow';
        ctx.fillText(label, s.x + 2, s.y);
      }
    }
  }

  // Surface missing dependencies up front, rather than failing mid-recording.
  rendererApi.ffmpegCaps().then((caps: any) => {
    if (!caps) return;

    if (caps.drawText === false) {
      const textBtn = document.querySelector('.anno-tool[data-tool="text"]') as HTMLButtonElement | null;
      if (textBtn) {
        textBtn.disabled = true;
        textBtn.title = 'Your ffmpeg was built without libfreetype — reinstall ffmpeg to enable text labels';
        textBtn.style.opacity = '0.4';
      }
    }

    const banner = $('depWarning');
    if (!banner) return;

    const fatal = caps.canRecord === false;
    if (Array.isArray(caps.problems) && caps.problems.length > 0) {
      banner.className = `dep-warning${fatal ? '' : ' warn'}`;
      banner.innerHTML =
        `<strong>${fatal ? '✗ Cannot record' : '⚠ Limited functionality'}</strong><br>` +
        `${caps.problems[0]}<br><code>${caps.installHint || ''}</code>`;
      banner.style.display = 'block';
      // Nothing can be captured at all — don't let the user start a doomed take.
      if (fatal) {
        recordingBlocked = true;
        const btn = $('btnRecord') as HTMLButtonElement;
        if (btn) btn.title = 'ffmpeg is required to capture on this platform';
        updateRecordButton();
      }
    }
  }).catch(() => {});

  function openAnnotator(): void {
    if (!lastSession?.frames?.length) { setStatus('No screenshots to annotate.'); return; }
    // Seed the per-frame store from whatever was applied previously, one entry
    // per current screenshot.
    annoPixelByFrame = lastSession.frames.map((_: string, i: number) =>
      (lastSession.annotationsByFrame?.[i] || []).map((a: any) => ({ ...a }))
    );
    annoIndex = 0;
    annoModal.style.display = 'flex';
    loadAnnoFrame(0);
  }

  function pos(e: MouseEvent): { x: number; y: number } {
    const r = annoCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (annoCanvas.width / r.width),
      y: (e.clientY - r.top) * (annoCanvas.height / r.height),
    };
  }

  annoCanvas.addEventListener('mousedown', e => {
    const p = pos(e);
    if (annoTool === 'text') {
      const text = (annoTextInput.value || '').trim();
      if (!text) { setStatus('Type the label text first.'); annoTextInput.focus(); return; }
      annoShapes.push({ type: 'text', x: p.x, y: p.y, w: 0, h: 0, text });
      redrawAnno();
      return;
    }
    annoDrawing = true;
    annoStart = p;
    annoCurrent = { type: annoTool, x: p.x, y: p.y, w: 0, h: 0 };
  });
  annoCanvas.addEventListener('mousemove', e => {
    if (!annoDrawing || !annoCurrent) return;
    const p = pos(e);
    annoCurrent.x = Math.min(annoStart.x, p.x);
    annoCurrent.y = Math.min(annoStart.y, p.y);
    annoCurrent.w = Math.abs(p.x - annoStart.x);
    annoCurrent.h = Math.abs(p.y - annoStart.y);
    redrawAnno();
  });
  function endDraw(): void {
    if (annoDrawing && annoCurrent && annoCurrent.w > 3 && annoCurrent.h > 3) {
      annoShapes.push(annoCurrent);
    }
    annoDrawing = false;
    annoCurrent = null;
    redrawAnno();
  }
  annoCanvas.addEventListener('mouseup', endDraw);
  annoCanvas.addEventListener('mouseleave', endDraw);

  document.querySelectorAll('.anno-tool').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.anno-tool').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      annoTool = (btn as HTMLElement).dataset.tool as any;
      annoTextInput.style.display = annoTool === 'text' ? 'inline-block' : 'none';
    });
  });

  $('btnAnnoUndo')?.addEventListener('click', () => { annoShapes.pop(); redrawAnno(); });
  $('btnAnnoClear')?.addEventListener('click', () => { annoShapes = []; redrawAnno(); });
  $('btnAnnoClose')?.addEventListener('click', () => { annoModal.style.display = 'none'; });
  $('btnAnnotate')?.addEventListener('click', openAnnotator);

  $('btnAnnoPrev')?.addEventListener('click', () => { commitCurrentFrame(); loadAnnoFrame(annoIndex - 1); });
  $('btnAnnoNext')?.addEventListener('click', () => { commitCurrentFrame(); loadAnnoFrame(annoIndex + 1); });

  $('btnAnnoDelete')?.addEventListener('click', async () => {
    if (!lastSession?.frames?.length) return;
    if (lastSession.frames.length <= 1) { setStatus('A session needs at least one screenshot.'); return; }
    const removed = lastSession.frames[annoIndex];
    lastSession.frames.splice(annoIndex, 1);
    annoPixelByFrame.splice(annoIndex, 1);
    // Keep any already-applied annotation store aligned even if the user closes
    // the editor without re-applying.
    if (Array.isArray(lastSession.annotationsByFrame)) {
      lastSession.annotationsByFrame.splice(annoIndex, 1);
    }
    // Ask the main process to remove the files from disk (best-effort).
    rendererApi.deleteFrame(removed).catch(() => {});
    // The burned preview may have been this shot — drop it and rebuild.
    lastSession.previewPath = undefined;
    if (annoIndex >= lastSession.frames.length) annoIndex = lastSession.frames.length - 1;
    loadAnnoFrame(annoIndex);
    updateUploadSummary(lastSession);
    renderPreview();
    setStatus('Screenshot deleted.');
  });

  $('btnAnnoApply')?.addEventListener('click', async () => {
    if (!lastSession?.frames?.length) return;
    commitCurrentFrame();
    // Persisted on the session; burned into the screenshots at upload time.
    lastSession.annotationsByFrame = annoPixelByFrame.map(a => a.map(s => ({ ...s })));
    const annotated = annoPixelByFrame.reduce((n, a) => n + (a.length ? 1 : 0), 0);
    setStatus('Applying annotations…');
    const apply = $('btnAnnoApply') as HTMLButtonElement;
    apply.disabled = true; apply.textContent = 'Applying…';
    const res = await rendererApi.annotateEvidence({
      frames: lastSession.frames,
      annotationsByFrame: lastSession.annotationsByFrame,
      previewIndex: annoIndex,
    });
    apply.disabled = false; apply.textContent = '✓ Apply to evidence';
    if (res?.error) { setStatus(`❌ Annotate failed: ${res.error}`); return; }
    // A preview of the shot that was on screen comes back so the panel updates.
    lastSession.previewPath = res.previewPath || undefined;
    renderPreview();
    annoModal.style.display = 'none';
    setStatus(annotated
      ? `✓ Annotations applied to ${annotated} screenshot${annotated === 1 ? '' : 's'}.`
      : '✓ Annotations cleared.');
  });

  // ── API Events ────────────────────────────────────────────────────────────────
  rendererApi.onFrameCaptured((data: { count: number }) => {
    const counter = $('frameCount');
    if (counter) counter.textContent = String(data.count);
    const tbCounter = $('tbFrameCount');
    if (tbCounter) tbCounter.textContent = String(data.count);
  });

  rendererApi.onStatusUpdate((msg: string) => setStatus(msg));

  // ── Persistent History ────────────────────────────────────────────────────────
  // Reopen a past session into the Capture upload panel so it can be re-uploaded.
  function reopenSession(entry: any): void {
    lastSession = { ...entry, notes: entry.notes || '' };
    switchTab('capture');
    showUploadPanel(lastSession);
    updateUploadSummary(lastSession);
    setStatus(`Reopened ${entry.testCaseKey} — ready to re-upload.`);
  }

  async function renderHistoryTab(): Promise<void> {
    const list = $('historyList');
    if (!list) return;
    const history = await rendererApi.getHistory();
    if (!Array.isArray(history) || history.length === 0) {
      list.textContent = 'No sessions yet.';
      return;
    }
    list.innerHTML = '';
    history.forEach((s: any) => {
      const when = s.timestamp ? new Date(s.timestamp).toLocaleString() : '';
      const tagClass = s.result === 'pass' ? 'tag-pass' : s.result === 'wip' ? 'tag-wip' : 'tag-fail';
      const tagText = s.result === 'wip' ? 'IN PROGRESS' : String(s.result || '').toUpperCase();
      const row = document.createElement('div');
      row.className = 'history-item';
      row.innerHTML = `
        <div class="history-main">
          <div>
            <strong>${s.testCaseKey || '—'}</strong>
            <span class="history-meta">${s.frames?.length || 0} screenshots${s.executionKey ? ` · ${s.executionKey}` : ''}${when ? ` · ${when}` : ''}</span>
          </div>
          <span class="${tagClass}">${tagText}</span>
        </div>
        <div class="history-actions"></div>`;
      const actions = row.querySelector('.history-actions') as HTMLElement;
      const mk = (label: string, cls: string, fn: () => void) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', fn);
        actions.appendChild(b);
      };
      mk('↺ Reopen', 'btn-secondary btn-mini', () => reopenSession(s));
      if (s.framesDir) mk('📁 Folder', 'btn-secondary btn-mini', () => rendererApi.openFolder(s.framesDir));
      mk('🗑 Delete', 'btn-secondary btn-mini btn-danger', async () => {
        const res = await rendererApi.deleteHistoryEntry(s.timestamp);
        if (res?.cancelled) return;
        if (res?.error) { setStatus(`❌ ${res.error}`); return; }
        // If the deleted session is the one loaded in the Capture panel, clear it.
        if (lastSession && lastSession.timestamp === s.timestamp) {
          lastSession = null;
          const panel = $('uploadPanel');
          if (panel) panel.style.display = 'none';
        }
        setStatus(res.deletedFiles
          ? `🗑 Deleted ${s.testCaseKey} and its files from disk.`
          : `🗑 Removed ${s.testCaseKey} from history.`);
        renderHistoryTab();
      });
      list.appendChild(row);
    });
  }
  refreshHistoryView = () => { renderHistoryTab(); };
  document.querySelector('.tab[data-tab="history"]')?.addEventListener('click', renderHistoryTab);

  // ── Global keyboard shortcuts (forwarded from main) ───────────────────────────
  rendererApi.onShortcut((action: string) => {
    if (action === 'record') {
      isRecording ? finishRecording() : startRecording();
    } else if (action === 'pause') {
      (btnTbPause as HTMLElement)?.click();
    } else if (action === 'cancel') {
      if (isRecording) discardRecording();
    }
  });

  // Restore the last project's cached test cases/cycles so the dropdowns are
  // populated immediately on launch, without re-fetching. "Load Project"
  // refreshes them from Jira/Zephyr.
  async function restoreProjectCache(): Promise<void> {
    const key = (($('projectKey') as HTMLInputElement)?.value || '').trim().toUpperCase();
    if (!key) return;
    const cache = await rendererApi.getProjectCache(key);
    if (!cache || !Array.isArray(cache.testCases) || cache.testCases.length === 0) return;
    allTestCases = cache.testCases;
    allTestCycles = Array.isArray(cache.testCycles) ? cache.testCycles : [];
    populateTestCases();
    populateTestCycles();
    updateRecordButton();
    const when = cache.cachedAt ? new Date(cache.cachedAt).toLocaleString() : '';
    setStatus(`✓ ${key} restored from cache (${allTestCases.length} cases, ${allTestCycles.length} cycles${when ? ` · ${when}` : ''}) — click Load Project to refresh`);
  }

  // ── Final Setup ───────────────────────────────────────────────────────────────
  loadSettings().then(() => restoreProjectCache());
  renderHistoryTab();
}

// ── Start ─────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
