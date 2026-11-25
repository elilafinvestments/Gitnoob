import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EMBLEM_HELPER_VERSION = 'v2';
const compileLocks = new Map();

const COMPOUND_PREFIXES = [
  'micro',
  'macro',
  'super',
  'hyper',
  'multi',
  'inter',
  'under',
  'over',
  'auto',
  'mini',
  'mega',
  'meta',
  'open',
  'fast',
  'code',
  'data',
  'play',
  'game',
  'note',
  'task',
  'chat',
  'mail',
  'file',
  'time',
  'home',
  'web',
  'app',
  'dev',
  'git',
  'net',
  'doc',
  'pdf',
  'img',
  'vid',
  'sql',
  'api',
  'bot',
  'cli',
  'py',
];

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function normalizeEmblemKind({ category, framework, packagingStrategy } = {}) {
  const cat = String(category || '').toLowerCase();
  const fw = String(framework || '').toLowerCase();
  const strat = String(packagingStrategy || '').toLowerCase();

  if (strat === 'react-component') return 'react';
  if (cat === 'game') return 'game';
  if (strat === 'python-portable' || cat === 'python-app' || fw.includes('python') || fw.includes('flask') || fw.includes('fastapi') || fw.includes('streamlit') || fw.includes('django')) {
    return 'python';
  }
  if (strat === 'node-portable' || cat === 'node-app' || cat === 'cli-tool') return 'node';
  if (fw.includes('react') && cat !== 'web-app') return 'react';
  return 'web';
}

export function deriveEmblemMonogram(appName) {
  const raw = String(appName || 'GN').trim();
  if (!raw) return 'GN';

  // Pure short alphanumeric token (e.g. "2048", "vim", "ai")
  const compact = raw.replace(/[^A-Za-z0-9]/g, '');
  if (compact.length > 0 && compact.length <= 4 && (/^\d+$/.test(compact) || compact.length <= 2)) {
    return compact.toUpperCase();
  }

  // Split on separators and camelCase boundaries
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  const word = (words[0] || compact || 'GN');
  const lower = word.toLowerCase();

  // Check well-known compound word prefixes (e.g. "microblog" -> "MB")
  for (const prefix of COMPOUND_PREFIXES) {
    if (lower.startsWith(prefix) && lower.length > prefix.length + 1) {
      return (word[0] + word[prefix.length]).toUpperCase();
    }
  }

  // Single word: first letter + next strong consonant (e.g. "hextris" -> "HX", "pacman" -> "PC")
  const rest = word.slice(1);
  const strongConsonant = rest.match(/[bcdfghjklmnpqrstvwxz]/i);
  if (strongConsonant) {
    return (word[0] + strongConsonant[0]).toUpperCase();
  }

  return word.slice(0, 2).toUpperCase() || 'GN';
}

function buildCategoryGlyphSvg(kind) {
  // Centered around (512, 246), rendered in crisp monochrome white stroke/fill
  switch (kind) {
    case 'game':
      // Crisp geometric D-pad + action dots
      return `
    <g transform="translate(512 246)" fill="none" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
      <rect x="-56" y="-28" width="112" height="56" rx="22" fill="#181818" stroke="#FFFFFF" stroke-width="8"/>
      <line x1="-30" y1="0" x2="-10" y2="0" stroke-width="8"/>
      <line x1="-20" y1="-10" x2="-20" y2="10" stroke-width="8"/>
      <circle cx="16" cy="-6" r="4.5" fill="#FFFFFF" stroke="none"/>
      <circle cx="30" cy="6" r="4.5" fill="#FFFFFF" stroke="none"/>
    </g>`;
    case 'react':
      // Crisp geometric React orbital rings
      return `
    <g transform="translate(512 246)" fill="none" stroke="#FFFFFF" stroke-width="7.5">
      <ellipse rx="46" ry="18"/>
      <ellipse rx="46" ry="18" transform="rotate(60)"/>
      <ellipse rx="46" ry="18" transform="rotate(120)"/>
      <circle r="7.5" fill="#FFFFFF" stroke="none"/>
    </g>`;
    case 'python':
      // Crisp terminal prompt + spark glyph
      return `
    <g transform="translate(512 246)" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="-52" y="-30" width="104" height="60" rx="14" fill="#181818"/>
      <polyline points="-28,-10 -12,0 -28,10"/>
      <line x1="2" y1="10" x2="26" y2="10"/>
      <circle cx="28" cy="-12" r="4" fill="#FFFFFF" stroke="none"/>
    </g>`;
    case 'node':
      // Crisp isometric architectural cube
      return `
    <g transform="translate(512 246)" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="0,-38 36,-18 36,18 0,38 -36,18 -36,-18" fill="#181818"/>
      <polyline points="-36,-18 0,2 36,-18"/>
      <line x1="0" y1="2" x2="0" y2="38"/>
    </g>`;
    case 'web':
    default:
      // Crisp minimal browser window grid
      return `
    <g transform="translate(512 246)" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="-52" y="-30" width="104" height="60" rx="12" fill="#181818"/>
      <line x1="-52" y1="-10" x2="52" y2="-10"/>
      <circle cx="-34" cy="-20" r="3.5" fill="#FFFFFF" stroke="none"/>
      <circle cx="-20" cy="-20" r="3.5" fill="#FFFFFF" stroke="none"/>
      <line x1="-14" y1="-10" x2="-14" y2="30" stroke-opacity="0.55" stroke-width="6"/>
    </g>`;
  }
}

/**
 * Generates a crisp 1024x1024 GitNoob architectural monochrome squircle emblem SVG
 * with Apple macOS icon inset proportions (~100px margin).
 */
export function buildArtifactEmblemSvg({ appName, category, framework, packagingStrategy } = {}) {
  const monogram = deriveEmblemMonogram(appName);
  const kind = normalizeEmblemKind({ category, framework, packagingStrategy });
  const glyphSvg = buildCategoryGlyphSvg(kind);

  const fontSize =
    monogram.length >= 4 ? 204 : monogram.length === 3 ? 258 : monogram.length === 2 ? 330 : 380;
  const letterSpacing = monogram.length >= 4 ? -3 : monogram.length === 3 ? -4 : -6;
  const textY = monogram.length >= 4 ? 588 : 622;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" data-monogram="${escapeXml(monogram)}" data-category="${escapeXml(kind)}">
  <!-- Outer architectural white frame (macOS 100px safe inset -> 824x824 squircle) -->
  <rect x="100" y="100" width="824" height="824" rx="186" fill="#FFFFFF" stroke="#E5E5E5" stroke-width="8"/>
  <!-- Deep matte-black core squircle -->
  <rect x="128" y="128" width="768" height="768" rx="160" fill="#0A0A0A"/>
  <!-- Fine architectural inner hairline border -->
  <rect x="160" y="160" width="704" height="704" rx="132" fill="none" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="4"/>
  <!-- Subtle corner registration ticks -->
  <g stroke="#FFFFFF" stroke-opacity="0.42" stroke-width="5" stroke-linecap="round">
    <line x1="226" y1="196" x2="250" y2="196"/>
    <line x1="774" y1="196" x2="798" y2="196"/>
    <line x1="226" y1="828" x2="250" y2="828"/>
    <line x1="774" y1="828" x2="798" y2="828"/>
  </g>
  <!-- Top category emblem glyph -->${glyphSvg}
  <!-- Center focal geometric monogram -->
  <text x="512" y="${textY}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', 'Liberation Sans', 'DejaVu Sans', Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" letter-spacing="${letterSpacing}" fill="#FFFFFF">${escapeXml(monogram)}</text>
  <!-- Bottom GitNoob hallmark pill -->
  <rect x="372" y="740" width="280" height="58" rx="29" fill="#141414" stroke="#FFFFFF" stroke-opacity="0.28" stroke-width="3"/>
  <circle cx="406" cy="769" r="6" fill="#FFFFFF"/>
  <text x="524" y="779" text-anchor="middle" font-family="'SF Mono', Menlo, Monaco, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace" font-weight="700" font-size="28" letter-spacing="6" fill="#FFFFFF">GITNOOB</text>
</svg>
`;
}

export function emblemSvgToDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function buildSwiftRendererSource() {
  return `import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
if args.count < 4 {
    fputs("Usage: emblem-render <output.png> <monogram> <kind>\\n", stderr)
    exit(1)
}
let outPath = args[1]
let monogram = args[2]
let kind = args[3]

let size = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fputs("Failed to create CGContext\\n", stderr)
    exit(1)
}

ctx.setAllowsAntialiasing(true)
ctx.setShouldAntialias(true)
ctx.setAllowsFontSmoothing(true)
ctx.setShouldSmoothFonts(true)

// Helper: flip Y from top-left SVG coordinates (0..1024) to CoreGraphics bottom-left
func flipRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
    return CGRect(x: x, y: 1024.0 - y - h, width: w, height: h)
}
func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    return CGPoint(x: x, y: 1024.0 - y)
}
func addRoundedRect(_ rect: CGRect, radius: CGFloat) -> CGPath {
    return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

// 1. Clear transparent canvas
ctx.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))

// 2. Outer white architectural squircle frame (100px Apple macOS safe inset)
let outerRect = flipRect(100, 100, 824, 824)
let outerPath = addRoundedRect(outerRect, radius: 186)
ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
ctx.addPath(outerPath)
ctx.fillPath()
ctx.setStrokeColor(red: 0.898, green: 0.898, blue: 0.898, alpha: 1)
ctx.setLineWidth(8)
ctx.addPath(outerPath)
ctx.strokePath()

// 3. Deep matte-black core squircle
let corePath = addRoundedRect(flipRect(128, 128, 768, 768), radius: 160)
ctx.setFillColor(red: 0.039, green: 0.039, blue: 0.039, alpha: 1)
ctx.addPath(corePath)
ctx.fillPath()

// 4. Fine inner hairline border
let innerPath = addRoundedRect(flipRect(160, 160, 704, 704), radius: 132)
ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.18)
ctx.setLineWidth(4)
ctx.addPath(innerPath)
ctx.strokePath()

// 5. Corner registration ticks
ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.42)
ctx.setLineWidth(5)
ctx.setLineCap(.round)
let ticks: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
    (226, 196, 250, 196),
    (774, 196, 798, 196),
    (226, 828, 250, 828),
    (774, 828, 798, 828)
]
for t in ticks {
    ctx.move(to: pt(t.0, t.1))
    ctx.addLine(to: pt(t.2, t.3))
}
ctx.strokePath()

// 6. Top category glyph centered at (512, 246)
let cx: CGFloat = 512
let cy: CGFloat = 246
ctx.setLineCap(.round)
ctx.setLineJoin(.round)

if kind == "game" {
    let pad = addRoundedRect(flipRect(cx - 56, cy - 28, 112, 56), radius: 22)
    ctx.setFillColor(red: 0.094, green: 0.094, blue: 0.094, alpha: 1)
    ctx.addPath(pad)
    ctx.fillPath()
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.setLineWidth(8)
    ctx.addPath(pad)
    ctx.strokePath()
    ctx.move(to: pt(cx - 30, cy))
    ctx.addLine(to: pt(cx - 10, cy))
    ctx.move(to: pt(cx - 20, cy - 10))
    ctx.addLine(to: pt(cx - 20, cy + 10))
    ctx.strokePath()
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fillEllipse(in: flipRect(cx + 11.5, cy - 10.5, 9, 9))
    ctx.fillEllipse(in: flipRect(cx + 25.5, cy + 1.5, 9, 9))
} else if kind == "react" {
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.setLineWidth(7.5)
    for angle in [0.0, 60.0, 120.0] {
        ctx.saveGState()
        ctx.translateBy(x: cx, y: 1024.0 - cy)
        ctx.rotate(by: CGFloat(angle * .pi / 180.0))
        ctx.strokeEllipse(in: CGRect(x: -46, y: -18, width: 92, height: 36))
        ctx.restoreGState()
    }
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fillEllipse(in: flipRect(cx - 7.5, cy - 7.5, 15, 15))
} else if kind == "python" {
    let box = addRoundedRect(flipRect(cx - 52, cy - 30, 104, 60), radius: 14)
    ctx.setFillColor(red: 0.094, green: 0.094, blue: 0.094, alpha: 1)
    ctx.addPath(box)
    ctx.fillPath()
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.setLineWidth(8)
    ctx.addPath(box)
    ctx.strokePath()
    ctx.move(to: pt(cx - 28, cy - 10))
    ctx.addLine(to: pt(cx - 12, cy))
    ctx.addLine(to: pt(cx - 28, cy + 10))
    ctx.move(to: pt(cx + 2, cy + 10))
    ctx.addLine(to: pt(cx + 26, cy + 10))
    ctx.strokePath()
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fillEllipse(in: flipRect(cx + 24, cy - 16, 8, 8))
} else if kind == "node" {
    let hexPts = [
        pt(cx, cy - 38),
        pt(cx + 36, cy - 18),
        pt(cx + 36, cy + 18),
        pt(cx, cy + 38),
        pt(cx - 36, cy + 18),
        pt(cx - 36, cy - 18)
    ]
    ctx.setFillColor(red: 0.094, green: 0.094, blue: 0.094, alpha: 1)
    ctx.addLines(between: hexPts)
    ctx.closePath()
    ctx.fillPath()
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.setLineWidth(8)
    ctx.addLines(between: hexPts)
    ctx.closePath()
    ctx.strokePath()
    ctx.move(to: pt(cx - 36, cy - 18))
    ctx.addLine(to: pt(cx, cy + 2))
    ctx.addLine(to: pt(cx + 36, cy - 18))
    ctx.move(to: pt(cx, cy + 2))
    ctx.addLine(to: pt(cx, cy + 38))
    ctx.strokePath()
} else {
    let win = addRoundedRect(flipRect(cx - 52, cy - 30, 104, 60), radius: 12)
    ctx.setFillColor(red: 0.094, green: 0.094, blue: 0.094, alpha: 1)
    ctx.addPath(win)
    ctx.fillPath()
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.setLineWidth(8)
    ctx.addPath(win)
    ctx.strokePath()
    ctx.move(to: pt(cx - 52, cy - 10))
    ctx.addLine(to: pt(cx + 52, cy - 10))
    ctx.strokePath()
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.55)
    ctx.setLineWidth(6)
    ctx.move(to: pt(cx - 14, cy - 10))
    ctx.addLine(to: pt(cx - 14, cy + 30))
    ctx.strokePath()
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    ctx.fillEllipse(in: flipRect(cx - 37.5, cy - 23.5, 7, 7))
    ctx.fillEllipse(in: flipRect(cx - 23.5, cy - 23.5, 7, 7))
}

// Helper to draw centered CoreText string at SVG center (x, centerY)
func drawCenteredText(_ text: String, centerX: CGFloat, centerY: CGFloat, fontName: String, fontSize: CGFloat, kern: CGFloat) {
    let font = CTFontCreateWithName(fontName as CFString, fontSize, nil)
    let color = CGColor(colorSpace: colorSpace, components: [1, 1, 1, 1])!
    let attrs: [CFString: Any] = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: color,
        kCTKernAttributeName: kern
    ]
    let attrStr = CFAttributedStringCreate(kCFAllocatorDefault, text as CFString, attrs as CFDictionary)!
    let line = CTLineCreateWithAttributedString(attrStr)
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    let drawX = centerX - bounds.width / 2.0 - bounds.origin.x
    let drawY = (1024.0 - centerY) - bounds.height / 2.0 - bounds.origin.y
    ctx.textMatrix = .identity
    ctx.textPosition = CGPoint(x: drawX, y: drawY)
    CTLineDraw(line, ctx)
}

// 7. Center focal monogram
let mLen = monogram.count
let mFontSize: CGFloat = mLen >= 4 ? 204 : (mLen == 3 ? 258 : (mLen == 2 ? 330 : 380))
let mKern: CGFloat = mLen >= 4 ? -3 : (mLen == 3 ? -4 : -6)
drawCenteredText(monogram, centerX: 512, centerY: 514, fontName: "HelveticaNeue-Bold", fontSize: mFontSize, kern: mKern)

// 8. Bottom GITNOOB hallmark pill
let pillPath = addRoundedRect(flipRect(372, 740, 280, 58), radius: 29)
ctx.setFillColor(red: 0.078, green: 0.078, blue: 0.078, alpha: 1)
ctx.addPath(pillPath)
ctx.fillPath()
ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.28)
ctx.setLineWidth(3)
ctx.addPath(pillPath)
ctx.strokePath()

ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
ctx.fillEllipse(in: flipRect(400, 763, 12, 12))
drawCenteredText("GITNOOB", centerX: 524, centerY: 769, fontName: "Menlo-Bold", fontSize: 28, kern: 6)

guard let image = ctx.makeImage() else {
    fputs("Failed to make CGImage\\n", stderr)
    exit(1)
}
let outURL = URL(fileURLWithPath: outPath) as CFURL
guard let dest = CGImageDestinationCreateWithURL(outURL, UTType.png.identifier as CFString, 1, nil) else {
    fputs("Failed to create PNG destination\\n", stderr)
    exit(1)
}
CGImageDestinationAddImage(dest, image, nil)
if !CGImageDestinationFinalize(dest) {
    fputs("Failed to write PNG\\n", stderr)
    exit(1)
}
`;
}

async function ensureSwiftEmblemRenderer(cacheDir) {
  const binPath = path.join(cacheDir, `emblem-render-${EMBLEM_HELPER_VERSION}`);
  if (fs.existsSync(binPath)) {
    return binPath;
  }

  if (!compileLocks.has(binPath)) {
    const compilePromise = (async () => {
      await fsp.mkdir(cacheDir, { recursive: true });
      const swiftSrcPath = path.join(cacheDir, `emblem-render-${EMBLEM_HELPER_VERSION}.swift`);
      const tmpBinPath = `${binPath}.tmp.${process.pid}.${Date.now()}`;
      await fsp.writeFile(swiftSrcPath, buildSwiftRendererSource(), 'utf8');
      try {
        await execFileAsync(
          'swiftc',
          ['-O', swiftSrcPath, '-o', tmpBinPath],
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        );
        await fsp.chmod(tmpBinPath, 0o755);
        await fsp.rename(tmpBinPath, binPath);
      } catch (err) {
        await fsp.rm(tmpBinPath, { force: true }).catch(() => {});
        throw err;
      } finally {
        await fsp.rm(swiftSrcPath, { force: true }).catch(() => {});
      }
      return binPath;
    })().finally(() => {
      compileLocks.delete(binPath);
    });
    compileLocks.set(binPath, compilePromise);
  }

  return compileLocks.get(binPath);
}

function parseSvgEmblemMetadata(svg) {
  const monoMatch = String(svg || '').match(/data-monogram="([^"]+)"/);
  const catMatch = String(svg || '').match(/data-category="([^"]+)"/);
  return {
    monogram: monoMatch ? monoMatch[1] : 'GN',
    kind: catMatch ? catMatch[1] : 'web',
  };
}

/**
 * Assembles a genuine multi-resolution Apple ICNS binary container from PNG buffers
 * (standard PNG-in-ICNS OSType chunks: icp4, icp5, icp6, ic07, ic08, ic09, ic10, ic11-ic14).
 */
export function buildIcnsFromPngMap(pngByPx) {
  const chunkSpec = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];

  const chunks = [];
  let totalSize = 8; // 'icns' magic + total uint32be length
  for (const [osType, px] of chunkSpec) {
    const pngBuf = pngByPx.get(px);
    if (!pngBuf || pngBuf.length === 0) continue;
    const chunkLen = 8 + pngBuf.length;
    const hdr = Buffer.alloc(8);
    hdr.write(osType, 0, 4, 'ascii');
    hdr.writeUInt32BE(chunkLen, 4);
    chunks.push(hdr, pngBuf);
    totalSize += chunkLen;
  }

  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalSize, 4);
  return Buffer.concat([fileHeader, ...chunks], totalSize);
}

/**
 * Wraps a 256x256 PNG buffer into a genuine Windows .ico file (22-byte header + PNG payload).
 */
export function buildIcoFromPngBuffer(pngBuffer) {
  const header = Buffer.alloc(6 + 16);
  // ICONDIR (6 bytes)
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: 1 = ICO
  header.writeUInt16LE(1, 4); // Image count: 1
  // ICONDIRENTRY (16 bytes)
  header.writeUInt8(0, 6); // Width: 0 means 256px
  header.writeUInt8(0, 7); // Height: 0 means 256px
  header.writeUInt8(0, 8); // Color count
  header.writeUInt8(0, 9); // Reserved
  header.writeUInt16LE(1, 10); // Color planes
  header.writeUInt16LE(32, 12); // Bits per pixel
  header.writeUInt32LE(pngBuffer.length, 14); // Image byte size
  header.writeUInt32LE(22, 18); // Offset to PNG data (6 + 16)
  return Buffer.concat([header, pngBuffer]);
}

async function renderPng1024({ svg, svgPath, png1024Path, cacheDir }) {
  // Primary renderer on macOS: cached Swift CoreGraphics/CoreText helper (pixel-perfect, transparent alpha, ~15ms)
  if (process.platform === 'darwin') {
    try {
      const { monogram, kind } = parseSvgEmblemMetadata(svg);
      const rendererBin = await ensureSwiftEmblemRenderer(cacheDir);
      await execFileAsync(rendererBin, [png1024Path, monogram, kind], { timeout: 15_000 });
      if (fs.existsSync(png1024Path) && (await fsp.stat(png1024Path)).size > 1000) {
        return true;
      }
    } catch {
      // Fall through to qlmanage fallback
    }

    // Fallback on macOS: qlmanage
    try {
      const qlOutDir = path.dirname(png1024Path);
      await execFileAsync('qlmanage', ['-t', '-s', '1024', '-o', qlOutDir, svgPath], { timeout: 15_000 });
      const qlOutput = path.join(qlOutDir, `${path.basename(svgPath)}.png`);
      if (fs.existsSync(qlOutput)) {
        await fsp.rename(qlOutput, png1024Path);
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

async function renderSvgWithRsvg(svgPath, px, outPngPath) {
  await execFileAsync('rsvg-convert', ['-w', String(px), '-h', String(px), svgPath, '-o', outPngPath], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return fs.existsSync(outPngPath) && (await fsp.stat(outPngPath)).size > 200;
}

/**
 * Generates native icon files in `outDir`:
 * - icon.svg
 * - icon-1024.png
 * - icon-256.png
 * - AppIcon.icns (multi-resolution macOS icon bundle via sips+iconutil on macOS or rsvg-convert + pure-Node ICNS on Linux)
 * - AppIcon.ico (Windows 256x256 ICO wrapping PNG)
 */
export async function generateNativeIcons({ svg, outDir, dataDir }) {
  await fsp.mkdir(outDir, { recursive: true });
  const cacheDir = dataDir ? path.join(dataDir, 'runtime-cache') : path.join(os.tmpdir(), 'gitnoob-emblem-cache');

  const svgPath = path.join(outDir, 'icon.svg');
  const png1024Path = path.join(outDir, 'icon-1024.png');
  const png256Path = path.join(outDir, 'icon-256.png');
  const icnsPath = path.join(outDir, 'AppIcon.icns');
  const icoPath = path.join(outDir, 'AppIcon.ico');

  await fsp.writeFile(svgPath, svg, 'utf8');

  let hasPng1024 = false;
  let hasIcns = false;
  let hasIco = false;
  let hasPng256 = false;

  if (process.platform === 'darwin') {
    hasPng1024 = await renderPng1024({ svg, svgPath, png1024Path, cacheDir });
    if (hasPng1024) {
      // Resize 256x256 PNG via sips
      await execFileAsync('/usr/bin/sips', ['-z', '256', '256', png1024Path, '--out', png256Path], {
        timeout: 15_000,
      });
      hasPng256 = fs.existsSync(png256Path);

      // Build genuine Windows .ico wrapping 256x256 PNG
      if (hasPng256) {
        const png256Buf = await fsp.readFile(png256Path);
        await fsp.writeFile(icoPath, buildIcoFromPngBuffer(png256Buf));
        hasIco = true;
      }

      // Build genuine multi-resolution macOS AppIcon.icns via sips + iconutil (with pure-Node ICNS fallback)
      const iconsetDir = path.join(outDir, `AppIcon-${process.pid}-${Date.now()}.iconset`);
      await fsp.mkdir(iconsetDir, { recursive: true });
      try {
        const uniquePx = [16, 32, 64, 128, 256, 512, 1024];
        const resizedPathByPx = new Map();

        await Promise.all(
          uniquePx.map(async (px) => {
            if (px === 1024) {
              resizedPathByPx.set(1024, png1024Path);
              return;
            }
            if (px === 256 && hasPng256) {
              resizedPathByPx.set(256, png256Path);
              return;
            }
            const dest = path.join(iconsetDir, `_resized_${px}.png`);
            await execFileAsync('/usr/bin/sips', ['-z', String(px), String(px), png1024Path, '--out', dest], {
              timeout: 15_000,
            });
            resizedPathByPx.set(px, dest);
          }),
        );

        const iconsetFiles = [
          ['icon_16x16.png', 16],
          ['icon_16x16@2x.png', 32],
          ['icon_32x32.png', 32],
          ['icon_32x32@2x.png', 64],
          ['icon_128x128.png', 128],
          ['icon_128x128@2x.png', 256],
          ['icon_256x256.png', 256],
          ['icon_256x256@2x.png', 512],
          ['icon_512x512.png', 512],
          ['icon_512x512@2x.png', 1024],
        ];

        let iconutilOk = false;
        try {
          const cleanSetDir = path.join(outDir, 'AppIcon.iconset');
          await fsp.rm(cleanSetDir, { recursive: true, force: true }).catch(() => {});
          await fsp.mkdir(cleanSetDir, { recursive: true });
          try {
            await Promise.all(
              iconsetFiles.map(([fname, px]) =>
                fsp.copyFile(resizedPathByPx.get(px), path.join(cleanSetDir, fname)),
              ),
            );
            await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', cleanSetDir, '-o', icnsPath], {
              timeout: 20_000,
            });
            iconutilOk = fs.existsSync(icnsPath) && (await fsp.stat(icnsPath)).size > 1000;
          } finally {
            await fsp.rm(cleanSetDir, { recursive: true, force: true }).catch(() => {});
          }
        } catch {
          iconutilOk = false;
        }

        if (!iconutilOk) {
          const pngByPx = new Map();
          for (const px of uniquePx) {
            const p = resizedPathByPx.get(px);
            if (p && fs.existsSync(p)) {
              pngByPx.set(px, await fsp.readFile(p));
            }
          }
          await fsp.writeFile(icnsPath, buildIcnsFromPngMap(pngByPx));
        }

        hasIcns = fs.existsSync(icnsPath);
      } finally {
        await fsp.rm(iconsetDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } else {
    // Linux / cross-platform path: render multi-resolution PNGs with rsvg-convert (librsvg2-bin)
    // and assemble AppIcon.icns + AppIcon.ico in pure Node! Degrades gracefully if rsvg-convert is absent.
    const tmpSizesDir = path.join(outDir, `_rsvg_${process.pid}_${Date.now()}`);
    try {
      await fsp.mkdir(tmpSizesDir, { recursive: true });
      const rsvgSizes = [1024, 512, 256, 128, 64, 32, 16];
      const pngByPx = new Map();

      // Render 1024px first to fast-fail gracefully if rsvg-convert is not installed
      const ok1024 = await renderSvgWithRsvg(svgPath, 1024, png1024Path);
      if (ok1024) {
        hasPng1024 = true;
        pngByPx.set(1024, await fsp.readFile(png1024Path));

        await Promise.all(
          rsvgSizes
            .filter((px) => px !== 1024)
            .map(async (px) => {
              const dest = px === 256 ? png256Path : path.join(tmpSizesDir, `icon-${px}.png`);
              const ok = await renderSvgWithRsvg(svgPath, px, dest);
              if (ok) {
                pngByPx.set(px, await fsp.readFile(dest));
              }
            }),
        );

        hasPng256 = pngByPx.has(256) && fs.existsSync(png256Path);
        if (hasPng256) {
          await fsp.writeFile(icoPath, buildIcoFromPngBuffer(pngByPx.get(256)));
          hasIco = true;
        }
        if (pngByPx.size > 0) {
          await fsp.writeFile(icnsPath, buildIcnsFromPngMap(pngByPx));
          hasIcns = fs.existsSync(icnsPath);
        }
      }
    } catch {
      // rsvg-convert unavailable or failed — degrade cleanly to icon.svg without throwing
    } finally {
      await fsp.rm(tmpSizesDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    svgPath,
    png1024Path: hasPng1024 ? png1024Path : null,
    png256Path: hasPng256 ? png256Path : null,
    icnsPath: hasIcns ? icnsPath : null,
    icoPath: hasIco ? icoPath : null,
  };
}
