export type TargetOS = 'macos-arm64' | 'macos-x64' | 'windows-x64' | 'linux-x64';
export type PackageFormat = 'bundle-zip' | 'single-html';
export type NavTab = 'package' | 'downloads' | 'runtimes';

export interface TargetOSOption {
  id: TargetOS;
  label: string;
  shortLabel: string;
  arch: string;
  launcherHint: string;
  detail: string;
}

export interface HealthStatus {
  ok: boolean;
  hostOs?: string;
  arch?: string;
  nodeVersion?: string;
  pythonAvailable?: boolean;
  pythonVersion?: string | null;
  runtimeCache?: unknown;
  supportsLocalSave?: boolean;
  localSaveBaseDir?: string;
}

export interface LocalSaveResult {
  ok: boolean;
  savedPath: string;
  displayPath: string;
  launcherPath?: string | null;
  launcherName?: string | null;
  openedInFinder?: boolean;
  launched?: boolean;
}

export interface CuratedRepo {
  id?: string;
  url: string;
  owner?: string;
  repo?: string;
  name: string;
  tagline?: string;
  description?: string;
  category: string;
  categoryLabel?: string;
  framework?: string;
  stars?: number;
  highlight?: string;
}

export interface RequiredRuntime {
  name: string;
  version?: string;
  reason?: string;
  sizeMB?: number;
}

export interface PlainEnglishInfo {
  summary: string;
  whatYouGet: string;
  howToRun: string[];
  controlsOrTips?: string[] | string | null;
}

export interface DetectedFiles {
  hasPackageJson?: boolean;
  hasIndexHtml?: boolean;
  hasRequirementsTxt?: boolean;
  hasPyprojectToml?: boolean;
  hasDockerfile?: boolean;
  hasEnvExample?: boolean;
  entryPoint?: string | null;
  buildScript?: string | null;
  startScript?: string | null;
  outputDir?: string | null;
  packageManager?: string | null;
  componentFiles?: string[];
}

export interface EnvVarSpec {
  key: string;
  defaultValue?: string;
  description?: string;
  required?: boolean;
}

export interface ReleaseAsset {
  name: string;
  downloadUrl?: string;
  browser_download_url?: string;
  url?: string;
  size?: number;
  contentType?: string;
}

export interface ReleaseInfo {
  tagName?: string;
  tag_name?: string;
  name?: string;
  publishedAt?: string;
  published_at?: string;
  htmlUrl?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

export interface CompatibilityInfo {
  score: number;
  label: string;
  reason?: string;
}

export interface EstimatedSizeMB {
  app: number;
  runtime: number;
  total: number;
}

export interface RepoAnalysis {
  id?: string;
  owner: string;
  repo: string;
  branch?: string | null;
  subdir?: string | null;
  canonicalUrl: string;
  name: string;
  description?: string;
  stars?: number;
  forks?: number;
  license?: string | null;
  defaultBranch?: string;
  updatedAt?: string;
  homepage?: string | null;
  topics?: string[];
  category: string;
  categoryLabel: string;
  framework: string;
  packagingStrategy:
    | 'single-html'
    | 'static-bundle'
    | 'react-component'
    | 'node-portable'
    | 'python-portable'
    | 'release-only'
    | string;
  supportsSingleHtml?: boolean;
  supportsLivePreview?: boolean;
  requiredRuntime?: RequiredRuntime | null;
  plainEnglish?: PlainEnglishInfo;
  detectedFiles?: DetectedFiles;
  envVars?: EnvVarSpec[];
  releases?: ReleaseInfo[];
  warnings?: string[];
  compatibility?: CompatibilityInfo;
  estimatedSizeMB?: EstimatedSizeMB;
}

export interface VerificationCheck {
  id?: string;
  name?: string;
  label?: string;
  passed: boolean;
  detail?: string;
}

export interface VerificationReport {
  passed: boolean;
  summary?: string;
  checks?: VerificationCheck[];
  runtimeVersion?: string | null;
  httpStatus?: number | null;
}

export interface BundleBreakdown {
  appCodeBytes: number;
  dependenciesBytes: number;
  runtimeBytes: number;
  launcherBytes: number;
  totalUncompressedBytes: number;
}

export interface FileTreeEntry {
  path: string;
  type?: 'file' | 'dir' | 'directory' | string;
  size?: number;
  category?: 'app' | 'dependencies' | 'runtime' | 'launcher' | string;
}

export interface BundledRuntimeInfo {
  name?: string;
  version?: string;
  targetOs?: string;
  source?: string;
  sizeBytes?: number;
}

export interface PackageResult {
  jobId?: string;
  targetOs?: TargetOS;
  format?: PackageFormat;
  zipPath?: string | null;
  zipFileName?: string | null;
  zipSizeBytes?: number | null;
  sha256?: string | null;
  singleHtmlPath?: string | null;
  singleHtmlFileName?: string | null;
  singleHtmlSizeBytes?: number | null;
  previewDir?: string | null;
  previewType?: 'static' | 'node' | 'python' | string | null;
  previewEntry?: string | null;
  bundledRuntime?: BundledRuntimeInfo | string | null;
  launcherName?: string | null;
  verification?: VerificationReport | null;
  breakdown?: BundleBreakdown | null;
  fileTree?: FileTreeEntry[];
  afterDownloadSteps?: Array<string | { title?: string; description?: string; step?: string }>;
  emblemSvg?: string | null;
}

export interface JobProgressEvent {
  stage?: string;
  stageIndex?: number;
  percent?: number;
  progress?: number;
  message?: string;
  timestamp?: string;
}

export interface JobLogEntry {
  timestamp?: string;
  level?: string;
  stage?: string;
  message: string;
}

export interface PackageJob {
  id: string;
  url: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  targetOs: TargetOS;
  format: PackageFormat;
  includeRuntime?: boolean;
  analysis?: RepoAnalysis;
  stage?: string;
  progress?: number;
  message?: string;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  completedAt?: string;
  downloadCount?: number;
  result?: PackageResult | null;
  logs?: Array<string | JobLogEntry>;
}

export interface NormalizedRuntimeEntry {
  key: string;
  runtime: 'node' | 'python' | string;
  label: string;
  version: string;
  targetOs: TargetOS | string;
  cached: boolean;
  sizeBytes?: number | null;
  approxCompressedMB?: number | null;
  path?: string | null;
  updatedAt?: string | null;
}

export interface PipelineStageDef {
  id: string;
  index: number;
  label: string;
  plainDescription: string;
  aliases: string[];
}
