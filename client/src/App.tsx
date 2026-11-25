import { AlertCircle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeRepo,
  deleteJob,
  fetchCurated,
  fetchHealth,
  fetchJob,
  fetchJobs,
  fetchRuntimes,
  startPackageJob,
  subscribeToJobEvents,
} from './api';
import { ArtifactWorkspace } from './components/ArtifactWorkspace';
import { BuildPipeline } from './components/BuildPipeline';
import { ComposerBar } from './components/ComposerBar';
import { ConfirmStep } from './components/ConfirmStep';
import { LibraryView } from './components/LibraryView';
import { Navbar } from './components/Navbar';
import type {
  CuratedRepo,
  JobLogEntry,
  NormalizedRuntimeEntry,
  PackageJob,
  RepoAnalysis,
  TargetOS,
} from './types';
import { detectUserOS, getFriendlyOsPossessive, pickFourSuggestions } from './utils';

type Screen = 'home' | 'checking' | 'confirm' | 'packaging' | 'artifact' | 'downloads';

export default function App() {
  const [detectedOs] = useState<TargetOS>(() => detectUserOS());
  const [selectedOs, setSelectedOs] = useState<TargetOS>(detectedOs);
  const [screen, setScreen] = useState<Screen>('home');

  // Data
  const [curated, setCurated] = useState<CuratedRepo[]>([]);
  const [jobs, setJobs] = useState<PackageJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [runtimes, setRuntimes] = useState<NormalizedRuntimeEntry[]>([]);
  const [supportsLocalSave, setSupportsLocalSave] = useState(false);

  // Composer & analysis
  const [urlInput, setUrlInput] = useState('');
  const [dockUrlInput, setDockUrlInput] = useState('');
  const [checkingLabel, setCheckingLabel] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RepoAnalysis | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [isStartingPackage, setIsStartingPackage] = useState(false);

  // Active packaging job & artifact
  const [activeJob, setActiveJob] = useState<PackageJob | null>(null);
  const [jobProgress, setJobProgress] = useState(0);
  const [jobStage, setJobStage] = useState<string | undefined>(undefined);
  const [jobMessage, setJobMessage] = useState('');
  const [jobLogs, setJobLogs] = useState<JobLogEntry[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  const cleanupStream = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const list = await fetchJobs();
      setJobs(list);
    } catch {
      // ignore
    } finally {
      setJobsLoading(false);
    }
  }, []);

  const refreshRuntimes = useCallback(async () => {
    try {
      const { entries } = await fetchRuntimes();
      setRuntimes(entries);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshJobs();
    refreshRuntimes();
    fetchHealth()
      .then((h) => setSupportsLocalSave(Boolean(h.supportsLocalSave)))
      .catch(() => setSupportsLocalSave(false));
    fetchCurated()
      .then((repos) => setCurated(repos))
      .catch(() => setCurated([]));

    return () => cleanupStream();
  }, [refreshJobs, refreshRuntimes, cleanupStream]);

  const suggestions = useMemo(() => pickFourSuggestions(curated), [curated]);

  const watchJob = useCallback(
    (job: PackageJob) => {
      cleanupStream();
      setActiveJob(job);
      setJobProgress(job.progress ?? 8);
      setJobStage(job.stage);
      setJobMessage(job.message || 'Starting...');
      setJobError(job.status === 'failed' ? job.error || 'Packaging failed' : null);

      const initialLogs: JobLogEntry[] = Array.isArray(job.logs)
        ? job.logs.map((entry) => (typeof entry === 'string' ? { message: entry } : entry))
        : [];
      setJobLogs(initialLogs);

      if (job.status === 'completed') {
        setScreen('artifact');
        return;
      }

      setScreen('packaging');
      if (job.status === 'failed' || job.status === 'cancelled') return;

      unsubscribeRef.current = subscribeToJobEvents(job.id, {
        onProgress: (ev) => {
          if (typeof ev.percent === 'number') setJobProgress(ev.percent);
          if (ev.stage) setJobStage(ev.stage);
          if (ev.message) setJobMessage(ev.message);
        },
        onLog: (entry) => {
          setJobLogs((prev) => [...prev.slice(-399), entry]);
        },
        onComplete: (completedJob) => {
          setActiveJob(completedJob);
          setJobProgress(100);
          setJobMessage('Ready to download');
          setScreen('artifact');
          setDockUrlInput('');
          refreshJobs();
          refreshRuntimes();
        },
        onError: (errMsg, failedJob) => {
          if (failedJob) setActiveJob(failedJob);
          setJobError(errMsg);
          refreshJobs();
        },
      });
    },
    [cleanupStream, refreshJobs, refreshRuntimes]
  );

  const launchPackageForAnalysis = useCallback(
    async (
      repoAnalysis: RepoAnalysis,
      targetOs: TargetOS,
      customEnv?: Record<string, string>
    ) => {
      setIsStartingPackage(true);
      setErrorMessage(null);
      setJobError(null);

      const cleanedEnv: Record<string, string> = {};
      if (customEnv) {
        for (const [k, v] of Object.entries(customEnv)) {
          if (v.trim() !== '') cleanedEnv[k] = v;
        }
      }

      try {
        const job = await startPackageJob({
          url: repoAnalysis.canonicalUrl,
          analysis: repoAnalysis,
          targetOs,
          format: 'bundle-zip',
          envVars: Object.keys(cleanedEnv).length > 0 ? cleanedEnv : undefined,
          includeRuntime: true,
        });
        refreshJobs();
        watchJob(job);
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not start packaging this repository.'
        );
        setScreen('home');
      } finally {
        setIsStartingPackage(false);
      }
    },
    [refreshJobs, watchJob]
  );

  // Effortless Auto-Flow: paste link -> analyze -> automatically package unless release-only or required .env!
  const handleStartFromUrl = useCallback(
    async (overrideUrl?: string, osOverride?: TargetOS) => {
      const target = (overrideUrl ?? urlInput).trim();
      if (!target) return;

      const targetOs = osOverride ?? selectedOs;
      if (overrideUrl) setUrlInput(overrideUrl);

      cleanupStream();
      setErrorMessage(null);
      setJobError(null);
      setPreviewExpanded(false);
      setCheckingLabel(target.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/$/, ''));
      setScreen('checking');

      try {
        const result = await analyzeRepo(target);
        setAnalysis(result);

        const initialEnv: Record<string, string> = {};
        if (Array.isArray(result.envVars)) {
          for (const v of result.envVars) {
            initialEnv[v.key] = v.defaultValue || '';
          }
        }
        setEnvValues(initialEnv);

        const isReleaseOnly = result.packagingStrategy === 'release-only';
        const hasRequiredEnv =
          Array.isArray(result.envVars) && result.envVars.some((v) => Boolean(v.required));

        if (isReleaseOnly || hasRequiredEnv) {
          setScreen('confirm');
          return;
        }

        // Automatically start packaging right away!
        await launchPackageForAnalysis(result, targetOs);
      } catch (err) {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'We could not open that GitHub link. Please double-check the URL and try again.'
        );
        setScreen('home');
      }
    },
    [urlInput, selectedOs, cleanupStream, launchPackageForAnalysis]
  );

  const handleResetHome = useCallback(() => {
    cleanupStream();
    setScreen('home');
    setUrlInput('');
    setDockUrlInput('');
    setErrorMessage(null);
    setJobError(null);
    setPreviewExpanded(false);
  }, [cleanupStream]);

  const handleOpenArtifactFromLibrary = useCallback(
    async (job: PackageJob) => {
      setErrorMessage(null);
      setPreviewExpanded(false);
      try {
        const fresh = await fetchJob(job.id);
        if (fresh.analysis) setAnalysis(fresh.analysis);
        setSelectedOs(fresh.targetOs || detectedOs);
        watchJob(fresh);
      } catch {
        if (job.analysis) setAnalysis(job.analysis);
        setSelectedOs(job.targetOs || detectedOs);
        watchJob(job);
      }
    },
    [detectedOs, watchJob]
  );

  const handleDeleteJob = useCallback(
    async (id: string) => {
      await deleteJob(id);
      if (activeJob?.id === id) {
        cleanupStream();
        setActiveJob(null);
      }
      await refreshJobs();
    },
    [activeJob?.id, cleanupStream, refreshJobs]
  );

  const handleRepackageForOs = useCallback(
    (nextOs: TargetOS) => {
      setSelectedOs(nextOs);
      if (analysis) {
        launchPackageForAnalysis(analysis, nextOs, envValues);
      } else if (activeJob?.url) {
        handleStartFromUrl(activeJob.url, nextOs);
      }
    },
    [analysis, envValues, activeJob?.url, launchPackageForAnalysis, handleStartFromUrl]
  );

  const completedCount = jobs.filter((j) => j.status === 'completed').length;
  const showingDownloads = screen === 'downloads';

  return (
    <div className="gn-shell">
      <Navbar
        showingDownloads={showingDownloads}
        downloadCount={completedCount || jobs.length}
        onBrandClick={handleResetHome}
        onToggleDownloads={() => {
          if (showingDownloads) {
            setScreen(activeJob && activeJob.status === 'completed' ? 'artifact' : 'home');
          } else {
            refreshJobs();
            refreshRuntimes();
            setScreen('downloads');
          }
        }}
      />

      <main className="gn-main">
        {/* CENTERED HOME SCREEN (ChatGPT-style) */}
        {screen === 'home' && (
          <div className="gn-center-stage">
            <h1 className="gn-landing-title">What GitHub app do you want to try?</h1>
            <p className="gn-landing-subtitle">
              Games, web apps, and tools—ready to open on your computer with zero coding.
            </p>

            <ComposerBar
              url={urlInput}
              onUrlChange={setUrlInput}
              selectedOs={selectedOs}
              detectedOs={detectedOs}
              onSelectOs={setSelectedOs}
              onSubmit={() => handleStartFromUrl()}
              isBusy={false}
              variant="hero"
            />

            {errorMessage && (
              <div className="gn-error-box" role="alert">
                <AlertCircle size={18} strokeWidth={1.85} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '2px' }}>Couldn&apos;t load that link</div>
                  <div style={{ color: '#525252' }}>{errorMessage}</div>
                </div>
              </div>
            )}

            <div className="gn-chips-row" aria-label="Quick examples">
              {suggestions.map((chip) => (
                <button
                  key={chip.url}
                  type="button"
                  className="gn-chip"
                  onClick={() => handleStartFromUrl(chip.url)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* CHECKING STATE (Brief calm transition while POST /api/analyze runs) */}
        {screen === 'checking' && (
          <div className="gn-center-stage">
            <div className="gn-card" style={{ maxWidth: '520px', textAlign: 'center', padding: '40px 28px' }}>
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
              <h2
                style={{
                  margin: '0 0 8px',
                  fontSize: '22px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                }}
              >
                Looking at {checkingLabel || 'repository'}...
              </h2>
              <p style={{ margin: 0, fontSize: '14.5px', color: '#525252' }}>
                Getting everything ready for {getFriendlyOsPossessive(selectedOs)}.
              </p>
            </div>
          </div>
        )}

        {/* OPTIONAL CONFIRM STEP (Only for release-only repos or repos with required API keys) */}
        {screen === 'confirm' && analysis && (
          <div className="gn-flow-stage">
            <ConfirmStep
              analysis={analysis}
              selectedOs={selectedOs}
              envValues={envValues}
              onEnvChange={(key, val) => setEnvValues((prev) => ({ ...prev, [key]: val }))}
              onContinuePackage={() => launchPackageForAnalysis(analysis, selectedOs, envValues)}
              onCancel={handleResetHome}
              isStarting={isStartingPackage}
            />
          </div>
        )}

        {/* PACKAGING PROGRESS (Calm centered card) */}
        {screen === 'packaging' && activeJob && (
          <div className="gn-flow-stage">
            <BuildPipeline
              job={activeJob}
              progress={jobProgress}
              stage={jobStage}
              message={jobMessage}
              logs={jobLogs}
              error={jobError}
              onRetry={() => {
                if (analysis) {
                  launchPackageForAnalysis(analysis, selectedOs, envValues);
                } else {
                  handleStartFromUrl(activeJob.url, activeJob.targetOs);
                }
              }}
              onReset={handleResetHome}
            />
          </div>
        )}

        {/* CENTRAL DOWNLOAD STAGE */}
        {screen === 'artifact' && activeJob && (
          <>
            <div className={`gn-flow-stage ${previewExpanded ? 'gn-flow-stage-wide' : ''}`}>
              <ArtifactWorkspace
                job={activeJob}
                detectedOs={detectedOs}
                supportsLocalSave={supportsLocalSave}
                onRepackageForOs={handleRepackageForOs}
                onDownloadTriggered={() => window.setTimeout(refreshJobs, 700)}
                onPreviewActiveChange={setPreviewExpanded}
              />
            </div>

            <ComposerBar
              url={dockUrlInput}
              onUrlChange={setDockUrlInput}
              selectedOs={selectedOs}
              detectedOs={detectedOs}
              onSelectOs={setSelectedOs}
              onSubmit={() => {
                const next = dockUrlInput.trim();
                if (!next) return;
                setDockUrlInput('');
                handleStartFromUrl(next);
              }}
              isBusy={false}
              variant="dock"
            />
          </>
        )}

        {/* MY DOWNLOADS VIEW */}
        {screen === 'downloads' && (
          <LibraryView
            jobs={jobs}
            runtimes={runtimes}
            loading={jobsLoading}
            onRefresh={() => {
              refreshJobs();
              refreshRuntimes();
            }}
            onOpenArtifact={handleOpenArtifactFromLibrary}
            onDeleteJob={handleDeleteJob}
            onGoHome={handleResetHome}
          />
        )}
      </main>
    </div>
  );
}
