import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Copy,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JobLogEntry, PackageJob } from '../types';
import {
  PIPELINE_STAGES,
  formatDuration,
  getFriendlyOsPossessive,
  getFriendlyStageSentence,
  resolveStageIndex,
} from '../utils';

interface BuildPipelineProps {
  job: PackageJob;
  progress: number;
  stage: string | undefined;
  message: string;
  logs: JobLogEntry[];
  error: string | null;
  onRetry: () => void;
  onReset: () => void;
}

export function BuildPipeline({
  job,
  progress,
  stage,
  message,
  logs,
  error,
  onRetry,
  onReset,
}: BuildPipelineProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const isFailed = Boolean(error) || job.status === 'failed';
  const isCompleted = job.status === 'completed';
  const activeStageIndex = isCompleted
    ? PIPELINE_STAGES.length
    : resolveStageIndex(stage || job.stage, progress);

  useEffect(() => {
    const startTs = job.createdAt ? Date.parse(job.createdAt) : Date.now();
    const update = () => {
      const secs = Math.max(
        0,
        Math.floor((Date.now() - (Number.isNaN(startTs) ? Date.now() : startTs)) / 1000)
      );
      setElapsedSec(secs);
    };
    update();
    if (isFailed || isCompleted) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [job.createdAt, isFailed, isCompleted]);

  useEffect(() => {
    if (detailsOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [logs, detailsOpen]);

  const handleCopyLogs = async () => {
    try {
      await navigator.clipboard.writeText(logs.map((l) => l.message).join('\n'));
      setCopiedLogs(true);
      window.setTimeout(() => setCopiedLogs(false), 1800);
    } catch {
      // ignore
    }
  };

  const displayPercent = isCompleted ? 100 : Math.max(6, Math.min(98, Math.round(progress || 8)));
  const appName = job.analysis?.name || job.url.split('/').pop() || 'your app';
  const osFriendly = getFriendlyOsPossessive(job.targetOs);
  const isReactComponent = job.analysis?.packagingStrategy === 'react-component';
  const statusLine =
    isReactComponent && activeStageIndex === 2
      ? 'Automatically wrapping this React component into a ready-to-use app...'
      : getFriendlyStageSentence(stage || job.stage, progress);

  return (
    <div className="gn-card" style={{ maxWidth: '580px' }}>
      <div style={{ textAlign: 'center' }}>
        {!isFailed && (
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '9999px',
              background: '#f7f7f8',
              border: '1px solid #e5e5e5',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
            }}
          >
            <Loader2 size={18} strokeWidth={2} className="gn-spin" />
          </div>
        )}

        <h2
          style={{
            margin: '0 0 8px',
            fontSize: '24px',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.25,
          }}
        >
          {isFailed ? `Couldn't finish preparing ${appName}` : `Preparing ${appName} for ${osFriendly}...`}
        </h2>

        {!isFailed && (
          <p style={{ margin: '0 0 22px', fontSize: '14.5px', color: '#525252' }}>
            {statusLine}
          </p>
        )}
      </div>

      {!isFailed && (
        <div>
          <div
            className="gn-progress-track"
            role="progressbar"
            aria-valuenow={displayPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="gn-progress-fill" style={{ width: `${displayPercent}%` }} />
          </div>

          <div
            style={{
              marginTop: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12.5px',
              color: '#737373',
            }}
          >
            <span>{displayPercent}%</span>
            <span>{formatDuration(elapsedSec)}</span>
          </div>
        </div>
      )}

      {isFailed && (
        <div
          style={{
            marginTop: '16px',
            padding: '16px',
            borderRadius: '16px',
            border: '1px solid #000000',
            background: '#f7f7f8',
            display: 'flex',
            gap: '12px',
            alignItems: 'flex-start',
          }}
          role="alert"
        >
          <AlertCircle size={18} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', color: '#000000', marginBottom: '14px', lineHeight: 1.5 }}>
              {error || job.error || 'Something went wrong while preparing this download.'}
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button type="button" className="gn-pill-btn gn-pill-primary gn-pill-sm" onClick={onRetry}>
                <RotateCcw size={13} strokeWidth={2} />
                <span>Try again</span>
              </button>
              <button type="button" className="gn-pill-btn gn-pill-sm" onClick={onReset}>
                <span>Try another link</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quiet Collapsible "Show details" */}
      <div style={{ marginTop: '22px', textAlign: 'center' }}>
        <button
          type="button"
          className="gn-pill-btn gn-pill-quiet"
          onClick={() => setDetailsOpen((o) => !o)}
          style={{ border: 'none', background: 'transparent', padding: '6px 12px' }}
        >
          <span>{detailsOpen ? 'Hide details' : 'Show details'}</span>
          {detailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {detailsOpen && (
        <div
          style={{
            marginTop: '14px',
            paddingTop: '16px',
            borderTop: '1px solid #e5e5e5',
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
            {PIPELINE_STAGES.map((s) => {
              const state =
                s.index < activeStageIndex
                  ? 'done'
                  : s.index === activeStageIndex && !isFailed
                    ? 'active'
                    : 'pending';
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '13.5px',
                    color: state === 'pending' ? '#737373' : '#000000',
                    fontWeight: state === 'active' ? 600 : 400,
                  }}
                >
                  {state === 'done' ? (
                    <span
                      style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '9999px',
                        background: '#000000',
                        color: '#ffffff',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Check size={11} strokeWidth={2.5} />
                    </span>
                  ) : state === 'active' ? (
                    <Loader2 size={16} strokeWidth={2} className="gn-spin" style={{ flexShrink: 0 }} />
                  ) : (
                    <Circle size={15} strokeWidth={1.5} color="#c4c4c4" style={{ flexShrink: 0 }} />
                  )}
                  <span>{s.label}</span>
                </div>
              );
            })}
          </div>

          {message && (
            <div
              className="gn-mono"
              style={{ fontSize: '11.5px', color: '#525252', marginBottom: '10px' }}
            >
              {message}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 500, color: '#525252' }}>
              Build log ({logs.length})
            </span>
            {logs.length > 0 && (
              <button type="button" className="gn-pill-btn gn-pill-sm" onClick={handleCopyLogs}>
                {copiedLogs ? <Check size={12} /> : <Copy size={12} />}
                <span>{copiedLogs ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </div>

          <div className="gn-log-box">
            {logs.length === 0 ? (
              <div style={{ color: '#737373' }}>Waiting for build output...</div>
            ) : (
              logs.map((entry, idx) => <div key={idx}>{entry.message}</div>)
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
