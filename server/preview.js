import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const REAPER_INTERVAL_MS = 60 * 1000;
const STARTUP_TIMEOUT_MS = 20 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.manifest': 'text/cache-manifest',
  '.webmanifest': 'application/manifest+json',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function waitForPort(port, child, getStderr, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let settled = false;

    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      const tail = getStderr().slice(-600).trim();
      reject(
        new Error(
          `Preview server exited before becoming ready (code=${code}, signal=${signal})${
            tail ? `: ${tail}` : ''
          }`
        )
      );
    };

    child.once('exit', onExit);

    const probe = () => {
      if (settled) return;
      if (Date.now() - start > timeoutMs) {
        settled = true;
        child.removeListener('exit', onExit);
        reject(new Error('Preview server timed out while starting up.'));
        return;
      }

      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        if (!settled) {
          settled = true;
          child.removeListener('exit', onExit);
          resolve();
        }
      });
      socket.once('error', () => {
        socket.destroy();
        if (!settled) {
          setTimeout(probe, 200);
        }
      });
    };

    probe();
  });
}

function rewriteHtmlForPreview(html, basePrefix) {
  let out = html;
  const normalizedBase = basePrefix.endsWith('/') ? basePrefix : `${basePrefix}/`;

  // Inject <base href="..."> if not already present so relative assets always resolve under /preview/<id>/
  if (!/<base\s+[^>]*href=/i.test(out)) {
    if (/<head(\s[^>]*)?>/i.test(out)) {
      out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n<base href="${normalizedBase}">`);
    } else if (/<html(\s[^>]*)?>/i.test(out)) {
      out = out.replace(/<html(\s[^>]*)?>/i, (m) => `${m}\n<head><base href="${normalizedBase}"></head>`);
    } else {
      out = `<base href="${normalizedBase}">\n${out}`;
    }
  }

  // Rewrite root-relative src="/..." and href="/..." (skipping protocol-relative "//..." and already-prefixed)
  const escapedPrefix = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rootAttrRe = new RegExp(
    `(\\b(?:src|href|action|poster)=["'])\\/(?!\\/|${escapedPrefix.slice(1)})`,
    'gi'
  );
  out = out.replace(rootAttrRe, `$1${normalizedBase}`);

  return out;
}

function findBundledExecutable(previewDir, candidates) {
  // Search previewDir and up to 2 ancestor levels (e.g., staged bundle root has .gitnoob/runtime/...)
  const roots = [previewDir, path.dirname(previewDir), path.dirname(path.dirname(previewDir))];
  for (const root of roots) {
    if (!root) continue;
    for (const rel of candidates) {
      const full = path.join(root, rel);
      if (fs.existsSync(full)) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          // exists but not executable on this host OS
        }
      }
    }
  }
  return null;
}

function resolveDynamicLaunchSpec(job, port) {
  const result = job.result || {};
  const previewDir = result.previewDir;
  const previewType = result.previewType;
  const previewEntry = result.previewEntry;
  const bundleRoot = path.dirname(previewDir);

  const baseEnv = {
    ...process.env,
    ...(job.envVars && typeof job.envVars === 'object' ? job.envVars : {}),
    PORT: String(port),
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    GITNOOB_NO_OPEN: '1',
    GITNOOB_PREVIEW: '1',
    BROWSER: 'none',
    NODE_ENV: process.env.NODE_ENV || 'production',
  };

  if (previewType === 'node') {
    // Only use bundled node if it's executable on this host OS, else host process.execPath
    const nodeBin =
      findBundledExecutable(previewDir, [
        '.gitnoob/runtime/node/bin/node',
        '.gitnoob/runtime/node/node',
      ]) || process.execPath;

    // 1. Explicit previewEntry object or script
    if (previewEntry && typeof previewEntry === 'object' && previewEntry.command) {
      return {
        command: previewEntry.command === 'node' ? nodeBin : previewEntry.command,
        args: Array.isArray(previewEntry.args) ? previewEntry.args : [],
        cwd: previewEntry.cwd || previewDir,
        env: { ...baseEnv, ...(previewEntry.env || {}) },
      };
    }

    const runAppScript = path.join(bundleRoot, '.gitnoob', 'run-app.mjs');
    if (fs.existsSync(runAppScript)) {
      return {
        command: nodeBin,
        args: [runAppScript],
        cwd: bundleRoot,
        env: baseEnv,
      };
    }

    if (typeof previewEntry === 'string' && previewEntry.trim()) {
      const resolvedEntry = path.isAbsolute(previewEntry)
        ? previewEntry
        : path.join(previewDir, previewEntry);
      if (fs.existsSync(resolvedEntry)) {
        return {
          command: nodeBin,
          args: [resolvedEntry],
          cwd: previewDir,
          env: baseEnv,
        };
      }
    }

    // Fallback to package.json main/start
    const pkgPath = path.join(previewDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.start) {
          return {
            command: 'npm',
            args: ['run', 'start'],
            cwd: previewDir,
            env: baseEnv,
          };
        }
        if (pkg.main) {
          return {
            command: nodeBin,
            args: [path.join(previewDir, pkg.main)],
            cwd: previewDir,
            env: baseEnv,
          };
        }
      } catch {
        // ignore invalid package.json
      }
    }

    for (const candidate of ['server.js', 'index.js', 'app.js', 'src/index.js']) {
      const full = path.join(previewDir, candidate);
      if (fs.existsSync(full)) {
        return {
          command: nodeBin,
          args: [full],
          cwd: previewDir,
          env: baseEnv,
        };
      }
    }

    throw new Error('Could not locate a runnable Node.js entry point for live preview.');
  }

  if (previewType === 'python') {
    const pyBin =
      findBundledExecutable(previewDir, [
        '.gitnoob/runtime/python/bin/python3',
        '.gitnoob/runtime/python/bin/python',
      ]) || 'python3';

    const pyLibsDir = path.join(previewDir, '.gitnoob-pylibs');
    const pythonPathParts = [];
    if (fs.existsSync(pyLibsDir)) pythonPathParts.push(pyLibsDir);
    if (process.env.PYTHONPATH) pythonPathParts.push(process.env.PYTHONPATH);

    const pyEnv = {
      ...baseEnv,
      FLASK_RUN_HOST: '127.0.0.1',
      FLASK_RUN_PORT: String(port),
      STREAMLIT_SERVER_ADDRESS: '127.0.0.1',
      STREAMLIT_SERVER_PORT: String(port),
      STREAMLIT_SERVER_HEADLESS: 'true',
      GRADIO_SERVER_NAME: '127.0.0.1',
      GRADIO_SERVER_PORT: String(port),
      PYTHONUNBUFFERED: '1',
      ...(pythonPathParts.length > 0 ? { PYTHONPATH: pythonPathParts.join(path.delimiter) } : {}),
    };

    if (previewEntry && typeof previewEntry === 'object' && previewEntry.command) {
      return {
        command: previewEntry.command === 'python3' ? pyBin : previewEntry.command,
        args: Array.isArray(previewEntry.args) ? previewEntry.args : [],
        cwd: previewEntry.cwd || previewDir,
        env: { ...pyEnv, ...(previewEntry.env || {}) },
      };
    }

    if (typeof previewEntry === 'string' && previewEntry.trim()) {
      const resolvedEntry = path.isAbsolute(previewEntry)
        ? previewEntry
        : path.join(previewDir, previewEntry);
      if (fs.existsSync(resolvedEntry)) {
        return {
          command: pyBin,
          args: [resolvedEntry],
          cwd: previewDir,
          env: pyEnv,
        };
      }
    }

    for (const candidate of ['app.py', 'main.py', 'server.py', 'run.py']) {
      const full = path.join(previewDir, candidate);
      if (fs.existsSync(full)) {
        return {
          command: pyBin,
          args: [full],
          cwd: previewDir,
          env: pyEnv,
        };
      }
    }

    throw new Error('Could not locate a runnable Python entry point for live preview.');
  }

  throw new Error(`Unsupported preview type "${previewType}".`);
}

function killProcessTree(child) {
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
      // already dead
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
  }, 3000).unref();
}

export class PreviewManager {
  constructor({ store }) {
    this.store = store;
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    this._reaper = setInterval(() => this._reapIdle(), REAPER_INTERVAL_MS);
    this._reaper.unref();
  }

  async startPreview(job) {
    if (!job || job.status !== 'completed') {
      const err = new Error('Live preview is only available after packaging completes.');
      err.statusCode = 400;
      throw err;
    }

    const result = job.result || {};
    const existing = this.sessions.get(job.id);
    if (existing) {
      if (existing.type === 'static' || (existing.child && existing.child.exitCode === null)) {
        existing.lastAccessedAt = Date.now();
        return {
          previewUrl: `/preview/${job.id}/`,
          previewType: existing.type,
        };
      }
      this.sessions.delete(job.id);
    }

    const hasPreviewDir = Boolean(result.previewDir && fs.existsSync(result.previewDir));
    const hasSingleHtml = Boolean(result.singleHtmlPath && fs.existsSync(result.singleHtmlPath));

    if (!hasPreviewDir && !hasSingleHtml) {
      const err = new Error('This package does not include a live previewable app.');
      err.statusCode = 400;
      throw err;
    }

    const previewType = result.previewType || 'static';

    // Static directory or single-file HTML fallback
    if (previewType === 'static' || !hasPreviewDir) {
      this.sessions.set(job.id, {
        jobId: job.id,
        type: 'static',
        dir: hasPreviewDir ? path.resolve(result.previewDir) : null,
        singleHtmlPath: hasSingleHtml ? path.resolve(result.singleHtmlPath) : null,
        startedAt: Date.now(),
        lastAccessedAt: Date.now(),
      });
      return {
        previewUrl: `/preview/${job.id}/`,
        previewType: 'static',
      };
    }

    // Dynamic Node.js or Python preview sandbox
    if (previewType === 'node' || previewType === 'python') {
      const port = await getFreePort();
      const spec = resolveDynamicLaunchSpec(job, port);

      let stderrBuf = '';
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000);
      });
      child.stdout?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000);
      });

      try {
        await waitForPort(port, child, () => stderrBuf, STARTUP_TIMEOUT_MS);
      } catch (err) {
        killProcessTree(child);
        err.statusCode = 502;
        throw err;
      }

      const session = {
        jobId: job.id,
        type: previewType,
        port,
        child,
        startedAt: Date.now(),
        lastAccessedAt: Date.now(),
      };

      child.once('exit', () => {
        if (this.sessions.get(job.id) === session) {
          this.sessions.delete(job.id);
        }
      });

      this.sessions.set(job.id, session);
      return {
        previewUrl: `/preview/${job.id}/`,
        previewType,
      };
    }

    const err = new Error(`Unsupported preview type "${previewType}".`);
    err.statusCode = 400;
    throw err;
  }

  async stopPreview(jobId) {
    const session = this.sessions.get(jobId);
    if (!session) return false;
    this.sessions.delete(jobId);
    if (session.child) {
      killProcessTree(session.child);
    }
    return true;
  }

  stopAll() {
    clearInterval(this._reaper);
    for (const [jobId, session] of this.sessions.entries()) {
      if (session.child) {
        killProcessTree(session.child);
      }
      this.sessions.delete(jobId);
    }
  }

  _reapIdle() {
    const now = Date.now();
    for (const [jobId, session] of this.sessions.entries()) {
      if (session.child && now - session.lastAccessedAt > IDLE_TIMEOUT_MS) {
        console.log(`[preview] Reaping idle ${session.type} preview for job ${jobId}`);
        killProcessTree(session.child);
        this.sessions.delete(jobId);
      }
    }
  }

  /**
   * Express middleware mounted at `/preview/:id`.
   */
  handleRequest = async (req, res) => {
    const jobId = req.params.id;
    let session = this.sessions.get(jobId);

    // Auto-start static preview seamlessly if the user opens /preview/:id/ directly (e.g. "Open in New Tab")
    if (!session) {
      const job = this.store.getJob(jobId);
      if (job && job.status === 'completed' && (job.result?.previewDir || job.result?.singleHtmlPath)) {
        try {
          await this.startPreview(job);
          session = this.sessions.get(jobId);
        } catch (err) {
          res.status(err.statusCode || 502).send(`Preview could not be started: ${err.message}`);
          return;
        }
      }
    }

    if (!session) {
      res.status(404).send('Preview session is not active for this package.');
      return;
    }

    session.lastAccessedAt = Date.now();

    // Ensure trailing slash on bare `/preview/:id` so relative asset paths work cleanly
    const origPathOnly = req.originalUrl.split('?')[0];
    if (origPathOnly === `/preview/${jobId}`) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      res.redirect(302, `/preview/${jobId}/${qs}`);
      return;
    }

    // Remove frame-blocking headers so iframe embedding inside GitNoob always works
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Cache-Control', 'no-cache');

    if (session.type === 'static') {
      this._serveStatic(session, req, res);
      return;
    }

    this._proxyDynamic(session, req, res);
  };

  _serveStatic(session, req, res) {
    const basePrefix = `/preview/${session.jobId}/`;

    // Single-HTML only preview
    if (!session.dir && session.singleHtmlPath) {
      try {
        const html = fs.readFileSync(session.singleHtmlPath, 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (err) {
        res.status(500).send(`Failed to read preview artifact: ${err.message}`);
      }
      return;
    }

    let subPath = '/';
    try {
      subPath = decodeURIComponent(req.path || '/');
    } catch {
      res.status(400).send('Malformed preview path.');
      return;
    }

    const safeRel = subPath.replace(/^\/+/, '');
    let candidate = path.resolve(session.dir, safeRel);

    // Prevent path traversal outside previewDir
    if (candidate !== session.dir && !candidate.startsWith(session.dir + path.sep)) {
      res.status(403).send('Forbidden preview path.');
      return;
    }

    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        const indexInDir = path.join(candidate, 'index.html');
        if (fs.existsSync(indexInDir)) {
          candidate = indexInDir;
        }
      }

      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        // SPA fallback for extensionless HTML navigation routes
        const ext = path.extname(candidate);
        const rootIndex = path.join(session.dir, 'index.html');
        if (!ext && fs.existsSync(rootIndex)) {
          candidate = rootIndex;
        } else {
          res.status(404).send('Asset not found in preview bundle.');
          return;
        }
      }

      const mime = getMimeType(candidate);
      res.setHeader('Content-Type', mime);

      if (mime.startsWith('text/html')) {
        const rawHtml = fs.readFileSync(candidate, 'utf8');
        const rewritten = rewriteHtmlForPreview(rawHtml, basePrefix);
        res.send(rewritten);
        return;
      }

      const stream = fs.createReadStream(candidate);
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end('Error reading preview file.');
      });
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).send(`Preview error: ${err.message}`);
      }
    }
  }

  _proxyDynamic(session, req, res) {
    const basePrefix = `/preview/${session.jobId}`;
    const targetPath = req.url && req.url.startsWith('/') ? req.url : `/${req.url || ''}`;

    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${session.port}`;
    delete headers['accept-encoding']; // keep uncompressed so redirects/headers stay clean

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: session.port,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const respHeaders = { ...proxyRes.headers };
        delete respHeaders['x-frame-options'];
        delete respHeaders['content-security-policy'];

        // Keep root-relative redirects inside `/preview/:id`
        if (typeof respHeaders.location === 'string' && respHeaders.location.startsWith('/')) {
          if (!respHeaders.location.startsWith(basePrefix)) {
            respHeaders.location = `${basePrefix}${respHeaders.location}`;
          }
        }

        res.writeHead(proxyRes.statusCode || 200, respHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).send(`Preview proxy error: ${err.message}`);
      }
    });

    req.pipe(proxyReq);
  }
}
