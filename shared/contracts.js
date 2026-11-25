/**
 * Shared contracts, constants, and stage definitions for GitNoob.
 * Pure ESM with zero external dependencies so server and tooling can import directly.
 */

export const TARGET_OS_OPTIONS = [
  {
    id: 'macos-arm64',
    label: 'macOS (Apple Silicon)',
    shortLabel: 'macOS ARM64',
    platform: 'darwin',
    arch: 'arm64',
    launcherHint: 'Double-click "Open <App>.app" (or START_MAC.command)',
    archiveExt: '.zip',
  },
  {
    id: 'macos-x64',
    label: 'macOS (Intel)',
    shortLabel: 'macOS Intel',
    platform: 'darwin',
    arch: 'x64',
    launcherHint: 'Double-click "Open <App>.app" (or START_MAC.command)',
    archiveExt: '.zip',
  },
  {
    id: 'windows-x64',
    label: 'Windows (64-bit)',
    shortLabel: 'Windows x64',
    platform: 'win32',
    arch: 'x64',
    launcherHint: 'Double-click "Launch <App>.vbs" (or START_WINDOWS.bat)',
    archiveExt: '.zip',
  },
  {
    id: 'linux-x64',
    label: 'Linux (64-bit)',
    shortLabel: 'Linux x64',
    platform: 'linux',
    arch: 'x64',
    launcherHint: 'Run "./START_LINUX.sh" or double-click the desktop launcher',
    archiveExt: '.zip',
  },
];

export const TARGET_OS_IDS = TARGET_OS_OPTIONS.map((o) => o.id);

export const PACKAGE_FORMATS = [
  {
    id: 'bundle-zip',
    label: 'Complete Standalone Bundle (.zip)',
    shortLabel: 'Standalone .zip',
    description:
      'Complete app, dependencies, embedded portable runtime, and native double-click launcher.',
    ext: '.zip',
    mimeType: 'application/zip',
  },
  {
    id: 'single-html',
    label: 'Single-File HTML Artifact (.html)',
    shortLabel: 'Single .html',
    description:
      'Everything inlined into one self-contained HTML file—double-click to open directly in any browser.',
    ext: '.html',
    mimeType: 'text/html; charset=utf-8',
  },
];

export const PACKAGE_FORMAT_IDS = PACKAGE_FORMATS.map((f) => f.id);

export const PIPELINE_STAGES = [
  {
    id: 'clone',
    index: 0,
    label: 'Clone & Inspect',
    description: 'Downloading repository source files and verifying project layout.',
  },
  {
    id: 'install',
    index: 1,
    label: 'Install Dependencies',
    description: 'Installing required packages and libraries into an isolated directory.',
  },
  {
    id: 'build',
    index: 2,
    label: 'Build & Optimize',
    description: 'Compiling assets and preparing the runnable application payload.',
  },
  {
    id: 'runtime',
    index: 3,
    label: 'Bundle Portable Runtime',
    description: 'Attaching a self-contained Node.js or Python runtime for zero-setup execution.',
  },
  {
    id: 'launcher',
    index: 4,
    label: 'Create Native Launcher',
    description: 'Generating OS-native double-click launchers and startup instructions.',
  },
  {
    id: 'verify',
    index: 5,
    label: 'Smoke Test',
    description: 'Verifying runtime execution, launcher permissions, and bundle integrity.',
  },
  {
    id: 'seal',
    index: 6,
    label: 'Seal Package',
    description: 'Compressing the standalone package and computing SHA-256 checksums.',
  },
];

export const STAGE_IDS = PIPELINE_STAGES.map((s) => s.id);

export const JOB_STATUSES = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const PACKAGING_STRATEGIES = [
  'single-html',
  'static-bundle',
  'react-component',
  'node-portable',
  'python-portable',
  'release-only',
];

export const CURATED_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'game', label: 'Games' },
  { id: 'web-app', label: 'Web Apps' },
  { id: 'static-site', label: 'Static Sites' },
  { id: 'python-app', label: 'Python' },
  { id: 'node-app', label: 'Node.js' },
];

export function detectHostTargetOs(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  }
  if (platform === 'win32') {
    return 'windows-x64';
  }
  return 'linux-x64';
}

export function isValidTargetOs(targetOs) {
  return TARGET_OS_IDS.includes(targetOs);
}

export function isValidPackageFormat(format) {
  return PACKAGE_FORMAT_IDS.includes(format);
}
