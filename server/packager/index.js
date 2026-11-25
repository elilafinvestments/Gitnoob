import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ensureRuntime,
  installRuntimeIntoBundle,
  getRuntimeCacheStatus,
  getHostTargetOs,
} from './runtimes.js';
import { cloneAndBuild } from './builder.js';
import { buildSingleHtmlArtifact } from './htmlInliner.js';
import { createLaunchers, buildAfterDownloadSteps } from './launchers.js';
import { verifyAndInspectBundle } from './verifier.js';
import { archiveBundle } from './archiver.js';
import { buildArtifactEmblemSvg, generateNativeIcons } from './emblem.js';

const STAGE_LABELS = {
  clone: 'Clone & Inspect',
  install: 'Install Dependencies',
  build: 'Build & Optimize',
  runtime: 'Bundle Portable Runtime',
  launcher: 'Create Native Launcher',
  verify: 'Smoke Test',
  seal: 'Seal Package',
};

function slugify(value) {
  return (
    String(value || 'app')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'app'
  );
}

/**
 * Packages a GitHub repository into a self-contained, double-click ready download
 * (with bundled portable runtime, native OS launchers, automated smoke test,
 * and single-file HTML artifact when eligible).
 */
export async function packageRepository({
  jobId,
  analysis,
  targetOs = getHostTargetOs(),
  format = 'bundle-zip',
  envVars = {},
  includeRuntime = true,
  dataDir,
  onProgress,
}) {
  if (!jobId) throw new Error('jobId is required');
  if (!analysis || !analysis.repo) throw new Error('analysis with repo metadata is required');
  if (!dataDir) throw new Error('dataDir is required');

  const safeTargetOs = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64'].includes(targetOs)
    ? targetOs
    : getHostTargetOs();

  const slug = slugify(analysis.repo || analysis.name);
  const buildRoot = path.join(dataDir, 'builds', jobId);
  const stageDir = path.join(buildRoot, `${slug}-${safeTargetOs}`);
  const packagesOutDir = path.join(dataDir, 'packages', jobId);

  await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(stageDir, { recursive: true });
  await fsp.mkdir(packagesOutDir, { recursive: true });

  const emitProgress = (stage, percent, message) => {
    if (typeof onProgress === 'function') {
      onProgress({
        type: 'progress',
        stage,
        stageLabel: STAGE_LABELS[stage] || stage,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        message,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const emitLog = (message, stream = 'stdout', stage = 'build') => {
    if (typeof onProgress === 'function') {
      onProgress({
        type: 'log',
        stage,
        stream,
        message,
        timestamp: new Date().toISOString(),
      });
    }
  };

  // --- STAGES 1–3: Clone, Install Dependencies, Build & Optimize ---
  let currentStage = 'clone';
  const buildResult = await cloneAndBuild({
    jobId,
    analysis,
    targetOs: safeTargetOs,
    envVars,
    dataDir,
    stageDir,
    onStageProgress: (stage, percent, message) => {
      currentStage = stage;
      emitProgress(stage, percent, message);
    },
    onLog: (line, stream) => emitLog(line, stream, currentStage),
  });

  // Generate bespoke GitNoob artifact emblem SVG for native icons, READ_ME_FIRST, HTML favicon, and UI
  const emblemSvg = buildArtifactEmblemSvg({
    appName: analysis.name || analysis.repo || slug,
    category: analysis.category,
    framework: analysis.framework,
    packagingStrategy: analysis.packagingStrategy,
  });

  // Generate Single-File HTML Artifact whenever the staged app is static
  let singleHtmlArtifact = null;
  if (buildResult.appMode === 'static') {
    emitProgress('build', 55, 'Generating single-file HTML artifact...');
    try {
      singleHtmlArtifact = await buildSingleHtmlArtifact({
        appDir: buildResult.appDir,
        outDir: packagesOutDir,
        slug,
        emblemSvg,
      });
      if (singleHtmlArtifact) {
        emitLog(
          `Single-file artifact created: ${singleHtmlArtifact.fileName} (${(singleHtmlArtifact.sizeBytes / 1024).toFixed(1)} KB, ${singleHtmlArtifact.inlinedAssetsCount} assets inlined)`,
          'stdout',
          'build',
        );
      }
    } catch (err) {
      emitLog(`Single-file HTML inlining skipped: ${err.message}`, 'stderr', 'build');
    }
  }

  // --- STAGE 4: Bundle Portable Runtime ---
  let bundledRuntimeInfo = null;
  const shouldBundleRuntime = includeRuntime !== false;
  if (shouldBundleRuntime) {
    const runtimeName = buildResult.runtimeNeeded === 'python' ? 'python' : 'node';
    emitProgress('runtime', 58, `Preparing portable ${runtimeName === 'python' ? 'Python' : 'Node.js'} runtime for ${safeTargetOs}...`);

    const ensured = await ensureRuntime(runtimeName, safeTargetOs, dataDir, (evt) => {
      const scaledPercent = evt.percent != null ? 58 + Math.round((evt.percent / 100) * 10) : 62;
      emitProgress('runtime', scaledPercent, evt.message);
      emitLog(evt.message, 'stdout', 'runtime');
    });

    emitProgress('runtime', 69, `Extracting lean ${ensured.name} v${ensured.version} into bundle...`);
    bundledRuntimeInfo = await installRuntimeIntoBundle(ensured, stageDir, (evt) => {
      emitLog(evt.message, 'stdout', 'runtime');
    });

    emitProgress(
      'runtime',
      74,
      `Bundled ${bundledRuntimeInfo.name} v${bundledRuntimeInfo.version} (${(bundledRuntimeInfo.installedBytes / (1024 * 1024)).toFixed(1)} MB uncompressed).`,
    );
  } else {
    emitProgress('runtime', 74, 'Portable runtime skipped (using lightweight package mode).');
  }

  // --- STAGE 5: Create Native Double-Click Launchers ---
  emitProgress('launcher', 76, `Generating native ${safeTargetOs} double-click launcher & bespoke emblem...`);
  const launcherInfo = await createLaunchers({
    stageDir,
    analysis,
    slug,
    targetOs: safeTargetOs,
    buildResult,
    bundledRuntime: bundledRuntimeInfo,
    emblemSvg,
    dataDir,
  });
  emitLog(`Created native launcher: ${launcherInfo.launcherName}`, 'stdout', 'launcher');
  emitProgress('launcher', 82, `Created ${launcherInfo.launcherName} and READ_ME_FIRST.html.`);

  // --- STAGE 6: Automated Smoke Test & Bundle X-Ray ---
  emitProgress('verify', 84, 'Running automated pre-download smoke test & bundle X-Ray...');
  const { verification, breakdown, fileTree } = await verifyAndInspectBundle({
    stageDir,
    targetOs: safeTargetOs,
    buildResult,
    bundledRuntime: bundledRuntimeInfo,
    launcherInfo,
  });

  for (const check of verification.checks) {
    emitLog(`[${check.passed ? 'PASS' : 'WARN'}] ${check.label}: ${check.detail}`, check.passed ? 'stdout' : 'stderr', 'verify');
  }
  emitProgress('verify', 91, verification.summary);

  // --- STAGE 7: Seal Package (.zip) & SHA-256 ---
  emitProgress('seal', 93, `Sealing ${slug}-${safeTargetOs}.zip archive...`);
  const archiveInfo = await archiveBundle({
    stageDir,
    outDir: packagesOutDir,
    slug,
    targetOs: safeTargetOs,
  });
  emitLog(
    `Archive sealed: ${archiveInfo.zipFileName} (${(archiveInfo.zipSizeBytes / (1024 * 1024)).toFixed(2)} MB, SHA-256: ${archiveInfo.sha256.slice(0, 16)}...)`,
    'stdout',
    'seal',
  );
  emitProgress('seal', 100, 'Package ready to download.');

  // Clean up cloned source & temporary harness directories while keeping stageDir intact for live preview
  await fsp.rm(path.join(buildRoot, 'src'), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(buildRoot, 'harness'), { recursive: true, force: true }).catch(() => {});

  const afterDownloadSteps = buildAfterDownloadSteps({
    targetOs: safeTargetOs,
    launcherName: launcherInfo.launcherName,
    cleanName: launcherInfo.cleanName,
    format,
    singleHtmlFileName: singleHtmlArtifact?.fileName || null,
  });

  return {
    jobId,
    targetOs: safeTargetOs,
    format,
    zipPath: archiveInfo.zipPath,
    zipFileName: archiveInfo.zipFileName,
    zipSizeBytes: archiveInfo.zipSizeBytes,
    sha256: archiveInfo.sha256,
    singleHtmlPath: singleHtmlArtifact?.path || null,
    singleHtmlFileName: singleHtmlArtifact?.fileName || null,
    singleHtmlSizeBytes: singleHtmlArtifact?.sizeBytes || 0,
    previewDir: buildResult.previewDir,
    previewType: buildResult.previewType,
    previewEntry: buildResult.previewEntry,
    bundledRuntime: bundledRuntimeInfo
      ? {
          runtime: bundledRuntimeInfo.runtime,
          name: bundledRuntimeInfo.name,
          version: bundledRuntimeInfo.version,
          targetOs: bundledRuntimeInfo.targetOs,
          source: bundledRuntimeInfo.source,
          relativeBinPath: bundledRuntimeInfo.relativeBinPath,
          sizeBytes: bundledRuntimeInfo.installedBytes,
        }
      : null,
    launcherName: launcherInfo.launcherName,
    emblemSvg,
    verification,
    breakdown,
    fileTree,
    afterDownloadSteps,
  };
}

export { getRuntimeCacheStatus, buildArtifactEmblemSvg, generateNativeIcons };
