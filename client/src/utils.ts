import type {
  BundledRuntimeInfo,
  CuratedRepo,
  NormalizedRuntimeEntry,
  PipelineStageDef,
  ReleaseAsset,
  ReleaseInfo,
  TargetOS,
  TargetOSOption,
  VerificationCheck,
  VerificationReport,
} from './types';

export const TARGET_OS_OPTIONS: TargetOSOption[] = [
  {
    id: 'macos-arm64',
    label: 'Mac (Apple Silicon)',
    shortLabel: 'Mac',
    arch: 'M1 – M4',
    launcherHint: 'Open <App>.app',
    detail: 'Apple Silicon Macs (2020 and newer)',
  },
  {
    id: 'macos-x64',
    label: 'Mac (Intel)',
    shortLabel: 'Intel Mac',
    arch: 'Intel',
    launcherHint: 'Open <App>.app',
    detail: 'Older Intel-based Macs',
  },
  {
    id: 'windows-x64',
    label: 'Windows',
    shortLabel: 'Windows',
    arch: '64-bit',
    launcherHint: 'Launch <App>.vbs',
    detail: 'Windows 10 & 11 (64-bit)',
  },
  {
    id: 'linux-x64',
    label: 'Linux',
    shortLabel: 'Linux',
    arch: '64-bit',
    launcherHint: 'START_LINUX.sh',
    detail: 'Linux desktops (64-bit)',
  },
];

export const PIPELINE_STAGES: PipelineStageDef[] = [
  {
    id: 'clone',
    index: 0,
    label: 'Download project files',
    plainDescription: 'Downloading the project files from GitHub...',
    aliases: ['clone', 'fetch', 'inspect', 'prepare', 'init', 'queued'],
  },
  {
    id: 'install',
    index: 1,
    label: 'Install required pieces',
    plainDescription: 'Installing the libraries this app needs...',
    aliases: ['install', 'deps', 'dependencies', 'pip', 'npm'],
  },
  {
    id: 'build',
    index: 2,
    label: 'Prepare app',
    plainDescription: 'Preparing the app so it runs smoothly offline...',
    aliases: ['build', 'compile', 'optimize', 'inline', 'html', 'artifact'],
  },
  {
    id: 'runtime',
    index: 3,
    label: 'Bundle runtime',
    plainDescription: 'Bundling everything it needs to run with zero setup...',
    aliases: ['runtime', 'portable', 'node', 'python', 'embed'],
  },
  {
    id: 'launcher',
    index: 4,
    label: 'Create double-click launcher',
    plainDescription: 'Creating a simple double-click launcher for your computer...',
    aliases: ['launcher', 'launchers', 'app-bundle', 'shortcut'],
  },
  {
    id: 'verify',
    index: 5,
    label: 'Verify it opens cleanly',
    plainDescription: 'Checking that the app opens cleanly before we hand it to you...',
    aliases: ['verify', 'smoke', 'test', 'check', 'xray'],
  },
  {
    id: 'seal',
    index: 6,
    label: 'Wrap up download',
    plainDescription: 'Wrapping up your download...',
    aliases: ['seal', 'archive', 'zip', 'package', 'finalize', 'complete', 'done'],
  },
];

export const DEFAULT_SUGGESTIONS: Array<{ label: string; url: string }> = [
  { label: '2048 Game', url: 'https://github.com/gabrielecirulli/2048' },
  { label: 'Todo Web App', url: 'https://github.com/mdn/todo-react' },
  { label: 'React Color Picker', url: 'https://github.com/omgovich/react-colorful' },
  { label: 'Microblog (Python)', url: 'https://github.com/miguelgrinberg/microblog' },
];

export function pickFourSuggestions(curated: CuratedRepo[]): Array<{ label: string; url: string }> {
  if (!Array.isArray(curated) || curated.length === 0) return DEFAULT_SUGGESTIONS;

  const preferredOrder = [
    { match: 'gabrielecirulli/2048', label: '2048 Game' },
    { match: 'mdn/todo-react', label: 'Todo Web App' },
    { match: 'omgovich/react-colorful', label: 'React Color Picker' },
    { match: 'miguelgrinberg/microblog', label: 'Microblog (Python)' },
  ];

  const picked: Array<{ label: string; url: string }> = [];
  for (const pref of preferredOrder) {
    const found = curated.find((r) => r.url.toLowerCase().includes(pref.match));
    if (found) {
      picked.push({ label: pref.label, url: found.url });
    } else if (pref.match === 'omgovich/react-colorful') {
      picked.push({
        label: pref.label,
        url: 'https://github.com/omgovich/react-colorful',
      });
    }
  }

  for (const repo of curated) {
    if (picked.length >= 4) break;
    if (!picked.some((p) => p.url === repo.url)) {
      picked.push({ label: repo.name, url: repo.url });
    }
  }

  return picked.length > 0 ? picked.slice(0, 4) : DEFAULT_SUGGESTIONS;
}

export function resolveStageIndex(stage?: string, progress?: number): number {
  if (stage) {
    const lower = stage.toLowerCase();
    for (const def of PIPELINE_STAGES) {
      if (def.id === lower || def.aliases.some((alias) => lower.includes(alias))) {
        return def.index;
      }
    }
  }
  if (typeof progress === 'number' && !Number.isNaN(progress)) {
    const clamped = Math.max(0, Math.min(100, progress));
    if (clamped >= 98) return PIPELINE_STAGES.length - 1;
    return Math.min(PIPELINE_STAGES.length - 1, Math.floor((clamped / 100) * PIPELINE_STAGES.length));
  }
  return 0;
}

export function getFriendlyStageSentence(stage?: string, progress?: number): string {
  const idx = resolveStageIndex(stage, progress);
  return PIPELINE_STAGES[Math.min(idx, PIPELINE_STAGES.length - 1)].plainDescription;
}

export function detectUserOS(): TargetOS {
  if (typeof navigator === 'undefined') return 'macos-arm64';
  const ua = (navigator.userAgent || '').toLowerCase();
  const platform = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    ''
  ).toLowerCase();

  if (platform.includes('win') || ua.includes('windows')) {
    return 'windows-x64';
  }
  if (platform.includes('linux') || (ua.includes('linux') && !ua.includes('android'))) {
    return 'linux-x64';
  }
  if (platform.includes('mac') || ua.includes('mac os') || ua.includes('macintosh')) {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl && 'getExtension' in gl) {
        const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          const renderer = String(
            (gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''
          ).toLowerCase();
          if (renderer.includes('intel')) return 'macos-x64';
          if (renderer.includes('apple')) return 'macos-arm64';
        }
      }
    } catch {
      // ignore WebGL errors
    }
    return 'macos-arm64';
  }
  return 'macos-arm64';
}

export function getOSOption(targetOs?: string): TargetOSOption {
  return TARGET_OS_OPTIONS.find((opt) => opt.id === targetOs) || TARGET_OS_OPTIONS[0];
}

export function getFriendlyOsPossessive(targetOs?: string): string {
  if (targetOs === 'windows-x64') return 'your Windows PC';
  if (targetOs === 'linux-x64') return 'Linux';
  if (targetOs === 'macos-x64') return 'your Intel Mac';
  return 'your Mac';
}

export function getOneLineOpenHint(
  targetOs: TargetOS,
  appName: string,
  launcherName?: string | null,
  hasZip?: boolean,
  hasSingleHtml?: boolean
): string {
  if (!hasZip && hasSingleHtml) {
    return `Double-click the downloaded .html file to open ${appName} right in your browser.`;
  }
  if (targetOs === 'windows-x64') {
    const launcher = launcherName || `Launch ${appName}.vbs`;
    return `Extract the folder and double-click ${launcher} — no setup needed.`;
  }
  if (targetOs === 'linux-x64') {
    const launcher = launcherName || 'START_LINUX.sh';
    return `Unzip the folder and run ${launcher} — no setup needed.`;
  }
  const launcher = launcherName || `Open ${appName}.app`;
  return `Unzip the folder and double-click ${launcher} — no setup needed.`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
}

export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return 'Just now';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatBundledRuntimeLabel(runtime?: BundledRuntimeInfo | string | null): string {
  if (!runtime) return 'Self-contained';
  if (typeof runtime === 'string') return runtime;
  const name = runtime.name
    ? runtime.name.toLowerCase().includes('python')
      ? 'Python'
      : runtime.name.toLowerCase().includes('node')
        ? 'Node.js'
        : runtime.name
    : 'Portable runtime';
  return runtime.version ? `${name} ${runtime.version.replace(/^v/i, '')}` : name;
}

export function normalizeVerificationChecks(report?: VerificationReport | null): VerificationCheck[] {
  if (!report) return [];
  if (Array.isArray(report.checks) && report.checks.length > 0) {
    return report.checks.map((c, idx) => ({
      id: c.id || String(idx),
      name: c.name || c.label || 'Verification check',
      passed: Boolean(c.passed),
      detail: c.detail,
    }));
  }
  const derived: VerificationCheck[] = [
    {
      id: 'overall',
      name: 'Pre-download check',
      passed: Boolean(report.passed),
      detail: report.summary || (report.passed ? 'Ready to launch' : 'Check notes'),
    },
  ];
  if (report.runtimeVersion) {
    derived.push({
      id: 'runtime-exec',
      name: 'Bundled runtime check',
      passed: true,
      detail: `Verified ${report.runtimeVersion}`,
    });
  }
  if (report.httpStatus) {
    derived.push({
      id: 'http-boot',
      name: 'App startup check',
      passed: report.httpStatus >= 200 && report.httpStatus < 400,
      detail: `Responded cleanly (HTTP ${report.httpStatus})`,
    });
  }
  return derived;
}

export function normalizeReleaseAssets(releases?: ReleaseInfo[]): Array<{
  releaseName: string;
  tagName: string;
  htmlUrl?: string;
  asset: ReleaseAsset;
  downloadUrl: string;
}> {
  if (!Array.isArray(releases)) return [];
  const items: Array<{
    releaseName: string;
    tagName: string;
    htmlUrl?: string;
    asset: ReleaseAsset;
    downloadUrl: string;
  }> = [];

  for (const rel of releases) {
    const tag = rel.tagName || rel.tag_name || 'Release';
    const releaseName = rel.name || tag;
    const htmlUrl = rel.htmlUrl || rel.html_url;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    for (const asset of assets) {
      const downloadUrl = asset.downloadUrl || asset.browser_download_url || asset.url || '';
      if (downloadUrl) {
        items.push({ releaseName, tagName: tag, htmlUrl, asset, downloadUrl });
      }
    }
  }
  return items;
}

export function normalizeRuntimesResponse(raw: unknown): NormalizedRuntimeEntry[] {
  const entries: NormalizedRuntimeEntry[] = [];

  const pushEntry = (item: Record<string, unknown>, fallbackRuntime?: string, fallbackOs?: string) => {
    const runtime = String(item.runtime || item.name || item.engine || fallbackRuntime || 'node').toLowerCase();
    const targetOs = String(item.targetOs || item.os || item.platform || fallbackOs || 'macos-arm64');
    const version = String(item.version || (runtime === 'python' ? '3.12' : '22.14.0'));
    const cached = Boolean(item.cached ?? item.available ?? item.installed ?? item.exists ?? false);
    const sizeBytes =
      typeof item.sizeBytes === 'number'
        ? item.sizeBytes
        : typeof item.size === 'number'
          ? item.size
          : null;
    const approxCompressedMB =
      typeof item.approxCompressedMB === 'number' ? item.approxCompressedMB : null;
    entries.push({
      key: `${runtime}-${targetOs}`,
      runtime,
      label: runtime === 'python' ? 'Portable Python' : runtime === 'node' ? 'Portable Node.js' : runtime,
      version,
      targetOs,
      cached,
      sizeBytes,
      approxCompressedMB,
      path: typeof item.path === 'string' ? item.path : typeof item.archivePath === 'string' ? item.archivePath : null,
      updatedAt:
        typeof item.cachedAt === 'string'
          ? item.cachedAt
          : typeof item.updatedAt === 'string'
            ? item.updatedAt
            : typeof item.mtime === 'string'
              ? item.mtime
              : null,
    });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') {
        pushEntry(item as Record<string, unknown>);
      }
    }
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.entries)) {
      for (const item of obj.entries) {
        if (item && typeof item === 'object') pushEntry(item as Record<string, unknown>);
      }
    } else if (Array.isArray(obj.items)) {
      for (const item of obj.items) {
        if (item && typeof item === 'object') pushEntry(item as Record<string, unknown>);
      }
    }
  }

  const byKey = new Map<string, NormalizedRuntimeEntry>();
  for (const e of entries) {
    byKey.set(e.key, e);
  }

  const defaults: Array<{ runtime: 'node' | 'python'; label: string; version: string }> = [
    { runtime: 'node', label: 'Portable Node.js', version: '22.14.0' },
    { runtime: 'python', label: 'Portable Python', version: '3.12.9' },
  ];

  const matrix: NormalizedRuntimeEntry[] = [];
  for (const def of defaults) {
    for (const osOpt of TARGET_OS_OPTIONS) {
      const key = `${def.runtime}-${osOpt.id}`;
      const existing = byKey.get(key);
      if (existing) {
        matrix.push(existing);
        byKey.delete(key);
      } else {
        matrix.push({
          key,
          runtime: def.runtime,
          label: def.label,
          version: def.version,
          targetOs: osOpt.id,
          cached: false,
          sizeBytes: null,
          approxCompressedMB: null,
          path: null,
          updatedAt: null,
        });
      }
    }
  }
  for (const extra of byKey.values()) {
    matrix.push(extra);
  }
  return matrix;
}

export function buildDefaultAfterDownloadSteps(
  targetOs: TargetOS,
  appName: string,
  launcherName?: string | null,
  hasSingleHtml?: boolean,
  format?: string
): Array<{ title: string; detail: string }> {
  if (format === 'single-html' && hasSingleHtml) {
    return [
      {
        title: 'Find your downloaded .html file',
        detail: `Look in your Downloads folder for the ${appName} HTML file.`,
      },
      {
        title: 'Double-click to open it',
        detail: 'It opens right in your web browser—everything it needs is saved inside that single file.',
      },
      {
        title: 'Keep or share it anywhere',
        detail: 'Move it to your Desktop or share it with a friend. Works offline with zero installation.',
      },
    ];
  }

  if (targetOs === 'macos-arm64' || targetOs === 'macos-x64') {
    const launcher = launcherName || `Open ${appName}.app`;
    return [
      {
        title: 'Save directly to your Downloads folder',
        detail:
          'Using "Save to Downloads" unpacks the app straight to ~/Downloads/GitNoob so it opens immediately with no Apple security warning.',
      },
      {
        title: `Double-click "${launcher}"`,
        detail:
          'The app starts automatically using everything bundled inside—no extra installs required.',
      },
      {
        title: 'If you downloaded the .zip in your browser instead',
        detail:
          'If macOS says "Apple could not verify...", click Done (don\'t click Move to Bin), then open System Settings → Privacy & Security, scroll down, and click Open Anyway.',
      },
    ];
  }

  if (targetOs === 'windows-x64') {
    const launcher = launcherName || `Launch ${appName}.vbs`;
    return [
      {
        title: 'Extract all files from the .zip',
        detail: 'Right-click the downloaded .zip file and pick "Extract All..." before opening.',
      },
      {
        title: `Double-click "${launcher}"`,
        detail: 'Launches cleanly using the bundled runtime—no Node.js or Python installation needed.',
      },
      {
        title: 'Want to see startup details?',
        detail: 'Double-click START_WINDOWS.bat anytime if you want to see live startup output.',
      },
    ];
  }

  const launcher = launcherName || 'START_LINUX.sh';
  return [
    {
      title: 'Unzip the downloaded folder',
      detail: 'Extract the .zip archive into any folder on your computer.',
    },
    {
      title: `Open "${launcher}"`,
      detail: 'Double-click the desktop shortcut or run ./START_LINUX.sh. Everything needed is already bundled.',
    },
    {
      title: 'Move it anywhere',
      detail: 'The whole folder is completely portable and works offline.',
    },
  ];
}

export function buildMacTerminalOpenCommand(
  zipFileName?: string | null,
  appName?: string,
  launcherName?: string | null
): string {
  const folder = zipFileName
    ? zipFileName.replace(/\.zip$/i, '')
    : (appName || 'app').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const launcher = launcherName || `Open ${appName || 'App'}.app`;
  return `xattr -dr com.apple.quarantine ~/Downloads/${folder} && open ~/Downloads/${folder}/"${launcher}"`;
}
