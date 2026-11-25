import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';

const execFileAsync = promisify(execFile);

import {
  TARGET_OS_OPTIONS,
  PACKAGE_FORMATS,
  PIPELINE_STAGES,
  detectHostTargetOs,
} from '../shared/contracts.js';
import { CatalogStore } from './store.js';
import { JobManager, getAnalyzerModule, getPackagerModule } from './jobs.js';
import { PreviewManager } from './preview.js';
import { getCuratedRepos } from './curated.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST_DIR = path.join(PROJECT_ROOT, 'client', 'dist');

function resolveDefaultDataDir() {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');
}

function detectPythonInfo() {
  for (const bin of ['python3', 'python']) {
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (out) {
        return { available: true, version: out.replace(/^Python\s+/i, ''), binary: bin };
      }
    } catch {
      // try next
    }
  }
  return { available: false, version: null, binary: null };
}

function sanitizeDownloadFilename(name, fallback) {
  const base = (name || fallback || 'gitnoob-package')
    .replace(/[\r\n"]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .trim();
  return base || fallback || 'gitnoob-package';
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocalhostRequest(req) {
  if (
    process.env.RENDER === 'true' ||
    process.env.RENDER_SERVICE_ID ||
    process.env.GITNOOB_DISABLE_LOCAL_SAVE === '1'
  ) {
    return false;
  }
  // Never allow local save when accessed through a reverse proxy
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) {
    return false;
  }
  const remote = req.socket?.remoteAddress || '';
  if (LOOPBACK_ADDRESSES.has(remote)) {
    return true;
  }
  return false;
}

function sanitizeLocalSlug(raw, fallback = 'gitnoob-app') {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    const fb = String(fallback || 'gitnoob-app').replace(/[^a-zA-Z0-9_-]+/g, '-');
    return fb || 'gitnoob-app';
  }
  return cleaned;
}

function sanitizeLocalHtmlFilename(raw, fallbackSlug) {
  const base = path.basename(String(raw || ''));
  let cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 100);
  if (!cleaned || cleaned === '.html') {
    cleaned = `${sanitizeLocalSlug(fallbackSlug)}-artifact.html`;
  }
  if (!cleaned.toLowerCase().endsWith('.html')) {
    cleaned = `${cleaned}.html`;
  }
  return cleaned;
}

function assertInsideRoot(rootDir, targetPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    const err = new Error('Invalid destination path outside ~/Downloads/GitNoob.');
    err.statusCode = 400;
    throw err;
  }
  return resolvedTarget;
}

function findLauncherInSavedDir(destDir, preferredLauncherName) {
  const entries = fs.existsSync(destDir) ? fs.readdirSync(destDir, { withFileTypes: true }) : [];

  // Prefer "Open *.app", then any "*.app"
  const openApp = entries.find(
    (e) => e.isDirectory() && e.name.startsWith('Open ') && e.name.endsWith('.app')
  );
  const anyApp = openApp || entries.find((e) => e.isDirectory() && e.name.endsWith('.app'));
  if (anyApp) {
    return {
      appPath: path.join(destDir, anyApp.name),
      launcherPath: path.join(destDir, anyApp.name),
      launcherName: anyApp.name,
    };
  }

  if (preferredLauncherName) {
    const pref = path.join(destDir, path.basename(preferredLauncherName));
    if (fs.existsSync(pref)) {
      return { appPath: null, launcherPath: pref, launcherName: path.basename(pref) };
    }
  }

  const fallbackCandidates = ['START_MAC.command', 'START_WINDOWS.bat', 'START_LINUX.sh'];
  for (const name of fallbackCandidates) {
    const candidate = path.join(destDir, name);
    if (fs.existsSync(candidate)) {
      return { appPath: null, launcherPath: candidate, launcherName: name };
    }
  }

  const vbs = entries.find((e) => e.isFile() && e.name.endsWith('.vbs'));
  if (vbs) {
    return {
      appPath: null,
      launcherPath: path.join(destDir, vbs.name),
      launcherName: vbs.name,
    };
  }

  return { appPath: null, launcherPath: destDir, launcherName: path.basename(destDir) };
}

function prepareMacAppBundle(destDir, appPath) {
  if (process.platform !== 'darwin') return;

  // Ensure START_MAC.command is executable if present
  const startCmd = path.join(destDir, 'START_MAC.command');
  if (fs.existsSync(startCmd)) {
    try {
      fs.chmodSync(startCmd, 0o755);
    } catch {
      // ignore chmod errors
    }
  }

  if (appPath && fs.existsSync(appPath)) {
    // Ensure Contents/MacOS/launch (and any executables inside Contents/MacOS) have +x
    const macOsBinDir = path.join(appPath, 'Contents', 'MacOS');
    if (fs.existsSync(macOsBinDir)) {
      try {
        for (const name of fs.readdirSync(macOsBinDir)) {
          const binPath = path.join(macOsBinDir, name);
          if (fs.statSync(binPath).isFile()) {
            fs.chmodSync(binPath, 0o755);
          }
        }
      } catch {
        // ignore chmod errors
      }
    }

    // Best-effort ad-hoc code-sign so Apple Silicon accepts the local bundle cleanly
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
        stdio: 'ignore',
        timeout: 20000,
      });
    } catch {
      // best-effort: codesign may be unavailable
    }
  }

  // Touch .app bundle and containing folder so macOS Finder immediately refreshes custom AppIcon.icns
  for (const target of [appPath, destDir]) {
    if (!target || !fs.existsSync(target)) continue;
    try {
      execFileSync('touch', [target], { stdio: 'ignore', timeout: 5000 });
    } catch {
      try {
        const now = new Date();
        fs.utimesSync(target, now, now);
      } catch {
        // ignore touch errors
      }
    }
  }
}

function buildFallbackEmblemSvg(appName = 'G') {
  const initial =
    String(appName || 'G')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 1)
      .toUpperCase() || 'G';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${initial}">
  <rect x="24" y="24" width="464" height="464" rx="112" fill="#0A0A0A"/>
  <rect x="34" y="34" width="444" height="444" rx="102" fill="none" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="4"/>
  <text x="256" y="316" text-anchor="middle" fill="#FFFFFF" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="220" font-weight="700">${initial}</text>
</svg>`;
}

function launchDetachedOpen(args) {
  if (process.platform !== 'darwin') return false;
  try {
    const child = spawn('open', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function createServerApp({ dataDir } = {}) {
  const resolvedDataDir = path.resolve(dataDir || resolveDefaultDataDir());
  fs.mkdirSync(resolvedDataDir, { recursive: true });

  const app = express();
  const store = new CatalogStore(resolvedDataDir);
  const previewManager = new PreviewManager({ store });
  const jobManager = new JobManager({ store, dataDir: resolvedDataDir, previewManager });
  const pythonInfo = detectPythonInfo();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  // Graceful JSON syntax error handler
  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON request payload.' });
      return;
    }
    next(err);
  });

  // 0. Lightweight liveness probe for Render / container healthchecks
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // 1. Health & Host Diagnostics
  app.get('/api/health', async (req, res) => {
    let runtimeCache = {
      cached: [],
      available: [],
      cacheDir: path.join(resolvedDataDir, 'runtime-cache'),
    };
    try {
      const packager = await getPackagerModule();
      if (typeof packager.getRuntimeCacheStatus === 'function') {
        runtimeCache = await packager.getRuntimeCacheStatus(resolvedDataDir);
      }
    } catch {
      // packager not ready yet or returned error; report empty cache cleanly
    }

    const localRequest = isLocalhostRequest(req);

    res.json({
      ok: true,
      hostOs: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      targetOs: detectHostTargetOs(),
      nodeVersion: process.version,
      pythonAvailable: pythonInfo.available,
      pythonVersion: pythonInfo.version,
      supportsLocalSave: localRequest,
      localSaveBaseDir: '~/Downloads/GitNoob',
      runtimeCache,
      contracts: {
        targetOsOptions: TARGET_OS_OPTIONS,
        packageFormats: PACKAGE_FORMATS,
        pipelineStages: PIPELINE_STAGES,
      },
    });
  });

  // 2. Curated Instant-Try Showcase
  app.get('/api/curated', (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    res.json({ repos: getCuratedRepos(category) });
  });

  // 3. Repository Analysis
  app.post('/api/analyze', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const forceRefresh = Boolean(req.body?.forceRefresh);

    if (!rawUrl) {
      res.status(400).json({
        error: 'Please paste a GitHub repository link (for example, https://github.com/gabrielecirulli/2048).',
      });
      return;
    }

    let analyzerMod;
    try {
      analyzerMod = await getAnalyzerModule();
    } catch (err) {
      res.status(503).json({
        error: `Repository analyzer is unavailable: ${err.message}`,
      });
      return;
    }

    let parsed;
    try {
      parsed = analyzerMod.parseGitHubUrl(rawUrl);
    } catch (err) {
      res.status(400).json({
        error:
          err?.message ||
          'That does not look like a valid GitHub repository URL. Try https://github.com/owner/repo.',
      });
      return;
    }

    const cacheKey = `${parsed.canonicalUrl}${parsed.branch ? `#${parsed.branch}` : ''}${
      parsed.subdir ? `:${parsed.subdir}` : ''
    }`;

    if (!forceRefresh) {
      const cached = store.getCachedAnalysis(cacheKey);
      if (cached) {
        res.json({ analysis: cached, cached: true });
        return;
      }
    }

    try {
      const analysis = await analyzerMod.analyzeRepository(rawUrl, { forceRefresh });
      store.saveAnalysis(cacheKey, analysis);
      res.json({ analysis, cached: false });
    } catch (err) {
      const msg = err?.message || 'Failed to inspect this GitHub repository.';
      const statusCode =
        err?.statusCode && Number.isInteger(err.statusCode)
          ? err.statusCode
          : /not found|404/i.test(msg)
            ? 404
            : /invalid|must be|github/i.test(msg)
              ? 400
              : 502;
      res.status(statusCode).json({ error: msg });
    }
  });

  // 4. Start Packaging Job
  app.post('/api/package', (req, res) => {
    try {
      const { url, analysis, targetOs, format, envVars, includeRuntime } = req.body || {};
      const job = jobManager.createAndStartJob({
        url,
        analysis,
        targetOs,
        format,
        envVars,
        includeRuntime,
      });
      res.status(202).json({ job });
    } catch (err) {
      const status = err?.statusCode || 400;
      res.status(status).json({
        error: err?.message || 'Could not start packaging job.',
      });
    }
  });

  // 5. List All Jobs (newest first)
  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: store.getJobs() });
  });

  // 6. Get Single Job
  app.get('/api/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" was not found.` });
      return;
    }
    res.json({ job });
  });

  // 7. Live SSE Stream for a Job
  app.get('/api/jobs/:id/events', (req, res) => {
    jobManager.attachSseClient(req.params.id, req, res);
  });

  // 7b. Bespoke Artifact Emblem SVG (persisted on result or synthesized dynamically for legacy jobs)
  app.get('/api/jobs/:id/emblem.svg', async (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      res.status(404).type('text/plain').send('Job not found.');
      return;
    }

    let svg = typeof job.result?.emblemSvg === 'string' && job.result.emblemSvg.trim()
      ? job.result.emblemSvg
      : null;

    if (!svg) {
      const appName = job.analysis?.name || job.analysis?.repo || job.id;
      try {
        const packager = await getPackagerModule();
        if (typeof packager.buildArtifactEmblemSvg === 'function') {
          svg = packager.buildArtifactEmblemSvg({
            appName,
            category: job.analysis?.category,
            framework: job.analysis?.framework,
            packagingStrategy: job.analysis?.packagingStrategy,
          });
        }
      } catch {
        // fall through to clean monochrome fallback emblem
      }
      if (!svg || typeof svg !== 'string') {
        svg = buildFallbackEmblemSvg(appName);
      }
    }

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  });

  // 8. Download Packaged Artifact (.zip or single-file .html)
  app.get('/api/jobs/:id/download', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" was not found.` });
      return;
    }
    if (job.status !== 'completed' || !job.result) {
      res.status(409).json({
        error: 'This package is not ready for download yet.',
      });
      return;
    }

    const requestedFormat =
      typeof req.query.format === 'string' ? req.query.format.trim().toLowerCase() : '';
    const wantsSingleHtml =
      requestedFormat === 'single-html' ||
      (!requestedFormat && job.format === 'single-html' && !job.result.zipPath);

    let filePath = null;
    let fileName = null;
    let contentType = 'application/octet-stream';

    if (wantsSingleHtml) {
      filePath = job.result.singleHtmlPath;
      fileName = sanitizeDownloadFilename(
        job.result.singleHtmlFileName,
        `${job.analysis?.repo || job.id}-artifact.html`
      );
      contentType = 'text/html; charset=utf-8';
    } else {
      filePath = job.result.zipPath;
      fileName = sanitizeDownloadFilename(
        job.result.zipFileName,
        `${job.analysis?.repo || job.id}-${job.targetOs}.zip`
      );
      contentType = 'application/zip';
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({
        error: wantsSingleHtml
          ? 'A single-file HTML artifact is not available for this package.'
          : 'The packaged archive file could not be found on disk.',
      });
      return;
    }

    const stat = fs.statSync(filePath);
    store.incrementDownloadCount(job.id);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error(`[download] Failed streaming ${filePath}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream download artifact.' });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  });

  // 8b. Direct Local Save (localhost-only, avoids macOS browser download quarantine)
  app.post('/api/jobs/:id/save-local', async (req, res) => {
    if (!isLocalhostRequest(req)) {
      res.status(403).json({
        error: 'Local save is only available when running GitNoob on your own computer.',
      });
      return;
    }

    const job = store.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" was not found.` });
      return;
    }
    if (job.status !== 'completed' || !job.result) {
      res.status(409).json({
        error: 'This package is not ready to save yet.',
      });
      return;
    }

    const { openInFinder = false, launchApp = false, format } = req.body || {};
    const localSaveRoot = path.resolve(path.join(os.homedir(), 'Downloads', 'GitNoob'));
    fs.mkdirSync(localSaveRoot, { recursive: true });

    const cleanName = sanitizeLocalSlug(job.analysis?.repo || job.analysis?.name || job.id, job.id);
    const wantsSingleHtml = format === 'single-html';

    try {
      if (wantsSingleHtml) {
        const srcHtml = job.result.singleHtmlPath;
        if (!srcHtml || !fs.existsSync(srcHtml)) {
          res.status(404).json({
            error: 'A single-file HTML artifact is not available for this package.',
          });
          return;
        }
        const safeFileName = sanitizeLocalHtmlFilename(
          job.result.singleHtmlFileName,
          cleanName
        );
        const destFile = assertInsideRoot(localSaveRoot, path.join(localSaveRoot, safeFileName));
        fs.copyFileSync(srcHtml, destFile);
        store.incrementDownloadCount(job.id);

        let launched = false;
        let openedInFinder = false;
        if (launchApp) {
          launched = launchDetachedOpen([destFile]);
        } else if (openInFinder) {
          openedInFinder = launchDetachedOpen(['-R', destFile]);
        }

        res.json({
          ok: true,
          savedPath: destFile,
          displayPath: `~/Downloads/GitNoob/${safeFileName}`,
          launcherPath: destFile,
          launcherName: safeFileName,
          openedInFinder,
          launched,
        });
        return;
      }

      // Full standalone app bundle: unpack directly via local unzip (no browser quarantine)
      const zipPath = job.result.zipPath;
      if (!zipPath || !fs.existsSync(zipPath)) {
        res.status(404).json({
          error: 'The packaged archive file could not be found on disk.',
        });
        return;
      }

      const destDir = assertInsideRoot(localSaveRoot, path.join(localSaveRoot, cleanName));
      const markerPath = path.join(destDir, '.gitnoob-saved-job');
      const alreadySavedSameJob =
        launchApp &&
        fs.existsSync(destDir) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf8').trim() === job.id;

      if (!alreadySavedSameJob) {
        const stageDir = assertInsideRoot(
          localSaveRoot,
          path.join(localSaveRoot, `.staging-${cleanName}-${Date.now()}-${process.pid}`)
        );
        fs.mkdirSync(stageDir, { recursive: true });

        try {
          await execFileAsync('unzip', ['-oq', zipPath, '-d', stageDir], {
            maxBuffer: 20 * 1024 * 1024,
          });

          // If zip extracted into a single top-level directory (standard GitNoob layout), promote it cleanly
          const topEntries = fs
            .readdirSync(stageDir, { withFileTypes: true })
            .filter((e) => e.name !== '__MACOSX' && e.name !== '.DS_Store');
          const sourceToMove =
            topEntries.length === 1 && topEntries[0].isDirectory()
              ? path.join(stageDir, topEntries[0].name)
              : stageDir;

          fs.rmSync(destDir, { recursive: true, force: true });
          fs.renameSync(sourceToMove, destDir);
          fs.writeFileSync(markerPath, `${job.id}\n`, 'utf8');
        } finally {
          fs.rmSync(stageDir, { recursive: true, force: true });
        }

        store.incrementDownloadCount(job.id);
      }

      const { appPath, launcherPath, launcherName } = findLauncherInSavedDir(
        destDir,
        job.result.launcherName
      );

      prepareMacAppBundle(destDir, appPath);

      let launched = false;
      let openedInFinder = false;
      if (launchApp) {
        launched = launchDetachedOpen([appPath || launcherPath || destDir]);
      } else if (openInFinder) {
        openedInFinder = launchDetachedOpen(['-R', appPath || launcherPath || destDir]);
      }

      res.json({
        ok: true,
        savedPath: destDir,
        displayPath: `~/Downloads/GitNoob/${cleanName}`,
        launcherPath,
        launcherName,
        openedInFinder,
        launched,
      });
    } catch (err) {
      res.status(err?.statusCode || 500).json({
        error: err?.message || 'Failed to save package locally.',
      });
    }
  });

  // 9. Start Live Preview Sandbox
  app.post('/api/jobs/:id/preview/start', async (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: `Job "${req.params.id}" was not found.` });
      return;
    }
    try {
      const info = await previewManager.startPreview(job);
      res.json(info);
    } catch (err) {
      res.status(err?.statusCode || 500).json({
        error: err?.message || 'Could not start live preview for this package.',
      });
    }
  });

  // 10. Stop Live Preview Sandbox
  app.post('/api/jobs/:id/preview/stop', async (req, res) => {
    await previewManager.stopPreview(req.params.id);
    res.json({ stopped: true });
  });

  // 11. Live Preview Route Handler (matches `/preview/:id`, `/preview/:id/`, and `/preview/:id/*`)
  app.use('/preview/:id', previewManager.handleRequest);

  // 12. Portable Runtime Cache Status
  app.get('/api/runtimes', async (_req, res) => {
    try {
      const packager = await getPackagerModule();
      const runtimes = await packager.getRuntimeCacheStatus(resolvedDataDir);
      res.json({ runtimes });
    } catch (err) {
      res.status(503).json({
        error: `Runtime manager is unavailable: ${err.message}`,
        runtimes: [],
      });
    }
  });

  // 13. Delete Job & Cleanup Artifacts
  app.delete('/api/jobs/:id', async (req, res) => {
    const deleted = await jobManager.deleteJob(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: `Job "${req.params.id}" was not found.` });
      return;
    }
    res.json({ deleted: true });
  });

  // 14. Static Frontend & SPA Fallback (when `client/dist/index.html` exists)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api' || req.path.startsWith('/preview/')) {
      next();
      return;
    }
    if (fs.existsSync(CLIENT_DIST_DIR)) {
      express.static(CLIENT_DIST_DIR)(req, res, next);
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    if (req.path.startsWith('/api/') || req.path === '/api' || req.path.startsWith('/preview/')) {
      res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
      return;
    }
    const indexHtmlPath = path.join(CLIENT_DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
      res.sendFile(indexHtmlPath);
      return;
    }
    res.status(200).type('text/plain').send(
      'GitNoob API server is running. Build the client with `npm run build:client` or run the Vite dev server in `client/`.'
    );
  });

  // Final Express error handler
  app.use((err, _req, res, _next) => {
    console.error('[server] Unhandled error:', err);
    if (res.headersSent) return;
    res.status(err?.statusCode || 500).json({
      error: err?.message || 'Internal server error.',
    });
  });

  return { app, store, jobManager, previewManager };
}

export function startServer({ port = Number(process.env.PORT) || 3456, dataDir } = {}) {
  const resolvedDataDir = path.resolve(dataDir || resolveDefaultDataDir());
  const { app, previewManager } = createServerApp({ dataDir: resolvedDataDir });
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[gitnoob] Server listening on http://0.0.0.0:${port}`);
    console.log(`[gitnoob] Host: ${process.platform}/${process.arch} · Node ${process.version}`);
    console.log(`[gitnoob] Data dir: ${resolvedDataDir}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[gitnoob] Received ${signal}, stopping preview sandboxes and closing server…`);
    previewManager.stopAll();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startServer();
}
