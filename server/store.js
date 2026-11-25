import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_ANALYSIS_TTL_MS = 15 * 60 * 1000;

export class CatalogStore {
  constructor(dataDir) {
    const resolvedDir = path.resolve(
      dataDir || process.env.DATA_DIR || path.resolve(process.cwd(), 'data')
    );
    this.dataDir = resolvedDir;
    this.catalogPath = path.join(resolvedDir, 'catalog.json');
    this.buildsDir = path.join(resolvedDir, 'builds');
    this.packagesDir = path.join(resolvedDir, 'packages');
    this.runtimeCacheDir = path.join(resolvedDir, 'runtime-cache');
    this.state = {
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      jobs: {},
      analyses: {},
    };
    this._init();
  }

  _init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.buildsDir, { recursive: true });
    fs.mkdirSync(this.packagesDir, { recursive: true });
    fs.mkdirSync(this.runtimeCacheDir, { recursive: true });

    if (fs.existsSync(this.catalogPath)) {
      try {
        const raw = fs.readFileSync(this.catalogPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.state = {
            version: STORE_VERSION,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            jobs: parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {},
            analyses:
              parsed.analyses && typeof parsed.analyses === 'object' ? parsed.analyses : {},
          };
        }
      } catch (err) {
        const backupPath = `${this.catalogPath}.corrupt.${Date.now()}`;
        try {
          fs.renameSync(this.catalogPath, backupPath);
        } catch {
          // ignore backup failure
        }
        console.warn(`[store] Reset corrupted catalog.json (${err.message})`);
      }
    }

    let reconciled = 0;
    const now = new Date().toISOString();
    for (const job of Object.values(this.state.jobs)) {
      if (job && (job.status === 'running' || job.status === 'queued')) {
        job.status = 'failed';
        job.error =
          'Server restarted while this package was being built. Please package the repository again.';
        job.message = job.error;
        job.finishedAt = now;
        job.updatedAt = now;
        reconciled += 1;
      }
    }

    if (reconciled > 0 || !fs.existsSync(this.catalogPath)) {
      if (reconciled > 0) {
        console.log(`[store] Reconciled ${reconciled} stale job(s) to failed on startup.`);
      }
      this.persist();
    }
  }

  persist() {
    this.state.updatedAt = new Date().toISOString();
    const tmpPath = `${this.catalogPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const payload = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, this.catalogPath);
  }

  getJobs() {
    return Object.values(this.state.jobs).sort((a, b) => {
      const timeA = Date.parse(a?.createdAt || 0);
      const timeB = Date.parse(b?.createdAt || 0);
      return timeB - timeA;
    });
  }

  getJob(id) {
    return this.state.jobs[id] || null;
  }

  saveJob(job) {
    const now = new Date().toISOString();
    this.state.jobs[job.id] = {
      ...job,
      updatedAt: now,
    };
    this.persist();
    return this.state.jobs[job.id];
  }

  updateJob(id, patch, { persist = true } = {}) {
    const existing = this.state.jobs[id];
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.state.jobs[id] = updated;
    if (persist) {
      this.persist();
    }
    return updated;
  }

  deleteJob(id) {
    if (!this.state.jobs[id]) return false;
    delete this.state.jobs[id];
    this.persist();
    return true;
  }

  incrementDownloadCount(id) {
    const job = this.state.jobs[id];
    if (!job) return null;
    job.downloadCount = (Number(job.downloadCount) || 0) + 1;
    job.lastDownloadedAt = new Date().toISOString();
    job.updatedAt = job.lastDownloadedAt;
    this.persist();
    return job;
  }

  getCachedAnalysis(canonicalUrl, ttlMs = DEFAULT_ANALYSIS_TTL_MS) {
    if (!canonicalUrl) return null;
    const entry = this.state.analyses[canonicalUrl.toLowerCase()];
    if (!entry || !entry.analysis) return null;
    const age = Date.now() - Date.parse(entry.cachedAt || 0);
    if (age > ttlMs) return null;
    return entry.analysis;
  }

  saveAnalysis(canonicalUrl, analysis) {
    if (!canonicalUrl || !analysis) return;
    this.state.analyses[canonicalUrl.toLowerCase()] = {
      cachedAt: new Date().toISOString(),
      analysis,
    };
    // Keep cache bounded to 100 most recent entries
    const keys = Object.keys(this.state.analyses);
    if (keys.length > 100) {
      keys
        .sort(
          (a, b) =>
            Date.parse(this.state.analyses[a]?.cachedAt || 0) -
            Date.parse(this.state.analyses[b]?.cachedAt || 0)
        )
        .slice(0, keys.length - 100)
        .forEach((oldKey) => {
          delete this.state.analyses[oldKey];
        });
    }
    this.persist();
  }
}
