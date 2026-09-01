export interface AppConfig {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  zephyrApiToken: string;
  outputDir: string;
  attachScreenshotsIndividually?: boolean;
  // Draw a ring around the mouse cursor's position in each screenshot at the
  // moment the capture hotkey is pressed.
  markCursor?: boolean;
  // Electron global-shortcut accelerator that captures one screenshot while a
  // recording is running (e.g. "CommandOrControl+Shift+S"). Registered only for
  // the duration of the recording.
  captureHotkey?: string;
  // Keep the main window floating above other apps (so it isn't lost behind the
  // browser under test after selecting a region or finishing a recording).
  keepOnTop?: boolean;
  lastProjectKey?: string;
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TestSession {
  testCaseKey: string;
  testCaseName?: string;
  testCycleKey: string;
  projectKey: string;
  region: CaptureRegion;
  notes: string;
  // One screenshot is captured each time the capture hotkey is pressed; the set
  // is exported to a Word document (one screenshot per page) at upload time.
  docxPath?: string;
  framesDir?: string;
  result?: 'pass' | 'fail' | 'wip';
  frames?: string[];
  executionId?: number;
  executionKey?: string;
}
