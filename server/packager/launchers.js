import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TARGET_OS_LABELS } from './runtimes.js';
import { buildArtifactEmblemSvg, emblemSvgToDataUri, generateNativeIcons } from './emblem.js';

const execFileAsync = promisify(execFile);

export function sanitizeDisplayName(name) {
  const cleaned = String(name || 'GitNoob App')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'GitNoob App';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(str) {
  return escapeHtml(str).replace(/'/g, '&apos;');
}

function buildServeMjs(appName, defaultPort = 4173) {
  return `#!/usr/bin/env node
// GitNoob Zero-Dependency Local App Server
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLE_ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(BUNDLE_ROOT, 'app');
const APP_NAME = process.env.GITNOOB_APP_NAME || ${JSON.stringify(appName)};
const HOST = process.env.HOST || '127.0.0.1';
const NO_OPEN = process.env.GITNOOB_NO_OPEN === '1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function findAvailablePort(startPort) {
  if (startPort === 0) return Promise.resolve(0);
  return new Promise((resolve) => {
    const tryPort = (port) => {
      if (port > startPort + 50) {
        resolve(0);
        return;
      }
      const tester = net.createServer();
      tester.unref();
      tester.once('error', () => tryPort(port + 1));
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, HOST);
    };
    tryPort(startPort);
  });
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Ignore browser launch failures
  }
}

function resolveFilePath(reqUrl) {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(reqUrl, 'http://localhost').pathname);
  } catch {
    pathname = '/';
  }
  const normalized = path.posix.normalize(pathname).replace(/^\\/+/, '');
  let target = path.resolve(APP_DIR, normalized);

  if (target !== APP_DIR && !target.startsWith(APP_DIR + path.sep)) {
    return null;
  }

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }

  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    return target;
  }

  // SPA fallback for routes without a file extension
  if (!path.extname(pathname)) {
    const fallback = path.join(APP_DIR, 'index.html');
    if (fs.existsSync(fallback)) return fallback;
  }

  return null;
}

const server = http.createServer((req, res) => {
  const filePath = resolveFilePath(req.url || '/');
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
});

const requestedPort = process.env.PORT !== undefined ? Number(process.env.PORT) : ${Number(defaultPort) || 4173};
const bindPort = Number.isFinite(requestedPort) ? requestedPort : 4173;

findAvailablePort(bindPort).then((port) => {
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = \`http://\${HOST}:\${actualPort}/\`;

    console.log(\`GITNOOB_READY_URL=\${url}\`);
    console.log('');
    console.log('====================================================');
    console.log(\`  \${APP_NAME} — Packaged by GitNoob\`);
    console.log('====================================================');
    console.log(\`  URL:      \${url}\`);
    console.log(\`  Runtime:  Node.js \${process.version} (Portable)\`);
    console.log('');
    console.log('  Your browser should open automatically.');
    console.log('  Close this window to stop the app.');
    console.log('====================================================');
    console.log('');

    openBrowser(url);
  });
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
}

function buildRunAppMjs(appName, runConfig) {
  return `#!/usr/bin/env node
// GitNoob Portable Node.js Application Launcher
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLE_ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(BUNDLE_ROOT, 'app');
const APP_NAME = process.env.GITNOOB_APP_NAME || ${JSON.stringify(appName)};
const NO_OPEN = process.env.GITNOOB_NO_OPEN === '1';
const RUN_CONFIG = ${JSON.stringify(runConfig, null, 2)};

function loadDotEnv(envPath) {
  const loaded = {};
  if (!fs.existsSync(envPath)) return loaded;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\\r?\\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    loaded[key] = val;
  }
  return loaded;
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // ignore
  }
}

const nodeBinDir = path.dirname(process.execPath);
const localBinDir = path.join(APP_DIR, 'node_modules', '.bin');
const pathSep = process.platform === 'win32' ? ';' : ':';
const env = {
  ...loadDotEnv(path.join(APP_DIR, '.env')),
  ...process.env,
  PATH: [localBinDir, nodeBinDir, process.env.PATH || ''].filter(Boolean).join(pathSep),
};

console.log('');
console.log('====================================================');
console.log(\`  \${APP_NAME} — Packaged by GitNoob\`);
console.log('====================================================');
console.log(\`  Runtime:  Node.js \${process.version} (Portable)\`);
console.log('  Close this window to stop the app.');
console.log('====================================================');
console.log('');

let child;
const startScript = RUN_CONFIG.startScript;
const entryPoint = RUN_CONFIG.entryPoint || 'index.js';

if (startScript && !startScript.startsWith('node ')) {
  // Execute startScript via shell with bundled node & node_modules/.bin first on PATH
  child = spawn(startScript, { cwd: APP_DIR, env, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
} else {
  const scriptArgs = startScript
    ? startScript.replace(/^node\\s+/, '').trim().split(/\\s+/)
    : [entryPoint];
  child = spawn(process.execPath, scriptArgs, { cwd: APP_DIR, env, stdio: ['inherit', 'pipe', 'pipe'] });
}

let browserOpened = false;
const inspectOutput = (chunk, target) => {
  target.write(chunk);
  if (!browserOpened && RUN_CONFIG.isWeb) {
    const text = chunk.toString('utf8');
    const urlMatch = text.match(/https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):\\d+[^\\s]*/i);
    if (urlMatch) {
      browserOpened = true;
      const openUrl = urlMatch[0].replace('0.0.0.0', '127.0.0.1');
      console.log(\`GITNOOB_READY_URL=\${openUrl}\`);
      openBrowser(openUrl);
    }
  }
};

child.stdout.on('data', (c) => inspectOutput(c, process.stdout));
child.stderr.on('data', (c) => inspectOutput(c, process.stderr));

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`;
}

function buildRunPythonSh(appName, runConfig) {
  const entry = runConfig.entryPoint || 'main.py';
  const runner = runConfig.runner || 'script';
  const defaultStartPort =
    runner === 'flask'
      ? 5050
      : runner === 'streamlit'
        ? 8501
        : runner === 'gradio'
          ? 7860
          : runner === 'fastapi'
            ? 8000
            : Number(runConfig.defaultPort) || 8000;
  const startPort = runner === 'flask' && Number(runConfig.defaultPort) === 5000
    ? 5050
    : (Number(runConfig.defaultPort) || defaultStartPort);
  const moduleName = entry.replace(/\.py$/, '').replace(/[\\/]/g, '.');
  const isWebRunner = ['streamlit', 'fastapi', 'flask', 'gradio'].includes(runner);

  const portPickerBlock = isWebRunner
    ? `if [ -z "\${PORT:-}" ]; then
  APP_PORT="$("$PYTHON_BIN" - <<'PYEOF'
import socket
for p in range(${startPort}, ${startPort + 50}):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", p))
            print(p)
            break
        except OSError:
            pass
else:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        print(s.getsockname()[1])
PYEOF
)"
else
  APP_PORT="$PORT"
fi
export PORT="$APP_PORT"`
    : '';

  const browserPollerBlock = isWebRunner
    ? `start_browser_when_ready() {
  local server_pid="$1"
  local url="http://127.0.0.1:$APP_PORT"
  [ "\${GITNOOB_NO_OPEN:-0}" = "1" ] && return 0
  "$PYTHON_BIN" - "$server_pid" "$APP_PORT" "$url" <<'PYEOF' &
import os, socket, subprocess, sys, time
pid = int(sys.argv[1])
port = int(sys.argv[2])
url = sys.argv[3]
deadline = time.time() + 45.0
while time.time() < deadline:
    try:
        os.kill(pid, 0)
    except OSError:
        sys.exit(0)
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            opener = "open" if sys.platform == "darwin" else "xdg-open"
            subprocess.Popen([opener, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            sys.exit(0)
    except OSError:
        time.sleep(0.3)
PYEOF
}`
    : '';

  let preStartBlock = '';
  let serverExecLine = `"$PYTHON_BIN" "${entry}" "$@"`;

  if (runner === 'streamlit') {
    serverExecLine = `"$PYTHON_BIN" -m streamlit run "${entry}" --server.address 127.0.0.1 --server.port "$APP_PORT" --server.headless true`;
  } else if (runner === 'fastapi') {
    serverExecLine = `"$PYTHON_BIN" -m uvicorn "${moduleName}:app" --host 127.0.0.1 --port "$APP_PORT"`;
  } else if (runner === 'flask') {
    preStartBlock = `export FLASK_APP="${entry}"
export SECRET_KEY="\${SECRET_KEY:-gitnoob-local-dev-key}"
if [ -d "$APP_DIR/migrations" ]; then
  echo "  Initializing local database (flask db upgrade)..."
  "$PYTHON_BIN" -m flask db upgrade >/dev/null 2>&1 || true
fi`;
    serverExecLine = `"$PYTHON_BIN" -m flask run --host=127.0.0.1 --port="$APP_PORT"`;
  } else if (runner === 'gradio') {
    preStartBlock = `export GRADIO_SERVER_NAME=127.0.0.1
export GRADIO_SERVER_PORT="$APP_PORT"`;
    serverExecLine = `"$PYTHON_BIN" "${entry}" "$@"`;
  }

  const runSection = isWebRunner
    ? `${preStartBlock}
echo "  URL:      http://127.0.0.1:$APP_PORT"
echo "  Waiting for server to start..."
echo ""

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

set +e
${serverExecLine} &
SERVER_PID=$!
start_browser_when_ready "$SERVER_PID"
wait "$SERVER_PID"
EXIT_CODE=$?
set -e

if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "===================================================="
  echo "  ${appName} stopped unexpectedly (exit code $EXIT_CODE)."
  echo "===================================================="
  if [ -t 0 ] && [ "\${GITNOOB_NO_OPEN:-0}" != "1" ]; then
    read -n 1 -s -r -p "Press any key to close this window..."
    echo ""
  fi
fi
exit "$EXIT_CODE"`
    : `set +e
${serverExecLine}
EXIT_CODE=$?
set -e
if [ "$EXIT_CODE" -ne 0 ] && [ -t 0 ] && [ "\${GITNOOB_NO_OPEN:-0}" != "1" ]; then
  echo ""
  echo "${appName} exited with code $EXIT_CODE."
  read -n 1 -s -r -p "Press any key to close this window..."
  echo ""
fi
exit "$EXIT_CODE"`;

  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$BUNDLE_ROOT/app"
BUNDLED_PYTHON="$BUNDLE_ROOT/.gitnoob/runtime/python/bin/python3"

if [ -x "$BUNDLED_PYTHON" ]; then
  PYTHON_BIN="$BUNDLED_PYTHON"
else
  PYTHON_BIN="$(command -v python3 || command -v python)"
fi

export PYTHONPATH="$APP_DIR/.gitnoob-pylibs:$APP_DIR\${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONNOUSERSITE=1
export PYTHONUNBUFFERED=1

if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$APP_DIR/.env"
  set +a
fi

${portPickerBlock}
${browserPollerBlock}

echo ""
echo "===================================================="
echo "  ${appName} — Packaged by GitNoob"
echo "===================================================="
echo "  Runtime:  $("$PYTHON_BIN" --version 2>&1) (Portable)"
echo "  Close this window to stop the app."
echo "===================================================="

cd "$APP_DIR"
${runSection}
`;
}

function buildRunPythonBat(appName, runConfig) {
  const entry = (runConfig.entryPoint || 'main.py').replace(/\//g, '\\');
  const runner = runConfig.runner || 'script';
  const defaultStartPort =
    runner === 'flask'
      ? 5050
      : runner === 'streamlit'
        ? 8501
        : runner === 'gradio'
          ? 7860
          : runner === 'fastapi'
            ? 8000
            : Number(runConfig.defaultPort) || 8000;
  const startPort = runner === 'flask' && Number(runConfig.defaultPort) === 5000
    ? 5050
    : (Number(runConfig.defaultPort) || defaultStartPort);
  const moduleName = (runConfig.entryPoint || 'main.py').replace(/\.py$/, '').replace(/[\\/]/g, '.');
  const isWebRunner = ['streamlit', 'fastapi', 'flask', 'gradio'].includes(runner);

  const portPickerLines = isWebRunner
    ? [
        `set "APP_PORT=${startPort}"`,
        `if not "%PORT%"=="" set "APP_PORT=%PORT%"`,
        `if "%PORT%"=="" (`,
        `  for /f "delims=" %%P in ('"%PYTHON_BIN%" -c "import socket; exec(\\"for p in range(${startPort},${startPort + 50}):\\\\n try:\\\\n  s=socket.socket();s.bind(('127.0.0.1',p));s.close();print(p);break\\\\n except OSError: pass\\")"') do set "APP_PORT=%%P"`,
        `)`,
        'set "PORT=%APP_PORT%"',
      ]
    : [];

  const browserPollerLine = isWebRunner
    ? `if not "%GITNOOB_NO_OPEN%"=="1" start "" /b "%PYTHON_BIN%" -c "import socket,time,webbrowser; p=int('%APP_PORT%'); d=time.time()+45; exec('while time.time()<d:\\n try:\\n  s=socket.create_connection((\\'127.0.0.1\\',p),0.4);s.close();webbrowser.open(f\\'http://127.0.0.1:{p}\\');break\\n except OSError:\\n  time.sleep(0.3)')"`
    : '';

  let launchLines = [`"%PYTHON_BIN%" "${entry}" %*`];
  if (runner === 'streamlit') {
    launchLines = [
      browserPollerLine,
      `"%PYTHON_BIN%" -m streamlit run "${entry}" --server.address 127.0.0.1 --server.port %APP_PORT% --server.headless true`,
    ];
  } else if (runner === 'fastapi') {
    launchLines = [
      browserPollerLine,
      `"%PYTHON_BIN%" -m uvicorn ${moduleName}:app --host 127.0.0.1 --port %APP_PORT%`,
    ];
  } else if (runner === 'flask') {
    launchLines = [
      `set "FLASK_APP=${entry}"`,
      'if not defined SECRET_KEY set "SECRET_KEY=gitnoob-local-dev-key"',
      'if exist "%APP_DIR%\\migrations" "%PYTHON_BIN%" -m flask db upgrade >nul 2>&1',
      browserPollerLine,
      `"%PYTHON_BIN%" -m flask run --host=127.0.0.1 --port=%APP_PORT%`,
    ];
  } else if (runner === 'gradio') {
    launchLines = [
      'set "GRADIO_SERVER_NAME=127.0.0.1"',
      'set "GRADIO_SERVER_PORT=%APP_PORT%"',
      browserPollerLine,
      `"%PYTHON_BIN%" "${entry}" %*`,
    ];
  }

  return [
    '@echo off',
    'setlocal',
    'set "SCRIPT_DIR=%~dp0"',
    'for %%I in ("%SCRIPT_DIR%..") do set "BUNDLE_ROOT=%%~fI"',
    'set "APP_DIR=%BUNDLE_ROOT%\\app"',
    'set "BUNDLED_PYTHON=%BUNDLE_ROOT%\\.gitnoob\\runtime\\python\\python.exe"',
    'if exist "%BUNDLED_PYTHON%" (',
    '  set "PYTHON_BIN=%BUNDLED_PYTHON%"',
    ') else (',
    '  set "PYTHON_BIN=python"',
    ')',
    'set "PYTHONPATH=%APP_DIR%\\.gitnoob-pylibs;%APP_DIR%;%PYTHONPATH%"',
    'set "PYTHONNOUSERSITE=1"',
    'set "PYTHONUNBUFFERED=1"',
    ...portPickerLines,
    'echo.',
    'echo ====================================================',
    `echo   ${appName} - Packaged by GitNoob`,
    'echo ====================================================',
    'echo   Close this window to stop the app.',
    'echo ====================================================',
    'echo.',
    'cd /d "%APP_DIR%"',
    ...launchLines,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
}

function buildMacInfoPlist(cleanName, slug) {
  const bundleId = `app.gitnoob.${slug.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() || 'bundle'}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(cleanName)}</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${escapeXml(cleanName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function buildMacAppLaunchScript(cleanName, appMode) {
  if (appMode === 'python') {
    return `#!/usr/bin/env bash
set -euo pipefail
BUNDLE_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
xattr -dr com.apple.quarantine "$BUNDLE_DIR" 2>/dev/null || true
if [ -x "$BUNDLE_DIR/START_MAC.command" ]; then
  open -a Terminal "$BUNDLE_DIR/START_MAC.command"
else
  exec "$BUNDLE_DIR/.gitnoob/run-python.sh"
fi
`;
  }

  const targetScript = appMode === 'node' ? '.gitnoob/run-app.mjs' : '.gitnoob/serve.mjs';
  return `#!/usr/bin/env bash
set -euo pipefail
BUNDLE_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
xattr -dr com.apple.quarantine "$BUNDLE_DIR" 2>/dev/null || true

BUNDLED_NODE="$BUNDLE_DIR/.gitnoob/runtime/node/bin/node"
if [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "$NODE_BIN" ]; then
  osascript -e 'display dialog "Portable Node.js runtime was not found inside this package. Try double-clicking START_MAC.command or re-downloading with runtime enabled." with title "${cleanName.replace(/"/g, '\\"')}" buttons {"OK"} default button "OK"'
  exit 1
fi

LOG_FILE="$BUNDLE_DIR/.gitnoob/last-run.log"
exec "$NODE_BIN" "$BUNDLE_DIR/${targetScript}" >> "$LOG_FILE" 2>&1
`;
}

function buildStartMacCommand(appMode) {
  if (appMode === 'python') {
    return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/.gitnoob/run-python.sh" "$@"
`;
  }
  const targetScript = appMode === 'node' ? '.gitnoob/run-app.mjs' : '.gitnoob/serve.mjs';
  return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLED_NODE="$DIR/.gitnoob/runtime/node/bin/node"
if [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  NODE_BIN="$(command -v node)"
fi
exec "$NODE_BIN" "$DIR/${targetScript}" "$@"
`;
}

function buildStartWindowsBat(appMode) {
  if (appMode === 'python') {
    return [
      '@echo off',
      'call "%~dp0.gitnoob\\run-python.bat" %*',
      '',
    ].join('\r\n');
  }
  const targetScript = appMode === 'node' ? '.gitnoob\\run-app.mjs' : '.gitnoob\\serve.mjs';
  return [
    '@echo off',
    'setlocal',
    'set "DIR=%~dp0"',
    'set "BUNDLED_NODE=%DIR%.gitnoob\\runtime\\node\\node.exe"',
    'if exist "%BUNDLED_NODE%" (',
    '  "%BUNDLED_NODE%" "%DIR%' + targetScript + '" %*',
    ') else (',
    '  node "%DIR%' + targetScript + '" %*',
    ')',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
}

function buildLaunchWindowsVbs(appMode) {
  const windowStyle = appMode === 'static' ? 0 : 1;
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set FSO = CreateObject("Scripting.FileSystemObject")',
    'BaseDir = FSO.GetParentFolderName(WScript.ScriptFullName)',
    'BatPath = BaseDir & "\\START_WINDOWS.bat"',
    `WshShell.Run Chr(34) & BatPath & Chr(34), ${windowStyle}, False`,
    '',
  ].join('\r\n');
}

function buildStartLinuxSh(appMode) {
  if (appMode === 'python') {
    return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/.gitnoob/run-python.sh" "$@"
`;
  }
  const targetScript = appMode === 'node' ? '.gitnoob/run-app.mjs' : '.gitnoob/serve.mjs';
  return `#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLED_NODE="$DIR/.gitnoob/runtime/node/bin/node"
if [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  NODE_BIN="$(command -v node)"
fi
exec "$NODE_BIN" "$DIR/${targetScript}" "$@"
`;
}

function buildLinuxDesktopEntry(cleanName, hasIconPng = false) {
  return `[Desktop Entry]
Type=Application
Name=${cleanName}
Comment=Launch ${cleanName} (Packaged by GitNoob)
Exec=sh -c 'cd "$(dirname "%k")" && ./START_LINUX.sh'
${hasIconPng ? 'Icon=.gitnoob/icon.png\n' : ''}Terminal=true
Categories=Utility;Application;
`;
}

function buildWindowsDesktopIni(cleanName) {
  return [
    '[.ShellClassInfo]',
    'IconResource=.gitnoob\\AppIcon.ico,0',
    `InfoTip=${cleanName} (Packaged by GitNoob)`,
    '',
  ].join('\r\n');
}

export function buildAfterDownloadSteps({ targetOs, launcherName, cleanName, format, singleHtmlFileName }) {
  if (format === 'single-html' && singleHtmlFileName) {
    return [
      `Locate ${singleHtmlFileName} in your Downloads folder.`,
      'Double-click the file — it opens instantly in your default web browser with zero installation.',
      'You can move, copy, or run it completely offline anywhere.',
    ];
  }

  if (targetOs === 'macos-arm64' || targetOs === 'macos-x64') {
    return [
      'Double-click the downloaded .zip file to extract the app folder (or open it directly from ~/Downloads/GitNoob if saved locally).',
      `Open the folder and double-click "${launcherName}" (or START_MAC.command) — your browser will open automatically.`,
      'If macOS says "Not Opened", click Done (not Move to Bin) → open System Settings → Privacy & Security → scroll down and click Open Anyway.',
    ];
  }

  if (targetOs === 'windows-x64') {
    return [
      'Right-click the downloaded .zip file and choose "Extract All...".',
      `Open the extracted folder and double-click "${launcherName}" (or START_WINDOWS.bat).`,
      `Your browser will open "${cleanName}" automatically — no Node.js or Python installation needed.`,
    ];
  }

  return [
    'Extract the downloaded .zip archive into any folder.',
    `Double-click "${launcherName}" (or run ./START_LINUX.sh) to launch ${cleanName}.`,
    'Everything runs locally using the bundled portable runtime — close the window when finished.',
  ];
}

function buildReadMeHtml({ analysis, cleanName, slug, targetOs, launcherName, bundledRuntime, afterDownloadSteps, emblemSvg }) {
  const osLabel = TARGET_OS_LABELS[targetOs] || targetOs;
  const summary = analysis.plainEnglish?.summary || analysis.description || `${cleanName} packaged as a self-contained ready-to-run bundle.`;
  const controls = analysis.plainEnglish?.controlsOrTips || '';
  const runtimeLabel = bundledRuntime
    ? `${bundledRuntime.name} v${bundledRuntime.version} (included inside .gitnoob/runtime/)`
    : 'Uses system runtime (portable runtime omitted)';
  const isMac = targetOs === 'macos-arm64' || targetOs === 'macos-x64';
  const bundleFolderName = `${slug}-${targetOs}`;
  const macUnlockCommand = `xattr -dr com.apple.quarantine ~/Downloads/${bundleFolderName} && open ~/Downloads/${bundleFolderName}/"${launcherName}"`;
  const emblemDataUri = emblemSvg ? emblemSvgToDataUri(emblemSvg) : null;

  const stepsHtml = afterDownloadSteps
    .map((step, i) => `<li><span class="step-num">0${i + 1}</span><span>${escapeHtml(step)}</span></li>`)
    .join('\n');

  const macUnlockSection = isMac
    ? `
    <h2>macOS 15+ Quick Unlock (If Downloaded via Browser)</h2>
    <div class="unlock-box">
      <p class="unlock-note">If macOS says <strong>&ldquo;Not Opened&rdquo;</strong>, click <strong>Done</strong> (not Move to Bin) &rarr; open <strong>System Settings &rarr; Privacy &amp; Security</strong> &rarr; scroll down and click <strong>Open Anyway</strong>.</p>
      <p class="unlock-note" style="margin-top: 10px;">Or paste this one-line command into Terminal to unlock and launch immediately:</p>
      <div class="cmd-row">
        <code id="unlock-cmd">${escapeHtml(macUnlockCommand)}</code>
        <button type="button" id="copy-btn" onclick="copyUnlockCmd()">Copy</button>
      </div>
    </div>`
    : '';

  const copyScript = isMac
    ? `<script>
    function copyUnlockCmd() {
      var el = document.getElementById('unlock-cmd');
      var btn = document.getElementById('copy-btn');
      if (!el) return;
      var text = el.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          if (btn) { btn.textContent = 'Copied'; setTimeout(function() { btn.textContent = 'Copy'; }, 1800); }
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (btn) { btn.textContent = 'Copied'; setTimeout(function() { btn.textContent = 'Copy'; }, 1800); }
      }
    }
  </script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="generator" content="GitNoob">
  ${emblemDataUri ? `<link rel="icon" type="image/svg+xml" href="${emblemDataUri}">` : ''}
  <title>${escapeHtml(cleanName)} — Read Me First</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #FFFFFF;
      color: #000000;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
      line-height: 1.6;
      padding: 48px 24px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    .eyebrow {
      font-family: "JetBrains Mono", Menlo, Monaco, monospace;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #525252;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 36px;
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.1;
      margin-bottom: 16px;
    }
    .summary {
      font-size: 16px;
      color: #262626;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid #000000;
    }
    h2 {
      font-size: 13px;
      font-family: "JetBrains Mono", Menlo, Monaco, monospace;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin: 28px 0 14px;
    }
    ol.steps { list-style: none; border: 1px solid #000000; }
    ol.steps li {
      display: flex;
      gap: 16px;
      padding: 16px 20px;
      border-bottom: 1px solid #E5E5E5;
      align-items: baseline;
    }
    ol.steps li:last-child { border-bottom: none; }
    .step-num {
      font-family: "JetBrains Mono", Menlo, Monaco, monospace;
      font-weight: 700;
      font-size: 13px;
      flex-shrink: 0;
    }
    .unlock-box {
      border: 1px solid #000000;
      background: #FAFAFA;
      padding: 16px 20px;
    }
    .unlock-note { font-size: 14px; color: #171717; }
    .cmd-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 10px;
      padding: 10px 12px;
      background: #FFFFFF;
      border: 1px solid #D4D4D4;
    }
    .cmd-row code {
      flex: 1;
      font-family: "JetBrains Mono", Menlo, Monaco, monospace;
      font-size: 12px;
      overflow-x: auto;
      white-space: nowrap;
      color: #000000;
    }
    .cmd-row button {
      background: #000000;
      color: #FFFFFF;
      border: none;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }
    .specs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      border: 1px solid #E5E5E5;
      background: #FAFAFA;
      margin-top: 12px;
    }
    .spec-item {
      padding: 14px 16px;
      border-bottom: 1px solid #E5E5E5;
      border-right: 1px solid #E5E5E5;
    }
    .spec-label {
      font-family: "JetBrains Mono", Menlo, Monaco, monospace;
      font-size: 11px;
      text-transform: uppercase;
      color: #525252;
      margin-bottom: 4px;
    }
    .spec-value { font-size: 14px; font-weight: 600; word-break: break-word; }
    .tips {
      border: 1px solid #E5E5E5;
      background: #FAFAFA;
      padding: 16px 20px;
      font-size: 14px;
      white-space: pre-wrap;
    }
    .footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid #E5E5E5;
      font-size: 12px;
      color: #525252;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    a { color: #000000; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;">
      ${emblemDataUri ? `<img src="${emblemDataUri}" alt="${escapeHtml(cleanName)} emblem" width="60" height="60" style="display:block;flex-shrink:0;filter:drop-shadow(0 4px 10px rgba(0,0,0,0.10));">` : ''}
      <div>
        <div class="eyebrow" style="margin-bottom:4px;">GitNoob · Ready-to-Run Package</div>
        <h1 style="margin-bottom:0;">${escapeHtml(cleanName)}</h1>
      </div>
    </div>
    <p class="summary">${escapeHtml(summary)}</p>

    <h2>How to Launch</h2>
    <ol class="steps">
      ${stepsHtml}
    </ol>
    ${macUnlockSection}

    <h2>Package Specifications</h2>
    <div class="specs">
      <div class="spec-item">
        <div class="spec-label">Target Computer</div>
        <div class="spec-value">${escapeHtml(osLabel)}</div>
      </div>
      <div class="spec-item">
        <div class="spec-label">Primary Launcher</div>
        <div class="spec-value">${escapeHtml(launcherName)}</div>
      </div>
      <div class="spec-item">
        <div class="spec-label">Bundled Runtime</div>
        <div class="spec-value">${escapeHtml(runtimeLabel)}</div>
      </div>
      <div class="spec-item">
        <div class="spec-label">Source Repository</div>
        <div class="spec-value"><a href="${escapeHtml(analysis.canonicalUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(analysis.owner)}/${escapeHtml(analysis.repo)}</a></div>
      </div>
    </div>

    ${controls ? `<h2>Controls &amp; Tips</h2><div class="tips">${escapeHtml(controls)}</div>` : ''}

    <div class="footer">
      <span>Packaged by GitNoob — Zero Terminal, Zero Setup</span>
      <span>Stack: ${escapeHtml(analysis.framework || analysis.categoryLabel || 'Web App')}</span>
    </div>
  </div>
  ${copyScript}
</body>
</html>
`;
}

/**
 * Generates .gitnoob runtime scripts, native double-click OS launchers,
 * READ_ME_FIRST.html, and gitnoob-manifest.json inside stageDir.
 */
export async function createLaunchers({
  stageDir,
  analysis,
  slug,
  targetOs,
  buildResult,
  bundledRuntime,
  emblemSvg: providedEmblemSvg,
  dataDir,
}) {
  const cleanName = sanitizeDisplayName(analysis.name || analysis.repo || slug);
  const gitnoobDir = path.join(stageDir, '.gitnoob');
  await fsp.mkdir(gitnoobDir, { recursive: true });

  const emblemSvg =
    providedEmblemSvg ||
    buildArtifactEmblemSvg({
      appName: cleanName,
      category: analysis.category,
      framework: analysis.framework,
      packagingStrategy: analysis.packagingStrategy,
    });

  // Render native OS icon assets (.icns, .ico, .png, .svg) into a temp directory
  const tmpIconsDir = path.join(gitnoobDir, '_icons_tmp');
  let nativeIcons = { svgPath: null, png1024Path: null, png256Path: null, icnsPath: null, icoPath: null };
  try {
    nativeIcons = await generateNativeIcons({ svg: emblemSvg, outDir: tmpIconsDir, dataDir });
  } catch {
    // Non-fatal fallback: still ship SVG icon
  }

  // Always write .gitnoob/serve.mjs
  const servePath = path.join(gitnoobDir, 'serve.mjs');
  await fsp.writeFile(servePath, buildServeMjs(cleanName, buildResult.defaultPort), 'utf8');
  await fsp.chmod(servePath, 0o755).catch(() => {});

  // Write mode-specific runtime helper
  if (buildResult.appMode === 'node') {
    const runAppPath = path.join(gitnoobDir, 'run-app.mjs');
    await fsp.writeFile(runAppPath, buildRunAppMjs(cleanName, buildResult.runConfig), 'utf8');
    await fsp.chmod(runAppPath, 0o755).catch(() => {});
  } else if (buildResult.appMode === 'python') {
    const runPySh = path.join(gitnoobDir, 'run-python.sh');
    const runPyBat = path.join(gitnoobDir, 'run-python.bat');
    await fsp.writeFile(runPySh, buildRunPythonSh(cleanName, buildResult.runConfig), 'utf8');
    await fsp.chmod(runPySh, 0o755).catch(() => {});
    await fsp.writeFile(runPyBat, buildRunPythonBat(cleanName, buildResult.runConfig), 'utf8');
  }

  let launcherName = '';
  const createdLauncherPaths = [];

  try {
    if (targetOs === 'macos-arm64' || targetOs === 'macos-x64') {
      const appBundleName = `Open ${cleanName}.app`;
      const appBundlePath = path.join(stageDir, appBundleName);
      const contentsDir = path.join(appBundlePath, 'Contents');
      const macosDir = path.join(contentsDir, 'MacOS');
      const resourcesDir = path.join(contentsDir, 'Resources');

      await fsp.mkdir(macosDir, { recursive: true });
      await fsp.mkdir(resourcesDir, { recursive: true });

      const plistPath = path.join(contentsDir, 'Info.plist');
      const launchPath = path.join(macosDir, 'launch');
      const iconSvgPath = path.join(resourcesDir, 'icon.svg');
      const appIconIcnsDest = path.join(resourcesDir, 'AppIcon.icns');

      await fsp.writeFile(plistPath, buildMacInfoPlist(cleanName, slug), 'utf8');
      await fsp.writeFile(launchPath, buildMacAppLaunchScript(cleanName, buildResult.appMode), 'utf8');
      await fsp.chmod(launchPath, 0o755);
      await fsp.writeFile(iconSvgPath, emblemSvg, 'utf8');
      if (nativeIcons.icnsPath && fs.existsSync(nativeIcons.icnsPath)) {
        await fsp.copyFile(nativeIcons.icnsPath, appIconIcnsDest);
      }

      // Touch the .app bundle so macOS Finder immediately registers AppIcon.icns before signing
      const now = new Date();
      await fsp.utimes(appBundlePath, now, now).catch(() => {});

      // Best-effort ad-hoc code-sign on macOS so Apple Silicon accepts the local .app bundle cleanly
      if (process.platform === 'darwin') {
        try {
          await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', appBundlePath], {
            timeout: 15_000,
          });
        } catch {
          // Ignore if codesign is unavailable or fails in restricted environments
        }
      }

      const startCmdPath = path.join(stageDir, 'START_MAC.command');
      await fsp.writeFile(startCmdPath, buildStartMacCommand(buildResult.appMode), 'utf8');
      await fsp.chmod(startCmdPath, 0o755);

      launcherName = appBundleName;
      createdLauncherPaths.push(launchPath, startCmdPath);
    } else if (targetOs === 'windows-x64') {
      const batPath = path.join(stageDir, 'START_WINDOWS.bat');
      const vbsName = `Launch ${cleanName}.vbs`;
      const vbsPath = path.join(stageDir, vbsName);

      await fsp.writeFile(batPath, buildStartWindowsBat(buildResult.appMode), 'utf8');
      await fsp.writeFile(vbsPath, buildLaunchWindowsVbs(buildResult.appMode), 'utf8');
      if (nativeIcons.icoPath && fs.existsSync(nativeIcons.icoPath)) {
        await fsp.copyFile(nativeIcons.icoPath, path.join(gitnoobDir, 'AppIcon.ico'));
        await fsp.writeFile(path.join(stageDir, 'desktop.ini'), buildWindowsDesktopIni(cleanName), 'utf8');
      }

      launcherName = vbsName;
      createdLauncherPaths.push(vbsPath, batPath);
    } else {
      const shPath = path.join(stageDir, 'START_LINUX.sh');
      const desktopPath = path.join(stageDir, `${cleanName}.desktop`);
      let hasIconPng = false;
      if (nativeIcons.png256Path && fs.existsSync(nativeIcons.png256Path)) {
        await fsp.copyFile(nativeIcons.png256Path, path.join(gitnoobDir, 'icon.png'));
        hasIconPng = true;
      }

      await fsp.writeFile(shPath, buildStartLinuxSh(buildResult.appMode), 'utf8');
      await fsp.chmod(shPath, 0o755);

      await fsp.writeFile(desktopPath, buildLinuxDesktopEntry(cleanName, hasIconPng), 'utf8');
      await fsp.chmod(desktopPath, 0o755);

      launcherName = 'START_LINUX.sh';
      createdLauncherPaths.push(shPath, desktopPath);
    }
  } finally {
    await fsp.rm(tmpIconsDir, { recursive: true, force: true }).catch(() => {});
  }

  const afterDownloadSteps = buildAfterDownloadSteps({
    targetOs,
    launcherName,
    cleanName,
    format: 'bundle-zip',
  });

  // Write READ_ME_FIRST.html
  const readmeHtml = buildReadMeHtml({
    analysis,
    cleanName,
    slug,
    targetOs,
    launcherName,
    bundledRuntime,
    afterDownloadSteps,
    emblemSvg,
  });
  await fsp.writeFile(path.join(stageDir, 'READ_ME_FIRST.html'), readmeHtml, 'utf8');

  // Write gitnoob-manifest.json
  const manifest = {
    gitnoobVersion: '1.0.0',
    packagedAt: new Date().toISOString(),
    appName: cleanName,
    slug,
    repository: {
      owner: analysis.owner,
      repo: analysis.repo,
      url: analysis.canonicalUrl,
      branch: analysis.branch || analysis.defaultBranch || 'main',
    },
    targetOs,
    appMode: buildResult.appMode,
    launcherName,
    bundledRuntime: bundledRuntime
      ? {
          runtime: bundledRuntime.runtime,
          name: bundledRuntime.name,
          version: bundledRuntime.version,
          relativeBinPath: bundledRuntime.relativeBinPath,
        }
      : null,
    runConfig: buildResult.runConfig,
  };
  await fsp.writeFile(
    path.join(stageDir, 'gitnoob-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return {
    cleanName,
    launcherName,
    createdLauncherPaths,
    afterDownloadSteps,
  };
}
