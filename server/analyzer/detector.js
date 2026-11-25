const MAX_SINGLE_HTML_BINARY_BYTES = 30 * 1024 * 1024; // 30 MB

const BINARY_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.mp3', '.ogg', '.wav', '.m4a', '.flac', '.mp4', '.webm', '.mov',
  '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.glb', '.gltf', '.bin', '.obj', '.fbx', '.zip', '.tar', '.gz',
]);

const GAME_SIGNALS_RE =
  /\b(game|puzzle|arcade|2048|tetris|snake|pacman|flappy|chess|checkers|sudoku|minesweeper|pong|breakout|platformer|shooter|rpg|roguelike|hextris|dino|runner|racer|racing|asteroids|invaders|wordle|solitaire|mario|zelda|doom|canvas game|browser game|html5 game)\b/i;

const FRONTEND_BUNDLER_DEPS = [
  'vite',
  'react-scripts',
  'parcel',
  'parcel-bundler',
  'webpack',
  'webpack-cli',
  'astro',
  '@angular/cli',
  '@vue/cli-service',
  'svelte',
  'gatsby',
  'esbuild',
  'rollup',
  'snowpack',
  'rsbuild',
  '@rsbuild/core',
];

const SERVER_NODE_DEPS = [
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  'hapi',
  'hono',
  '@nestjs/core',
  'socket.io',
  'next',
  'nuxt',
  'nuxt3',
  '@remix-run/node',
  '@sveltejs/adapter-node',
  'polka',
  'restify',
  'meteor',
  'strapi',
  '@strapi/strapi',
];

function round1(n) {
  return Math.round(n * 10) / 10;
}

function safeParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getScopedTree(tree, subdir) {
  if (!subdir) return tree;
  const prefix = `${subdir.replace(/^\/+|\/+$/g, '')}/`;
  return tree
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({
      ...entry,
      path: entry.path.slice(prefix.length),
    }));
}

function getExtension(filePath) {
  const idx = filePath.lastIndexOf('.');
  if (idx === -1) return '';
  return filePath.slice(idx).toLowerCase();
}

function parsePythonDeps(requirementsTxt, pyprojectToml, setupPy) {
  const deps = new Set();

  if (requirementsTxt) {
    for (const line of requirementsTxt.split(/\r?\n/)) {
      const clean = line.split('#')[0].trim();
      if (!clean || clean.startsWith('-') || clean.startsWith('http')) continue;
      const pkg = clean.split(/[=<>!~;[\s]/)[0].trim().toLowerCase();
      if (pkg) deps.add(pkg);
    }
  }

  if (pyprojectToml) {
    // Capture common PEP 621 / Poetry / uv dependency declarations
    const depBlocks = [
      ...pyprojectToml.matchAll(/["']([a-zA-Z0-9_.-]+)(?:\[[^\]]+\])?(?:\s*[=<>!~^][^"']*)?["']/g),
      ...pyprojectToml.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=\s*(?:["'][\^~><=\d.*]+["']|\{)/gm),
    ];
    for (const m of depBlocks) {
      const pkg = m[1].toLowerCase();
      if (
        pkg &&
        !['python', 'name', 'version', 'description', 'readme', 'license', 'requires-python', 'authors', 'build-backend', 'requires'].includes(pkg)
      ) {
        deps.add(pkg);
      }
    }
  }

  if (setupPy) {
    for (const m of setupPy.matchAll(/["']([a-zA-Z0-9_.-]+)(?:\s*[=<>!~][^"']*)?["']/g)) {
      deps.add(m[1].toLowerCase());
    }
  }

  return deps;
}

function detectPythonImportsFromCode(files) {
  const found = new Set();
  const pyFiles = ['app.py', 'main.py', 'server.py', 'run.py', 'manage.py', 'wsgi.py'];
  const combined = pyFiles.map((k) => files[k] || '').join('\n');
  if (!combined) return found;

  for (const m of combined.matchAll(/^\s*(?:from|import)\s+([a-zA-Z0-9_]+)/gm)) {
    found.add(m[1].toLowerCase());
  }
  return found;
}

function detectPackageManager(relPathsSet, hasPackageJson, hasRequirementsTxt, hasPyprojectToml, files) {
  if (hasPackageJson) {
    if (relPathsSet.has('pnpm-lock.yaml')) return 'pnpm';
    if (relPathsSet.has('yarn.lock')) return 'yarn';
    if (relPathsSet.has('bun.lockb') || relPathsSet.has('bun.lock')) return 'bun';
    return 'npm';
  }
  if (hasPyprojectToml) {
    const pyproj = files['pyproject.toml'] || '';
    if (/\[tool\.poetry\]/i.test(pyproj)) return 'poetry';
    if (relPathsSet.has('uv.lock') || /\[tool\.uv\]/i.test(pyproj)) return 'uv';
    return 'pip';
  }
  if (hasRequirementsTxt) return 'pip';
  return null;
}

function detectPythonEntryPoint(relPathsSet, files, framework, repoName) {
  const candidates = ['app.py', 'main.py', 'server.py', 'run.py', 'manage.py', 'wsgi.py', 'bot.py', 'cli.py', 'index.py', 'game.py'];
  if (repoName) {
    const normalizedRepo = repoName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.py';
    candidates.push(normalizedRepo);
  }
  for (const c of candidates) {
    if (relPathsSet.has(c)) return c;
  }
  // Check pyproject.toml [project.scripts]
  const pyproj = files['pyproject.toml'] || '';
  const scriptsMatch = pyproj.match(/\[(?:project\.scripts|tool\.poetry\.scripts)\][\s\S]*?^\s*([a-zA-Z0-9_-]+)\s*=\s*["']([^"']+)["']/m);
  if (scriptsMatch) {
    return scriptsMatch[2];
  }
  if (framework === 'Django' && relPathsSet.has('manage.py')) return 'manage.py';
  // Look for any top-level .py file that isn't a config/setup/test helper
  const nonEntryNames = new Set([
    'setup.py', 'conftest.py', 'config.py', 'settings.py', 'constants.py', 'utils.py', '__init__.py', 'fabfile.py', 'noxfile.py',
  ]);
  for (const p of relPathsSet) {
    if (!p.includes('/') && p.endsWith('.py') && !nonEntryNames.has(p) && !p.startsWith('test_')) {
      return p;
    }
  }
  return null;
}

function detectNodeEntryPoint(pkgJson, relPathsSet) {
  if (!pkgJson) return null;
  if (typeof pkgJson.main === 'string' && pkgJson.main.trim()) return pkgJson.main.trim();
  if (typeof pkgJson.bin === 'string' && pkgJson.bin.trim()) return pkgJson.bin.trim();
  if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    const first = Object.values(pkgJson.bin)[0];
    if (typeof first === 'string') return first;
  }
  for (const c of ['server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js', 'dist/index.js']) {
    if (relPathsSet.has(c)) return c;
  }
  return null;
}

function hasUsableReleaseAssets(releases) {
  if (!Array.isArray(releases)) return false;
  return releases.some((r) => Array.isArray(r.assets) && r.assets.length > 0);
}

const IGNORED_COMPONENT_DIR_RE =
  /(?:^|\/)(node_modules|dist|build|out|coverage|\.git|\.next|\.nuxt|__tests__|__mocks__|fixtures|storybook-static)\//i;
const IGNORED_COMPONENT_FILE_RE =
  /\.(test|spec|stories|story|d|config)\.(jsx|tsx)$/i;
const IGNORED_CONFIG_BASENAME_RE =
  /(?:^|\/)(vite|tailwind|postcss|eslint|jest|vitest|babel|webpack|rollup|tsup|next|nuxt)\.config\.(jsx|tsx)$/i;

function rankComponentFile(filePath) {
  const lower = filePath.toLowerCase();
  const base = filePath.split('/').pop() || '';
  const isPascal = /^[A-Z]/.test(base);
  const depth = filePath.split('/').length - 1;

  let score = 500 - depth * 10;
  if (/^(src\/)?app\.(tsx|jsx)$/i.test(lower)) score = 1000;
  else if (/^(demo|example|examples)\/(src\/)?app\.(tsx|jsx)$/i.test(lower)) score = 920;
  else if (/^(src\/)?(demo|example|playground)\.(tsx|jsx)$/i.test(lower)) score = 900;
  else if (/^(demo|example|examples)\/.*\.(tsx|jsx)$/i.test(lower)) score = 800;
  else if (/^(src\/)?index\.(tsx|jsx)$/i.test(lower)) score = 700;
  else if (/^(src\/)?components?\/.*\.(tsx|jsx)$/i.test(lower)) score = 650 - depth * 5;
  else if (/^src\/[^/]+\.(tsx|jsx)$/i.test(lower)) score = 600;
  else if (!filePath.includes('/')) score = 560;

  if (isPascal) score += 25;
  return score;
}

function findReactComponentFiles(relPaths) {
  const candidates = relPaths.filter((p) => {
    if (!/\.(jsx|tsx)$/i.test(p)) return false;
    if (IGNORED_COMPONENT_DIR_RE.test(p)) return false;
    if (IGNORED_COMPONENT_FILE_RE.test(p)) return false;
    if (IGNORED_CONFIG_BASENAME_RE.test(p)) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const diff = rankComponentFile(b) - rankComponentFile(a);
    if (diff !== 0) return diff;
    const depthDiff = a.split('/').length - b.split('/').length;
    if (depthDiff !== 0) return depthDiff;
    return a.localeCompare(b);
  });

  return candidates.slice(0, 20);
}

/**
 * Deeply inspect a repository's tree, manifests, HTML, README, and metadata to determine
 * its category, stack framework, packaging strategy, compatibility score, warnings, and size estimate.
 */
export function detectProjectStack({
  metadata = {},
  languages = {},
  tree = [],
  files = {},
  releases = [],
  envVars = [],
  subdir = null,
}) {
  const scopedTree = getScopedTree(tree, subdir);
  const relPaths = scopedTree.filter((e) => e.type === 'blob').map((e) => e.path);
  const relPathsLower = new Set(relPaths.map((p) => p.toLowerCase()));
  const relPathsExact = new Set(relPaths);

  const pkgJson = safeParseJson(files['package.json']);
  const hasPackageJson = Boolean(pkgJson || relPathsLower.has('package.json'));
  const hasRootIndexHtml = relPathsLower.has('index.html');
  const hasPublicIndexHtml = relPathsLower.has('public/index.html');
  const hasSrcIndexHtml = relPathsLower.has('src/index.html');
  const hasIndexHtml = hasRootIndexHtml || hasPublicIndexHtml || hasSrcIndexHtml;
  const hasRequirementsTxt = relPathsLower.has('requirements.txt');
  const hasPyprojectToml = relPathsLower.has('pyproject.toml');
  const hasSetupPy = relPathsLower.has('setup.py');
  const hasDockerfile = relPathsLower.has('dockerfile');
  const hasDockerCompose =
    relPathsLower.has('docker-compose.yml') || relPathsLower.has('docker-compose.yaml');
  const hasCargoToml = relPathsLower.has('cargo.toml');
  const hasGoMod = relPathsLower.has('go.mod');
  const hasEnvExample =
    relPathsLower.has('.env.example') ||
    relPathsLower.has('.env.sample') ||
    relPathsLower.has('.env.template') ||
    relPathsLower.has('.env.local.example') ||
    relPathsLower.has('env.example');

  // Compute source & binary asset sizes from git tree
  let totalTreeBytes = 0;
  let binaryAssetBytes = 0;
  for (const entry of scopedTree) {
    if (entry.type !== 'blob') continue;
    const sz = entry.size || 0;
    totalTreeBytes += sz;
    if (BINARY_ASSET_EXTENSIONS.has(getExtension(entry.path))) {
      binaryAssetBytes += sz;
    }
  }
  const treeSizeMB = totalTreeBytes / (1024 * 1024);
  const repoSizeMB =
    scopedTree.length > 0 && totalTreeBytes > 0
      ? treeSizeMB
      : (metadata.sizeKB || 0) / 1024;

  const allDeps = {
    ...(pkgJson?.dependencies || {}),
    ...(pkgJson?.devDependencies || {}),
  };
  const peerDeps = pkgJson?.peerDependencies || {};
  const prodDeps = pkgJson?.dependencies || {};
  const depNames = new Set(Object.keys(allDeps));
  const prodDepNames = new Set(Object.keys(prodDeps));
  const hasReactDep = Boolean(allDeps.react || peerDeps.react);
  const scripts = pkgJson?.scripts || {};

  const pyDeps = parsePythonDeps(files['requirements.txt'], files['pyproject.toml'], files['setup.py']);
  const pyImports = detectPythonImportsFromCode(files);
  const allPy = new Set([...pyDeps, ...pyImports]);

  const indexHtmlContent =
    files['index.html'] || files['public/index.html'] || files['src/index.html'] || '';
  const readmeContent =
    files['readme.md'] || files['readme.rst'] || files['readme.txt'] || files['readme'] || '';

  const textCorpus = [
    metadata.name || '',
    metadata.description || '',
    ...(metadata.topics || []),
    readmeContent.slice(0, 2000),
  ].join(' ');

  const isGameRepo =
    GAME_SIGNALS_RE.test(textCorpus) ||
    depNames.has('phaser') ||
    depNames.has('kaboom') ||
    depNames.has('kaplay') ||
    depNames.has('excalibur') ||
    allPy.has('pygame') ||
    allPy.has('pygame-ce') ||
    allPy.has('arcade');

  const hasCanvasInHtml = /<canvas[\s>]/i.test(indexHtmlContent);

  // Detect modern JS frontend bundler
  const hasFrontendBundler =
    FRONTEND_BUNDLER_DEPS.some((d) => depNames.has(d)) ||
    relPathsLower.has('vite.config.js') ||
    relPathsLower.has('vite.config.ts') ||
    relPathsLower.has('vite.config.mjs') ||
    relPathsLower.has('astro.config.mjs') ||
    relPathsLower.has('astro.config.ts') ||
    relPathsLower.has('svelte.config.js') ||
    relPathsLower.has('angular.json');

  const hasServerNodeDep = SERVER_NODE_DEPS.some((d) => prodDepNames.has(d) || depNames.has(d));
  const isElectron = depNames.has('electron') || depNames.has('electron-builder');
  const isTauri = depNames.has('@tauri-apps/api') || depNames.has('@tauri-apps/cli') || relPathsLower.has('src-tauri/cargo.toml');

  const hasNextConfig =
    relPathsLower.has('next.config.js') ||
    relPathsLower.has('next.config.mjs') ||
    relPathsLower.has('next.config.ts');
  const nextConfigText =
    files['next.config.js'] || files['next.config.mjs'] || files['next.config.ts'] || '';
  const isNextStaticExport = /output\s*:\s*['"]export['"]/.test(nextConfigText);

  const hasPythonFiles = relPaths.some((p) => p.endsWith('.py'));
  const topLang = Object.entries(languages).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  const componentFiles = findReactComponentFiles(relPaths);
  const hasTsxComponent = componentFiles.some((p) => /\.tsx$/i.test(p));
  const hasNonReactJsxFramework =
    !hasReactDep && (depNames.has('solid-js') || depNames.has('preact') || depNames.has('vue'));
  const hasComponentLayoutHint =
    componentFiles.some((p) =>
      /^(src\/|components?\/|demo\/|examples?\/|[^/]+\.(jsx|tsx)$)/i.test(p)
    ) ||
    relPaths.some((p) => /^(demo|example|examples|components)\//i.test(p));
  const isBareReactComponentRepo =
    componentFiles.length > 0 &&
    !hasIndexHtml &&
    !hasNonReactJsxFramework &&
    (!hasPackageJson || !hasFrontendBundler);
  const isReactComponentLibRepo =
    componentFiles.length > 0 &&
    hasPackageJson &&
    hasReactDep &&
    !hasIndexHtml &&
    !isNextStaticExport &&
    !depNames.has('astro') &&
    !depNames.has('gatsby') &&
    !depNames.has('@angular/cli') &&
    hasComponentLayoutHint;
  const isRawReactComponentRepo = isBareReactComponentRepo || isReactComponentLibRepo;

  // Classification state
  let category = 'web-app';
  let categoryLabel = 'Interactive Web App';
  let framework = 'Vanilla JS';
  let packagingStrategy = 'static-bundle';
  let supportsSingleHtml = false;
  let supportsLivePreview = false;
  let requiredRuntime = null;
  let entryPoint = null;
  let buildScript = null;
  let startScript = null;
  let outputDir = null;

  const packageManager = detectPackageManager(
    relPathsLower,
    hasPackageJson,
    hasRequirementsTxt,
    hasPyprojectToml,
    files
  );

  // =========================================================================
  // STACK CLASSIFICATION PRIORITY TREE
  // =========================================================================

  // 1. Electron / Tauri Desktop App
  if (isElectron || isTauri) {
    category = 'desktop-app';
    categoryLabel = 'Desktop Application';
    framework = isElectron ? 'Electron' : 'Tauri';
    if (isElectron) {
      packagingStrategy = hasUsableReleaseAssets(releases) ? 'release-only' : 'node-portable';
      requiredRuntime =
        packagingStrategy === 'node-portable'
          ? {
              name: 'node',
              version: '22.14.0',
              reason: 'Runs the bundled Node.js / Electron desktop application.',
            }
          : null;
      startScript = scripts.start ? 'start' : null;
      buildScript = scripts.build ? 'build' : null;
      entryPoint = detectNodeEntryPoint(pkgJson, relPathsExact);
    } else {
      packagingStrategy = 'release-only';
      requiredRuntime = null;
    }
    supportsSingleHtml = false;
    supportsLivePreview = false;
  }
  // 2. Next.js / Nuxt / Remix / Express / Fastify / Koa / Node Server
  else if (
    hasPackageJson &&
    (depNames.has('next') || hasNextConfig || depNames.has('nuxt') || depNames.has('nuxt3') || hasServerNodeDep) &&
    !isNextStaticExport
  ) {
    if (depNames.has('next') || hasNextConfig) {
      framework = 'Next.js';
    } else if (depNames.has('nuxt') || depNames.has('nuxt3')) {
      framework = 'Nuxt';
    } else if (depNames.has('@remix-run/node')) {
      framework = 'Remix';
    } else if (depNames.has('@nestjs/core')) {
      framework = 'NestJS';
    } else if (depNames.has('fastify')) {
      framework = 'Fastify';
    } else if (depNames.has('hono')) {
      framework = 'Hono';
    } else if (depNames.has('koa')) {
      framework = 'Koa';
    } else if (depNames.has('socket.io')) {
      framework = depNames.has('express') ? 'Express + Socket.IO' : 'Node.js + Socket.IO';
    } else if (depNames.has('express')) {
      framework = depNames.has('react') ? 'Express + React' : 'Express';
    } else {
      framework = 'Node.js';
    }

    category = isGameRepo ? 'game' : 'node-app';
    categoryLabel = isGameRepo ? 'Multiplayer / Node.js Game' : 'Node.js Web App';
    packagingStrategy = 'node-portable';
    supportsSingleHtml = false;
    supportsLivePreview = true;
    requiredRuntime = {
      name: 'node',
      version: '22.14.0',
      reason: `Runs the ${framework} server locally inside your package without needing Node.js installed on your computer.`,
    };
    buildScript = scripts.build ? 'build' : null;
    startScript = scripts.start ? 'start' : scripts.serve ? 'serve' : scripts.dev ? 'dev' : null;
    entryPoint = detectNodeEntryPoint(pkgJson, relPathsExact);
    outputDir = depNames.has('next') ? '.next' : null;
  }
  // 2.5. Raw React Component Repository (bare .jsx/.tsx files or React component lib without index.html)
  else if (isRawReactComponentRepo) {
    category = isGameRepo ? 'game' : 'web-app';
    categoryLabel = isGameRepo ? 'React Game Component' : 'React Component App';
    framework = hasTsxComponent ? 'React + TypeScript Component' : 'React Component';
    packagingStrategy = 'react-component';
    supportsSingleHtml = binaryAssetBytes <= MAX_SINGLE_HTML_BINARY_BYTES;
    supportsLivePreview = true;
    requiredRuntime = {
      name: 'node',
      version: '22.14.0',
      reason: 'Powers the built-in local server for your compiled React component app.',
    };
    entryPoint = componentFiles[0] || null;
    buildScript = null;
    startScript = null;
    outputDir = 'dist';
  }
  // 3. Modern Frontend SPA / Static Build (Vite, CRA, Vue, Svelte, Astro, Parcel, Next static export)
  else if (
    hasPackageJson &&
    (hasFrontendBundler || isNextStaticExport) &&
    (scripts.build || hasIndexHtml)
  ) {
    const hasReact = depNames.has('react');
    const hasVue = depNames.has('vue');
    const hasSvelte = depNames.has('svelte');
    const hasSolid = depNames.has('solid-js');
    const hasPreact = depNames.has('preact');
    const hasVite =
      depNames.has('vite') ||
      relPathsLower.has('vite.config.js') ||
      relPathsLower.has('vite.config.ts') ||
      relPathsLower.has('vite.config.mjs');

    if (depNames.has('phaser')) framework = hasVite ? 'Vite + Phaser' : 'Phaser';
    else if (depNames.has('three')) framework = hasVite ? 'Vite + Three.js' : 'Three.js';
    else if (depNames.has('pixi.js')) framework = 'PixiJS';
    else if (isNextStaticExport) framework = 'Next.js (Static Export)';
    else if (depNames.has('astro')) framework = 'Astro';
    else if (depNames.has('@angular/cli') || depNames.has('@angular/core')) framework = 'Angular';
    else if (hasVite && hasReact) framework = 'Vite + React';
    else if (hasVite && hasVue) framework = 'Vite + Vue';
    else if (hasVite && hasSvelte) framework = 'Vite + Svelte';
    else if (hasVite && hasSolid) framework = 'Vite + Solid';
    else if (hasVite && hasPreact) framework = 'Vite + Preact';
    else if (hasVite) framework = 'Vite';
    else if (depNames.has('react-scripts')) framework = 'Create React App';
    else if (hasReact) framework = 'React';
    else if (hasVue) framework = 'Vue';
    else if (hasSvelte) framework = 'Svelte';
    else if (depNames.has('parcel') || depNames.has('parcel-bundler')) framework = 'Parcel';
    else if (depNames.has('gatsby')) framework = 'Gatsby';
    else framework = 'JavaScript Web App';

    category = isGameRepo ? 'game' : 'web-app';
    categoryLabel = isGameRepo ? 'Playable Browser Game' : 'Interactive Web App';
    packagingStrategy = 'static-bundle';
    supportsSingleHtml = binaryAssetBytes <= MAX_SINGLE_HTML_BINARY_BYTES;
    supportsLivePreview = true;
    requiredRuntime = {
      name: 'node',
      version: '22.14.0',
      reason: 'Powers the built-in local web server inside the .zip bundle so the app runs offline with zero setup.',
    };

    buildScript = scripts.build ? 'build' : null;
    startScript = scripts.preview ? 'preview' : scripts.start ? 'start' : scripts.dev ? 'dev' : null;
    entryPoint = hasRootIndexHtml
      ? 'index.html'
      : hasPublicIndexHtml
        ? 'public/index.html'
        : hasSrcIndexHtml
          ? 'src/index.html'
          : null;

    if (isNextStaticExport) outputDir = 'out';
    else if (depNames.has('react-scripts')) outputDir = 'build';
    else if (depNames.has('gatsby') || (hasSvelte && !hasVite)) outputDir = 'public';
    else if (depNames.has('astro') || hasVite || depNames.has('@vue/cli-service') || depNames.has('parcel') || depNames.has('webpack')) {
      outputDir = 'dist';
    } else {
      outputDir = 'dist';
    }
  }
  // 4. Pure / Direct Static HTML/CSS/JS Game or Website (root index.html, no frontend bundler required)
  else if (hasRootIndexHtml && !hasRequirementsTxt && !hasPyprojectToml) {
    const usesThree = /three(\.min)?\.js/i.test(indexHtmlContent) || depNames.has('three');
    const usesPhaser = /phaser(\.min)?\.js/i.test(indexHtmlContent) || depNames.has('phaser');
    const usesPixi = /pixi(\.min)?\.js/i.test(indexHtmlContent) || depNames.has('pixi.js');
    const usesP5 = /p5(\.min)?\.js/i.test(indexHtmlContent);
    const hasJsFiles = relPaths.some((p) => /\.(js|mjs)$/i.test(p));

    if (usesPhaser) framework = 'Phaser';
    else if (usesThree) framework = 'Three.js';
    else if (usesPixi) framework = 'PixiJS';
    else if (usesP5) framework = 'p5.js';
    else if (hasCanvasInHtml) framework = 'HTML5 / Canvas';
    else if (hasJsFiles) framework = 'HTML5 / Vanilla JS';
    else framework = 'HTML / CSS';

    if (isGameRepo) {
      category = 'game';
      categoryLabel = 'Playable Browser Game';
    } else if (hasJsFiles) {
      category = 'web-app';
      categoryLabel = 'Interactive Web App';
    } else {
      category = 'static-site';
      categoryLabel = 'Static Website';
    }

    packagingStrategy = 'static-bundle';
    supportsSingleHtml = binaryAssetBytes <= MAX_SINGLE_HTML_BINARY_BYTES;
    supportsLivePreview = true;
    requiredRuntime = {
      name: 'node',
      version: '22.14.0',
      reason: 'Powers the tiny built-in local server inside the .zip bundle so all game scripts, audio, and assets load cleanly offline.',
    };
    entryPoint = 'index.html';
    buildScript = null;
    startScript = null;
    outputDir = '.';
  }
  // 5. Python Application / Game / Desktop Tool / CLI / Library
  else if (
    hasRequirementsTxt ||
    hasPyprojectToml ||
    hasSetupPy ||
    (hasPythonFiles && topLang === 'Python')
  ) {
    const hasStreamlit = allPy.has('streamlit');
    const hasGradio = allPy.has('gradio');
    const hasFastApi = allPy.has('fastapi') || allPy.has('uvicorn');
    const hasFlask = allPy.has('flask');
    const hasDjango = allPy.has('django') || relPathsLower.has('manage.py');
    const hasDash = allPy.has('dash');
    const hasTornado = allPy.has('tornado') || allPy.has('aiohttp') || allPy.has('sanic') || allPy.has('bottle');
    const hasPygame = allPy.has('pygame') || allPy.has('pygame-ce') || allPy.has('arcade');
    const hasDesktopGui =
      allPy.has('tkinter') ||
      allPy.has('customtkinter') ||
      allPy.has('pyqt5') ||
      allPy.has('pyqt6') ||
      allPy.has('pyside6') ||
      allPy.has('pyside2') ||
      allPy.has('kivy') ||
      allPy.has('wxpython');

    entryPoint = detectPythonEntryPoint(relPathsExact, files, hasDjango ? 'Django' : null, metadata.name);

    // Check if this is actually a Python library (e.g. pallets/flask, requests, numpy)
    const hasSrcPackageDir = relPaths.some((p) => /^src\/[^/]+\/__init__\.py$/.test(p));
    const hasTopLevelEntry = Boolean(
      entryPoint && !entryPoint.includes(':') && !entryPoint.includes('/')
    );
    const hasCliScripts =
      /\[(?:project\.scripts|tool\.poetry\.scripts)\]/i.test(files['pyproject.toml'] || '') ||
      /console_scripts/i.test(files['setup.py'] || '');
    const isLikelyPyLibrary =
      !hasTopLevelEntry &&
      !hasRequirementsTxt &&
      (hasPyprojectToml || hasSetupPy) &&
      (hasSrcPackageDir || relPaths.some((p) => /^[^/]+\/__init__\.py$/.test(p))) &&
      !hasStreamlit &&
      !hasGradio &&
      !hasDjango &&
      !hasPygame &&
      !hasDesktopGui &&
      !hasCliScripts;

    if (isLikelyPyLibrary) {
      framework = 'Python Package';
      category = 'library';
      categoryLabel = 'Python Library';
      supportsLivePreview = false;
    } else if (hasStreamlit) {
      framework = 'Streamlit';
      category = 'python-app';
      categoryLabel = 'Python Web App';
      supportsLivePreview = true;
    } else if (hasGradio) {
      framework = 'Gradio';
      category = 'python-app';
      categoryLabel = 'Python AI / Web App';
      supportsLivePreview = true;
    } else if (hasFastApi) {
      framework = 'FastAPI';
      category = 'python-app';
      categoryLabel = 'Python Web App';
      supportsLivePreview = true;
    } else if (hasDjango) {
      framework = 'Django';
      category = 'python-app';
      categoryLabel = 'Python Web App';
      supportsLivePreview = true;
    } else if (hasFlask) {
      framework = 'Flask';
      category = 'python-app';
      categoryLabel = 'Python Web App';
      supportsLivePreview = true;
    } else if (hasDash) {
      framework = 'Dash';
      category = 'python-app';
      categoryLabel = 'Python Data App';
      supportsLivePreview = true;
    } else if (hasTornado) {
      framework = 'Python Web Server';
      category = 'python-app';
      categoryLabel = 'Python Web App';
      supportsLivePreview = true;
    } else if (hasPygame) {
      framework = allPy.has('arcade') ? 'Python Arcade' : 'Pygame';
      category = 'game';
      categoryLabel = 'Python Desktop Game';
      supportsLivePreview = false;
    } else if (hasDesktopGui) {
      framework = allPy.has('tkinter') || allPy.has('customtkinter') ? 'Tkinter' : 'Python GUI';
      category = 'desktop-app';
      categoryLabel = 'Desktop Utility';
      supportsLivePreview = false;
    } else if (hasCliScripts || allPy.has('click') || allPy.has('typer') || allPy.has('rich')) {
      framework = 'Python CLI';
      category = 'cli-tool';
      categoryLabel = 'Command-Line Tool';
      supportsLivePreview = false;
    } else {
      framework = 'Python';
      category = 'python-app';
      categoryLabel = 'Python Application';
      supportsLivePreview = false;
    }

    packagingStrategy = 'python-portable';
    supportsSingleHtml = false;
    requiredRuntime = {
      name: 'python',
      version: '3.12',
      reason: `Runs this ${framework} app with a self-contained portable Python 3.12 runtime so you never need to install Python.`,
    };
  }
  // 6. Node.js CLI Tool or Library or Generic Node App (has package.json, no bundler/server/index.html)
  else if (hasPackageJson) {
    const hasBin = Boolean(pkgJson?.bin);
    const hasStart = Boolean(scripts.start || scripts.serve);
    const isWorkspaceMonorepo = Boolean(pkgJson?.workspaces);

    entryPoint = detectNodeEntryPoint(pkgJson, relPathsExact);
    buildScript = scripts.build ? 'build' : null;
    startScript = scripts.start ? 'start' : scripts.serve ? 'serve' : null;

    if (hasBin && !hasStart) {
      category = 'cli-tool';
      categoryLabel = 'Command-Line Tool';
      framework = 'Node.js CLI';
      packagingStrategy = 'node-portable';
      supportsLivePreview = false;
    } else if (hasStart) {
      category = 'node-app';
      categoryLabel = 'Node.js App';
      framework = 'Node.js';
      packagingStrategy = 'node-portable';
      supportsLivePreview = Boolean(
        /http|server|port|listen|web/i.test(textCorpus) || scripts.serve
      );
    } else if (hasIndexHtml) {
      category = isGameRepo ? 'game' : 'web-app';
      categoryLabel = isGameRepo ? 'Playable Browser Game' : 'Interactive Web App';
      framework = 'HTML5 / Vanilla JS';
      packagingStrategy = 'static-bundle';
      supportsSingleHtml = binaryAssetBytes <= MAX_SINGLE_HTML_BINARY_BYTES;
      supportsLivePreview = true;
      outputDir = hasPublicIndexHtml ? 'public' : '.';
    } else {
      category = 'library';
      categoryLabel = isWorkspaceMonorepo ? 'Multi-Package Project' : 'JavaScript Library';
      framework = depNames.has('typescript') ? 'TypeScript Library' : 'Node.js Library';
      packagingStrategy = 'node-portable';
      supportsLivePreview = false;
    }

    requiredRuntime = {
      name: 'node',
      version: '22.14.0',
      reason: 'Bundles a portable Node.js v22.14.0 runtime so the package works without installing Node.js.',
    };
  }
  // 7. Native / Compiled Languages (Rust, Go, C/C++, Swift, Java, C#, Haskell, etc.) -> release-only
  else if (
    hasCargoToml ||
    hasGoMod ||
    [
      'Rust', 'Go', 'C', 'C++', 'C#', 'Swift', 'Java', 'Kotlin', 'Zig',
      'Haskell', 'OCaml', 'Scala', 'Dart', 'Elixir', 'Erlang', 'Nim', 'Crystal', 'Fortran',
    ].includes(topLang) ||
    (hasUsableReleaseAssets(releases) &&
      !['JavaScript', 'TypeScript', 'HTML', 'CSS', 'Python', 'Vue', 'Svelte', 'Astro', ''].includes(topLang))
  ) {
    if (hasCargoToml || topLang === 'Rust') framework = 'Rust';
    else if (hasGoMod || topLang === 'Go') framework = 'Go';
    else framework = topLang || 'Native Code';

    category = isGameRepo
      ? 'game'
      : /cli|terminal|command[- ]line|converter|compiler|tool/i.test(textCorpus)
        ? 'cli-tool'
        : 'desktop-app';
    categoryLabel =
      category === 'game'
        ? `${framework} Game`
        : category === 'cli-tool'
          ? `${framework} CLI Tool`
          : `${framework} Application`;
    packagingStrategy = 'release-only';
    supportsSingleHtml = false;
    supportsLivePreview = false;
    requiredRuntime = null;
  }
  // 8. Fallback: check for nested index.html (only for web-oriented repos, e.g. docs/ or public/)
  else {
    const isWebLang = ['', 'HTML', 'JavaScript', 'TypeScript', 'CSS', 'SCSS'].includes(topLang);
    const nestedIndex = isWebLang
      ? relPaths.find(
          (p) => /^(public|web|site|app|src|demo|dist|build|docs)\/index\.html$/i.test(p)
        )
      : null;
    if (nestedIndex) {
      const dir = nestedIndex.includes('/') ? nestedIndex.split('/')[0] : '.';
      category = isGameRepo ? 'game' : 'static-site';
      categoryLabel = isGameRepo ? 'Playable Browser Game' : 'Static Website';
      framework = 'HTML / CSS / JS';
      packagingStrategy = 'static-bundle';
      supportsSingleHtml = binaryAssetBytes <= MAX_SINGLE_HTML_BINARY_BYTES;
      supportsLivePreview = true;
      entryPoint = nestedIndex;
      outputDir = dir;
      requiredRuntime = {
        name: 'node',
        version: '22.14.0',
        reason: 'Powers the built-in local web server inside the .zip bundle so files load smoothly offline.',
      };
    } else {
      category = 'library';
      categoryLabel = 'Source Repository';
      framework = topLang || 'Unknown Stack';
      packagingStrategy = 'release-only';
      supportsSingleHtml = false;
      supportsLivePreview = false;
      requiredRuntime = null;
    }
  }

  // =========================================================================
  // WARNINGS & COMPATIBILITY SCORING
  // =========================================================================
  const warnings = [];
  let score = 95;

  // External database dependencies
  const dbSignals = [];
  if (depNames.has('pg') || depNames.has('postgres') || allPy.has('psycopg2') || allPy.has('psycopg2-binary') || allPy.has('asyncpg')) {
    dbSignals.push('PostgreSQL');
  }
  if (depNames.has('mongoose') || depNames.has('mongodb') || allPy.has('pymongo') || allPy.has('motor')) {
    dbSignals.push('MongoDB');
  }
  if (depNames.has('mysql') || depNames.has('mysql2') || allPy.has('pymysql') || allPy.has('mysqlclient')) {
    dbSignals.push('MySQL');
  }
  if (depNames.has('redis') || depNames.has('ioredis') || allPy.has('redis')) {
    dbSignals.push('Redis');
  }
  if (dbSignals.length > 0) {
    warnings.push(
      `This app expects an external ${dbSignals.join(' / ')} database server. You will need a running database connection for full functionality.`
    );
    score -= 22;
  }

  // Required API keys or environment variables
  const requiredEnvVars = envVars.filter((v) => v.required);
  if (requiredEnvVars.length > 0) {
    const sampleKeys = requiredEnvVars
      .slice(0, 3)
      .map((v) => v.key)
      .join(', ');
    warnings.push(
      `Requires ${requiredEnvVars.length} configuration ${requiredEnvVars.length === 1 ? 'key' : 'keys'} (${sampleKeys}) — you can enter them below before packaging.`
    );
    score -= 8;
  }

  // Native compiled addons / heavy ML frameworks
  const heavyDeps = ['torch', 'tensorflow', 'jax', 'transformers', 'opencv-python', 'scipy'].filter((d) =>
    allPy.has(d)
  );
  if (heavyDeps.length > 0) {
    warnings.push(
      `Uses large scientific/AI packages (${heavyDeps.join(', ')}), which can make the downloaded bundle very large and slow to install.`
    );
    score -= 20;
  }

  const nativeNodeAddons = ['sharp', 'better-sqlite3', 'sqlite3', 'canvas', 'node-gyp', 'bcrypt'].filter((d) =>
    prodDepNames.has(d)
  );
  if (nativeNodeAddons.length > 0) {
    warnings.push(
      `Includes native Node.js extensions (${nativeNodeAddons.join(', ')}). Packaging works best when targeting the same OS as the build host.`
    );
    score -= 10;
  }

  // Monorepo warning
  if (pkgJson?.workspaces && !hasRootIndexHtml && !startScript) {
    warnings.push(
      'This is a multi-package repository (monorepo). For best results, paste a direct link to a specific app subfolder (e.g. /tree/main/examples/...).'
    );
    score -= 25;
  }

  // Huge repository warning
  if (repoSizeMB > 100) {
    warnings.push(
      `Large repository (~${Math.round(repoSizeMB)} MB of source/assets). Cloning and packaging may take a few minutes.`
    );
    score -= 15;
  } else if (binaryAssetBytes > MAX_SINGLE_HTML_BINARY_BYTES && packagingStrategy === 'static-bundle') {
    warnings.push(
      'Media assets exceed 30 MB, so single-file .html export is disabled—use the full .zip bundle instead.'
    );
  }

  // Category/strategy specific scoring adjustments
  if (packagingStrategy === 'static-bundle' && !buildScript) {
    // Pure static HTML/JS games & sites are nearly 100% bulletproof
    score = Math.min(99, score + 3);
  } else if (packagingStrategy === 'static-bundle' && buildScript) {
    score -= 5;
  } else if (packagingStrategy === 'react-component') {
    score -= 6;
  } else if (packagingStrategy === 'node-portable') {
    score -= 8;
  } else if (packagingStrategy === 'python-portable') {
    score -= 10;
    if (!entryPoint && category !== 'library') {
      warnings.push(
        'Could not pinpoint a single startup script automatically—check the bundled README if it needs a custom command.'
      );
      score -= 15;
    }
  } else if (packagingStrategy === 'release-only') {
    if (hasUsableReleaseAssets(releases)) {
      score = Math.min(score, 68);
      warnings.push(
        `${framework} projects compile to native binaries. Use the official prebuilt GitHub Release installers listed below for the fastest one-click install.`
      );
    } else {
      score = Math.min(score, 32);
      warnings.push(
        `This is a ${framework} source repository with no prebuilt GitHub Releases published yet, so GitNoob cannot auto-bundle a runnable binary.`
      );
    }
  }

  if (category === 'library') {
    score = Math.min(score, 42);
    warnings.push(
      'This repository is a developer code library rather than a standalone app—it does not include a clickable end-user interface.'
    );
  }

  if (hasDockerCompose && !hasRootIndexHtml && packagingStrategy !== 'static-bundle') {
    warnings.push(
      'Includes a docker-compose setup, which may coordinate extra background services beyond this single app.'
    );
    score -= 10;
  }

  if (metadata.archived) {
    warnings.push('This repository is marked as archived (read-only) by its author on GitHub.');
  }

  score = Math.max(10, Math.min(100, Math.round(score)));

  let compatLabel;
  let compatReason;
  if (score >= 75) {
    compatLabel = 'Ready to Package';
    compatReason =
      packagingStrategy === 'static-bundle' && !buildScript
        ? 'Self-contained browser app with zero external dependencies—packages cleanly in seconds.'
        : packagingStrategy === 'react-component'
          ? 'React component repository—GitNoob automatically wraps it in a standalone runnable app and compiles it for offline use.'
          : packagingStrategy === 'static-bundle'
            ? `Standard ${framework} frontend that compiles cleanly into an offline bundle.`
            : `Well-structured ${framework} project ready to bundle with its portable runtime.`;
  } else if (score >= 45) {
    compatLabel = 'Packageable with Notes';
    compatReason =
      packagingStrategy === 'release-only'
        ? `Official prebuilt ${framework} installers are available directly from GitHub Releases.`
        : warnings[0] || `Can be packaged with its ${framework} runtime, though a few setup notes apply.`;
  } else {
    compatLabel = 'Limited Support';
    compatReason =
      warnings[0] ||
      'This repository does not match a standalone runnable app format and may require developer tools.';
  }

  // =========================================================================
  // REALISTIC SIZE ESTIMATES (compressed download MB)
  // =========================================================================
  const sourceMB = Math.max(0.2, Math.min(repoSizeMB * 0.65, 250));
  let estimatedAppMB = sourceMB;

  if (packagingStrategy === 'static-bundle') {
    estimatedAppMB = buildScript ? Math.max(1.2, Math.min(sourceMB, 15)) : Math.max(0.3, sourceMB);
  } else if (packagingStrategy === 'react-component') {
    estimatedAppMB = Math.max(1.2, Math.min(sourceMB + 0.8, 15));
  } else if (packagingStrategy === 'node-portable') {
    const depCount = prodDepNames.size || depNames.size;
    estimatedAppMB = sourceMB + Math.min(depCount * 0.8 + 4, 85);
  } else if (packagingStrategy === 'python-portable') {
    const pyCount = pyDeps.size || 3;
    const mlBoost = heavyDeps.length > 0 ? 180 : 0;
    estimatedAppMB = sourceMB + Math.min(pyCount * 1.2 + 3, 60) + mlBoost;
  } else {
    estimatedAppMB = 0;
  }

  let estimatedRuntimeMB = 0;
  if (requiredRuntime?.name === 'node') estimatedRuntimeMB = 18;
  else if (requiredRuntime?.name === 'python') estimatedRuntimeMB = 22;

  const estimatedSizeMB = {
    app: round1(estimatedAppMB),
    runtime: round1(estimatedRuntimeMB),
    total: round1(estimatedAppMB + estimatedRuntimeMB),
  };

  return {
    category,
    categoryLabel,
    framework,
    packagingStrategy,
    supportsSingleHtml,
    supportsLivePreview,
    requiredRuntime,
    detectedFiles: {
      hasPackageJson,
      hasIndexHtml,
      hasRequirementsTxt,
      hasPyprojectToml,
      hasDockerfile,
      hasEnvExample,
      entryPoint,
      buildScript,
      startScript,
      outputDir,
      packageManager,
      componentFiles,
    },
    warnings,
    compatibility: {
      score,
      label: compatLabel,
      reason: compatReason,
    },
    estimatedSizeMB,
  };
}
