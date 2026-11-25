import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getHostTargetOs, ensureHostPythonBinary } from './runtimes.js';
import { buildReactComponentHarness } from './reactHarness.js';

const DEFAULT_TIMEOUT_MS = 180_000;

const STATIC_EXCLUDE_NAMES = new Set([
  '.git',
  '.github',
  '.gitlab',
  '.vscode',
  '.idea',
  '.DS_Store',
  'Thumbs.db',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  '.gitnoob',
]);

const STATIC_EXCLUDE_TEST_DIRS = new Set([
  '__tests__',
  'test',
  'tests',
  'e2e',
  'cypress',
  '.nyc_output',
  'coverage',
]);

const PIP_PLATFORM_MAP = {
  'macos-arm64': 'macosx_11_0_arm64',
  'macos-x64': 'macosx_10_9_x86_64',
  'windows-x64': 'win_amd64',
  'linux-x64': 'manylinux2014_x86_64',
};

function runCommandStreaming(cmd, args, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, onLog } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);

    const handleChunk = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') {
        stdout += text;
        if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
      } else {
        stderr += text;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      }
      if (typeof onLog === 'function') {
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) onLog(trimmed, stream);
        }
      }
    };

    child.stdout.on('data', (c) => handleChunk(c, 'stdout'));
    child.stderr.on('data', (c) => handleChunk(c, 'stderr'));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        reject(new Error(`Command "${cmd} ${args.join(' ')}" timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`Command "${cmd} ${args[0] || ''}" failed (exit ${code})${tail ? `:\n${tail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function copyFilteredDir(srcDir, destDir, { excludeNames = STATIC_EXCLUDE_NAMES, excludeTestDirs = true } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    if (excludeNames.has(entry.name)) continue;
    if (excludeTestDirs && entry.isDirectory() && STATIC_EXCLUDE_TEST_DIRS.has(entry.name.toLowerCase())) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(srcPath).catch(() => null);
      if (linkTarget) {
        await fsp.symlink(linkTarget, destPath).catch(() => {});
      }
    } else if (entry.isDirectory()) {
      await copyFilteredDir(srcPath, destPath, { excludeNames, excludeTestDirs });
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatEnvFile(envVars) {
  if (!envVars || typeof envVars !== 'object') return '';
  const lines = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const strVal = value == null ? '' : String(value);
    if (!strVal) continue;
    const needsQuotes = /[\s#"']/.test(strVal);
    lines.push(`${key}=${needsQuotes ? JSON.stringify(strVal) : strVal}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function findCompiledOutputDir(workDir, preferredOutputDir) {
  const candidates = [];
  if (preferredOutputDir) candidates.push(preferredOutputDir);
  candidates.push('dist', 'build', 'out', 'public', '_site');

  for (const rel of candidates) {
    const full = path.join(workDir, rel);
    if (fs.existsSync(path.join(full, 'index.html'))) {
      return full;
    }
  }
  return null;
}

function detectFrontendBuildApp(pkg, analysis) {
  if (!pkg || !pkg.scripts || !pkg.scripts.build) return false;
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const frontendSignals = [
    'vite',
    'react-scripts',
    '@vue/cli-service',
    'parcel',
    'parcel-bundler',
    'astro',
    'svelte',
    '@sveltejs/vite-plugin-svelte',
    'webpack',
    'gatsby',
    'esbuild',
  ];
  const hasFrontendTool = frontendSignals.some((dep) => dep in allDeps);
  const isNextServer = 'next' in allDeps && !String(pkg.scripts.build).includes('export');
  if (isNextServer) return false;

  if (analysis?.packagingStrategy === 'static-bundle' || analysis?.packagingStrategy === 'single-html') {
    return true;
  }
  return hasFrontendTool && !('express' in allDeps) && !('fastify' in allDeps) && !('koa' in allDeps);
}

function detectNodeStartInfo(workDir, pkg, analysis) {
  const allDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const startScript = pkg?.scripts?.start || analysis?.detectedFiles?.startScript || null;
  let entryPoint = analysis?.detectedFiles?.entryPoint || pkg?.main || null;

  if (!entryPoint) {
    const candidates = ['server.js', 'index.js', 'app.js', 'main.js', 'src/server.js', 'src/index.js', 'dist/index.js', 'dist/server.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        entryPoint = c;
        break;
      }
    }
  }

  const webSignals = ['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'next', 'nuxt', 'socket.io', 'http-server', 'serve', 'vite'];
  const isWeb = webSignals.some((d) => d in allDeps) ||
    ['web-app', 'game', 'static-site'].includes(analysis?.category);

  let defaultPort = 3000;
  if ('vite' in allDeps) defaultPort = 4173;
  else if ('express' in allDeps) defaultPort = 3000;

  return {
    startScript,
    entryPoint: entryPoint || 'index.js',
    isWeb,
    defaultPort,
  };
}

async function detectPythonRunInfo(workDir, analysis) {
  const reqPath = path.join(workDir, 'requirements.txt');
  const pyprojectPath = path.join(workDir, 'pyproject.toml');
  let depsText = '';
  if (fs.existsSync(reqPath)) {
    depsText += (await fsp.readFile(reqPath, 'utf8').catch(() => '')).toLowerCase();
  }
  if (fs.existsSync(pyprojectPath)) {
    depsText += '\n' + (await fsp.readFile(pyprojectPath, 'utf8').catch(() => '')).toLowerCase();
  }

  const frameworkHint = (analysis?.framework || '').toLowerCase();
  let entryPoint = analysis?.detectedFiles?.entryPoint || null;
  if (!entryPoint || !fs.existsSync(path.join(workDir, entryPoint))) {
    const candidates = ['app.py', 'main.py', 'server.py', 'run.py', 'wsgi.py', 'game.py', 'cli.py', 'src/app.py', 'src/main.py'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        entryPoint = c;
        break;
      }
    }
    if (!entryPoint) {
      const files = await fsp.readdir(workDir).catch(() => []);
      const firstPy = files.find((f) => f.endsWith('.py') && f !== 'setup.py');
      entryPoint = firstPy || 'main.py';
    }
  }

  let runner = 'script';
  let isWeb = false;
  let defaultPort = 8000;

  if (frameworkHint.includes('streamlit') || /\bstreamlit\b/.test(depsText)) {
    runner = 'streamlit';
    isWeb = true;
    defaultPort = 8501;
  } else if (frameworkHint.includes('gradio') || /\bgradio\b/.test(depsText)) {
    runner = 'gradio';
    isWeb = true;
    defaultPort = 7860;
  } else if (frameworkHint.includes('fastapi') || /\bfastapi\b/.test(depsText)) {
    runner = 'fastapi';
    isWeb = true;
    defaultPort = 8000;
  } else if (frameworkHint.includes('flask') || /\bflask\b/.test(depsText)) {
    runner = 'flask';
    isWeb = true;
    defaultPort = 5050;
  } else if (frameworkHint.includes('pygame') || /\bpygame\b/.test(depsText)) {
    runner = 'pygame';
    isWeb = false;
  }

  return {
    runner,
    entryPoint,
    isWeb,
    defaultPort,
    hasRequirements: fs.existsSync(reqPath),
    hasPyproject: fs.existsSync(pyprojectPath),
  };
}

function resolveMatchingLocalSuffix(rawRef, appDestDir) {
  if (!rawRef) return null;
  const trimmed = rawRef.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('javascript:')) {
    return null;
  }

  // Already a relative path like "./assets/foo.js" or "assets/foo.js"
  if (!trimmed.startsWith('/') && !/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('//')) {
    return null;
  }

  let pathname = '';
  let suffix = '';
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      pathname = decodeURIComponent(parsed.pathname);
      suffix = `${parsed.search || ''}${parsed.hash || ''}`;
    } else if (trimmed.startsWith('//')) {
      const parsed = new URL(`https:${trimmed}`);
      pathname = decodeURIComponent(parsed.pathname);
      suffix = `${parsed.search || ''}${parsed.hash || ''}`;
    } else {
      const qIdx = trimmed.search(/[?#]/);
      pathname = decodeURIComponent(qIdx >= 0 ? trimmed.slice(0, qIdx) : trimmed);
      suffix = qIdx >= 0 ? trimmed.slice(qIdx) : '';
    }
  } catch {
    return null;
  }

  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const normRoot = path.resolve(appDestDir);
  for (let i = 0; i < parts.length; i += 1) {
    const relCandidate = parts.slice(i).join('/');
    const fullCandidate = path.resolve(appDestDir, relCandidate);
    if (!fullCandidate.startsWith(normRoot + path.sep)) continue;
    try {
      if (fs.existsSync(fullCandidate) && fs.statSync(fullCandidate).isFile()) {
        return `./${relCandidate}${suffix}`;
      }
    } catch {
      // ignore stat errors
    }
  }
  return null;
}

/**
 * Rewrites absolute remote/subpath asset URLs (e.g., GitHub Pages base URLs like
 * https://mdn.github.io/todo-react/assets/... or /todo-react/assets/...) in built
 * app/index.html to local relative "./..." paths whenever the asset exists in appDestDir.
 */
async function localizeBuiltHtmlAssets(appDestDir) {
  const indexPath = path.join(appDestDir, 'index.html');
  if (!fs.existsSync(indexPath)) return 0;

  const original = await fsp.readFile(indexPath, 'utf8');
  let rewrittenCount = 0;

  const updated = original.replace(
    /(\b(?:src|href|poster)\s*=\s*)(["'])([^"']+)\2/gi,
    (fullMatch, prefix, quote, rawVal) => {
      const localized = resolveMatchingLocalSuffix(rawVal, appDestDir);
      if (localized) {
        rewrittenCount += 1;
        return `${prefix}${quote}${localized}${quote}`;
      }
      return fullMatch;
    },
  );

  if (rewrittenCount > 0 && updated !== original) {
    await fsp.writeFile(indexPath, updated, 'utf8');
  }
  return rewrittenCount;
}

function isSimpleViteBuildScript(pkg) {
  const script = String(pkg?.scripts?.build || '').trim();
  if (!script) return false;
  return /\bvite\s+build\b/.test(script) && !/[;&|]/.test(script);
}

async function hasReactComponentFiles(workDir, maxDepth = 4) {
  const skip = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.github', 'coverage', '__tests__', 'test', 'tests']);
  async function scan(dir, depth) {
    if (depth > maxDepth) return false;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /\.[jt]sx$/i.test(entry.name) && !/\.(test|spec|stories|config)\.[jt]sx$/i.test(entry.name)) {
        return true;
      }
      if (entry.isDirectory()) {
        if (await scan(full, depth + 1)) return true;
      }
    }
    return false;
  }
  return scan(workDir, 0);
}

/**
 * Clones the GitHub repository into an isolated build directory, installs dependencies,
 * runs any required build step, and populates <stageDir>/app/.
 */
export async function cloneAndBuild({
  jobId,
  analysis,
  targetOs,
  envVars,
  dataDir,
  stageDir,
  onStageProgress,
  onLog,
}) {
  const buildRoot = path.join(dataDir, 'builds', jobId);
  const srcDir = path.join(buildRoot, 'src');
  const appDestDir = path.join(stageDir, 'app');

  await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(buildRoot, { recursive: true });
  await fsp.mkdir(appDestDir, { recursive: true });

  const repoUrl = analysis.canonicalUrl
    ? (analysis.canonicalUrl.endsWith('.git') ? analysis.canonicalUrl : `${analysis.canonicalUrl}.git`)
    : `https://github.com/${analysis.owner}/${analysis.repo}.git`;

  const emitProgress = (stage, percent, message) => {
    if (typeof onStageProgress === 'function') {
      onStageProgress(stage, percent, message);
    }
  };

  // --- STAGE 1: CLONE & INSPECT ---
  emitProgress('clone', 5, `Cloning ${analysis.owner}/${analysis.repo}...`);
  const branch = analysis.branch || analysis.defaultBranch || null;

  try {
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) {
      cloneArgs.push('--branch', branch, '--single-branch');
    }
    cloneArgs.push(repoUrl, srcDir);
    await runCommandStreaming('git', cloneArgs, {
      cwd: buildRoot,
      timeoutMs: 120_000,
      onLog,
    });
  } catch (err) {
    if (branch) {
      // Retry without --branch in case branch detection differed from default
      await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {});
      await runCommandStreaming('git', ['clone', '--depth', '1', repoUrl, srcDir], {
        cwd: buildRoot,
        timeoutMs: 120_000,
        onLog,
      });
    } else {
      throw err;
    }
  }

  let workDir = srcDir;
  if (analysis.subdir) {
    const candidate = path.resolve(srcDir, analysis.subdir);
    const normSrc = path.resolve(srcDir);
    if (candidate.startsWith(normSrc + path.sep) && fs.existsSync(candidate)) {
      workDir = candidate;
    }
  }

  const pkg = await readJsonSafe(path.join(workDir, 'package.json'));
  const hasIndexHtml = fs.existsSync(path.join(workDir, 'index.html'));
  const hasRequirements = fs.existsSync(path.join(workDir, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workDir, 'pyproject.toml'));

  // Write user-provided .env values before build (so build-time env vars work)
  const envContent = formatEnvFile(envVars);
  if (envContent) {
    await fsp.writeFile(path.join(workDir, '.env'), envContent, 'utf8');
  }

  const strategy = analysis.packagingStrategy || (
    hasIndexHtml && !pkg?.scripts?.build
      ? 'static-bundle'
      : hasRequirements || hasPyproject
        ? 'python-portable'
        : pkg
          ? (detectFrontendBuildApp(pkg, analysis) ? 'static-bundle' : 'node-portable')
          : 'static-bundle'
  );

  emitProgress('clone', 18, `Repository cloned. Preparing ${strategy} pipeline.`);

  // --- CASE 0: Raw React Component Repository (Auto-Harness) ---
  if (strategy === 'react-component') {
    const harnessResult = await buildReactComponentHarness({
      workDir,
      buildRoot,
      appDestDir,
      analysis,
      dataDir,
      localizeHtmlFn: localizeBuiltHtmlAssets,
      onStageProgress,
      onLog,
    });
    if (envContent) {
      await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
    }
    return harnessResult;
  }

  // --- CASE A: Frontend Build App (Vite / React / Vue / Svelte / CRA / Parcel / Astro) ---
  if (
    (strategy === 'static-bundle' || strategy === 'single-html') &&
    detectFrontendBuildApp(pkg, analysis)
  ) {
    let buildError = null;
    let compiledDir = null;

    try {
      emitProgress('install', 22, 'Installing frontend dependencies with npm...');
      await runCommandStreaming(
        'npm',
        ['install', '--no-audit', '--no-fund', '--prefer-offline'],
        { cwd: workDir, timeoutMs: DEFAULT_TIMEOUT_MS, onLog },
      );
      emitProgress('install', 38, 'Dependencies installed.');

      emitProgress('build', 42, 'Compiling production web bundle...');
      const buildEnv = { CI: 'false', NODE_ENV: 'production', PUBLIC_URL: '.' };
      if (isSimpleViteBuildScript(pkg)) {
        try {
          await runCommandStreaming('npm', ['run', 'build', '--', '--base=./'], {
            cwd: workDir,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            env: buildEnv,
            onLog,
          });
        } catch {
          // Fallback to unmodified build script if wrapper rejects --base
          await runCommandStreaming('npm', ['run', 'build'], {
            cwd: workDir,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            env: buildEnv,
            onLog,
          });
        }
      } else {
        await runCommandStreaming('npm', ['run', 'build'], {
          cwd: workDir,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          env: buildEnv,
          onLog,
        });
      }

      compiledDir = findCompiledOutputDir(workDir, analysis.detectedFiles?.outputDir);
    } catch (err) {
      buildError = err;
    }

    // Automatic fallback to React Component Auto-Harness when a library build emits no index.html (or fails)
    if (!compiledDir && (await hasReactComponentFiles(workDir))) {
      if (typeof onLog === 'function') {
        onLog(
          buildError
            ? `Standard build did not produce an app (${buildError.message.split('\n')[0]}). Switching to React Component Auto-Harness...`
            : 'Build emitted library modules without index.html. Wrapping in React Component Auto-Harness...',
          'stdout',
        );
      }
      const harnessResult = await buildReactComponentHarness({
        workDir,
        buildRoot,
        appDestDir,
        analysis,
        dataDir,
        localizeHtmlFn: localizeBuiltHtmlAssets,
        onStageProgress,
        onLog,
      });
      if (envContent) {
        await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
      }
      return harnessResult;
    }

    if (buildError) {
      throw buildError;
    }
    if (!compiledDir) {
      throw new Error('Build succeeded, but no compiled index.html output directory (dist/, build/, out/) was found.');
    }

    await copyFilteredDir(compiledDir, appDestDir, { excludeTestDirs: false });
    const localizedCount = await localizeBuiltHtmlAssets(appDestDir);
    if (localizedCount > 0 && typeof onLog === 'function') {
      onLog(`Localized ${localizedCount} absolute asset reference(s) in index.html for offline execution.`, 'stdout');
    }
    if (envContent) {
      await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
    }

    emitProgress('build', 54, `Compiled assets copied from ${path.basename(compiledDir)}/.`);

    return {
      appMode: 'static',
      runtimeNeeded: 'node',
      appDir: appDestDir,
      previewDir: appDestDir,
      previewType: 'static',
      previewEntry: 'index.html',
      defaultPort: 4173,
      isWeb: true,
      runConfig: { mode: 'static', entryPoint: 'index.html', defaultPort: 4173 },
    };
  }

  // --- CASE B: Pure Static / HTML5 Game or App ---
  if (strategy === 'static-bundle' || strategy === 'single-html' || (hasIndexHtml && strategy !== 'node-portable' && strategy !== 'python-portable')) {
    emitProgress('install', 32, 'Pure web app detected — zero npm dependencies required.');
    emitProgress('build', 44, 'Staging clean HTML/CSS/JS application files...');

    // Check if index.html is in root or a common subfolder like public/ or docs/
    let staticSource = workDir;
    if (!hasIndexHtml) {
      for (const sub of ['public', 'dist', 'build', 'docs', 'web', 'src']) {
        if (fs.existsSync(path.join(workDir, sub, 'index.html'))) {
          staticSource = path.join(workDir, sub);
          break;
        }
      }
    }

    await copyFilteredDir(staticSource, appDestDir, { excludeTestDirs: true });
    if (envContent) {
      await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
    }

    emitProgress('build', 54, 'Application assets staged and optimized.');

    return {
      appMode: 'static',
      runtimeNeeded: 'node',
      appDir: appDestDir,
      previewDir: appDestDir,
      previewType: fs.existsSync(path.join(appDestDir, 'index.html')) ? 'static' : null,
      previewEntry: 'index.html',
      defaultPort: 4173,
      isWeb: true,
      runConfig: { mode: 'static', entryPoint: 'index.html', defaultPort: 4173 },
    };
  }

  // --- CASE C: Node.js Server / Full-Stack / CLI App ---
  if (strategy === 'node-portable') {
    if (pkg) {
      emitProgress('install', 22, 'Installing Node.js dependencies...');
      await runCommandStreaming(
        'npm',
        ['install', '--no-audit', '--no-fund', '--prefer-offline'],
        { cwd: workDir, timeoutMs: DEFAULT_TIMEOUT_MS, onLog },
      );
      emitProgress('install', 38, 'Node.js dependencies installed.');

      if (pkg.scripts?.build) {
        emitProgress('build', 42, 'Running project build script...');
        await runCommandStreaming('npm', ['run', 'build'], {
          cwd: workDir,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          env: { CI: 'false' },
          onLog,
        });
      } else {
        emitProgress('build', 45, 'No compile step required — preparing runnable Node.js app...');
      }
    } else {
      emitProgress('install', 35, 'No package.json dependencies required.');
      emitProgress('build', 45, 'Staging Node.js application...');
    }

    // Copy runnable app including node_modules
    const nodeExclude = new Set(['.git', '.github', '.gitlab', '.vscode', '.idea', '.DS_Store', 'Thumbs.db', '.gitnoob']);
    await copyFilteredDir(workDir, appDestDir, { excludeNames: nodeExclude, excludeTestDirs: true });
    if (envContent) {
      await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
    }

    const startInfo = detectNodeStartInfo(appDestDir, pkg, analysis);
    emitProgress('build', 54, `Node.js app staged (entry: ${startInfo.entryPoint}).`);

    return {
      appMode: 'node',
      runtimeNeeded: 'node',
      appDir: appDestDir,
      previewDir: appDestDir,
      previewType: startInfo.isWeb ? 'node' : null,
      previewEntry: startInfo.entryPoint,
      defaultPort: startInfo.defaultPort,
      isWeb: startInfo.isWeb,
      runConfig: {
        mode: 'node',
        startScript: startInfo.startScript,
        entryPoint: startInfo.entryPoint,
        isWeb: startInfo.isWeb,
        defaultPort: startInfo.defaultPort,
      },
    };
  }

function normalizePyPkgName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

function extractPkgNameFromSpec(spec) {
  const m = String(spec || '').trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? m[1] : '';
}

function extractFailedPythonPackages(errMessage) {
  const found = new Set();
  const text = String(errMessage || '');
  const patterns = [
    /Failed building wheel for\s+([A-Za-z0-9._-]+)/gi,
    /Building wheel for\s+([A-Za-z0-9._-]+)/gi,
    /No matching distribution found for\s+([A-Za-z0-9._-]+)/gi,
    /Could not find a version that satisfies the requirement\s+([A-Za-z0-9._-]+)/gi,
    /Failed to build installable wheels for some pyproject\.toml based projects\s*\(([^)]+)\)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      for (const part of m[1].split(/[,\s]+/)) {
        const cleaned = part.trim().replace(/[()'"`]/g, '');
        if (cleaned) found.add(normalizePyPkgName(cleaned));
      }
    }
  }
  return found;
}

function parseRequirementsSpecs(reqFilePath) {
  const raw = fs.readFileSync(reqFilePath, 'utf8');
  const specs = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+#.*$/, '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    specs.push(trimmed);
  }
  return specs;
}

async function hasInstalledPyPackages(pylibsDir) {
  const entries = await fsp.readdir(pylibsDir).catch(() => []);
  return entries.some((name) => !name.startsWith('.') && name !== 'bin');
}

  // --- CASE D: Python Application (Flask, FastAPI, Streamlit, Gradio, Pygame, CLI) ---
  if (strategy === 'python-portable') {
    const pyInfo = await detectPythonRunInfo(workDir, analysis);
    const pylibsDir = path.join(appDestDir, '.gitnoob-pylibs');

    emitProgress('install', 22, 'Copying Python application source...');
    await copyFilteredDir(workDir, appDestDir, { excludeTestDirs: true });
    if (envContent) {
      await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
    }

    const reqFilePath = path.join(workDir, 'requirements.txt');
    const reqSpecs = pyInfo.hasRequirements ? parseRequirementsSpecs(reqFilePath) : [];
    const needsPipInstall = reqSpecs.length > 0 || pyInfo.hasPyproject;

    if (needsPipInstall) {
      await fsp.mkdir(pylibsDir, { recursive: true });
      const hostOs = getHostTargetOs();
      const isCrossTarget = targetOs !== hostOs;

      emitProgress('install', 24, 'Preparing Portable Python 3.12 pip installer...');
      const { pythonBin } = await ensureHostPythonBinary(dataDir, (evt) => {
        if (evt?.message && typeof onLog === 'function') {
          onLog(evt.message, 'stdout');
        }
      });

      const pipBaseArgs = [
        '-m',
        'pip',
        'install',
        '--target',
        pylibsDir,
        '--prefer-binary',
        '--no-cache-dir',
        '--disable-pip-version-check',
      ];
      const crossPlatformFlags =
        isCrossTarget && PIP_PLATFORM_MAP[targetOs]
          ? ['--platform', PIP_PLATFORM_MAP[targetOs], '--python-version', '3.12', '--only-binary=:all:']
          : [];
      const pipEnv = {
        PYTHONNOUSERSITE: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      };

      const fullPipArgs = [
        ...pipBaseArgs,
        ...crossPlatformFlags,
        ...(pyInfo.hasRequirements ? ['-r', reqFilePath] : [workDir]),
      ];

      emitProgress(
        'install',
        28,
        `Installing Python 3.12 packages into portable bundle${isCrossTarget ? ` (${targetOs} wheels)` : ''}...`,
      );

      let bulkSucceeded = false;
      let lastBulkErr = null;
      try {
        await runCommandStreaming(pythonBin, fullPipArgs, {
          cwd: workDir,
          env: pipEnv,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          onLog,
        });
        bulkSucceeded = true;
      } catch (bulkErr) {
        lastBulkErr = bulkErr;
      }

      // Tier 2: Coherent bulk retry — relax exact pins (or drop) for packages that failed to build wheels
      // so pip resolves ALL remaining requirements together with mutually compatible versions!
      if (!bulkSucceeded && reqSpecs.length > 0) {
        let workingSpecs = [...reqSpecs];
        const relaxedOnce = new Set();

        for (let attempt = 1; attempt <= 3 && !bulkSucceeded; attempt += 1) {
          const failedPkgs = extractFailedPythonPackages(lastBulkErr?.message || '');
          if (failedPkgs.size === 0) break;

          let changed = false;
          const nextSpecs = [];
          for (const spec of workingSpecs) {
            const rawName = extractPkgNameFromSpec(spec);
            const normName = normalizePyPkgName(rawName);
            if (normName && failedPkgs.has(normName)) {
              changed = true;
              if (!relaxedOnce.has(normName) && /[=<>~!]/.test(spec)) {
                relaxedOnce.add(normName);
                nextSpecs.push(rawName); // Relax pin so pip picks a prebuilt Python 3.12 wheel
                if (typeof onLog === 'function') {
                  onLog(`Relaxing pin "${spec}" -> "${rawName}" to use prebuilt Python 3.12 wheel...`, 'stdout');
                }
              } else if (typeof onLog === 'function') {
                onLog(`Skipping incompatible/optional package "${spec}" for coherent install.`, 'stderr');
              }
            } else {
              nextSpecs.push(spec);
            }
          }

          if (!changed || nextSpecs.length === 0) break;
          workingSpecs = nextSpecs;

          const tempReqPath = path.join(buildRoot, `requirements.gitnoob.${attempt}.txt`);
          await fsp.writeFile(tempReqPath, `${workingSpecs.join('\n')}\n`, 'utf8');
          await fsp.rm(pylibsDir, { recursive: true, force: true }).catch(() => {});
          await fsp.mkdir(pylibsDir, { recursive: true });

          try {
            await runCommandStreaming(
              pythonBin,
              [...pipBaseArgs, ...crossPlatformFlags, '-r', tempReqPath],
              { cwd: workDir, env: pipEnv, timeoutMs: DEFAULT_TIMEOUT_MS, onLog },
            );
            bulkSucceeded = true;
          } catch (retryErr) {
            lastBulkErr = retryErr;
          } finally {
            await fsp.rm(tempReqPath, { force: true }).catch(() => {});
          }
        }
      }

      // Tier 3: Last-resort line-by-line fallback (without --upgrade so pinned versions stay consistent)
      if (!bulkSucceeded && reqSpecs.length > 0) {
        if (typeof onLog === 'function') {
          onLog(
            `Coherent bulk pip install failed (${lastBulkErr?.message?.split('\n')[0] || 'unknown error'}). Falling back to package-by-package install...`,
            'stderr',
          );
        }
        let installedCount = 0;
        const skippedSpecs = [];
        for (const spec of reqSpecs) {
          try {
            await runCommandStreaming(
              pythonBin,
              [...pipBaseArgs, ...crossPlatformFlags, spec],
              { cwd: workDir, env: pipEnv, timeoutMs: 90_000, onLog },
            );
            installedCount += 1;
          } catch (lineErr) {
            if (crossPlatformFlags.length > 0) {
              try {
                await runCommandStreaming(
                  pythonBin,
                  [...pipBaseArgs, spec],
                  { cwd: workDir, env: pipEnv, timeoutMs: 90_000, onLog },
                );
                installedCount += 1;
                continue;
              } catch {
                // fall through
              }
            }
            skippedSpecs.push(spec);
            if (typeof onLog === 'function') {
              onLog(`Skipped incompatible/optional Python package "${spec}": ${lineErr.message.split('\n')[0]}`, 'stderr');
            }
          }
        }
        if (typeof onLog === 'function') {
          onLog(
            `Installed ${installedCount}/${reqSpecs.length} Python packages${skippedSpecs.length > 0 ? ` (skipped: ${skippedSpecs.join(', ')})` : ''}.`,
            'stdout',
          );
        }
      } else if (!bulkSucceeded && pyInfo.hasPyproject) {
        if (crossPlatformFlags.length > 0) {
          await runCommandStreaming(pythonBin, [...pipBaseArgs, workDir], {
            cwd: workDir,
            env: pipEnv,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            onLog,
          });
        } else {
          throw new Error('Failed to install Python dependencies from pyproject.toml.');
        }
      }

      // NEVER silently ship an empty .gitnoob-pylibs/ when requirements were declared
      if (!(await hasInstalledPyPackages(pylibsDir))) {
        throw new Error(
          'Python dependency installation produced an empty .gitnoob-pylibs/ directory. Check build logs for package errors.',
        );
      }

      emitProgress('install', 38, 'Python 3.12 dependencies bundled into .gitnoob-pylibs/.');
    } else {
      emitProgress('install', 36, 'No external Python packages required (standard library only).');
    }

    emitProgress('build', 54, `Python app staged (${pyInfo.runner}: ${pyInfo.entryPoint}).`);

    return {
      appMode: 'python',
      runtimeNeeded: 'python',
      appDir: appDestDir,
      previewDir: appDestDir,
      previewType: pyInfo.isWeb ? 'python' : null,
      previewEntry: pyInfo.entryPoint,
      defaultPort: pyInfo.defaultPort,
      isWeb: pyInfo.isWeb,
      runConfig: {
        mode: 'python',
        runner: pyInfo.runner,
        entryPoint: pyInfo.entryPoint,
        isWeb: pyInfo.isWeb,
        defaultPort: pyInfo.defaultPort,
      },
    };
  }

  // --- FALLBACK: Check for React components before copying raw repo ---
  if (!hasIndexHtml && (await hasReactComponentFiles(workDir))) {
    const harnessResult = await buildReactComponentHarness({
      workDir,
      buildRoot,
      appDestDir,
      analysis,
      dataDir,
      localizeHtmlFn: localizeBuiltHtmlAssets,
      onStageProgress,
      onLog,
    });
    if (envContent) {
      await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
    }
    return harnessResult;
  }

  // --- FALLBACK: Copy repo cleanly ---
  emitProgress('install', 35, 'No build dependencies required.');
  emitProgress('build', 50, 'Staging repository files...');
  await copyFilteredDir(workDir, appDestDir, { excludeTestDirs: true });
  if (envContent) {
    await fsp.writeFile(path.join(appDestDir, '.env'), envContent, 'utf8');
  }

  return {
    appMode: hasIndexHtml ? 'static' : 'generic',
    runtimeNeeded: 'node',
    appDir: appDestDir,
    previewDir: hasIndexHtml ? appDestDir : null,
    previewType: hasIndexHtml ? 'static' : null,
    previewEntry: hasIndexHtml ? 'index.html' : null,
    defaultPort: 4173,
    isWeb: hasIndexHtml,
    runConfig: { mode: hasIndexHtml ? 'static' : 'generic', entryPoint: 'index.html', defaultPort: 4173 },
  };
}
