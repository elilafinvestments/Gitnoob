import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const USER_AGENT = 'GitNoob/1.0';
const FETCH_TIMEOUT_MS = 12000;
const MAX_RAW_FILE_BYTES = 256 * 1024; // 256 KB cap for inspection files

const RESERVED_OWNER_SEGMENTS = new Set([
  'settings',
  'explore',
  'topics',
  'trending',
  'collections',
  'events',
  'sponsors',
  'notifications',
  'new',
  'organizations',
  'orgs',
  'login',
  'signup',
  'join',
  'pricing',
  'features',
  'enterprise',
  'marketplace',
  'search',
  'about',
  'issues',
  'pulls',
  'codespaces',
  'gist',
]);

const VALID_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

const EXTENSION_TO_LANGUAGE = {
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.java': 'Java',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.astro': 'Astro',
  '.sh': 'Shell',
};

/**
 * Parse a GitHub repository URL or shorthand into normalized components.
 * Supports:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo/tree/main/examples/foo
 * - https://github.com/owner/repo/blob/main/index.html
 * - git@github.com:owner/repo.git
 * - github.com/owner/repo
 * - owner/repo
 */
export function parseGitHubUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Please paste a GitHub repository link, such as https://github.com/owner/repo.');
  }

  let raw = input.trim();

  // Strip surrounding angle brackets or quotes if copied from markdown/chat
  raw = raw.replace(/^[<"'`]+|[>"'`]+$/g, '').trim();

  // Convert SSH syntax: git@github.com:owner/repo(.git)
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (sshMatch) {
    raw = `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Handle shorthand `owner/repo` (no protocol, no domain, exactly 2 segments)
  if (
    !raw.includes('://') &&
    !/^(www\.)?github\.com(\/|$)/i.test(raw) &&
    !raw.includes('.')
  ) {
    const cleanShorthand = raw.replace(/^\/+|\/+$/g, '');
    const parts = cleanShorthand.split('/');
    if (parts.length === 2 && VALID_SEGMENT_RE.test(parts[0]) && VALID_SEGMENT_RE.test(parts[1])) {
      raw = `https://github.com/${parts[0]}/${parts[1]}`;
    } else {
      throw new Error(
        'That does not look like a valid GitHub repository. Use a link like https://github.com/owner/repo or owner/repo.'
      );
    }
  } else if (
    !raw.includes('://') &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/i.test(raw.replace(/^\/+|\/+$/g, '')) &&
    !/^(www\.)?github\.com/i.test(raw)
  ) {
    // Handle `owner/repo.js` or `owner/repo.git` shorthand where repo name contains a dot
    raw = `https://github.com/${raw.replace(/^\/+|\/+$/g, '')}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      'Could not read that URL. Please paste a full GitHub link like https://github.com/owner/repo.'
    );
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error(
      `Only GitHub repositories are supported right now (received "${url.hostname}"). Paste a github.com repository link.`
    );
  }

  const segments = url.pathname
    .split('/')
    .map((s) => decodeURIComponent(s.trim()))
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error(
      'That GitHub link is missing a repository name. Please include both owner and repository (e.g., https://github.com/owner/repo).'
    );
  }

  const owner = segments[0];
  let repo = segments[1].replace(/\.git$/i, '');

  if (RESERVED_OWNER_SEGMENTS.has(owner.toLowerCase())) {
    throw new Error(
      'That points to a GitHub page rather than a repository. Paste a link to a specific repository like https://github.com/owner/repo.'
    );
  }

  if (!VALID_SEGMENT_RE.test(owner) || !VALID_SEGMENT_RE.test(repo) || repo === '.' || repo === '..') {
    throw new Error(
      'The repository owner or name contains unsupported characters. Check the GitHub link and try again.'
    );
  }

  let branch = null;
  let subdir = null;

  if (segments.length >= 4 && (segments[2] === 'tree' || segments[2] === 'blob')) {
    branch = segments[3] || null;
    const rest = segments.slice(4);
    if (segments[2] === 'tree' && rest.length > 0) {
      subdir = rest.join('/').replace(/^\/+|\/+$/g, '');
    } else if (segments[2] === 'blob' && rest.length > 1) {
      // Strip the filename, keep parent directory as subdir
      subdir = rest.slice(0, -1).join('/').replace(/^\/+|\/+$/g, '');
    }
  }

  return {
    owner,
    repo,
    branch,
    subdir: subdir || null,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

function buildApiHeaders(token) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const resolvedToken = token || process.env.GITHUB_TOKEN;
  if (resolvedToken) {
    headers.Authorization = `Bearer ${resolvedToken}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRateLimitResponse(res, bodyText = '') {
  if (res.status === 429) return true;
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') return true;
    if (/rate limit|abuse detection|secondary rate/i.test(bodyText)) return true;
  }
  return false;
}

function detectAssetOsHint(assetName) {
  const lower = (assetName || '').toLowerCase();
  if (/\.dmg$|\.pkg$|darwin|macos|osx|apple/.test(lower)) {
    if (/arm64|aarch64|apple[-_]?silicon/.test(lower)) return 'macos-arm64';
    if (/x64|x86_64|amd64|intel/.test(lower)) return 'macos-x64';
    return 'macos';
  }
  if (/\.exe$|\.msi$|win64|win32|windows/.test(lower)) {
    return 'windows-x64';
  }
  if (/\.appimage$|\.deb$|\.rpm$|linux/.test(lower)) {
    return 'linux-x64';
  }
  return null;
}

function normalizeReleases(rawReleases) {
  if (!Array.isArray(rawReleases)) return [];
  return rawReleases
    .filter((rel) => rel && !rel.draft)
    .slice(0, 5)
    .map((rel) => ({
      tagName: rel.tag_name || '',
      name: rel.name || rel.tag_name || 'Release',
      publishedAt: rel.published_at || rel.created_at || null,
      htmlUrl: rel.html_url || '',
      prerelease: Boolean(rel.prerelease),
      assets: Array.isArray(rel.assets)
        ? rel.assets
            .filter((a) => a && a.browser_download_url)
            .slice(0, 12)
            .map((a) => ({
              name: a.name,
              size: a.size || 0,
              downloadUrl: a.browser_download_url,
              contentType: a.content_type || 'application/octet-stream',
              osHint: detectAssetOsHint(a.name),
            }))
        : [],
    }));
}

/**
 * Determine which files in the git tree are worth downloading for deep inspection.
 * Returns a list of full repo paths (preserving exact casing from the tree).
 */
function selectInspectionFiles(treeEntries, subdir) {
  const prefix = subdir ? `${subdir.replace(/^\/+|\/+$/g, '')}/` : '';

  // Map lowercase relative path -> actual repo path
  const relToFull = new Map();
  const rootRelToFull = new Map();

  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue;
    rootRelToFull.set(entry.path.toLowerCase(), entry.path);
    if (prefix) {
      if (entry.path.startsWith(prefix)) {
        const rel = entry.path.slice(prefix.length);
        relToFull.set(rel.toLowerCase(), entry.path);
      }
    } else {
      relToFull.set(entry.path.toLowerCase(), entry.path);
    }
  }

  const wantedRelative = [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'setup.py',
    'pipfile',
    'index.html',
    'public/index.html',
    'src/index.html',
    'app/index.html',
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.local.example',
    'env.example',
    'readme.md',
    'readme.rst',
    'readme.txt',
    'readme',
    'cargo.toml',
    'go.mod',
    'dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'app.py',
    'main.py',
    'server.py',
    'run.py',
    'manage.py',
    'wsgi.py',
  ];

  const selected = new Map(); // logicalKey (lowercase relative) -> fullPath

  for (const candidate of wantedRelative) {
    if (relToFull.has(candidate)) {
      selected.set(candidate, relToFull.get(candidate));
    }
  }

  // If subdir has no README, fall back to root README.md
  const hasReadme = ['readme.md', 'readme.rst', 'readme.txt', 'readme'].some((k) => selected.has(k));
  if (!hasReadme && prefix) {
    for (const r of ['readme.md', 'readme.rst', 'readme.txt', 'readme']) {
      if (rootRelToFull.has(r)) {
        selected.set(r, rootRelToFull.get(r));
        break;
      }
    }
  }

  return selected;
}

async function fetchRawFiles(owner, repo, branch, selectedFiles, token) {
  const files = {};
  const headers = { 'User-Agent': USER_AGENT };
  const resolvedToken = token || process.env.GITHUB_TOKEN;
  if (resolvedToken) {
    headers.Authorization = `Bearer ${resolvedToken}`;
  }

  const entries = Array.from(selectedFiles.entries());
  await Promise.all(
    entries.map(async ([logicalKey, fullPath]) => {
      try {
        const encodedPath = fullPath
          .split('/')
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        const url = `${GITHUB_RAW_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodedPath}`;
        const res = await fetchWithTimeout(url, { headers }, 8000);
        if (!res.ok) return;
        const text = await res.text();
        files[logicalKey] =
          text.length > MAX_RAW_FILE_BYTES ? text.slice(0, MAX_RAW_FILE_BYTES) : text;
      } catch {
        // Non-fatal: individual file read failure doesn't break analysis
      }
    })
  );

  return files;
}

function inferLanguagesFromTree(treeEntries) {
  const totals = {};
  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue;
    const ext = path.extname(entry.path).toLowerCase();
    const lang = EXTENSION_TO_LANGUAGE[ext];
    if (!lang) continue;
    totals[lang] = (totals[lang] || 0) + (entry.size || 100);
  }
  return totals;
}

/**
 * Rate-limit resilient fallback: shallow blobless clone + git ls-tree + git show.
 * Works even when GitHub REST API anonymous rate limit (60 req/hr) is completely exhausted!
 */
async function cloneFallbackFetch(parsed) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnoob-inspect-'));
  const cloneArgsBase = ['clone', '--depth', '1', '--single-branch'];
  if (parsed.branch) {
    cloneArgsBase.push('--branch', parsed.branch);
  }
  const cloneUrl = `${parsed.canonicalUrl}.git`;

  try {
    // First attempt blobless no-checkout clone (ultra-fast even for huge repos)
    try {
      await execFileAsync(
        'git',
        [...cloneArgsBase, '--filter=blob:none', '--no-checkout', cloneUrl, tmpDir],
        {
          timeout: 30000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }
      );
    } catch {
      // Fall back to standard shallow clone if server/git rejects partial clone
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });
      await execFileAsync('git', [...cloneArgsBase, cloneUrl, tmpDir], {
        timeout: 45000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    }

    // Determine effective branch
    let effectiveBranch = parsed.branch;
    if (!effectiveBranch) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', tmpDir, 'symbolic-ref', '--short', 'HEAD'],
          { timeout: 5000 }
        );
        effectiveBranch = stdout.trim() || 'main';
      } catch {
        effectiveBranch = 'main';
      }
    }

    // List entire git tree (omit `-l` so blobless partial clones never trigger per-blob fetches)
    const { stdout: lsOut } = await execFileAsync(
      'git',
      ['-C', tmpDir, 'ls-tree', '-r', 'HEAD'],
      {
        timeout: 15000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }
    );

    const tree = [];
    for (const line of lsOut.split('\n')) {
      if (!line) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) continue;
      const meta = line.slice(0, tabIdx).trim().split(/\s+/);
      const filePath = line.slice(tabIdx + 1);
      const type = meta[1] || 'blob';
      tree.push({ path: filePath, type, size: 0 });
    }

    // Read only key inspection files via `git show HEAD:<path>`
    const selected = selectInspectionFiles(tree, parsed.subdir);
    const files = {};

    await Promise.all(
      Array.from(selected.entries()).map(async ([logicalKey, fullPath]) => {
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', tmpDir, 'show', `HEAD:${fullPath}`],
            {
              timeout: 15000,
              maxBuffer: MAX_RAW_FILE_BYTES * 2,
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            }
          );
          files[logicalKey] =
            stdout.length > MAX_RAW_FILE_BYTES ? stdout.slice(0, MAX_RAW_FILE_BYTES) : stdout;
        } catch {
          // Ignore individual missing/unreadable files
        }
      })
    );

    // Get last commit date for updatedAt
    let updatedAt = null;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', tmpDir, 'log', '-1', '--format=%cI'],
        { timeout: 5000 }
      );
      updatedAt = stdout.trim() || null;
    } catch {
      updatedAt = null;
    }

    return {
      source: 'git-fallback',
      effectiveBranch,
      metadata: {
        name: parsed.repo,
        description: '',
        stars: 0,
        forks: 0,
        license: null,
        defaultBranch: effectiveBranch,
        updatedAt,
        homepage: null,
        topics: [],
        sizeKB: Math.round(tree.reduce((sum, e) => sum + (e.size || 0), 0) / 1024),
        archived: false,
      },
      languages: inferLanguagesFromTree(tree),
      tree,
      treeTruncated: false,
      files,
      releases: [],
    };
  } catch (err) {
    const stderr = err?.stderr || err?.message || '';
    if (/not found|repository .* not found|authentication failed|could not read username/i.test(stderr)) {
      throw new Error(
        `Could not access "${parsed.owner}/${parsed.repo}" on GitHub. Double-check the URL and make sure the repository is public.`
      );
    }
    throw new Error(
      `Failed to inspect "${parsed.owner}/${parsed.repo}" (GitHub API rate-limited and git fallback failed: ${stderr.slice(0, 160)}).`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fetch repository metadata, languages, git tree, releases, and key inspection files.
 * Automatically falls back to shallow git clone on GitHub API rate-limit (403/429).
 */
export async function fetchRepositoryData(parsed, options = {}) {
  const headers = buildApiHeaders(options.token);
  const { owner, repo } = parsed;

  let repoRes;
  try {
    repoRes = await fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers }
    );
  } catch {
    // Network glitch hitting API -> try git fallback
    return await cloneFallbackFetch(parsed);
  }

  if (repoRes.status === 404) {
    throw new Error(
      `Repository "${owner}/${repo}" was not found on GitHub. Double-check the link and make sure the repository is public.`
    );
  }

  if (!repoRes.ok) {
    const errText = await repoRes.text().catch(() => '');
    if (isRateLimitResponse(repoRes, errText) || repoRes.status >= 500) {
      return await cloneFallbackFetch(parsed);
    }
    throw new Error(
      `GitHub returned an error (${repoRes.status}) while checking "${owner}/${repo}". Please try again in a moment.`
    );
  }

  const repoJson = await repoRes.json();
  const effectiveBranch = parsed.branch || repoJson.default_branch || 'main';

  // Fetch languages, recursive git tree, and releases in parallel
  const [langResult, treeResult, relResult] = await Promise.allSettled([
    fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`,
      { headers }
    ),
    fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(effectiveBranch)}?recursive=1`,
      { headers }
    ),
    fetchWithTimeout(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=5`,
      { headers }
    ),
  ]);

  let languages = {};
  if (langResult.status === 'fulfilled' && langResult.value.ok) {
    languages = await langResult.value.json().catch(() => ({}));
  }

  let releases = [];
  if (relResult.status === 'fulfilled' && relResult.value.ok) {
    const relJson = await relResult.value.json().catch(() => []);
    releases = normalizeReleases(relJson);
  }

  let tree = [];
  let treeTruncated = false;

  if (treeResult.status === 'fulfilled') {
    const res = treeResult.value;
    if (res.ok) {
      const treeJson = await res.json().catch(() => ({}));
      tree = Array.isArray(treeJson.tree)
        ? treeJson.tree.map((item) => ({
            path: item.path,
            type: item.type,
            size: item.size || 0,
          }))
        : [];
      treeTruncated = Boolean(treeJson.truncated);
    } else {
      const errText = await res.text().catch(() => '');
      if (isRateLimitResponse(res, errText)) {
        // Rate limit hit mid-request: fall back to git clone, preserving fetched metadata!
        const fallback = await cloneFallbackFetch({ ...parsed, branch: effectiveBranch });
        return {
          ...fallback,
          metadata: {
            name: repoJson.name || parsed.repo,
            description: repoJson.description || '',
            stars: repoJson.stargazers_count ?? 0,
            forks: repoJson.forks_count ?? 0,
            license: repoJson.license?.spdx_id && repoJson.license.spdx_id !== 'NOASSERTION'
              ? repoJson.license.spdx_id
              : repoJson.license?.name || null,
            defaultBranch: repoJson.default_branch || effectiveBranch,
            updatedAt: repoJson.pushed_at || repoJson.updated_at || fallback.metadata.updatedAt,
            homepage: repoJson.homepage || null,
            topics: Array.isArray(repoJson.topics) ? repoJson.topics : [],
            sizeKB: repoJson.size || fallback.metadata.sizeKB,
            archived: Boolean(repoJson.archived),
          },
          languages: Object.keys(languages).length > 0 ? languages : fallback.languages,
          releases: releases.length > 0 ? releases : fallback.releases,
        };
      }
      // If branch had slashes (e.g. feature/foo/subdir) or didn't exist, try fallback
      if (res.status === 404 && parsed.branch) {
        return await cloneFallbackFetch(parsed);
      }
    }
  } else {
    return await cloneFallbackFetch({ ...parsed, branch: effectiveBranch });
  }

  const selectedFiles = selectInspectionFiles(tree, parsed.subdir);
  const files = await fetchRawFiles(owner, repo, effectiveBranch, selectedFiles, options.token);

  return {
    source: 'github-api',
    effectiveBranch,
    metadata: {
      name: repoJson.name || parsed.repo,
      description: repoJson.description || '',
      stars: repoJson.stargazers_count ?? 0,
      forks: repoJson.forks_count ?? 0,
      license:
        repoJson.license?.spdx_id && repoJson.license.spdx_id !== 'NOASSERTION'
          ? repoJson.license.spdx_id
          : repoJson.license?.name || null,
      defaultBranch: repoJson.default_branch || effectiveBranch,
      updatedAt: repoJson.pushed_at || repoJson.updated_at || null,
      homepage: repoJson.homepage || null,
      topics: Array.isArray(repoJson.topics) ? repoJson.topics : [],
      sizeKB: repoJson.size || 0,
      archived: Boolean(repoJson.archived),
    },
    languages: Object.keys(languages).length > 0 ? languages : inferLanguagesFromTree(tree),
    tree,
    treeTruncated,
    files,
    releases,
  };
}
