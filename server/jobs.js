import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  JOB_STATUSES,
  PIPELINE_STAGES,
  detectHostTargetOs,
  isValidPackageFormat,
  isValidTargetOs,
} from '../shared/contracts.js';

const MAX_BUFFERED_EVENTS = 500;
const MAX_PERSISTED_LOGS = 250;

let analyzerModPromise = null;
let packagerModPromise = null;

export async function getAnalyzerModule() {
  if (!analyzerModPromise) {
    analyzerModPromise = import('./analyzer/index.js').catch((err) => {
      analyzerModPromise = null;
      throw err;
    });
  }
  return analyzerModPromise;
}

export async function getPackagerModule() {
  if (!packagerModPromise) {
    packagerModPromise = import('./packager/index.js').catch((err) => {
      packagerModPromise = null;
      throw err;
    });
  }
  return packagerModPromise;
}

function getStageMeta(stageId) {
  return (
    PIPELINE_STAGES.find((s) => s.id === stageId) || {
      id: stageId || 'clone',
      index: 0,
      label: stageId ? String(stageId) : 'Preparing',
      description: '',
    }
  );
}

function formatSseMessage(eventName, data, id) {
  let out = '';
  if (id !== undefined && id !== null) {
    out += `id: ${id}\n`;
  }
  if (eventName) {
    out += `event: ${eventName}\n`;
  }
  const json = JSON.stringify(data);
  for (const line of json.split('\n')) {
    out += `data: ${line}\n`;
  }
  out += '\n';
  return out;
}

export class JobManager {
  constructor({ store, dataDir, previewManager }) {
    this.store = store;
    this.dataDir = path.resolve(
      dataDir || store?.dataDir || process.env.DATA_DIR || path.resolve(process.cwd(), 'data')
    );
    this.previewManager = previewManager;
    /** @type {Map<string, { nextSeq: number, events: Array<{id: number, event: string, data: any}>, subscribers: Set<import('express').Response>, cancelled: boolean, lastPersistMs: number }>} */
    this.liveJobs = new Map();
  }

  _ensureChannel(jobId) {
    let channel = this.liveJobs.get(jobId);
    if (!channel) {
      channel = {
        nextSeq: 1,
        events: [],
        subscribers: new Set(),
        cancelled: false,
        lastPersistMs: 0,
      };
      this.liveJobs.set(jobId, channel);
    }
    return channel;
  }

  _emit(jobId, eventName, data) {
    const channel = this._ensureChannel(jobId);
    const id = channel.nextSeq++;
    const record = { id, event: eventName, data };
    channel.events.push(record);
    if (channel.events.length > MAX_BUFFERED_EVENTS) {
      channel.events.splice(0, channel.events.length - MAX_BUFFERED_EVENTS);
    }

    const frame = formatSseMessage(eventName, data, id);
    for (const res of Array.from(channel.subscribers)) {
      try {
        if (!res.writableEnded) {
          res.write(frame);
        } else {
          channel.subscribers.delete(res);
        }
      } catch {
        channel.subscribers.delete(res);
      }
    }
  }

  _appendLog(job, message, level = 'info', stage = job.stage) {
    if (!message) return;
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      stage: stage || job.stage || 'clone',
      message: String(message),
    };
    const logs = Array.isArray(job.logs) ? [...job.logs, entry] : [entry];
    if (logs.length > MAX_PERSISTED_LOGS) {
      logs.splice(0, logs.length - MAX_PERSISTED_LOGS);
    }
    const channel = this._ensureChannel(job.id);
    const now = Date.now();
    const shouldPersist = now - channel.lastPersistMs > 1500;
    if (shouldPersist) channel.lastPersistMs = now;
    this.store.updateJob(job.id, { logs }, { persist: shouldPersist });
    this._emit(job.id, 'log', entry);
  }

  createAndStartJob({ url, analysis, targetOs, format, envVars, includeRuntime }) {
    const resolvedUrl = (url || analysis?.canonicalUrl || '').trim();
    if (!resolvedUrl) {
      const err = new Error('Please provide a GitHub repository URL to package.');
      err.statusCode = 400;
      throw err;
    }

    const resolvedTargetOs = targetOs || detectHostTargetOs();
    if (!isValidTargetOs(resolvedTargetOs)) {
      const err = new Error(`Unsupported target OS "${resolvedTargetOs}".`);
      err.statusCode = 400;
      throw err;
    }

    const resolvedFormat = format || 'bundle-zip';
    if (!isValidPackageFormat(resolvedFormat)) {
      const err = new Error(`Unsupported package format "${resolvedFormat}".`);
      err.statusCode = 400;
      throw err;
    }

    const jobId = `gn_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const job = {
      id: jobId,
      url: resolvedUrl,
      targetOs: resolvedTargetOs,
      format: resolvedFormat,
      includeRuntime: includeRuntime !== false,
      envVars: envVars && typeof envVars === 'object' ? envVars : {},
      status: JOB_STATUSES.QUEUED,
      stage: 'clone',
      stageLabel: getStageMeta('clone').label,
      progress: 0,
      message: 'Queued for packaging…',
      analysis: analysis || null,
      result: null,
      error: null,
      downloadCount: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      logs: [],
    };

    this.store.saveJob(job);
    this._ensureChannel(jobId);

    this._emit(jobId, 'progress', {
      jobId,
      status: job.status,
      stage: job.stage,
      stageLabel: job.stageLabel,
      progress: 0,
      message: job.message,
      timestamp: now,
    });

    // Run asynchronously after returning the queued job
    setImmediate(() => {
      this._executeJob(jobId).catch((err) => {
        console.error(`[jobs] Unhandled job error for ${jobId}:`, err);
      });
    });

    return job;
  }

  async _executeJob(jobId) {
    const channel = this._ensureChannel(jobId);
    let job = this.store.getJob(jobId);
    if (!job || channel.cancelled) return;

    const startedAt = new Date().toISOString();
    job = this.store.updateJob(jobId, {
      status: JOB_STATUSES.RUNNING,
      startedAt,
      stage: 'clone',
      stageLabel: getStageMeta('clone').label,
      progress: 3,
      message: 'Starting packaging pipeline…',
    });

    this._emit(jobId, 'progress', {
      jobId,
      status: job.status,
      stage: job.stage,
      stageLabel: job.stageLabel,
      progress: job.progress,
      message: job.message,
      timestamp: startedAt,
    });

    try {
      // Step 1: Analyze repository if analysis was not pre-supplied
      let analysis = job.analysis;
      if (!analysis || !analysis.owner || !analysis.repo) {
        this._appendLog(job, `Inspecting repository ${job.url}…`, 'info', 'clone');
        const analyzerMod = await getAnalyzerModule();
        analysis = await analyzerMod.analyzeRepository(job.url);
        if (channel.cancelled) return;
        this.store.saveAnalysis(analysis.canonicalUrl || job.url, analysis);
        job = this.store.updateJob(jobId, {
          analysis,
          url: analysis.canonicalUrl || job.url,
          progress: 8,
          message: `Identified ${analysis.name || analysis.repo} (${analysis.framework || analysis.categoryLabel})`,
        });
        this._emit(jobId, 'progress', {
          jobId,
          status: job.status,
          stage: 'clone',
          stageLabel: getStageMeta('clone').label,
          progress: 8,
          message: job.message,
          timestamp: new Date().toISOString(),
        });
      }

      if (channel.cancelled) return;

      // Step 2: Run packager
      const packagerMod = await getPackagerModule();
      const onProgress = (evt = {}) => {
        if (channel.cancelled) return;
        const currentJob = this.store.getJob(jobId);
        if (!currentJob) return;

        // Pure log event
        if (evt.type === 'log' || (evt.log && !evt.stage && evt.progress === undefined && evt.percent === undefined)) {
          this._appendLog(
            currentJob,
            evt.log || evt.message,
            evt.level || 'info',
            evt.stage || currentJob.stage
          );
          return;
        }

        const stage = evt.stage || currentJob.stage || 'clone';
        const stageMeta = getStageMeta(stage);
        const rawProgress = evt.progress ?? evt.percent;
        const progress =
          typeof rawProgress === 'number' && Number.isFinite(rawProgress)
            ? Math.max(0, Math.min(99, Math.round(rawProgress)))
            : currentJob.progress;
        const message = evt.message || stageMeta.description || currentJob.message;
        const stageChanged = stage !== currentJob.stage;

        const now = Date.now();
        const shouldPersist = stageChanged || now - channel.lastPersistMs > 1500;
        if (shouldPersist) channel.lastPersistMs = now;

        const updated = this.store.updateJob(
          jobId,
          {
            stage,
            stageLabel: evt.stageLabel || stageMeta.label,
            progress,
            message,
          },
          { persist: shouldPersist }
        );

        this._emit(jobId, 'progress', {
          jobId,
          status: updated.status,
          stage: updated.stage,
          stageLabel: updated.stageLabel,
          progress: updated.progress,
          message: updated.message,
          timestamp: new Date().toISOString(),
        });

        if (evt.log) {
          this._appendLog(updated, evt.log, evt.level || 'info', stage);
        } else if (stageChanged && message) {
          this._appendLog(updated, `[${stageMeta.label}] ${message}`, 'info', stage);
        }
      };

      const result = await packagerMod.packageRepository({
        jobId,
        analysis,
        targetOs: job.targetOs,
        format: job.format,
        envVars: job.envVars,
        includeRuntime: job.includeRuntime,
        dataDir: this.dataDir,
        onProgress,
      });

      if (channel.cancelled) {
        await this._cleanupDiskArtifacts(jobId);
        return;
      }

      const finishedAt = new Date().toISOString();
      const completedJob = this.store.updateJob(jobId, {
        status: JOB_STATUSES.COMPLETED,
        stage: 'seal',
        stageLabel: getStageMeta('seal').label,
        progress: 100,
        message: 'Package ready to preview and download.',
        result,
        finishedAt,
        error: null,
      });

      this._appendLog(
        completedJob,
        `Packaging completed cleanly (${result?.zipFileName || result?.singleHtmlFileName || jobId}).`,
        'success',
        'seal'
      );

      this._emit(jobId, 'progress', {
        jobId,
        status: completedJob.status,
        stage: 'seal',
        stageLabel: getStageMeta('seal').label,
        progress: 100,
        message: completedJob.message,
        timestamp: finishedAt,
      });

      this._emit(jobId, 'complete', {
        jobId,
        job: completedJob,
        timestamp: finishedAt,
      });

      this._closeSubscribers(jobId);
    } catch (err) {
      if (channel.cancelled) return;
      const finishedAt = new Date().toISOString();
      const friendlyMessage =
        err?.message || 'An unexpected error occurred while packaging this repository.';

      const failedJob = this.store.updateJob(jobId, {
        status: JOB_STATUSES.FAILED,
        error: friendlyMessage,
        message: friendlyMessage,
        finishedAt,
      });

      if (failedJob) {
        this._appendLog(failedJob, `Error: ${friendlyMessage}`, 'error', failedJob.stage);
      }

      this._emit(jobId, 'error', {
        jobId,
        error: friendlyMessage,
        job: failedJob,
        timestamp: finishedAt,
      });

      this._closeSubscribers(jobId);
    }
  }

  _closeSubscribers(jobId) {
    const channel = this.liveJobs.get(jobId);
    if (!channel) return;
    setTimeout(() => {
      for (const res of Array.from(channel.subscribers)) {
        try {
          if (!res.writableEnded) res.end();
        } catch {
          // ignore
        }
      }
      channel.subscribers.clear();
    }, 150);
  }

  attachSseClient(jobId, req, res) {
    const job = this.store.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: `Job "${jobId}" was not found.` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const channel = this.liveJobs.get(jobId);

    if (channel && channel.events.length > 0) {
      // Replay full buffered history
      for (const evt of channel.events) {
        res.write(formatSseMessage(evt.event, evt.data, evt.id));
      }
    } else {
      // Reconstruct history from persisted job (e.g., after server restart)
      let seq = 1;
      for (const log of job.logs || []) {
        res.write(formatSseMessage('log', log, seq++));
      }
      res.write(
        formatSseMessage(
          'progress',
          {
            jobId: job.id,
            status: job.status,
            stage: job.stage,
            stageLabel: job.stageLabel,
            progress: job.progress,
            message: job.message,
            timestamp: job.updatedAt || job.createdAt,
          },
          seq++
        )
      );
      if (job.status === JOB_STATUSES.COMPLETED) {
        res.write(
          formatSseMessage(
            'complete',
            { jobId: job.id, job, timestamp: job.finishedAt || job.updatedAt },
            seq++
          )
        );
      } else if (job.status === JOB_STATUSES.FAILED || job.status === JOB_STATUSES.CANCELLED) {
        res.write(
          formatSseMessage(
            'error',
            {
              jobId: job.id,
              error: job.error || 'Packaging did not complete.',
              job,
              timestamp: job.finishedAt || job.updatedAt,
            },
            seq++
          )
        );
      }
    }

    // If job is already finished, close after replay
    if (
      job.status === JOB_STATUSES.COMPLETED ||
      job.status === JOB_STATUSES.FAILED ||
      job.status === JOB_STATUSES.CANCELLED
    ) {
      res.end();
      return;
    }

    const activeChannel = this._ensureChannel(jobId);
    activeChannel.subscribers.add(res);

    const keepAlive = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(keepAlive);
        activeChannel.subscribers.delete(res);
        return;
      }
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAlive);
        activeChannel.subscribers.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      activeChannel.subscribers.delete(res);
    });
  }

  async cancelJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return null;

    const channel = this._ensureChannel(jobId);
    channel.cancelled = true;

    if (job.status === JOB_STATUSES.QUEUED || job.status === JOB_STATUSES.RUNNING) {
      const finishedAt = new Date().toISOString();
      const updated = this.store.updateJob(jobId, {
        status: JOB_STATUSES.CANCELLED,
        error: 'Packaging was cancelled.',
        message: 'Packaging was cancelled.',
        finishedAt,
      });
      this._emit(jobId, 'error', {
        jobId,
        error: updated.error,
        job: updated,
        timestamp: finishedAt,
      });
      this._closeSubscribers(jobId);
      return updated;
    }
    return job;
  }

  async deleteJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) return false;

    if (this.previewManager) {
      await this.previewManager.stopPreview(jobId);
    }

    const channel = this.liveJobs.get(jobId);
    if (channel) {
      channel.cancelled = true;
      this._closeSubscribers(jobId);
      this.liveJobs.delete(jobId);
    }

    await this._cleanupDiskArtifacts(jobId);
    this.store.deleteJob(jobId);
    return true;
  }

  async _cleanupDiskArtifacts(jobId) {
    const buildDir = path.join(this.dataDir, 'builds', jobId);
    const packageDir = path.join(this.dataDir, 'packages', jobId);
    await Promise.all([
      fs.rm(buildDir, { recursive: true, force: true }).catch(() => {}),
      fs.rm(packageDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}
