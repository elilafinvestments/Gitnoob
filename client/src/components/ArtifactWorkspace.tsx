import {
  AlertCircle,
  BookOpen,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  Play,
  RefreshCw,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDownloadUrl, saveJobLocally, startPreview, stopPreview } from '../api';
import type { LocalSaveResult, PackageJob, TargetOS } from '../types';
import { AppEmblem } from './AppEmblem';
import {
  TARGET_OS_OPTIONS,
  buildDefaultAfterDownloadSteps,
  buildMacTerminalOpenCommand,
  formatBundledRuntimeLabel,
  formatBytes,
  getOSOption,
  getOneLineOpenHint,
  normalizeVerificationChecks,
} from '../utils';

interface ArtifactWorkspaceProps {
  job: PackageJob;
  detectedOs: TargetOS;
  supportsLocalSave: boolean;
  onRepackageForOs: (targetOs: TargetOS) => void;
  onDownloadTriggered?: () => void;
  onPreviewActiveChange?: (wide: boolean) => void;
}

type OptionalPanel = null | 'preview' | 'guide' | 'xray' | 'other-os';

export function ArtifactWorkspace({
  job,
  detectedOs,
  supportsLocalSave,
  onRepackageForOs,
  onDownloadTriggered,
  onPreviewActiveChange,
}: ArtifactWorkspaceProps) {
  const result = job.result;
  const hasPreview = Boolean(result?.previewDir);
  const hasZip = Boolean(result?.zipPath || result?.zipFileName || result?.zipSizeBytes);
  const hasSingleHtml = Boolean(
    result?.singleHtmlPath || result?.singleHtmlFileName || result?.singleHtmlSizeBytes
  );

  // Collapsed by default so the central Download card stays serene and uncluttered
  const [openPanel, setOpenPanel] = useState<OptionalPanel>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedSha, setCopiedSha] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [fileQuery, setFileQuery] = useState('');

  // Zero-warning Mac Local Save state
  const [localSaveResult, setLocalSaveResult] = useState<LocalSaveResult | null>(null);
  const [localSaveBusy, setLocalSaveBusy] = useState<'save' | 'launch' | 'finder' | null>(null);
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const [launchedNotice, setLaunchedNotice] = useState(false);

  const targetOs = (result?.targetOs || job.targetOs) as TargetOS;
  const osOption = getOSOption(targetOs);
  const appName = job.analysis?.name || job.url.split('/').pop() || 'App';
  const runtimeLabel = formatBundledRuntimeLabel(result?.bundledRuntime);
  const isMacTarget = targetOs.startsWith('macos');
  const isUserOnMac = detectedOs === 'macos-arm64' || detectedOs === 'macos-x64';
  const canLocalSaveMac = Boolean(supportsLocalSave) && isUserOnMac && isMacTarget && hasZip;
  const isReactComponent = job.analysis?.packagingStrategy === 'react-component';

  const verificationChecks = useMemo(
    () => normalizeVerificationChecks(result?.verification),
    [result?.verification]
  );

  useEffect(() => {
    setOpenPanel(null);
    setPreviewUrl(null);
    setPreviewError(null);
    setIsFullscreen(false);
    setFileQuery('');
    setLocalSaveResult(null);
    setLocalSaveBusy(null);
    setLocalSaveError(null);
    setLaunchedNotice(false);
  }, [job.id]);

  useEffect(() => {
    onPreviewActiveChange?.(openPanel === 'preview');
  }, [openPanel, onPreviewActiveChange]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const handleLocalSave = useCallback(
    async (mode: 'save' | 'launch' | 'finder') => {
      setLocalSaveBusy(mode);
      setLocalSaveError(null);
      try {
        const res = await saveJobLocally(job.id, {
          openInFinder: mode === 'save' || mode === 'finder',
          launchApp: mode === 'launch',
        });
        setLocalSaveResult(res);
        if (mode === 'launch') {
          setLaunchedNotice(true);
          window.setTimeout(() => setLaunchedNotice(false), 3000);
        }
        onDownloadTriggered?.();
      } catch (err) {
        setLocalSaveError(
          err instanceof Error ? err.message : 'Could not save directly to your Downloads folder.'
        );
      } finally {
        setLocalSaveBusy(null);
      }
    },
    [job.id, onDownloadTriggered]
  );

  const launchPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const { previewUrl: url } = await startPreview(job.id);
      setPreviewUrl(url);
      setIframeKey((k) => k + 1);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Could not open browser preview');
    } finally {
      setPreviewLoading(false);
    }
  }, [job.id]);

  const handleTogglePanel = (panel: Exclude<OptionalPanel, null>) => {
    if (openPanel === panel) {
      if (panel === 'preview' && previewUrl) {
        stopPreview(job.id).catch(() => {});
        setPreviewUrl(null);
      }
      setOpenPanel(null);
      return;
    }
    setOpenPanel(panel);
    if (panel === 'preview' && !previewUrl && !previewLoading) {
      launchPreview();
    }
  };

  const handleCopySha = async () => {
    if (!result?.sha256) return;
    try {
      await navigator.clipboard.writeText(result.sha256);
      setCopiedSha(true);
      window.setTimeout(() => setCopiedSha(false), 1800);
    } catch {
      // ignore
    }
  };

  const macTerminalCmd = useMemo(
    () => buildMacTerminalOpenCommand(result?.zipFileName, appName, result?.launcherName),
    [result?.zipFileName, appName, result?.launcherName]
  );

  const handleCopyMacCmd = async () => {
    try {
      await navigator.clipboard.writeText(macTerminalCmd);
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 2000);
    } catch {
      // ignore
    }
  };

  const afterDownloadSteps = useMemo(() => {
    const rawSteps = result?.afterDownloadSteps;
    if (Array.isArray(rawSteps) && rawSteps.length > 0) {
      // Guard against any legacy cached job steps that mention removed macOS 15 actions
      const hasLegacyMacHint = rawSteps.some((item) => {
        const txt = typeof item === 'string' ? item : `${item.title || ''} ${item.description || ''} ${item.step || ''}`;
        return /FIX_MAC_SECURITY|Right-click/i.test(txt);
      });
      if (!hasLegacyMacHint) {
        return rawSteps.map((item, idx) => {
          if (typeof item === 'string') {
            return { title: `Step ${idx + 1}`, detail: item };
          }
          return {
            title: item.title || `Step ${idx + 1}`,
            detail: item.description || item.step || '',
          };
        });
      }
    }
    return buildDefaultAfterDownloadSteps(
      targetOs,
      appName,
      result?.launcherName,
      hasSingleHtml,
      result?.format || job.format
    );
  }, [result, targetOs, job.format, appName, hasSingleHtml]);

  const breakdownSegments = useMemo(() => {
    const b = result?.breakdown;
    if (!b) return [];
    const total = Math.max(
      1,
      b.totalUncompressedBytes ||
        b.appCodeBytes + b.dependenciesBytes + b.runtimeBytes + b.launcherBytes
    );
    return [
      { id: 'app', label: 'App files', bytes: b.appCodeBytes || 0, pattern: 'gn-pattern-solid' },
      {
        id: 'dependencies',
        label: 'Libraries',
        bytes: b.dependenciesBytes || 0,
        pattern: 'gn-pattern-hatch',
      },
      {
        id: 'runtime',
        label: 'Bundled runtime',
        bytes: b.runtimeBytes || 0,
        pattern: 'gn-pattern-stipple',
      },
      {
        id: 'launcher',
        label: 'Launcher & guide',
        bytes: b.launcherBytes || 0,
        pattern: 'gn-pattern-outline',
      },
    ].map((s) => ({ ...s, pct: (s.bytes / total) * 100 }));
  }, [result?.breakdown]);

  const filteredFiles = useMemo(() => {
    const list = Array.isArray(result?.fileTree) ? result!.fileTree : [];
    const q = fileQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((entry) => entry.path.toLowerCase().includes(q));
  }, [result?.fileTree, fileQuery]);

  const plainSummary =
    job.analysis?.plainEnglish?.summary ||
    job.analysis?.description ||
    'Ready to run directly on your computer.';

  const runtimeReassurance = isReactComponent
    ? 'Automatically wrapped this React component into a ready-to-use app—everything needed is bundled inside.'
    : result?.bundledRuntime
      ? `Includes ${runtimeLabel} inside, so you don't need to install anything else.`
      : 'Everything it needs to run is already bundled inside.';

  const openHint = canLocalSaveMac
    ? 'Saved straight to your Mac—opens immediately with no Apple security popup.'
    : getOneLineOpenHint(targetOs, appName, result?.launcherName, hasZip, hasSingleHtml);

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* CENTRAL HERO DOWNLOAD CARD */}
      <div className="gn-card" style={{ maxWidth: '640px', textAlign: 'center', padding: '36px 32px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginBottom: '18px',
          }}
        >
          <AppEmblem jobId={job.id} appName={appName} size={72} />
        </div>

        <div style={{ marginBottom: '14px' }}>
          <span className="gn-ready-pill">
            <Check size={14} strokeWidth={2.4} />
            <span>
              {isReactComponent
                ? 'Ready to use · Wrapped React component'
                : 'Ready to use · Everything included'}
            </span>
          </span>
        </div>

        <h1
          style={{
            margin: '0 0 10px',
            fontSize: 'clamp(28px, 4vw, 34px)',
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1.15,
            color: '#000000',
          }}
        >
          {appName}
        </h1>

        <p
          style={{
            margin: '0 auto 28px',
            maxWidth: '500px',
            fontSize: '15px',
            lineHeight: 1.55,
            color: '#525252',
          }}
        >
          {plainSummary} {runtimeReassurance}
        </p>

        {/* PRIMARY ACTION AREA */}
        {canLocalSaveMac ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            {localSaveResult ? (
              <div
                style={{
                  width: '100%',
                  maxWidth: '460px',
                  border: '1px solid #e5e5e5',
                  borderRadius: '18px',
                  background: '#f7f7f8',
                  padding: '16px 18px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '7px',
                    fontSize: '13.5px',
                    fontWeight: 500,
                    color: '#000000',
                  }}
                >
                  <Check size={15} strokeWidth={2.4} />
                  <span>
                    Saved to <span className="gn-mono" style={{ fontSize: '12.5px' }}>{localSaveResult.displayPath}</span>
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="gn-pill-btn gn-pill-primary"
                    disabled={localSaveBusy !== null}
                    onClick={() => handleLocalSave('launch')}
                    style={{ padding: '11px 22px' }}
                  >
                    {localSaveBusy === 'launch' ? (
                      <Loader2 size={15} strokeWidth={2} className="gn-spin" />
                    ) : (
                      <Play size={14} strokeWidth={2.2} />
                    )}
                    <span>{launchedNotice ? `Opening ${appName}...` : `Open ${appName} Now`}</span>
                  </button>

                  <button
                    type="button"
                    className="gn-pill-btn"
                    disabled={localSaveBusy !== null}
                    onClick={() => handleLocalSave('finder')}
                    style={{ padding: '11px 16px' }}
                  >
                    {localSaveBusy === 'finder' ? (
                      <Loader2 size={14} strokeWidth={2} className="gn-spin" />
                    ) : (
                      <FolderOpen size={14} strokeWidth={1.9} />
                    )}
                    <span>Show in Finder</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="gn-pill-btn gn-pill-primary gn-pill-hero"
                disabled={localSaveBusy !== null}
                onClick={() => handleLocalSave('save')}
              >
                {localSaveBusy === 'save' ? (
                  <>
                    <Loader2 size={18} strokeWidth={2} className="gn-spin" />
                    <span>Saving to Downloads...</span>
                  </>
                ) : (
                  <>
                    <Download size={18} strokeWidth={2.2} />
                    <span>Save to Downloads (Ready to Open)</span>
                  </>
                )}
              </button>
            )}

            {localSaveError && (
              <div
                style={{
                  fontSize: '13px',
                  color: '#000000',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  background: '#f7f7f8',
                  border: '1px solid #e5e5e5',
                }}
                role="alert"
              >
                <AlertCircle size={14} strokeWidth={2} />
                <span>{localSaveError}</span>
              </div>
            )}

            {hasSingleHtml ? (
              <>
                <a
                  href={getDownloadUrl(job.id, 'single-html')}
                  download={result?.singleHtmlFileName || undefined}
                  className="gn-pill-btn"
                  onClick={() => onDownloadTriggered?.()}
                  style={{ padding: '10px 20px', fontSize: '14px' }}
                >
                  <FileCode2 size={15} strokeWidth={1.9} />
                  <span>
                    Download Single .html File (Opens in Browser
                    {result?.singleHtmlSizeBytes ? ` · ${formatBytes(result.singleHtmlSizeBytes)}` : ''}
                    )
                  </span>
                </a>

                <a
                  href={getDownloadUrl(job.id)}
                  download={result?.zipFileName || undefined}
                  onClick={() => onDownloadTriggered?.()}
                  style={{
                    fontSize: '13px',
                    color: '#525252',
                    textDecoration: 'underline',
                    textUnderlineOffset: '3px',
                  }}
                >
                  Or download .zip archive
                  {result?.zipSizeBytes ? ` (${formatBytes(result.zipSizeBytes)})` : ''}
                </a>
              </>
            ) : (
              <a
                href={getDownloadUrl(job.id)}
                download={result?.zipFileName || undefined}
                className="gn-pill-btn"
                onClick={() => onDownloadTriggered?.()}
                style={{ padding: '10px 20px', fontSize: '14px' }}
              >
                <Download size={15} strokeWidth={1.9} />
                <span>
                  Or download .zip archive
                  {result?.zipSizeBytes ? ` (${formatBytes(result.zipSizeBytes)})` : ''}
                </span>
              </a>
            )}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            {(hasZip || !hasSingleHtml) && (
              <a
                href={getDownloadUrl(job.id)}
                download={result?.zipFileName || undefined}
                className="gn-pill-btn gn-pill-primary gn-pill-hero"
                onClick={() => onDownloadTriggered?.()}
              >
                <Download size={18} strokeWidth={2.2} />
                <span>
                  Download {appName} for {osOption.shortLabel}
                  {result?.zipSizeBytes ? ` (${formatBytes(result.zipSizeBytes)})` : ''}
                </span>
              </a>
            )}

            {hasSingleHtml && (
              <a
                href={getDownloadUrl(job.id, 'single-html')}
                download={result?.singleHtmlFileName || undefined}
                className={`gn-pill-btn ${!hasZip ? 'gn-pill-primary gn-pill-hero' : ''}`}
                onClick={() => onDownloadTriggered?.()}
                style={hasZip ? { padding: '10px 20px', fontSize: '14px' } : undefined}
              >
                <FileCode2 size={15} strokeWidth={1.9} />
                <span>
                  {hasZip ? 'Or download as a single .html file' : `Download ${appName}.html`}
                  {result?.singleHtmlSizeBytes ? ` (${formatBytes(result.singleHtmlSizeBytes)})` : ''}
                </span>
              </a>
            )}
          </div>
        )}

        <p
          style={{
            margin: '18px auto 0',
            fontSize: '13.5px',
            color: '#525252',
            maxWidth: '480px',
          }}
        >
          {openHint}
        </p>
      </div>

      {/* QUIET OPTIONAL PILL BAR (Collapsed by default) */}
      <div
        style={{
          marginTop: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          maxWidth: '640px',
        }}
      >
        {hasPreview && (
          <button
            type="button"
            className="gn-pill-btn gn-pill-quiet"
            data-active={openPanel === 'preview'}
            onClick={() => handleTogglePanel('preview')}
          >
            <Play size={13} strokeWidth={2} />
            <span>Try it in browser</span>
          </button>
        )}

        <button
          type="button"
          className="gn-pill-btn gn-pill-quiet"
          data-active={openPanel === 'guide'}
          onClick={() => handleTogglePanel('guide')}
        >
          <BookOpen size={13} strokeWidth={1.9} />
          <span>How to open</span>
        </button>

        <button
          type="button"
          className="gn-pill-btn gn-pill-quiet"
          data-active={openPanel === 'xray'}
          onClick={() => handleTogglePanel('xray')}
        >
          <Layers size={13} strokeWidth={1.9} />
          <span>What&apos;s inside</span>
        </button>

        <button
          type="button"
          className="gn-pill-btn gn-pill-quiet"
          data-active={openPanel === 'other-os'}
          onClick={() => handleTogglePanel('other-os')}
        >
          <Monitor size={13} strokeWidth={1.9} />
          <span>Need Windows / Linux / Intel Mac?</span>
        </button>
      </div>

      {/* EXPANDABLE PANEL 1: TRY IT IN BROWSER */}
      {openPanel === 'preview' && hasPreview && (
        <div className="gn-subpanel gn-subpanel-wide" style={{ padding: '14px' }}>
          <div className="gn-preview-shell" data-fullscreen={isFullscreen}>
            <div className="gn-preview-bar">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', fontWeight: 600 }}>
                <span>{appName} preview</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {previewUrl && (
                  <>
                    <button
                      type="button"
                      className="gn-pill-btn gn-pill-sm"
                      onClick={() => setIframeKey((k) => k + 1)}
                    >
                      <RefreshCw size={13} strokeWidth={1.9} />
                      <span>Reload</span>
                    </button>

                    <button
                      type="button"
                      className="gn-pill-btn gn-pill-sm"
                      onClick={() => setIsFullscreen((f) => !f)}
                    >
                      {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
                    </button>

                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="gn-pill-btn gn-pill-sm"
                    >
                      <ExternalLink size={13} strokeWidth={1.9} />
                      <span>New tab</span>
                    </a>
                  </>
                )}

                <button
                  type="button"
                  className="gn-pill-btn gn-pill-sm"
                  onClick={() => {
                    setIsFullscreen(false);
                    handleTogglePanel('preview');
                  }}
                >
                  <X size={13} strokeWidth={2} />
                  <span>Close</span>
                </button>
              </div>
            </div>

            {previewLoading ? (
              <div
                style={{
                  height: '440px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                }}
              >
                <Loader2 size={22} strokeWidth={1.9} className="gn-spin" />
                <div style={{ fontSize: '14px', color: '#525252' }}>Starting {appName}...</div>
              </div>
            ) : previewError ? (
              <div style={{ padding: '40px 24px', textAlign: 'center' }}>
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>Preview couldn&apos;t start</div>
                <div style={{ fontSize: '13.5px', color: '#525252', marginBottom: '14px' }}>
                  {previewError}
                </div>
                <button type="button" className="gn-pill-btn gn-pill-primary gn-pill-sm" onClick={launchPreview}>
                  <span>Try again</span>
                </button>
              </div>
            ) : previewUrl ? (
              <iframe
                key={iframeKey}
                src={previewUrl}
                title={`${appName} preview`}
                className="gn-preview-iframe"
                allow="fullscreen; gamepad; clipboard-read; clipboard-write"
              />
            ) : null}
          </div>
        </div>
      )}

      {/* EXPANDABLE PANEL 2: HOW TO OPEN */}
      {openPanel === 'guide' && (
        <div className="gn-subpanel">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '16px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
              How to open on {osOption.label}
            </h3>
            <button
              type="button"
              className="gn-icon-btn"
              onClick={() => setOpenPanel(null)}
              aria-label="Close guide"
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {afterDownloadSteps.slice(0, 3).map((step, idx) => (
              <div key={idx} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <span
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '9999px',
                    background: '#000000',
                    color: '#ffffff',
                    fontSize: '12px',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: '1px',
                  }}
                >
                  {idx + 1}
                </span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>
                    {step.title}
                  </div>
                  <div style={{ fontSize: '13.5px', color: '#525252', lineHeight: 1.5 }}>
                    {step.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {isMacTarget && (
            <div
              style={{
                marginTop: '18px',
                padding: '16px 18px',
                borderRadius: '14px',
                background: '#f7f7f8',
                fontSize: '13.5px',
                color: '#000000',
                lineHeight: 1.55,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                Downloaded the .zip in your browser and see &ldquo;Apple could not verify...&rdquo;?
              </div>
              <ol style={{ margin: '0 0 12px', paddingLeft: '18px', color: '#525252' }}>
                <li style={{ marginBottom: '4px' }}>
                  Click <strong style={{ color: '#000000' }}>Done</strong> (don&apos;t click Move to
                  Bin).
                </li>
                <li>
                  Open <strong style={{ color: '#000000' }}>System Settings → Privacy &amp; Security</strong>,
                  scroll down, and click <strong style={{ color: '#000000' }}>Open Anyway</strong>.
                </li>
              </ol>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  flexWrap: 'wrap',
                  paddingTop: '10px',
                  borderTop: '1px solid #e5e5e5',
                }}
              >
                <div
                  className="gn-mono"
                  style={{
                    fontSize: '11.5px',
                    color: '#525252',
                    flex: '1 1 220px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={macTerminalCmd}
                >
                  {macTerminalCmd}
                </div>
                <button
                  type="button"
                  className="gn-pill-btn gn-pill-sm"
                  onClick={handleCopyMacCmd}
                >
                  {copiedCmd ? <Check size={12} /> : <Terminal size={12} />}
                  <span>{copiedCmd ? 'Copied command' : 'Copy Terminal open command'}</span>
                </button>
              </div>
            </div>
          )}

          {result?.sha256 && (
            <div
              style={{
                marginTop: '16px',
                paddingTop: '14px',
                borderTop: '1px solid #e5e5e5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '12px', color: '#737373', marginBottom: '2px' }}>
                  File verification (SHA-256)
                </div>
                <div
                  className="gn-mono"
                  style={{
                    fontSize: '11.5px',
                    color: '#525252',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {result.sha256}
                </div>
              </div>
              <button type="button" className="gn-pill-btn gn-pill-sm" onClick={handleCopySha}>
                {copiedSha ? <Check size={12} /> : <Copy size={12} />}
                <span>{copiedSha ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* EXPANDABLE PANEL 3: WHAT'S INSIDE (BUNDLE X-RAY) */}
      {openPanel === 'xray' && (
        <div className="gn-subpanel">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '16px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>What&apos;s inside</h3>
            <button
              type="button"
              className="gn-icon-btn"
              onClick={() => setOpenPanel(null)}
              aria-label="Close bundle details"
            >
              <X size={16} />
            </button>
          </div>

          {breakdownSegments.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '12.5px',
                  color: '#525252',
                  marginBottom: '8px',
                }}
              >
                <span>Package contents</span>
                <span>
                  {formatBytes(result?.breakdown?.totalUncompressedBytes)} unpacked
                  {result?.zipSizeBytes ? ` · ${formatBytes(result.zipSizeBytes)} zip` : ''}
                </span>
              </div>

              <div className="gn-xray-bar" aria-label="Package size breakdown">
                {breakdownSegments
                  .filter((seg) => seg.bytes > 0)
                  .map((seg, idx, arr) => (
                    <div
                      key={seg.id}
                      className={seg.pattern}
                      style={{
                        width: `${Math.max(seg.pct, 2)}%`,
                        borderRight: idx < arr.length - 1 ? '1px solid #000000' : 'none',
                      }}
                      title={`${seg.label}: ${formatBytes(seg.bytes)}`}
                    />
                  ))}
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: '14px',
                  flexWrap: 'wrap',
                  marginTop: '10px',
                  fontSize: '12.5px',
                  color: '#525252',
                }}
              >
                {breakdownSegments.map((seg) => (
                  <span
                    key={seg.id}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <span className={`gn-swatch ${seg.pattern}`} />
                    <span style={{ color: '#000000', fontWeight: 500 }}>{seg.label}</span>
                    <span>{formatBytes(seg.bytes)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {verificationChecks.length > 0 && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>
                Checks passed before packaging
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                {verificationChecks.map((chk) => (
                  <div
                    key={chk.id || chk.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                      fontSize: '13px',
                      padding: '8px 12px',
                      borderRadius: '10px',
                      background: '#f7f7f8',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontWeight: 500 }}>
                      <Check size={14} strokeWidth={2.4} />
                      <span>{chk.name}</span>
                    </span>
                    {chk.detail && (
                      <span style={{ fontSize: '12px', color: '#525252' }}>{chk.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(result?.fileTree) && result!.fileTree.length > 0 && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  marginBottom: '8px',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600 }}>
                  Files ({filteredFiles.length})
                </span>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    border: '1px solid #e5e5e5',
                    borderRadius: '9999px',
                    padding: '4px 12px',
                    background: '#ffffff',
                  }}
                >
                  <Search size={13} color="#737373" />
                  <input
                    type="text"
                    placeholder="Filter files..."
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: '12.5px',
                      width: '150px',
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  border: '1px solid #e5e5e5',
                  borderRadius: '12px',
                  maxHeight: '220px',
                  overflowY: 'auto',
                }}
              >
                {filteredFiles.map((entry, idx) => {
                  const isDir = entry.type === 'dir' || entry.type === 'directory';
                  return (
                    <div
                      key={`${entry.path}-${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        padding: '7px 12px',
                        borderBottom:
                          idx < filteredFiles.length - 1 ? '1px solid #f0f0f0' : 'none',
                        fontSize: '12px',
                      }}
                    >
                      <span
                        className="gn-mono"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '7px',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {isDir ? (
                          <Folder size={13} strokeWidth={1.7} />
                        ) : (
                          <FileCode2 size={13} strokeWidth={1.5} color="#737373" />
                        )}
                        <span>{entry.path}</span>
                      </span>
                      <span className="gn-mono" style={{ color: '#737373', flexShrink: 0 }}>
                        {isDir ? '' : formatBytes(entry.size)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* EXPANDABLE PANEL 4: NEED ANOTHER OS? */}
      {openPanel === 'other-os' && (
        <div className="gn-subpanel" style={{ textAlign: 'center' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '15.5px', fontWeight: 600 }}>
              Package {appName} for a different computer
            </h3>
            <button
              type="button"
              className="gn-icon-btn"
              onClick={() => setOpenPanel(null)}
              aria-label="Close OS selector"
            >
              <X size={16} />
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap',
              justifyContent: 'center',
              marginTop: '10px',
            }}
          >
            {TARGET_OS_OPTIONS.map((opt) => {
              const isCurrent = opt.id === targetOs;
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`gn-pill-btn ${isCurrent ? 'gn-pill-primary' : ''}`}
                  disabled={isCurrent}
                  onClick={() => {
                    setOpenPanel(null);
                    onRepackageForOs(opt.id);
                  }}
                >
                  {isCurrent && <Check size={14} strokeWidth={2.2} />}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
