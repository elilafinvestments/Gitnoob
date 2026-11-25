import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_TOTAL_ARTIFACT_BYTES = 25 * 1024 * 1024; // 25 MB cap
const MAX_SINGLE_ASSET_BYTES = 8 * 1024 * 1024; // 8 MB per binary asset

const MIME_BY_EXT = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.wasm': 'application/wasm',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function isRemoteOrDataUrl(ref) {
  if (!ref) return true;
  const trimmed = ref.trim();
  if (!trimmed) return true;
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:')
  );
}

function resolveLocalAssetPath(ref, baseDir, rootDir) {
  const cleanRef = ref.trim().split(/[?#]/)[0];
  if (!cleanRef) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(cleanRef);
  } catch {
    decoded = cleanRef;
  }

  const candidate = decoded.startsWith('/')
    ? path.resolve(rootDir, decoded.slice(1))
    : path.resolve(baseDir, decoded);

  const normalizedRoot = path.resolve(rootDir);
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
    return null;
  }

  return candidate;
}

async function fileToDataUri(filePath, budget) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_SINGLE_ASSET_BYTES) return null;
    const encodedEstimate = Math.ceil(stat.size * 1.37) + 64;
    if (budget.remaining < encodedEstimate) return null;

    const buf = await fsp.readFile(filePath);
    const mime = getMimeType(filePath);
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    budget.remaining -= dataUri.length;
    budget.inlinedAssets += 1;
    return dataUri;
  } catch {
    return null;
  }
}

async function inlineCssUrls(cssContent, cssDir, rootDir, budget, depth = 0) {
  if (depth > 3) return cssContent;

  // Handle @import "foo.css" or @import url("foo.css")
  let processed = '';
  const importRegex = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?([^;]*);/gi;
  let lastIndex = 0;
  for (const match of cssContent.matchAll(importRegex)) {
    const [fullMatch, , href, media] = match;
    processed += cssContent.slice(lastIndex, match.index);
    lastIndex = match.index + fullMatch.length;

    if (isRemoteOrDataUrl(href)) {
      processed += fullMatch;
      continue;
    }

    const importPath = resolveLocalAssetPath(href, cssDir, rootDir);
    if (importPath && fs.existsSync(importPath)) {
      try {
        const importedCss = await fsp.readFile(importPath, 'utf8');
        const resolvedNested = await inlineCssUrls(
          importedCss,
          path.dirname(importPath),
          rootDir,
          budget,
          depth + 1,
        );
        const mediaQuery = media && media.trim() ? media.trim() : '';
        processed += mediaQuery ? `@media ${mediaQuery} {\n${resolvedNested}\n}` : resolvedNested;
        budget.inlinedAssets += 1;
        continue;
      } catch {
        // Keep original import on error
      }
    }
    processed += fullMatch;
  }
  processed += cssContent.slice(lastIndex);

  // Replace url(...) references with base64 data URIs
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let out = '';
  lastIndex = 0;
  for (const match of processed.matchAll(urlRegex)) {
    const [fullMatch, , rawRef] = match;
    out += processed.slice(lastIndex, match.index);
    lastIndex = match.index + fullMatch.length;

    if (isRemoteOrDataUrl(rawRef)) {
      out += fullMatch;
      continue;
    }

    const assetPath = resolveLocalAssetPath(rawRef, cssDir, rootDir);
    if (assetPath) {
      const dataUri = await fileToDataUri(assetPath, budget);
      if (dataUri) {
        out += `url("${dataUri}")`;
        continue;
      }
    }
    out += fullMatch;
  }
  out += processed.slice(lastIndex);

  return out;
}

function escapeInlineScript(jsContent) {
  return jsContent.replace(/<\/(script)/gi, '<\\/$1');
}

function escapeInlineStyle(cssContent) {
  return cssContent.replace(/<\/(style)/gi, '<\\/$1');
}

function parseAttributes(tagStr) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRegex.exec(tagStr)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

/**
 * Generates a self-contained single-file HTML artifact (Claude-Artifact style)
 * from a static app/game directory containing index.html.
 * Returns { path, fileName, sizeBytes, inlinedAssetsCount } or null if not eligible.
 */
export async function buildSingleHtmlArtifact({ appDir, outDir, slug, emblemSvg }) {
  const indexPath = path.join(appDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  let html = await fsp.readFile(indexPath, 'utf8');
  if (!html || !html.trim()) {
    return null;
  }

  const budget = {
    remaining: MAX_TOTAL_ARTIFACT_BYTES - Buffer.byteLength(html, 'utf8'),
    inlinedAssets: 0,
  };

  // 1. Inline local <link rel="stylesheet" href="..."> and favicon <link rel="icon" href="...">
  const linkRegex = /<link\b[^>]*>/gi;
  let result = '';
  let lastIndex = 0;
  for (const match of html.matchAll(linkRegex)) {
    const fullTag = match[0];
    result += html.slice(lastIndex, match.index);
    lastIndex = match.index + fullTag.length;

    const attrs = parseAttributes(fullTag);
    const rel = (attrs.rel || '').toLowerCase();
    const href = attrs.href || '';

    if (isRemoteOrDataUrl(href)) {
      result += fullTag;
      continue;
    }

    const assetPath = resolveLocalAssetPath(href, appDir, appDir);
    if (!assetPath || !fs.existsSync(assetPath)) {
      result += fullTag;
      continue;
    }

    if (rel.split(/\s+/).includes('stylesheet')) {
      try {
        const cssRaw = await fsp.readFile(assetPath, 'utf8');
        if (budget.remaining > Buffer.byteLength(cssRaw, 'utf8')) {
          const cssInlined = await inlineCssUrls(cssRaw, path.dirname(assetPath), appDir, budget);
          const safeCss = escapeInlineStyle(cssInlined);
          const mediaAttr = attrs.media ? ` media="${attrs.media}"` : '';
          budget.remaining -= Buffer.byteLength(safeCss, 'utf8');
          budget.inlinedAssets += 1;
          result += `<style${mediaAttr} data-gitnoob-src="${href}">\n${safeCss}\n</style>`;
          continue;
        }
      } catch {
        // Keep original tag on failure
      }
    } else if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
      const dataUri = await fileToDataUri(assetPath, budget);
      if (dataUri) {
        const updatedTag = fullTag.replace(
          /href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
          `href="${dataUri}"`,
        );
        result += updatedTag;
        continue;
      }
    }

    result += fullTag;
  }
  result += html.slice(lastIndex);
  html = result;

  // 2. Inline url(...) inside existing inline <style>...</style> blocks
  const styleBlockRegex = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
  result = '';
  lastIndex = 0;
  for (const match of html.matchAll(styleBlockRegex)) {
    const [fullMatch, openTag, cssBody, closeTag] = match;
    result += html.slice(lastIndex, match.index);
    lastIndex = match.index + fullMatch.length;

    if (openTag.includes('data-gitnoob-src=')) {
      result += fullMatch;
      continue;
    }
    const processedCss = await inlineCssUrls(cssBody, appDir, appDir, budget);
    result += `${openTag}${escapeInlineStyle(processedCss)}${closeTag}`;
  }
  result += html.slice(lastIndex);
  html = result;

  // 3. Inline local <script ... src="..."></script>
  const scriptRegex = /<script\b([^>]*)>\s*<\/script>/gi;
  result = '';
  lastIndex = 0;
  let skippedModuleImport = false;
  for (const match of html.matchAll(scriptRegex)) {
    const [fullMatch, attrStr] = match;
    result += html.slice(lastIndex, match.index);
    lastIndex = match.index + fullMatch.length;

    const attrs = parseAttributes(attrStr);
    const src = attrs.src || '';

    if (!src || isRemoteOrDataUrl(src)) {
      result += fullMatch;
      continue;
    }

    const scriptPath = resolveLocalAssetPath(src, appDir, appDir);
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      result += fullMatch;
      continue;
    }

    try {
      const jsRaw = await fsp.readFile(scriptPath, 'utf8');
      const isModule = (attrs.type || '').toLowerCase() === 'module';

      // If an ES module script relies on relative imports (e.g. import x from './chunk.js'),
      // inlining it alone breaks relative resolution in file:// mode.
      if (isModule && /(?:import|export)\s+[^'"]*from\s+['"]\.{1,2}\//.test(jsRaw)) {
        skippedModuleImport = true;
        result += fullMatch;
        continue;
      }

      if (budget.remaining > Buffer.byteLength(jsRaw, 'utf8')) {
        const safeJs = escapeInlineScript(jsRaw);
        budget.remaining -= Buffer.byteLength(safeJs, 'utf8');
        budget.inlinedAssets += 1;
        const typeAttr = attrs.type ? ` type="${attrs.type}"` : '';
        result += `<script${typeAttr} data-gitnoob-src="${src}">\n${safeJs}\n</script>`;
        continue;
      }
    } catch {
      // Keep original tag on error
    }

    result += fullMatch;
  }
  result += html.slice(lastIndex);
  html = result;

  // If the app uses chunked ES modules that couldn't be inlined standalone, it's not a clean single-file artifact
  if (skippedModuleImport) {
    return null;
  }

  // 4. Inline local <img ... src="..."> as base64 data URIs
  const imgRegex = /<img\b[^>]*>/gi;
  result = '';
  lastIndex = 0;
  for (const match of html.matchAll(imgRegex)) {
    const fullTag = match[0];
    result += html.slice(lastIndex, match.index);
    lastIndex = match.index + fullTag.length;

    const attrs = parseAttributes(fullTag);
    const src = attrs.src || '';
    if (!src || isRemoteOrDataUrl(src)) {
      result += fullTag;
      continue;
    }

    const imgPath = resolveLocalAssetPath(src, appDir, appDir);
    if (imgPath) {
      const dataUri = await fileToDataUri(imgPath, budget);
      if (dataUri) {
        const updatedTag = fullTag.replace(
          /src\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
          `src="${dataUri}"`,
        );
        result += updatedTag;
        continue;
      }
    }
    result += fullTag;
  }
  result += html.slice(lastIndex);
  html = result;

  // 5. Inject clean <meta name="generator" content="GitNoob"> & bespoke emblem fallback favicon
  const metaTag = '<meta name="generator" content="GitNoob">';
  if (!/name=["']generator["'][^>]*GitNoob/i.test(html)) {
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n  ${metaTag}`);
    } else if (/<html\b[^>]*>/i.test(html)) {
      html = html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${metaTag}</head>`);
    } else {
      html = `${metaTag}\n${html}`;
    }
  }

  if (emblemSvg && !/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i.test(html)) {
    const iconDataUri = `data:image/svg+xml;base64,${Buffer.from(emblemSvg, 'utf8').toString('base64')}`;
    const faviconTag = `<link rel="icon" type="image/svg+xml" href="${iconDataUri}">`;
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n  ${faviconTag}`);
    }
  }

  const finalSize = Buffer.byteLength(html, 'utf8');
  if (finalSize > MAX_TOTAL_ARTIFACT_BYTES) {
    return null;
  }

  await fsp.mkdir(outDir, { recursive: true });
  const fileName = `${slug}-artifact.html`;
  const outPath = path.join(outDir, fileName);
  await fsp.writeFile(outPath, html, 'utf8');

  return {
    path: outPath,
    fileName,
    sizeBytes: finalSize,
    inlinedAssetsCount: budget.inlinedAssets,
  };
}
