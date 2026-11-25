import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);

export const NODE_VERSION = '22.14.0';
export const PYTHON_VERSION = '3.12.9';
export const PYTHON_RELEASE_TAG = '20250317';

export const TARGET_OS_LABELS = {
  'macos-arm64': 'macOS (Apple Silicon)',
  'macos-x64': 'macOS (Intel)',
  'windows-x64': 'Windows (64-bit)',
  'linux-x64': 'Linux (64-bit)',
};

export const RUNTIME_CATALOG = {
  node: {
    name: 'Portable Node.js',
    version: NODE_VERSION,
    targets: {
      'macos-arm64': {
        fileName: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        archiveType: 'tar.gz',
        rootFolder: `node-v${NODE_VERSION}-darwin-arm64`,
        relativeBin: 'bin/node',
        approxCompressedMB: 18,
      },
      'macos-x64': {
        fileName: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
        archiveType: 'tar.gz',
        rootFolder: `node-v${NODE_VERSION}-darwin-x64`,
        relativeBin: 'bin/node',
        approxCompressedMB: 19,
      },
      'windows-x64': {
        fileName: `node-v${NODE_VERSION}-win-x64.zip`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
        archiveType: 'zip',
        rootFolder: `node-v${NODE_VERSION}-win-x64`,
        relativeBin: 'node.exe',
        approxCompressedMB: 20,
      },
      'linux-x64': {
        fileName: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
        archiveType: 'tar.xz',
        rootFolder: `node-v${NODE_VERSION}-linux-x64`,
        relativeBin: 'bin/node',
        approxCompressedMB: 17,
      },
    },
  },
  python: {
    name: 'Portable Python',
    version: PYTHON_VERSION,
    targets: {
      'macos-arm64': {
        fileName: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
        url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
        archiveType: 'tar.gz',
        rootFolder: 'python',
        relativeBin: 'bin/python3',
        approxCompressedMB: 21,
      },
      'macos-x64': {
        fileName: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
        url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-apple-darwin-install_only_stripped.tar.gz`,
        archiveType: 'tar.gz',
        rootFolder: 'python',
        relativeBin: 'bin/python3',
        approxCompressedMB: 22,
      },
      'windows-x64': {
        fileName: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
        url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
        archiveType: 'tar.gz',
        rootFolder: 'python',
        relativeBin: 'python.exe',
        approxCompressedMB: 23,
      },
      'linux-x64': {
        fileName: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
        url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
        archiveType: 'tar.gz',
        rootFolder: 'python',
        relativeBin: 'bin/python3',
        approxCompressedMB: 24,
      },
    },
  },
};

const inFlightDownloads = new Map();
const hostPythonExtractLocks = new Map();

export function getHostTargetOs() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (process.platform === 'win32') {
    return 'windows-x64';
  }
  return 'linux-x64';
}

function getCacheDir(dataDir) {
  return path.join(dataDir, 'runtime-cache');
}

async function fileExistsAndValid(filePath, minBytes = 1024 * 1024) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

async function downloadFileAtomically(url, destPath, onProgress) {
  const dir = path.dirname(destPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'GitNoob/1.0 (Universal App Packager)',
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${url}`);
    }

    const totalBytes = Number(response.headers.get('content-length')) || 0;
    let downloadedBytes = 0;
    let lastEmit = 0;

    const webStream = response.body;
    const nodeReadable = Readable.fromWeb(webStream);

    nodeReadable.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const now = Date.now();
      if (typeof onProgress === 'function' && (now - lastEmit > 350 || (totalBytes > 0 && downloadedBytes >= totalBytes))) {
        lastEmit = now;
        const pct = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;
        onProgress({
          downloadedBytes,
          totalBytes,
          percent: pct,
        });
      }
    });

    const writeStream = fs.createWriteStream(tmpPath);
    await pipeline(nodeReadable, writeStream);

    const stat = await fsp.stat(tmpPath);
    if (stat.size < 1024 * 1024) {
      throw new Error(`Downloaded runtime archive looks incomplete (${stat.size} bytes)`);
    }

    await fsp.rename(tmpPath, destPath);
    return stat.size;
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ensures the portable runtime archive for (runtimeName, targetOs) is cached locally.
 * Falls back cleanly to host process.execPath for Node.js on the host OS if offline.
 */
export async function ensureRuntime(runtimeName, targetOs, dataDir, onProgress) {
  const catalogEntry = RUNTIME_CATALOG[runtimeName];
  if (!catalogEntry) {
    throw new Error(`Unsupported runtime: ${runtimeName}`);
  }
  const target = catalogEntry.targets[targetOs];
  if (!target) {
    throw new Error(`Unsupported target OS "${targetOs}" for runtime "${runtimeName}"`);
  }

  const cacheDir = getCacheDir(dataDir);
  await fsp.mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, target.fileName);

  const emit = (message, extra = {}) => {
    if (typeof onProgress === 'function') {
      onProgress({
        runtime: runtimeName,
        targetOs,
        message,
        ...extra,
      });
    }
  };

  if (await fileExistsAndValid(archivePath)) {
    const stat = await fsp.stat(archivePath);
    emit(`Using cached ${catalogEntry.name} v${catalogEntry.version} for ${TARGET_OS_LABELS[targetOs]}`, {
      cached: true,
      percent: 100,
    });
    return {
      runtime: runtimeName,
      name: catalogEntry.name,
      version: catalogEntry.version,
      targetOs,
      source: 'cache',
      archivePath,
      archiveType: target.archiveType,
      rootFolder: target.rootFolder,
      relativeBin: target.relativeBin,
      archiveSizeBytes: stat.size,
    };
  }

  const lockKey = `${runtimeName}:${targetOs}:${archivePath}`;
  try {
    if (!inFlightDownloads.has(lockKey)) {
      emit(`Downloading ${catalogEntry.name} v${catalogEntry.version} for ${TARGET_OS_LABELS[targetOs]}...`, {
        cached: false,
        percent: 0,
      });

      const downloadPromise = downloadFileAtomically(target.url, archivePath, ({ downloadedBytes, totalBytes, percent }) => {
        const mbDone = (downloadedBytes / (1024 * 1024)).toFixed(1);
        const mbTotal = totalBytes > 0 ? ` / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB` : ' MB';
        emit(`Downloading ${catalogEntry.name} v${catalogEntry.version} (${mbDone}${mbTotal})`, {
          downloadedBytes,
          totalBytes,
          percent: percent ?? 50,
        });
      }).finally(() => {
        inFlightDownloads.delete(lockKey);
      });

      inFlightDownloads.set(lockKey, downloadPromise);
    } else {
      emit(`Waiting for in-progress download of ${catalogEntry.name} v${catalogEntry.version}...`, {
        cached: false,
        percent: 30,
      });
    }

    const archiveSizeBytes = await inFlightDownloads.get(lockKey);
    emit(`Cached ${catalogEntry.name} v${catalogEntry.version} (${(archiveSizeBytes / (1024 * 1024)).toFixed(1)} MB)`, {
      cached: true,
      percent: 100,
    });

    return {
      runtime: runtimeName,
      name: catalogEntry.name,
      version: catalogEntry.version,
      targetOs,
      source: 'downloaded',
      archivePath,
      archiveType: target.archiveType,
      rootFolder: target.rootFolder,
      relativeBin: target.relativeBin,
      archiveSizeBytes,
    };
  } catch (err) {
    // Resilient fallback: if network download fails on host OS for Node.js, copy process.execPath!
    if (runtimeName === 'node' && targetOs === getHostTargetOs()) {
      const stat = await fsp.stat(process.execPath);
      emit(`Network unavailable — using host Node.js ${process.version} binary fallback for ${TARGET_OS_LABELS[targetOs]}`, {
        fallback: true,
        percent: 100,
      });
      return {
        runtime: 'node',
        name: 'Portable Node.js',
        version: process.version.replace(/^v/, ''),
        targetOs,
        source: 'host-fallback',
        hostBinaryPath: process.execPath,
        relativeBin: target.relativeBin,
        archiveSizeBytes: stat.size,
      };
    }
    throw new Error(`Failed to fetch ${catalogEntry.name} v${catalogEntry.version} for ${targetOs}: ${err.message}`);
  }
}

async function computeDirSize(dirPath) {
  let total = 0;
  const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      const lstat = await fsp.lstat(full).catch(() => null);
      if (lstat) total += lstat.size;
    } else if (entry.isDirectory()) {
      total += await computeDirSize(full);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) total += stat.size;
    }
  }
  return total;
}

/**
 * Extracts only the lean runtime files required into <bundleDir>/.gitnoob/runtime/<runtime>/
 */
export async function installRuntimeIntoBundle(runtimeInfo, bundleDir, onProgress) {
  const runtimeDestDir = path.join(bundleDir, '.gitnoob', 'runtime', runtimeInfo.runtime);
  await fsp.mkdir(runtimeDestDir, { recursive: true });

  const emit = (message) => {
    if (typeof onProgress === 'function') {
      onProgress({ runtime: runtimeInfo.runtime, targetOs: runtimeInfo.targetOs, message });
    }
  };

  if (runtimeInfo.runtime === 'node') {
    if (runtimeInfo.source === 'host-fallback') {
      const binDest = path.join(runtimeDestDir, runtimeInfo.relativeBin);
      await fsp.mkdir(path.dirname(binDest), { recursive: true });
      await fsp.copyFile(runtimeInfo.hostBinaryPath, binDest);
      await fsp.chmod(binDest, 0o755).catch(() => {});
      emit(`Bundled host Node.js binary (${runtimeInfo.version}) into package`);
    } else if (runtimeInfo.archiveType === 'tar.gz' || runtimeInfo.archiveType === 'tar.xz') {
      emit(`Extracting lean Portable Node.js v${runtimeInfo.version} binary...`);
      const tarFlag = runtimeInfo.archiveType === 'tar.xz' ? '-xJf' : '-xzf';
      const binMember = `${runtimeInfo.rootFolder}/bin/node`;
      const licenseMember = `${runtimeInfo.rootFolder}/LICENSE`;

      // Extract only bin/node and LICENSE (strips include/, share/, npm docs -> ultra-lean!)
      try {
        await execFileAsync('tar', [
          tarFlag,
          runtimeInfo.archivePath,
          '-C',
          runtimeDestDir,
          '--strip-components=1',
          binMember,
          licenseMember,
        ], { maxBuffer: 10 * 1024 * 1024 });
      } catch {
        // Fallback if LICENSE casing/path varies: extract bin/node alone
        await execFileAsync('tar', [
          tarFlag,
          runtimeInfo.archivePath,
          '-C',
          runtimeDestDir,
          '--strip-components=1',
          binMember,
        ], { maxBuffer: 10 * 1024 * 1024 });
      }
      const binPath = path.join(runtimeDestDir, runtimeInfo.relativeBin);
      await fsp.chmod(binPath, 0o755).catch(() => {});
    } else if (runtimeInfo.archiveType === 'zip') {
      emit(`Extracting lean Portable Node.js v${runtimeInfo.version} for Windows...`);
      const tmpExtract = path.join(bundleDir, '.gitnoob', 'runtime', '_tmp_node_extract');
      await fsp.mkdir(tmpExtract, { recursive: true });
      try {
        await execFileAsync('unzip', [
          '-o',
          '-q',
          runtimeInfo.archivePath,
          `${runtimeInfo.rootFolder}/node.exe`,
          `${runtimeInfo.rootFolder}/LICENSE`,
          '-d',
          tmpExtract,
        ], { maxBuffer: 10 * 1024 * 1024 });

        const extractedRoot = path.join(tmpExtract, runtimeInfo.rootFolder);
        await fsp.rename(
          path.join(extractedRoot, 'node.exe'),
          path.join(runtimeDestDir, 'node.exe'),
        );
        const licenseSrc = path.join(extractedRoot, 'LICENSE');
        if (fs.existsSync(licenseSrc)) {
          await fsp.rename(licenseSrc, path.join(runtimeDestDir, 'LICENSE')).catch(() => {});
        }
      } finally {
        await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
      }
    }

    const binFullPath = path.join(runtimeDestDir, runtimeInfo.relativeBin);
    if (!fs.existsSync(binFullPath)) {
      throw new Error(`Expected bundled Node.js binary not found at ${binFullPath}`);
    }
    const installedBytes = await computeDirSize(runtimeDestDir);
    return {
      runtime: 'node',
      name: runtimeInfo.name,
      version: runtimeInfo.version,
      targetOs: runtimeInfo.targetOs,
      source: runtimeInfo.source,
      relativeBinPath: path.posix.join('.gitnoob', 'runtime', 'node', runtimeInfo.relativeBin),
      absoluteBinPath: binFullPath,
      installedBytes,
    };
  }

  if (runtimeInfo.runtime === 'python') {
    emit(`Extracting Portable Python v${runtimeInfo.version}...`);
    await execFileAsync('tar', [
      '-xzf',
      runtimeInfo.archivePath,
      '-C',
      runtimeDestDir,
      '--strip-components=1',
    ], { maxBuffer: 20 * 1024 * 1024 });

    // Strip unneeded stdlib tests / idlelib / turtledemo to keep bundle lean
    const stripCandidates = [
      path.join(runtimeDestDir, 'lib', 'python3.12', 'test'),
      path.join(runtimeDestDir, 'lib', 'python3.12', 'idlelib'),
      path.join(runtimeDestDir, 'lib', 'python3.12', 'turtledemo'),
      path.join(runtimeDestDir, 'Lib', 'test'),
      path.join(runtimeDestDir, 'Lib', 'idlelib'),
      path.join(runtimeDestDir, 'Lib', 'turtledemo'),
    ];
    for (const dir of stripCandidates) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    const binFullPath = path.join(runtimeDestDir, runtimeInfo.relativeBin);
    if (!fs.existsSync(binFullPath)) {
      throw new Error(`Expected bundled Python binary not found at ${binFullPath}`);
    }
    if (runtimeInfo.targetOs !== 'windows-x64') {
      await fsp.chmod(binFullPath, 0o755).catch(() => {});
    }

    const installedBytes = await computeDirSize(runtimeDestDir);
    return {
      runtime: 'python',
      name: runtimeInfo.name,
      version: runtimeInfo.version,
      targetOs: runtimeInfo.targetOs,
      source: runtimeInfo.source,
      relativeBinPath: path.posix.join('.gitnoob', 'runtime', 'python', runtimeInfo.relativeBin),
      absoluteBinPath: binFullPath,
      installedBytes,
    };
  }

  throw new Error(`Unsupported runtime install: ${runtimeInfo.runtime}`);
}

/**
 * Returns cache status for all supported portable runtimes & target OSes.
 */
export async function getRuntimeCacheStatus(dataDir) {
  const cacheDir = getCacheDir(dataDir);
  const results = [];

  for (const [runtimeKey, entry] of Object.entries(RUNTIME_CATALOG)) {
    for (const [targetOs, target] of Object.entries(entry.targets)) {
      const archivePath = path.join(cacheDir, target.fileName);
      let cached = false;
      let sizeBytes = 0;
      let cachedAt = null;

      try {
        const stat = await fsp.stat(archivePath);
        if (stat.isFile() && stat.size >= 1024 * 1024) {
          cached = true;
          sizeBytes = stat.size;
          cachedAt = stat.mtime.toISOString();
        }
      } catch {
        // Not cached yet
      }

      results.push({
        id: `${runtimeKey}-${targetOs}`,
        runtime: runtimeKey,
        name: entry.name,
        version: entry.version,
        targetOs,
        osLabel: TARGET_OS_LABELS[targetOs] || targetOs,
        fileName: target.fileName,
        cached,
        sizeBytes,
        approxCompressedMB: target.approxCompressedMB,
        cachedAt,
        downloadUrl: target.url,
      });
    }
  }

  return results;
}

/**
 * Ensures an extracted, host-runnable Portable Python 3.12.9 binary (with pip)
 * exists in `<dataDir>/runtime-cache/python-host-3.12/` so pip installs always use
 * exact Python 3.12 ABI (never host Homebrew Python 3.13 / PEP 668).
 */
export async function ensureHostPythonBinary(dataDir, onProgress) {
  const hostOs = getHostTargetOs();
  const ensured = await ensureRuntime('python', hostOs, dataDir, onProgress);
  const extractDir = path.join(getCacheDir(dataDir), `python-host-${PYTHON_VERSION}-${hostOs}`);
  const binPath = path.join(extractDir, ensured.relativeBin);

  if (fs.existsSync(binPath)) {
    return { pythonBin: binPath, version: ensured.version, hostOs };
  }

  if (!hostPythonExtractLocks.has(extractDir)) {
    const extractPromise = (async () => {
      const tmpDir = `${extractDir}.tmp.${process.pid}.${Date.now()}`;
      await fsp.mkdir(tmpDir, { recursive: true });
      try {
        await execFileAsync('tar', ['-xzf', ensured.archivePath, '-C', tmpDir, '--strip-components=1'], {
          maxBuffer: 20 * 1024 * 1024,
        });
        const tmpBin = path.join(tmpDir, ensured.relativeBin);
        if (!fs.existsSync(tmpBin)) {
          throw new Error(`Extracted host Python binary not found at ${tmpBin}`);
        }
        if (hostOs !== 'windows-x64') {
          await fsp.chmod(tmpBin, 0o755).catch(() => {});
        }
        // Verify pip is available (bootstrap via ensurepip if stripped)
        try {
          await execFileAsync(tmpBin, ['-m', 'pip', '--version'], { timeout: 15_000 });
        } catch {
          await execFileAsync(tmpBin, ['-m', 'ensurepip', '--upgrade'], { timeout: 30_000 });
        }
        await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        await fsp.rename(tmpDir, extractDir);
      } catch (err) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    })().finally(() => {
      hostPythonExtractLocks.delete(extractDir);
    });
    hostPythonExtractLocks.set(extractDir, extractPromise);
  }

  await hostPythonExtractLocks.get(extractDir);
  return { pythonBin: binPath, version: ensured.version, hostOs };
}

