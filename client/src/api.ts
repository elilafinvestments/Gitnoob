import type {
  CuratedRepo,
  HealthStatus,
  JobLogEntry,
  JobProgressEvent,
  LocalSaveResult,
  NormalizedRuntimeEntry,
  PackageFormat,
  PackageJob,
  RepoAnalysis,
  TargetOS,
} from './types';
import { normalizeRuntimesResponse } from './utils';

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(text.slice(0, 240) || `Request failed (${res.status})`);
      }
    }
  }

  if (!res.ok) {
    const message =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.message === 'string' && data.message) ||
      `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return data as T;
}

export async function fetchHealth(): Promise<HealthStatus> {
  return apiJson<HealthStatus>('/api/health');
}

export async function fetchCurated(): Promise<CuratedRepo[]> {
  const data = await apiJson<{ repos?: CuratedRepo[] }>('/api/curated');
  return Array.isArray(data.repos) ? data.repos : [];
}

export async function analyzeRepo(url: string): Promise<RepoAnalysis> {
  const data = await apiJson<{ analysis: RepoAnalysis }>('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return data.analysis;
}

export async function startPackageJob(payload: {
  url: string;
  analysis?: RepoAnalysis;
  targetOs: TargetOS;
  format: PackageFormat;
  envVars?: Record<string, string>;
  includeRuntime?: boolean;
}): Promise<PackageJob> {
  const data = await apiJson<{ job: PackageJob }>('/api/package', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      includeRuntime: payload.includeRuntime ?? true,
    }),
  });
  return data.job;
}

export async function fetchJobs(): Promise<PackageJob[]> {
  const data = await apiJson<{ jobs?: PackageJob[] }>('/api/jobs');
  return Array.isArray(data.jobs) ? data.jobs : [];
}

export async function fetchJob(id: string): Promise<PackageJob> {
  const data = await apiJson<{ job: PackageJob }>(`/api/jobs/${encodeURIComponent(id)}`);
  return data.job;
}

export async function deleteJob(id: string): Promise<void> {
  await apiJson(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function startPreview(jobId: string): Promise<{ previewUrl: string }> {
  return apiJson<{ previewUrl: string }>(
    `/api/jobs/${encodeURIComponent(jobId)}/preview/start`,
    { method: 'POST', body: JSON.stringify({}) }
  );
}

export async function stopPreview(jobId: string): Promise<void> {
  await apiJson(`/api/jobs/${encodeURIComponent(jobId)}/preview/stop`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function saveJobLocally(
  jobId: string,
  options: {
    openInFinder?: boolean;
    launchApp?: boolean;
    format?: 'bundle-zip' | 'single-html';
  } = {}
): Promise<LocalSaveResult> {
  return apiJson<LocalSaveResult>(
    `/api/jobs/${encodeURIComponent(jobId)}/save-local`,
    {
      method: 'POST',
      body: JSON.stringify(options),
    }
  );
}

export async function fetchRuntimes(): Promise<{
  entries: NormalizedRuntimeEntry[];
  raw: unknown;
}> {
  const data = await apiJson<{ runtimes?: unknown }>('/api/runtimes');
  const raw = data.runtimes ?? data;
  return { entries: normalizeRuntimesResponse(raw), raw };
}

export function getDownloadUrl(jobId: string, format?: 'single-html'): string {
  const base = `/api/jobs/${encodeURIComponent(jobId)}/download`;
  return format === 'single-html' ? `${base}?format=single-html` : base;
}

export interface JobStreamHandlers {
  onProgress?: (event: JobProgressEvent) => void;
  onLog?: (entry: JobLogEntry) => void;
  onComplete?: (job: PackageJob) => void;
  onError?: (errorMessage: string, job?: PackageJob) => void;
}

export function subscribeToJobEvents(jobId: string, handlers: JobStreamHandlers): () => void {
  let closed = false;
  let pollTimer: number | null = null;
  let es: EventSource | null = null;

  const stopAll = () => {
    closed = true;
    if (es) {
      es.close();
      es = null;
    }
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const handleParsed = (eventName: string, rawPayload: string) => {
    if (closed) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawPayload);
    } catch {
      if (eventName === 'log' || rawPayload.trim()) {
        handlers.onLog?.({ message: rawPayload, timestamp: new Date().toISOString() });
      }
      return;
    }

    const type = eventName !== 'message' ? eventName : String(data.type || data.event || 'progress');

    if (type === 'log') {
      const msg =
        typeof data.message === 'string'
          ? data.message
          : typeof data.line === 'string'
            ? data.line
            : JSON.stringify(data);
      handlers.onLog?.({
        message: msg,
        stage: typeof data.stage === 'string' ? data.stage : undefined,
        level: typeof data.level === 'string' ? data.level : undefined,
        timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
      });
      return;
    }

    if (type === 'complete' || type === 'completed') {
      const jobObj = (data.job && typeof data.job === 'object' ? data.job : data) as PackageJob;
      if (jobObj && jobObj.id) {
        stopAll();
        handlers.onComplete?.(jobObj);
      } else {
        fetchJob(jobId)
          .then((fresh) => {
            stopAll();
            handlers.onComplete?.(fresh);
          })
          .catch(() => {
            stopAll();
          });
      }
      return;
    }

    if (type === 'error' || type === 'failed') {
      const errMsg =
        (typeof data.error === 'string' && data.error) ||
        (typeof data.message === 'string' && data.message) ||
        'Packaging failed';
      const jobObj = data.job && typeof data.job === 'object' ? (data.job as PackageJob) : undefined;
      stopAll();
      handlers.onError?.(errMsg, jobObj);
      return;
    }

    // progress
    const progressVal =
      typeof data.percent === 'number'
        ? data.percent
        : typeof data.progress === 'number'
          ? data.progress
          : undefined;

    handlers.onProgress?.({
      stage: typeof data.stage === 'string' ? data.stage : undefined,
      stageIndex: typeof data.stageIndex === 'number' ? data.stageIndex : undefined,
      percent: progressVal,
      progress: progressVal,
      message: typeof data.message === 'string' ? data.message : undefined,
      timestamp: typeof data.timestamp === 'string' ? data.timestamp : undefined,
    });

    if (typeof data.log === 'string' && data.log.trim()) {
      handlers.onLog?.({
        message: data.log,
        stage: typeof data.stage === 'string' ? data.stage : undefined,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const startFallbackPolling = () => {
    if (closed || pollTimer !== null) return;
    pollTimer = window.setInterval(async () => {
      if (closed) return;
      try {
        const job = await fetchJob(jobId);
        handlers.onProgress?.({
          stage: job.stage,
          percent: job.progress,
          progress: job.progress,
          message: job.message,
        });
        if (job.status === 'completed') {
          stopAll();
          handlers.onComplete?.(job);
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          stopAll();
          handlers.onError?.(job.error || 'Packaging failed', job);
        }
      } catch {
        // transient network hiccup; keep polling
      }
    }, 1800);
  };

  try {
    es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    es.addEventListener('progress', (e) => handleParsed('progress', (e as MessageEvent).data));
    es.addEventListener('log', (e) => handleParsed('log', (e as MessageEvent).data));
    es.addEventListener('complete', (e) => handleParsed('complete', (e as MessageEvent).data));
    es.addEventListener('error', (e) => {
      const me = e as MessageEvent;
      if (me.data) {
        handleParsed('error', me.data);
      } else if (!closed) {
        // SSE connection dropped or closed by server; verify final state via polling
        startFallbackPolling();
      }
    });
    es.onmessage = (e) => handleParsed('message', e.data);
  } catch {
    startFallbackPolling();
  }

  return stopAll;
}
