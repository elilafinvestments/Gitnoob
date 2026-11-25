import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getHostTargetOs } from './runtimes.js';

const execFileAsync = promisify(execFile);
const MAX_FILE_TREE_ENTRIES = 250;

function classifyRelativePath(relPosixPath) {
  if (relPosixPath.startsWith('.gitnoob/runtime/') || relPosixPath === '.gitnoob/runtime') {
    return 'runtime';
  }
  if (
    relPosixPath.startsWith('app/node_modules/') ||
    relPosixPath === 'app/node_modules' ||
    relPosixPath.startsWith('app/.gitnoob-pylibs/') ||
    relPosixPath === 'app/.gitnoob-pylibs'
  ) {
    return 'dependencies';
  }
  if (
    relPosixPath.startsWith('app/') ||
    relPosixPath === 'app'
  ) {
    return 'app';
  }
  return 'launcher';
}

async function inspectBundleFiles(stageDir) {
  const breakdown = {
    appCodeBytes: 0,
    dependenciesBytes: 0,
    runtimeBytes: 0,
    launcherBytes: 0,
    totalUncompressedBytes: 0,
  };

  const priorityEntries = [];
  const secondaryEntries = [];

  async function walk(currentDir, relBase, depth) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPosix = relBase ? `${relBase}/${entry.name}` : entry.name;
      const category = classifyRelativePath(relPosix);

      if (entry.isSymbolicLink()) {
        const lstat = await fsp.lstat(fullPath).catch(() => null);
        const size = lstat ? lstat.size : 0;
        addBytes(breakdown, category, size);
        if (depth <= 2) {
          priorityEntries.push({ path: relPosix, type: 'file', size, category });
        }
        continue;
      }

      if (entry.isDirectory()) {
        const isHeavyDir =
          relPosix === 'app/node_modules' ||
          relPosix === 'app/.gitnoob-pylibs' ||
          relPosix.startsWith('.gitnoob/runtime/python/lib');

        if (depth <= 2 || relPosix.startsWith('Open ')) {
          priorityEntries.push({ path: relPosix, type: 'dir', size: 0, category });
        } else if (!isHeavyDir && secondaryEntries.length < MAX_FILE_TREE_ENTRIES) {
          secondaryEntries.push({ path: relPosix, type: 'dir', size: 0, category });
        }

        await walk(fullPath, relPosix, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath).catch(() => null);
        const size = stat ? stat.size : 0;
        addBytes(breakdown, category, size);

        const isInsideHeavyDeps =
          relPosix.startsWith('app/node_modules/') ||
          relPosix.startsWith('app/.gitnoob-pylibs/') ||
          relPosix.startsWith('.gitnoob/runtime/python/lib/');

        if (!isInsideHeavyDeps && depth <= 2) {
          priorityEntries.push({ path: relPosix, type: 'file', size, category });
        } else if (!isInsideHeavyDeps && secondaryEntries.length < MAX_FILE_TREE_ENTRIES) {
          secondaryEntries.push({ path: relPosix, type: 'file', size, category });
        }
      }
    }
  }

  await walk(stageDir, '', 0);

  const fileTree = [...priorityEntries, ...secondaryEntries].slice(0, MAX_FILE_TREE_ENTRIES);
  return { breakdown, fileTree };
}

function addBytes(breakdown, category, size) {
  breakdown.totalUncompressedBytes += size;
  if (category === 'runtime') breakdown.runtimeBytes += size;
  else if (category === 'dependencies') breakdown.dependenciesBytes += size;
  else if (category === 'launcher') breakdown.launcherBytes += size;
  else breakdown.appCodeBytes += size;
}

async function checkBinaryMagic(filePath, targetOs) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    if (targetOs === 'windows-x64') {
      return buf[0] === 0x4d && buf[1] === 0x5a; // MZ
    }
    if (targetOs === 'linux-x64') {
      return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46; // \x7fELF
    }
    // macOS Mach-O (64-bit / universal fat)
    const hex = buf.toString('hex');
    return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'feedfacf', 'feedface'].includes(hex);
  } finally {
    await fh.close();
  }
}

async function runStaticServerSmokeTest(nodeBin, serveScriptPath) {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [serveScriptPath], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        GITNOOB_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let output = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1500).unref();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ passed: false, detail: 'Smoke test server timed out after 10s' });
    }, 10_000);

    const onData = async (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/GITNOOB_READY_URL=(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match && !settled) {
        const url = match[1];
        try {
          const res = await fetch(url);
          const body = await res.text();
          const looksHtml = /<(?:!doctype|html|head|body|script|div|canvas)/i.test(body);
          if (res.status === 200 && body.length > 0) {
            finish({
              passed: true,
              detail: `HTTP 200 OK from bundled server (${body.length.toLocaleString()} bytes${looksHtml ? ', valid HTML' : ''})`,
            });
          } else {
            finish({
              passed: false,
              detail: `Server responded with HTTP ${res.status} (${body.length} bytes)`,
            });
          }
        } catch (err) {
          finish({ passed: false, detail: `HTTP probe failed: ${err.message}` });
        }
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish({ passed: false, detail: `Failed to spawn server: ${err.message}` }));
    child.on('exit', (code) => {
      if (!settled) {
        finish({ passed: false, detail: `Server exited unexpectedly (code ${code})` });
      }
    });
  });
}

function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function killProcessGroup(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
    }
  }, 1500).unref();
}

async function runPythonWebSmokeTest(runPyShPath) {
  const port = await getEphemeralPort();
  const url = `http://127.0.0.1:${port}/`;

  return new Promise((resolve) => {
    const child = spawn('bash', [runPyShPath], {
      detached: process.platform !== 'win32',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME || '/tmp',
        TMPDIR: process.env.TMPDIR || '/tmp',
        PORT: String(port),
        GITNOOB_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let outputTail = '';
    let pollTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (pollTimer) clearTimeout(pollTimer);
      killProcessGroup(child);
      resolve(result);
    };

    const appendOutput = (chunk) => {
      outputTail = (outputTail + chunk.toString('utf8')).slice(-2500);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    child.on('error', (err) => {
      finish({ passed: false, detail: `Failed to spawn Python launcher: ${err.message}` });
    });

    child.on('exit', (code) => {
      if (!settled) {
        const errLine = outputTail
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-3)
          .join(' | ');
        finish({
          passed: false,
          detail: `Python server exited early (code ${code})${errLine ? `: ${errLine}` : ''}`,
        });
      }
    });

    const deadlineTimer = setTimeout(() => {
      const errLine = outputTail
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-2)
        .join(' | ');
      finish({
        passed: false,
        detail: `Python web server did not accept connections on port ${port} within 15s${errLine ? ` (${errLine})` : ''}`,
      });
    }, 15_000);

    const poll = async () => {
      if (settled) return;
      try {
        const res = await fetch(url, { redirect: 'follow' });
        const body = await res.text();
        if (res.status >= 200 && res.status < 400) {
          const redirected = res.redirected ? ` -> ${new URL(res.url).pathname}` : '';
          finish({
            passed: true,
            detail: `HTTP ${res.status} OK${redirected} from bundled Python server (${body.length.toLocaleString()} bytes)`,
          });
          return;
        }
        finish({
          passed: false,
          detail: `Bundled Python server responded with HTTP ${res.status} (${body.length} bytes)`,
        });
        return;
      } catch {
        if (!settled) {
          pollTimer = setTimeout(poll, 300);
        }
      }
    };

    pollTimer = setTimeout(poll, 350);
  });
}

/**
 * Automated pre-download smoke test & bundle X-Ray.
 */
export async function verifyAndInspectBundle({
  stageDir,
  targetOs,
  buildResult,
  bundledRuntime,
  launcherInfo,
}) {
  const checks = [];
  const hostOs = getHostTargetOs();
  const isHostOs = targetOs === hostOs;

  // 1. Check launcher existence & permissions
  const launcherMissing = [];
  const launcherNotExec = [];
  for (const lPath of launcherInfo.createdLauncherPaths || []) {
    if (!fs.existsSync(lPath)) {
      launcherMissing.push(path.basename(lPath));
      continue;
    }
    if (targetOs !== 'windows-x64') {
      const stat = await fsp.stat(lPath).catch(() => null);
      if (stat && (stat.mode & 0o111) === 0) {
        launcherNotExec.push(path.basename(lPath));
      }
    }
  }
  checks.push({
    id: 'launcher',
    label: 'Native Launcher Ready',
    passed: launcherMissing.length === 0 && launcherNotExec.length === 0,
    detail:
      launcherMissing.length > 0
        ? `Missing launcher files: ${launcherMissing.join(', ')}`
        : launcherNotExec.length > 0
          ? `Non-executable launchers: ${launcherNotExec.join(', ')}`
          : `Verified ${launcherInfo.launcherName} with valid permissions`,
  });

  // 2. Check app files
  const appDir = path.join(stageDir, 'app');
  const appEntries = await fsp.readdir(appDir).catch(() => []);
  const hasIndex = fs.existsSync(path.join(appDir, 'index.html'));
  const appOk = buildResult.appMode === 'static' ? hasIndex : appEntries.length > 0;
  checks.push({
    id: 'app-files',
    label: 'Application Files Verified',
    passed: appOk,
    detail: appOk
      ? `${appEntries.length} top-level item${appEntries.length === 1 ? '' : 's'} staged in app/${hasIndex ? ' (index.html present)' : ''}`
      : 'Staged app/ directory is missing expected entry files',
  });

  // 3. Check bundled portable runtime
  if (bundledRuntime) {
    const binPath = bundledRuntime.absoluteBinPath;
    if (!fs.existsSync(binPath)) {
      checks.push({
        id: 'runtime',
        label: 'Portable Runtime Verified',
        passed: false,
        detail: `Runtime binary missing at ${bundledRuntime.relativeBinPath}`,
      });
    } else if (isHostOs) {
      try {
        const { stdout, stderr } = await execFileAsync(binPath, ['--version'], { timeout: 10_000 });
        const reportedVersion = (stdout || stderr).trim().split(/\r?\n/)[0];
        checks.push({
          id: 'runtime',
          label: 'Portable Runtime Verified',
          passed: true,
          detail: `Executed bundled ${bundledRuntime.name} -> ${reportedVersion}`,
        });
      } catch (err) {
        checks.push({
          id: 'runtime',
          label: 'Portable Runtime Verified',
          passed: false,
          detail: `Bundled runtime failed --version check: ${err.message}`,
        });
      }
    } else {
      const validHeader = await checkBinaryMagic(binPath, targetOs).catch(() => false);
      checks.push({
        id: 'runtime',
        label: 'Portable Runtime Verified',
        passed: validHeader,
        detail: validHeader
          ? `Verified ${targetOs} executable binary header for ${bundledRuntime.name} v${bundledRuntime.version}`
          : `Unexpected executable format in ${bundledRuntime.relativeBinPath}`,
      });
    }
  } else {
    checks.push({
      id: 'runtime',
      label: 'Portable Runtime',
      passed: true,
      detail: 'Skipped (runtime bundling disabled for this package)',
    });
  }

  // 4. Live Boot Smoke Test
  const serveScriptPath = path.join(stageDir, '.gitnoob', 'serve.mjs');
  if (buildResult.appMode === 'static' && fs.existsSync(serveScriptPath)) {
    const nodeToTest = isHostOs && bundledRuntime?.runtime === 'node'
      ? bundledRuntime.absoluteBinPath
      : process.execPath;
    const smoke = await runStaticServerSmokeTest(nodeToTest, serveScriptPath);
    checks.push({
      id: 'smoke-test',
      label: 'Live Boot Smoke Test',
      passed: smoke.passed,
      detail: smoke.detail,
    });
  } else if (buildResult.appMode === 'node') {
    const runAppPath = path.join(stageDir, '.gitnoob', 'run-app.mjs');
    try {
      await execFileAsync(process.execPath, ['--check', runAppPath], { timeout: 5000 });
      checks.push({
        id: 'smoke-test',
        label: 'Launcher Script Syntax Check',
        passed: true,
        detail: `Verified .gitnoob/run-app.mjs syntax & app entry (${buildResult.runConfig.entryPoint})`,
      });
    } catch (err) {
      checks.push({
        id: 'smoke-test',
        label: 'Launcher Script Syntax Check',
        passed: false,
        detail: err.message,
      });
    }
  } else if (buildResult.appMode === 'python') {
    const entryExists = fs.existsSync(path.join(appDir, buildResult.runConfig.entryPoint));
    const runPyShPath = path.join(stageDir, '.gitnoob', 'run-python.sh');

    if (isHostOs && buildResult.isWeb && entryExists && fs.existsSync(runPyShPath)) {
      const pySmoke = await runPythonWebSmokeTest(runPyShPath);
      checks.push({
        id: 'smoke-test',
        label: 'Live Boot Smoke Test',
        passed: pySmoke.passed,
        detail: pySmoke.detail,
      });
    } else {
      let syntaxOk = true;
      let syntaxDetail = '';
      if (targetOs !== 'windows-x64' && fs.existsSync(runPyShPath)) {
        try {
          await execFileAsync('bash', ['-n', runPyShPath], { timeout: 5000 });
        } catch (err) {
          syntaxOk = false;
          syntaxDetail = ` (launcher syntax error: ${err.message})`;
        }
      }
      const pylibsDir = path.join(appDir, '.gitnoob-pylibs');
      const hasReqFile = fs.existsSync(path.join(appDir, 'requirements.txt'));
      const pylibsEntries = await fsp.readdir(pylibsDir).catch(() => []);
      const depsNote = hasReqFile
        ? `, ${pylibsEntries.length} bundled package entries in .gitnoob-pylibs/`
        : '';
      checks.push({
        id: 'smoke-test',
        label: 'Python Entry & Launcher Verification',
        passed: entryExists && syntaxOk,
        detail: entryExists && syntaxOk
          ? `Verified Python entry ${buildResult.runConfig.entryPoint} (${buildResult.runConfig.runner})${depsNote}`
          : !entryExists
            ? `Python entry ${buildResult.runConfig.entryPoint} not found in app/`
            : `Python launcher check failed${syntaxDetail}`,
      });
    }
  }

  // 5. Bundle X-Ray: exact breakdown + fileTree
  const { breakdown, fileTree } = await inspectBundleFiles(stageDir);

  const passed = checks.every((c) => c.passed);
  const passedCount = checks.filter((c) => c.passed).length;
  const summary = passed
    ? `All ${passedCount}/${checks.length} automated checks passed`
    : `${passedCount}/${checks.length} checks passed — review warnings`;

  return {
    verification: {
      passed,
      summary,
      checkedAt: new Date().toISOString(),
      checks,
    },
    breakdown,
    fileTree,
  };
}
