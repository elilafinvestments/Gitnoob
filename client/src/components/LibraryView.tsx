import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { getDownloadUrl } from '../api';
import type { NormalizedRuntimeEntry, PackageJob } from '../types';
import { formatBytes, formatRelativeTime, getOSOption } from '../utils';
import { AppEmblem } from './AppEmblem';

interface LibraryViewProps {
  jobs: PackageJob[];
  runtimes: NormalizedRuntimeEntry[];
  loading: boolean;
  onRefresh: () => void;
  onOpenArtifact: (job: PackageJob) => void;
  onDeleteJob: (id: string) => Promise<void>;
  onGoHome: () => void;
}

export function LibraryView({
  jobs,
  runtimes,
  loading,
  onRefresh,
  onOpenArtifact,
  onDeleteJob,
  onGoHome,
}: LibraryViewProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [cacheOpen, setCacheOpen] = useState(false);

  const handleConfirmDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDeleteJob(id);
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const cachedCount = runtimes.filter((r) => r.cached).length;

  return (
    <div className="gn-list-stage">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '22px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              margin: '0 0 4px',
              fontSize: '26px',
              fontWeight: 600,
              letterSpacing: '-0.025em',
            }}
          >
            My Downloads
          </h1>
          <div style={{ fontSize: '14px', color: '#525252' }}>
            Apps you&apos;ve packaged and saved on this computer
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="gn-pill-btn gn-pill-sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={13} strokeWidth={1.9} className={loading ? 'gn-spin' : ''} />
            <span>Refresh</span>
          </button>
          <button type="button" className="gn-pill-btn gn-pill-primary gn-pill-sm" onClick={onGoHome}>
            <span>New download</span>
          </button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="gn-card" style={{ maxWidth: '100%', textAlign: 'center', padding: '44px 24px' }}>
          <div style={{ fontSize: '17px', fontWeight: 600, marginBottom: '6px' }}>
            No downloads yet
          </div>
          <p style={{ margin: '0 auto 20px', maxWidth: '400px', fontSize: '14px', color: '#525252' }}>
            Paste any GitHub link on the home screen to package your first ready-to-run app.
          </p>
          <button type="button" className="gn-pill-btn gn-pill-primary" onClick={onGoHome}>
            <span>Paste a GitHub link</span>
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {jobs.map((job) => {
            const name = job.analysis?.name || job.url.split('/').pop() || job.id;
            const osOpt = getOSOption(job.result?.targetOs || job.targetOs);
            const sizeBytes = job.result?.zipSizeBytes || job.result?.singleHtmlSizeBytes;
            const isCompleted = job.status === 'completed';
            const isRunning = job.status === 'running' || job.status === 'queued';

            return (
              <div key={job.id} className="gn-download-row">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '14px',
                    minWidth: 0,
                    flex: '1 1 240px',
                  }}
                >
                  <AppEmblem jobId={job.id} appName={name} size={40} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '15.5px' }}>{name}</span>
                      {!isCompleted && (
                        <span
                          style={{
                            fontSize: '11.5px',
                            padding: '2px 8px',
                            borderRadius: '9999px',
                            border: '1px solid #e5e5e5',
                            background: '#f7f7f8',
                            color: '#525252',
                          }}
                        >
                          {isRunning ? 'Preparing...' : job.status}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '13px', color: '#737373', marginTop: '3px' }}>
                      {osOpt.label}
                      {sizeBytes ? ` · ${formatBytes(sizeBytes)}` : ''}
                      {' · '}
                      {formatRelativeTime(job.finishedAt || job.completedAt || job.createdAt)}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {isCompleted && (
                    <a
                      href={getDownloadUrl(
                        job.id,
                        !job.result?.zipPath && job.result?.singleHtmlPath
                          ? 'single-html'
                          : undefined
                      )}
                      download
                      className="gn-pill-btn gn-pill-primary gn-pill-sm"
                      onClick={() => window.setTimeout(onRefresh, 600)}
                    >
                      <Download size={13} strokeWidth={2.1} />
                      <span>Download</span>
                    </a>
                  )}

                  {(isCompleted || isRunning) && (
                    <button
                      type="button"
                      className="gn-pill-btn gn-pill-sm"
                      onClick={() => onOpenArtifact(job)}
                    >
                      <span>{isRunning ? 'View progress' : 'Open'}</span>
                      <ArrowUpRight size={13} strokeWidth={1.9} />
                    </button>
                  )}

                  {confirmDeleteId === job.id ? (
                    <button
                      type="button"
                      className="gn-pill-btn gn-pill-primary gn-pill-sm"
                      disabled={deletingId === job.id}
                      onClick={() => handleConfirmDelete(job.id)}
                    >
                      <span>{deletingId === job.id ? 'Removing...' : 'Remove'}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="gn-icon-btn"
                      onClick={() => setConfirmDeleteId(job.id)}
                      aria-label={`Delete ${name}`}
                      title="Remove from downloads"
                    >
                      <Trash2 size={15} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Quiet Collapsible Runtime Cache at the Bottom */}
      <div
        style={{
          marginTop: '36px',
          paddingTop: '20px',
          borderTop: '1px solid #f0f0f0',
          textAlign: 'center',
        }}
      >
        <button
          type="button"
          className="gn-pill-btn gn-pill-quiet"
          style={{ border: 'none', background: 'transparent' }}
          onClick={() => setCacheOpen((o) => !o)}
        >
          <span>Runtime cache ({cachedCount} saved locally)</span>
          {cacheOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {cacheOpen && (
          <div
            style={{
              marginTop: '14px',
              textAlign: 'left',
              border: '1px solid #e5e5e5',
              borderRadius: '16px',
              padding: '16px 18px',
              background: '#ffffff',
            }}
          >
            <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#525252', lineHeight: 1.5 }}>
              GitNoob automatically downloads and caches portable Node.js and Python runtimes as
              needed so packaged apps open without any setup.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {runtimes.map((entry) => {
                const osOpt = getOSOption(entry.targetOs);
                return (
                  <div
                    key={entry.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      fontSize: '13px',
                      padding: '8px 10px',
                      borderRadius: '10px',
                      background: entry.cached ? '#f7f7f8' : '#ffffff',
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 500 }}>{entry.label}</span>{' '}
                      <span style={{ color: '#737373' }}>· {osOpt.label}</span>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: '#525252', fontSize: '12.5px' }}>
                      {entry.cached ? (
                        <>
                          <Check size={13} strokeWidth={2.2} color="#000000" />
                          <span style={{ color: '#000000', fontWeight: 500 }}>
                            {entry.sizeBytes ? formatBytes(entry.sizeBytes) : 'Cached'}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: '#8a8a8a' }}>
                          {entry.approxCompressedMB ? `~${entry.approxCompressedMB} MB on demand` : 'On demand'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
