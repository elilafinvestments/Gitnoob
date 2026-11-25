import { parseGitHubUrl, fetchRepositoryData } from './github.js';
import { parseEnvFiles } from './envParser.js';
import { detectProjectStack } from './detector.js';
import { buildPlainEnglishSummary } from './readmeSummary.js';

export { parseGitHubUrl };

/**
 * Inspect a public GitHub repository and return a complete RepoAnalysis object
 * describing its stack, packaging strategy, runtime requirements, env keys,
 * official releases, warnings, compatibility score, and plain-English guide.
 */
export async function analyzeRepository(repoUrl, options = {}) {
  const parsed = parseGitHubUrl(repoUrl);
  const fetched = await fetchRepositoryData(parsed, options);

  const envVars = parseEnvFiles(fetched.files);
  const detected = detectProjectStack({
    metadata: fetched.metadata,
    languages: fetched.languages,
    tree: fetched.tree,
    files: fetched.files,
    releases: fetched.releases,
    envVars,
    subdir: parsed.subdir,
  });

  const readmeText =
    fetched.files['readme.md'] ||
    fetched.files['readme.rst'] ||
    fetched.files['readme.txt'] ||
    fetched.files['readme'] ||
    '';

  const plainEnglish = buildPlainEnglishSummary({
    metadata: fetched.metadata,
    readme: readmeText,
    detected,
    releases: fetched.releases,
  });

  const id = `${parsed.owner}/${parsed.repo}${parsed.subdir ? `/${parsed.subdir}` : ''}`.toLowerCase();

  return {
    id,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: fetched.effectiveBranch,
    subdir: parsed.subdir,
    canonicalUrl: parsed.canonicalUrl,
    name: fetched.metadata.name || parsed.repo,
    description: fetched.metadata.description || '',
    stars: fetched.metadata.stars ?? 0,
    forks: fetched.metadata.forks ?? 0,
    license: fetched.metadata.license || null,
    defaultBranch: fetched.metadata.defaultBranch || fetched.effectiveBranch,
    updatedAt: fetched.metadata.updatedAt || null,
    homepage: fetched.metadata.homepage || null,
    topics: fetched.metadata.topics || [],
    category: detected.category,
    categoryLabel: detected.categoryLabel,
    framework: detected.framework,
    packagingStrategy: detected.packagingStrategy,
    supportsSingleHtml: detected.supportsSingleHtml,
    supportsLivePreview: detected.supportsLivePreview,
    requiredRuntime: detected.requiredRuntime,
    plainEnglish,
    detectedFiles: detected.detectedFiles,
    envVars,
    releases: fetched.releases,
    warnings: detected.warnings,
    compatibility: detected.compatibility,
    estimatedSizeMB: detected.estimatedSizeMB,
  };
}
