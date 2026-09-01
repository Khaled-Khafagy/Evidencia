// Cross-platform launcher. The old start script used `env -u ELECTRON_RUN_AS_NODE
// ./node_modules/.bin/electron .` which is Unix-only (no `env` / POSIX path on
// Windows). This does the same thing with Node: clears the ELECTRON_RUN_AS_NODE
// variable (which, if set, makes Electron run as a plain Node process instead of
// launching the GUI) and spawns the Electron binary.
const { spawn } = require('child_process');
const electron = require('electron'); // resolves to the platform's electron binary path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('close', code => process.exit(code ?? 0));
