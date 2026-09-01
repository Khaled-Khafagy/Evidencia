import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('save-config', cfg),
  selectRegion: () => ipcRenderer.invoke('select-region'),
  startRecording: (session: unknown) => ipcRenderer.invoke('start-recording', session),
  stopRecording: (result: string) => ipcRenderer.invoke('stop-recording', result),
  pauseRecording: () => ipcRenderer.invoke('pause-recording'),
  resumeRecording: () => ipcRenderer.invoke('resume-recording'),
  uploadEvidence: (data: unknown) => ipcRenderer.invoke('upload-evidence', data),
  saveProjectKey: (key: string) => ipcRenderer.invoke('save-project-key', key),
  getProjectCache: (projectKey: string) => ipcRenderer.invoke('get-project-cache', projectKey),
  saveProjectCache: (data: unknown) => ipcRenderer.invoke('save-project-cache', data),
  fetchTestCases: (projectKey: string) => ipcRenderer.invoke('fetch-test-cases', projectKey),
  fetchTestCycles: (projectKey: string) => ipcRenderer.invoke('fetch-test-cycles', projectKey),
  fetchCycleTestCases: (testCycleKey: string) => ipcRenderer.invoke('fetch-cycle-test-cases', testCycleKey),
  getHistory: () => ipcRenderer.invoke('get-history'),
  deleteHistoryEntry: (timestamp: number) => ipcRenderer.invoke('delete-history-entry', timestamp),
  annotateEvidence: (data: unknown) => ipcRenderer.invoke('annotate-evidence', data),
  deleteFrame: (framePath: string) => ipcRenderer.invoke('delete-frame', framePath),
  ffmpegCaps: () => ipcRenderer.invoke('ffmpeg-caps'),
  openFolder: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),
  showSaveDialog: () => ipcRenderer.invoke('show-save-dialog'),
  onFrameCaptured: (cb: (data: { count: number }) => void) =>
    ipcRenderer.on('frame-captured', (_e, data) => cb(data)),
  onStatusUpdate: (cb: (msg: string) => void) =>
    ipcRenderer.on('status-update', (_e, msg) => cb(msg)),
  onToolbarMode: (cb: (active: boolean) => void) =>
    ipcRenderer.on('toolbar-mode', (_e, active) => cb(active)),
  onShortcut: (cb: (action: string) => void) =>
    ipcRenderer.on('shortcut', (_e, action) => cb(action)),
  // overlay IPC
  sendRegionSelected: (region: unknown) => ipcRenderer.send('region-selected', region),
  sendRegionCancelled: () => ipcRenderer.send('region-cancelled'),
});
