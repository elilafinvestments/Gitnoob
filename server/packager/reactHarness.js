import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HARNESS_TIMEOUT_MS = 180_000;
const MAX_COMPONENTS_IN_SWITCHER = 12;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.github',
  '.gitlab',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vscode',
  '.idea',
  'coverage',
  '__tests__',
  'test',
  'tests',
  'e2e',
  'cypress',
  '.gitnoob',
]);

const SKIP_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/i,
  /\.spec\.[jt]sx?$/i,
  /\.stories\.[jt]sx?$/i,
  /\.d\.ts$/i,
  /\.config\.[cm]?[jt]sx?$/i,
  /^(vite|vitest|jest|babel|rollup|webpack|tailwind|postcss|eslint|prettier|playwright|cypress)\./i,
  /^setupTests\.[jt]sx?$/i,
];

const IGNORED_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-scripts',
  'vite',
  '@vitejs/plugin-react',
  '@vitejs/plugin-react-swc',
  'typescript',
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'rollup',
  'webpack',
  'parcel',
  'esbuild',
  'tsup',
  'microbundle',
  'tailwindcss',
  'postcss',
  'autoprefixer',
  'husky',
  'lint-staged',
  'gh-pages',
  'rimraf',
  'cross-env',
  'nodemon',
  'concurrently',
  'storybook',
]);

const harnessBaseLock = new Map();

function runStreaming(cmd, args, { cwd, env, timeoutMs = HARNESS_TIMEOUT_MS, onLog } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);

    const onChunk = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') {
        stdout = (stdout + text).slice(-120_000);
      } else {
        stderr = (stderr + text).slice(-120_000);
      }
      if (typeof onLog === 'function') {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) onLog(trimmed, stream);
        }
      }
    };

    child.stdout.on('data', (c) => onChunk(c, 'stdout'));
    child.stderr.on('data', (c) => onChunk(c, 'stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command "${cmd} ${args.join(' ')}" timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-10).join('\n');
        reject(new Error(`Command "${cmd} ${args[0] || ''}" failed (exit ${code})${tail ? `:\n${tail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isPascalCaseComponentName(name) {
  if (!name || typeof name !== 'string') return false;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) return false;
  // Exclude ALL_CAPS constants like DEFAULT_CONFIG or API_URL
  if (/^[A-Z0-9_]+$/.test(name) && name.length > 1) return false;
  // Exclude common non-component type/util names
  if (/^(Props|State|Config|Options|Context|Types|Theme|Styles|Error|Utils|Helper|Constants)$/i.test(name)) {
    return false;
  }
  return true;
}

function shouldSkipFile(fileName) {
  return SKIP_FILE_PATTERNS.some((re) => re.test(fileName));
}

async function scanRepoFiles(workDir) {
  const componentFiles = [];
  const allCodeFiles = [];
  const cssFiles = [];

  async function walk(dir, relBase) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPosix = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPosix);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (shouldSkipFile(entry.name)) continue;

        if (ext === '.tsx' || ext === '.jsx') {
          componentFiles.push({ fullPath, relPath: relPosix, name: entry.name });
          allCodeFiles.push({ fullPath, relPath: relPosix });
        } else if (ext === '.ts' || ext === '.js' || ext === '.mjs') {
          allCodeFiles.push({ fullPath, relPath: relPosix });
        } else if (ext === '.css' && !entry.name.endsWith('.module.css')) {
          cssFiles.push({ fullPath, relPath: relPosix, name: entry.name });
        }
      }
    }
  }

  await walk(workDir, '');
  return { componentFiles, allCodeFiles, cssFiles };
}

function extractComponentExports(sourceText, relPath) {
  const exportsList = [];
  const baseName = path.basename(relPath, path.extname(relPath));
  const fallbackName = isPascalCaseComponentName(baseName)
    ? baseName
    : baseName.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase()) || 'Component';

  // Detect default export
  const defaultFnMatch = sourceText.match(/export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_]*)/);
  if (defaultFnMatch && isPascalCaseComponentName(defaultFnMatch[1])) {
    exportsList.push({ exportName: 'default', displayName: defaultFnMatch[1], isDefault: true });
  } else if (/export\s+default\b/.test(sourceText)) {
    const defaultIdentMatch = sourceText.match(/export\s+default\s+(?:React\.)?(?:memo|forwardRef)\(\s*([A-Z][A-Za-z0-9_]*)/)
      || sourceText.match(/export\s+default\s+([A-Z][A-Za-z0-9_]*)\s*[;\n]/);
    const displayName = (defaultIdentMatch && isPascalCaseComponentName(defaultIdentMatch[1]))
      ? defaultIdentMatch[1]
      : fallbackName;
    exportsList.push({ exportName: 'default', displayName, isDefault: true });
  }

  // Detect named function / class / const exports
  const namedFnRe = /export\s+(?:async\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_]*)\b/g;
  for (const m of sourceText.matchAll(namedFnRe)) {
    const name = m[1];
    if (isPascalCaseComponentName(name) && !exportsList.some((e) => e.displayName === name)) {
      exportsList.push({ exportName: name, displayName: name, isDefault: false });
    }
  }

  const namedConstRe = /export\s+(?:const|let)\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo|forwardRef|\(|[a-zA-Z0-9_]+\s*=>|function\b)/g;
  for (const m of sourceText.matchAll(namedConstRe)) {
    const name = m[1];
    if (isPascalCaseComponentName(name) && !exportsList.some((e) => e.displayName === name)) {
      exportsList.push({ exportName: name, displayName: name, isDefault: false });
    }
  }

  // Also catch `export { Foo, Bar }` (skipping `export type { ... }` and `type Foo`)
  const exportBlockRe = /export\s*\{([^}]+)\}(?!\s*from)/g;
  for (const m of sourceText.matchAll(exportBlockRe)) {
    const items = m[1].split(',');
    for (const rawItem of items) {
      const cleaned = rawItem.trim();
      if (!cleaned || cleaned.startsWith('type ')) continue;
      const aliasParts = cleaned.split(/\s+as\s+/);
      const exportedAs = (aliasParts[1] || aliasParts[0]).trim();
      if (isPascalCaseComponentName(exportedAs) && !exportsList.some((e) => e.displayName === exportedAs)) {
        exportsList.push({ exportName: exportedAs, displayName: exportedAs, isDefault: false });
      }
    }
  }

  return exportsList;
}

function scoreComponentCandidate(relPath, exportEntry, sourceText) {
  const lower = relPath.toLowerCase();
  let score = 40;

  // Priority 1: Dedicated App / Demo / Example top-level entry components
  if (/^(src\/)?app\.[jt]sx$/.test(lower)) score = 125;
  else if (/^(demo|example|examples)(\/[^/]+)?\/(src\/)?app\.[jt]sx$/.test(lower)) score = 120;
  else if (/^(src\/)?(demo|example|playground)\.[jt]sx$/.test(lower)) score = 112;
  // Priority 2: Library / primary components in root or src/
  else if (/^[^/]+\.[jt]sx$/.test(lower)) score = 95;
  else if (/^src\/index\.[jt]sx$/.test(lower)) score = 92;
  else if (/^src\/components\/[^/]+\.[jt]sx$/.test(lower)) score = 90;
  else if (/^src\/[^/]+\.[jt]sx$/.test(lower)) score = 88;
  // Priority 3: Demo / example helper components (ranked below real library components)
  else if (/^(demo|example|examples)\//.test(lower)) score = 52;

  // Penalize clearly internal helper/sub-components
  if (/\/(common|internal|internals|primitives|shared|utils|helpers|hooks|icons|subcomponents)\//.test(`/${lower}`)) {
    score -= 45;
  }
  if (/^(common|base|internal|abstract|icon|devtools)/i.test(exportEntry.displayName)) {
    score -= 25;
  }
  if (/(context|provider|portal|errorboundary|wrapper|layout)$/i.test(exportEntry.displayName)) {
    score -= 20;
  }

  // Prefer default exports slightly when tied
  if (exportEntry.isDefault) score += 5;
  // Prefer files with actual JSX markup
  if (/<[A-Za-z][^>]*>/.test(sourceText)) score += 10;

  return score;
}

function detectTailwindUsage(codeSources) {
  const twSignal = /className\s*=\s*["'`][^"'`]*\b(?:flex|grid|bg-(?:white|black|slate|gray|zinc|neutral|red|blue|green|indigo)-\d{2,3}|text-(?:xs|sm|base|lg|xl|2xl|3xl)|p-\d|px-\d|py-\d|mx-auto|rounded-(?:md|lg|xl|full)|shadow-(?:sm|md|lg))\b/;
  let hits = 0;
  for (const src of codeSources) {
    if (twSignal.test(src)) {
      hits += 1;
      if (hits >= 1) return true;
    }
  }
  return false;
}

function extractBareSpecifiers(sourceText) {
  const specifiers = new Set();
  const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicRe = /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [importRe, dynamicRe]) {
    for (const m of sourceText.matchAll(re)) {
      const spec = m[1].trim();
      if (!spec) continue;
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('node:') || spec.startsWith('http://') || spec.startsWith('https://')) {
        continue;
      }
      // Convert subpath imports like 'lucide-react/icons' or '@radix-ui/react-dialog/foo' to package name
      const pkgName = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/')
        : spec.split('/')[0];
      if (pkgName && !pkgName.startsWith('@types/') && !IGNORED_PACKAGES.has(pkgName)) {
        specifiers.add(pkgName);
      }
    }
  }
  return specifiers;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureReactHarnessBase(dataDir, onLog) {
  const baseDir = path.join(dataDir, 'runtime-cache', 'react-harness-base');
  const viteBin = path.join(baseDir, 'node_modules', '.bin', 'vite');
  const reactPkg = path.join(baseDir, 'node_modules', 'react', 'package.json');

  if (fs.existsSync(viteBin) && fs.existsSync(reactPkg)) {
    return baseDir;
  }

  if (!harnessBaseLock.has(baseDir)) {
    const setupPromise = (async () => {
      await fsp.mkdir(baseDir, { recursive: true });
      const basePkg = {
        name: 'gitnoob-react-harness-base',
        private: true,
        type: 'module',
        dependencies: {
          react: '^18.3.1',
          'react-dom': '^18.3.1',
        },
        devDependencies: {
          vite: '^6.2.0',
          '@vitejs/plugin-react': '^4.3.4',
        },
      };
      await fsp.writeFile(path.join(baseDir, 'package.json'), JSON.stringify(basePkg, null, 2) + '\n', 'utf8');
      if (typeof onLog === 'function') {
        onLog('Initializing reusable React + Vite harness cache (one-time setup)...', 'stdout');
      }
      await runStreaming('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], {
        cwd: baseDir,
        timeoutMs: HARNESS_TIMEOUT_MS,
        onLog,
      });
      return baseDir;
    })().finally(() => {
      harnessBaseLock.delete(baseDir);
    });
    harnessBaseLock.set(baseDir, setupPromise);
  }

  return harnessBaseLock.get(baseDir);
}

async function copyNodeModulesFast(srcNodeModules, destNodeModules) {
  // On macOS APFS, `cp -cR` uses instant copy-on-write clones!
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('cp', ['-cR', srcNodeModules, destNodeModules], { maxBuffer: 10 * 1024 * 1024 });
      return;
    } catch {
      await fsp.rm(destNodeModules, { recursive: true, force: true }).catch(() => {});
    }
  }
  await fsp.cp(srcNodeModules, destNodeModules, { recursive: true });
}

async function copyRepoSourceFiltered(srcDir, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyRepoSourceFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      if (shouldSkipFile(entry.name)) continue;
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

function selectStylesheets(cssFiles, candidateRelPaths) {
  // Prioritize global stylesheets in root, src/, or the same folder as the top component
  const topDir = candidateRelPaths[0] ? path.dirname(candidateRelPaths[0]) : '';
  const selected = [];
  for (const css of cssFiles) {
    const lower = css.relPath.toLowerCase();
    const cssDir = path.dirname(css.relPath);
    const isTopLevelCss = /^(index|app|style|styles|main|global|globals)\.css$/.test(path.basename(lower));
    const isInSrcRoot = /^src\/[^/]+\.css$/.test(lower);
    const isInTopDir = cssDir === topDir;
    if (isTopLevelCss || isInSrcRoot || isInTopDir) {
      selected.push(css);
    }
  }
  return selected.slice(0, 6);
}

function buildViteConfigMjs({ repoPkgName, repoEntryFile, hasSrcDir }) {
  const aliases = [
    `{ find: '@', replacement: path.resolve(__dirname, ${JSON.stringify(hasSrcDir ? 'repo-src/src' : 'repo-src')}) }`,
    `{ find: '~', replacement: path.resolve(__dirname, 'repo-src') }`,
  ];
  if (repoPkgName && repoEntryFile) {
    aliases.push(
      `{ find: ${JSON.stringify(repoPkgName)}, replacement: path.resolve(__dirname, ${JSON.stringify(`repo-src/${repoEntryFile}`)}) }`,
    );
  }

  return `import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Support Rollup/microbundle-style default CSS string imports (e.g. \`import styles from "./styles.css"\`)
function gitnoobCssDefaultInlinePlugin() {
  return {
    name: 'gitnoob-css-default-inline',
    enforce: 'pre',
    transform(code, id) {
      if (!/\\.[cm]?[jt]sx?$/.test(id) || id.includes('node_modules')) return null;
      const rewritten = code.replace(
        /(import\\s+[A-Za-z_$][\\w$]*\\s+from\\s+['"])([^'"]+\\.css)(['"])/g,
        (match, pre, spec, quote) => {
          if (spec.endsWith('.module.css') || spec.includes('?')) return match;
          return \`\${pre}\${spec}?inline\${quote}\`;
        },
      );
      return rewritten !== code ? { code: rewritten, map: null } : null;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [gitnoobCssDefaultInlinePlugin(), react()],
  css: {
    postcss: {
      plugins: [],
    },
  },
  resolve: {
    alias: [
      ${aliases.join(',\n      ')}
    ],
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
`;
}

function buildHarnessIndexHtml({ title, useTailwindCdn }) {
  const safeTitle = String(title || 'React Component App')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="generator" content="GitNoob" />
    <title>${safeTitle}</title>
    ${useTailwindCdn ? '<script src="https://cdn.tailwindcss.com"></script>' : ''}
    <style>
      html, body, #root {
        margin: 0;
        padding: 0;
        min-height: 100%;
        background: #ffffff;
        color: #000000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function buildHarnessMainTsx({ appTitle, selectedComponents, cssImports, isFullAppEntry }) {
  const importLines = [
    `import React, { Component, useState } from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
  ];

  cssImports.forEach((relPath) => {
    importLines.push(`import '../repo-src/${relPath}';`);
  });

  const registryEntries = [];
  selectedComponents.forEach((comp, idx) => {
    const localVar = `Comp_${idx}`;
    const importPath = `../repo-src/${comp.relPath.replace(/\.[jt]sx?$/, '')}`;
    if (comp.isDefault) {
      importLines.push(`import ${localVar} from ${JSON.stringify(importPath)};`);
    } else {
      importLines.push(`import { ${comp.exportName} as ${localVar} } from ${JSON.stringify(importPath)};`);
    }
    registryEntries.push(
      `  { id: ${JSON.stringify(`${comp.displayName}-${idx}`)}, label: ${JSON.stringify(comp.displayName)}, file: ${JSON.stringify(comp.relPath)}, Component: ${localVar} }`,
    );
  });

  return `${importLines.join('\n')}

type ComponentEntry = {
  id: string;
  label: string;
  file: string;
  Component: React.ComponentType<any>;
};

const COMPONENTS: ComponentEntry[] = [
${registryEntries.join(',\n')}
];

const IS_FULL_APP = ${JSON.stringify(Boolean(isFullAppEntry))};
const APP_TITLE = ${JSON.stringify(appTitle)};

const FALLBACK_PROPS: Record<string, any> = {
  title: APP_TITLE,
  label: APP_TITLE,
  name: APP_TITLE,
  color: '#000000',
  value: '#000000',
  defaultValue: '#000000',
  onChange: () => {},
  onClick: () => {},
  onSubmit: () => {},
  isOpen: true,
  open: true,
  items: ['Item 1', 'Item 2', 'Item 3'],
  data: [
    { name: 'A', value: 40 },
    { name: 'B', value: 75 },
    { name: 'C', value: 55 },
  ],
  children: APP_TITLE,
};

type ErrorBoundaryProps = {
  componentKey: string;
  Comp: React.ComponentType<any>;
  useFallbackProps: boolean;
  onRetryWithFallback: () => void;
};

type ErrorBoundaryState = {
  error: Error | null;
};

class HarnessErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.componentKey !== this.props.componentKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch() {
    if (!this.props.useFallbackProps) {
      this.props.onRetryWithFallback();
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 560, margin: '48px auto', padding: 24, border: '1px solid #000000', borderRadius: 12, background: '#ffffff', color: '#000000' }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#525252', marginBottom: 8 }}>
            Component Render Notice
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
            This component expected custom props to render.
          </div>
          <pre style={{ fontSize: 12, padding: 12, background: '#f5f5f5', border: '1px solid #e5e5e5', borderRadius: 8, overflowX: 'auto', margin: '0 0 16px' }}>
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ padding: '8px 16px', background: '#000000', color: '#ffffff', border: 'none', borderRadius: 999, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
          >
            Try Again
          </button>
        </div>
      );
    }
    const Target = this.props.Comp;
    return this.props.useFallbackProps ? <Target {...FALLBACK_PROPS} /> : <Target />;
  }
}

function GitNoobHarnessApp() {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [fallbackIds, setFallbackIds] = useState<Record<string, boolean>>({});

  if (COMPONENTS.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: '#000000', background: '#ffffff' }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>{APP_TITLE}</h1>
        <p style={{ color: '#525252' }}>No renderable React components were detected in this repository.</p>
      </div>
    );
  }

  const active = COMPONENTS[selectedIdx] || COMPONENTS[0];
  const useFallback = Boolean(fallbackIds[active.id]);

  // If the repo has a full App/Demo component, render it cleanly without extra chrome
  if (IS_FULL_APP && COMPONENTS.length === 1) {
    return (
      <HarnessErrorBoundary
        key={\`\${active.id}-\${useFallback ? 'fb' : 'raw'}\`}
        componentKey={active.id}
        Comp={active.Component}
        useFallbackProps={useFallback}
        onRetryWithFallback={() => setFallbackIds((prev) => ({ ...prev, [active.id]: true }))}
      />
    );
  }

  const showSwitcher = COMPONENTS.length > 1;

  return (
    <div style={{ minHeight: '100vh', background: '#ffffff', color: '#000000', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '12px 20px', borderBottom: '1px solid #e5e5e5', background: '#ffffff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-0.01em' }}>{APP_TITLE}</span>
          <span style={{ fontSize: 12, color: '#525252', padding: '2px 8px', border: '1px solid #e5e5e5', borderRadius: 999 }}>
            {active.file}
          </span>
        </div>
        {showSwitcher && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            {COMPONENTS.map((entry, idx) => {
              const isSelected = idx === selectedIdx;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedIdx(idx)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 999,
                    border: isSelected ? '1px solid #000000' : '1px solid #e5e5e5',
                    background: isSelected ? '#000000' : '#ffffff',
                    color: isSelected ? '#ffffff' : '#000000',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        )}
      </header>
      <main style={{ flex: 1, display: 'flex', alignItems: IS_FULL_APP ? 'stretch' : 'center', justifyContent: 'center', padding: IS_FULL_APP ? 0 : 32 }}>
        <div style={{ width: IS_FULL_APP ? '100%' : 'auto', maxWidth: '100%' }}>
          <HarnessErrorBoundary
            key={\`\${active.id}-\${useFallback ? 'fb' : 'raw'}\`}
            componentKey={active.id}
            Comp={active.Component}
            useFallbackProps={useFallback}
            onRetryWithFallback={() => setFallbackIds((prev) => ({ ...prev, [active.id]: true }))}
          />
        </div>
      </main>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<GitNoobHarnessApp />);
}
`;
}

/**
 * Wraps raw React `.tsx`/`.jsx` component repositories (with no index.html or app build)
 * inside a synthesized React + Vite harness, compiles them to standalone static assets
 * in `appDestDir`, and returns a standard static buildResult.
 */
export async function buildReactComponentHarness({
  workDir,
  buildRoot,
  appDestDir,
  analysis,
  dataDir,
  localizeHtmlFn,
  onStageProgress,
  onLog,
}) {
  const emit = (stage, percent, message) => {
    if (typeof onStageProgress === 'function') {
      onStageProgress(stage, percent, message);
    }
  };

  emit('install', 20, 'Inspecting React components and dependencies...');

  const { componentFiles, allCodeFiles, cssFiles } = await scanRepoFiles(workDir);
  if (componentFiles.length === 0) {
    throw new Error('No renderable .tsx or .jsx React component files were found in this repository.');
  }

  // Inspect candidate component files and extract exported components
  const candidates = [];
  const allCodeTexts = [];
  const codeFileContents = [];

  for (const file of allCodeFiles) {
    const content = await fsp.readFile(file.fullPath, 'utf8').catch(() => '');
    if (!content) continue;
    allCodeTexts.push(content);
    codeFileContents.push({ relPath: file.relPath, content });
  }

  for (const file of componentFiles) {
    const content = await fsp.readFile(file.fullPath, 'utf8').catch(() => '');
    if (!content) continue;
    const exportsList = extractComponentExports(content, file.relPath);
    for (const exp of exportsList) {
      const score = scoreComponentCandidate(file.relPath, exp, content);
      candidates.push({
        relPath: file.relPath,
        exportName: exp.exportName,
        displayName: exp.displayName,
        isDefault: exp.isDefault,
        score,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error('Found .tsx/.jsx files, but none exported a renderable React component.');
  }

  candidates.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

  // Deduplicate by displayName, keeping highest-ranked export
  const seenNames = new Set();
  const uniqueRanked = [];
  for (const c of candidates) {
    if (seenNames.has(c.displayName)) continue;
    seenNames.add(c.displayName);
    uniqueRanked.push(c);
  }

  // If the top candidate is a dedicated App/Demo component (score >= 110), prefer rendering it directly
  const isFullAppEntry = uniqueRanked[0].score >= 110;
  const selectedComponents = isFullAppEntry
    ? uniqueRanked.filter((c) => c.score >= 110).slice(0, 4)
    : uniqueRanked.filter((c) => c.score >= 60).slice(0, MAX_COMPONENTS_IN_SWITCHER);
  if (selectedComponents.length === 0) {
    selectedComponents.push(uniqueRanked[0]);
  }

  // Only scan third-party imports from active code trees (skip demo/example-only deps if selected components live in src/ or root)
  const usesDemoOrExample = selectedComponents.some((c) => /^(demo|example|examples)\//i.test(c.relPath));
  const importedPackages = new Set();
  for (const { relPath, content } of codeFileContents) {
    if (!usesDemoOrExample && /^(demo|example|examples)\//i.test(relPath)) continue;
    for (const pkg of extractBareSpecifiers(content)) {
      importedPackages.add(pkg);
    }
  }

  if (typeof onLog === 'function') {
    onLog(
      `Detected ${selectedComponents.length} React component(s): ${selectedComponents.map((c) => `${c.displayName} (${c.relPath})`).join(', ')}`,
      'stdout',
    );
  }

  // Gather extra third-party dependencies from repo package.json + source imports
  const repoPkg = await readJsonSafe(path.join(workDir, 'package.json'));
  const repoPkgName = repoPkg?.name || null;
  if (repoPkgName) {
    importedPackages.delete(repoPkgName);
  }

  const extraDeps = new Map();
  const repoDeps = { ...(repoPkg?.dependencies || {}) };
  const repoDevDeps = { ...(repoPkg?.devDependencies || {}) };
  for (const [pkgName, ver] of Object.entries(repoDeps)) {
    if (!IGNORED_PACKAGES.has(pkgName) && !pkgName.startsWith('@types/') && pkgName !== repoPkgName) {
      extraDeps.set(pkgName, ver);
    }
  }
  for (const pkgName of importedPackages) {
    if (!extraDeps.has(pkgName)) {
      extraDeps.set(pkgName, repoDevDeps[pkgName] || 'latest');
    }
  }

  // Ensure shared reusable React+Vite harness cache is warm
  emit('install', 24, 'Preparing reusable React + Vite harness...');
  const baseDir = await ensureReactHarnessBase(dataDir, onLog);

  const harnessDir = path.join(buildRoot, 'harness');
  const repoSrcDir = path.join(harnessDir, 'repo-src');
  const harnessSrcDir = path.join(harnessDir, 'src');
  await fsp.rm(harnessDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(harnessSrcDir, { recursive: true });

  // Copy repo source into harness/repo-src/
  await copyRepoSourceFiltered(workDir, repoSrcDir);

  // Determine if repo has an entry file for package-name aliasing (e.g., `import { HexColorPicker } from 'react-colorful'`)
  let repoEntryFile = null;
  for (const candidate of ['src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx', 'index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
    if (fs.existsSync(path.join(repoSrcDir, candidate))) {
      repoEntryFile = candidate;
      break;
    }
  }

  const harnessPkg = {
    name: 'gitnoob-react-harness',
    private: true,
    type: 'module',
    scripts: {
      build: 'vite build --base=./',
    },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      ...Object.fromEntries(extraDeps.entries()),
    },
    devDependencies: {
      vite: '^6.2.0',
      '@vitejs/plugin-react': '^4.3.4',
    },
  };
  await fsp.writeFile(path.join(harnessDir, 'package.json'), JSON.stringify(harnessPkg, null, 2) + '\n', 'utf8');

  const baseNodeModules = path.join(baseDir, 'node_modules');
  const harnessNodeModules = path.join(harnessDir, 'node_modules');

  if (extraDeps.size === 0) {
    // Zero extra deps — symlink straight to cached node_modules (instant!)
    await fsp.symlink(baseNodeModules, harnessNodeModules, 'dir');
    emit('install', 38, 'Linked cached React + Vite harness (zero extra dependencies).');
  } else {
    emit('install', 28, `Installing ${extraDeps.size} component package(s): ${[...extraDeps.keys()].slice(0, 5).join(', ')}...`);
    await copyNodeModulesFast(baseNodeModules, harnessNodeModules);
    const installSpecs = [...extraDeps.entries()].map(([name, ver]) => {
      if (!ver || ver === 'latest' || ver === '*') return name;
      // Avoid workspace:/file: specifiers that won't resolve from npm
      if (/^(workspace|file|link|portal):/.test(ver)) return name;
      return `${name}@${ver}`;
    });
    await runStreaming('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefer-offline', ...installSpecs], {
      cwd: harnessDir,
      timeoutMs: HARNESS_TIMEOUT_MS,
      onLog,
    });
    emit('install', 38, 'Component dependencies installed.');
  }

  // Synthesize harness files
  const selectedCss = selectStylesheets(cssFiles, selectedComponents.map((c) => c.relPath));
  const safeCssImports = [];
  let hasTailwindDirective = false;

  for (const css of selectedCss) {
    const destCssPath = path.join(repoSrcDir, css.relPath);
    if (!fs.existsSync(destCssPath)) continue;
    const rawCss = await fsp.readFile(destCssPath, 'utf8').catch(() => '');
    if (/@tailwind\b|@import\s+['"]tailwindcss['"]/i.test(rawCss)) {
      hasTailwindDirective = true;
      const stripped = rawCss
        .replace(/@tailwind\s+[^;]+;/gi, '')
        .replace(/@import\s+['"]tailwindcss['"]\s*;/gi, '');
      await fsp.writeFile(destCssPath, stripped, 'utf8');
    }
    safeCssImports.push(css.relPath);
  }

  const useTailwindCdn = hasTailwindDirective || detectTailwindUsage(allCodeTexts);
  const appTitle = analysis?.name || analysis?.repo || 'React Component App';
  const hasSrcDir = fs.existsSync(path.join(repoSrcDir, 'src'));

  await fsp.writeFile(
    path.join(harnessDir, 'vite.config.mjs'),
    buildViteConfigMjs({ repoPkgName, repoEntryFile, hasSrcDir }),
    'utf8',
  );
  await fsp.writeFile(
    path.join(harnessDir, 'index.html'),
    buildHarnessIndexHtml({ title: appTitle, useTailwindCdn }),
    'utf8',
  );
  await fsp.writeFile(
    path.join(harnessSrcDir, 'main.tsx'),
    buildHarnessMainTsx({
      appTitle,
      selectedComponents,
      cssImports: safeCssImports,
      isFullAppEntry,
    }),
    'utf8',
  );

  // Compile with Vite!
  emit('build', 44, `Compiling React component harness (${selectedComponents.length} component${selectedComponents.length === 1 ? '' : 's'})...`);
  const viteBin = path.join(harnessNodeModules, '.bin', 'vite');
  await runStreaming(viteBin, ['build', '--base=./'], {
    cwd: harnessDir,
    timeoutMs: HARNESS_TIMEOUT_MS,
    env: { NODE_ENV: 'production', CI: 'false' },
    onLog,
  });

  const compiledDist = path.join(harnessDir, 'dist');
  if (!fs.existsSync(path.join(compiledDist, 'index.html'))) {
    throw new Error('React harness build finished, but dist/index.html was not produced.');
  }

  await fsp.rm(appDestDir, { recursive: true, force: true }).catch(() => {});
  await fsp.cp(compiledDist, appDestDir, { recursive: true });

  if (typeof localizeHtmlFn === 'function') {
    await localizeHtmlFn(appDestDir);
  }

  emit('build', 54, `Compiled React component app (${selectedComponents.map((c) => c.displayName).slice(0, 3).join(', ')}).`);

  return {
    appMode: 'static',
    runtimeNeeded: 'node',
    appDir: appDestDir,
    previewDir: appDestDir,
    previewType: 'static',
    previewEntry: 'index.html',
    defaultPort: 4173,
    isWeb: true,
    isReactHarness: true,
    harnessComponents: selectedComponents.map((c) => c.displayName),
    runConfig: { mode: 'static', entryPoint: 'index.html', defaultPort: 4173 },
  };
}
