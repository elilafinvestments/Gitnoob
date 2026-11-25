function prettifyName(name) {
  if (!name) return 'this app';
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function stripMarkdownNoise(text) {
  if (!text) return '';
  return text
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Remove fenced code blocks
    .replace(/```[\s\S]*?```/g, ' ')
    // Remove badge links [![alt](img)](url)
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    // Remove images ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // Remove reference-style badge/image links [![alt][ref]][ref]
    .replace(/\[!\[[^\]]*\]\[[^\]]*\]\]\[[^\]]*\]/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Replace markdown links [label](url) with label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Replace reference links [label][ref] with label
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Remove reference link definitions [ref]: url
    .replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '')
    // Strip bold/italic/strikethrough/code ticks
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,!?;:]|$)/g, '$1$2')
    // Remove emoji shortcodes like :rocket:
    .replace(/:[a-z0-9_+-]+:/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstReadmeParagraph(readme) {
  if (typeof readme !== 'string' || !readme.trim()) return '';

  // Remove fenced code blocks and HTML comments before splitting into paragraphs
  const cleanedRaw = readme
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '\n\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  const blocks = cleanedRaw.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Skip headings, horizontal rules, tables, and pure badge/image blocks
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^[-=*_]{3,}$/.test(trimmed)) continue;
    if (/^\|.*\|/.test(trimmed)) continue;
    if (/^>\s*\[!/.test(trimmed)) continue;

    // Skip blocks that are just title underlines (Setext headings)
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 2 && /^[=-]{3,}$/.test(lines[1])) continue;
    // Skip bullet lists for main summary
    if (lines.every((l) => /^[-*+]\s+/.test(l))) continue;

    const plain = stripMarkdownNoise(trimmed);
    if (plain.length < 25) continue;
    // Skip boilerplate license/install/contribute intros
    if (/^(table of contents|installation|getting started|npm install|license|contributing)/i.test(plain)) {
      continue;
    }

    return plain;
  }

  return '';
}

function truncateToSentences(text, maxChars = 240) {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
  }

  // Split into sentences
  const sentences = normalized.match(/[^.!?]+[.!?]+/g) || [normalized];
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s.trim()}` : s.trim();
    if (next.length > maxChars && out) break;
    out = next;
    if (out.length >= 110) break;
  }

  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1).replace(/\s+\S*$/, '')}…`;
  }
  return out;
}

function extractControlsOrTips(readme) {
  if (typeof readme !== 'string' || !readme.trim()) return [];

  const tips = [];
  const seen = new Set();

  const addTip = (raw) => {
    const clean = stripMarkdownNoise(raw).replace(/^[-*•\d.)\s]+/, '').trim();
    if (clean.length < 8 || clean.length > 180) return;
    if (/^(npm |yarn |pnpm |pip |git clone|http|www\.)/i.test(clean)) return;
    if (/\b(added custom code|contributed|pull request|thanks to|made with|license)\b/i.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tips.push(clean);
  };

  // Look for relevant sections in README
  const sectionRe =
    /^#{1,4}\s*(how to play|controls|gameplay|playing|keyboard|shortcuts|tips|usage|features)\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|\Z)/gim;

  let match;
  while ((match = sectionRe.exec(readme)) !== null) {
    const body = match[2] || '';
    const cleanedBody = body.replace(/```[\s\S]*?```/g, '');
    const lines = cleanedBody.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^\|?[-:\s|]+\|?$/.test(trimmed)) continue;
      if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
        addTip(trimmed);
      } else if (/^\|.+\|$/.test(trimmed)) {
        const cols = trimmed
          .split('|')
          .map((c) => stripMarkdownNoise(c))
          .filter(Boolean);
        if (cols.length >= 2 && !/^(key|control|shortcut|action|command)$/i.test(cols[0])) {
          addTip(`${cols[0]}: ${cols.slice(1).join(' — ')}`);
        }
      } else if (trimmed.length >= 25 && tips.length < 3) {
        addTip(trimmed);
      }
      if (tips.length >= 5) return tips;
    }
  }

  // Fallback: scan README for sentences mentioning arrow keys, WASD, spacebar, swipe, click
  if (tips.length === 0) {
    const noCode = readme.replace(/```[\s\S]*?```/g, '');
    for (const line of noCode.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (
        /\b(arrow keys|wasd|spacebar|space bar|swipe|click to|press [a-z]|use your mouse|left and right)\b/i.test(
          trimmed
        ) &&
        !/^#{1,6}\s/.test(trimmed)
      ) {
        addTip(trimmed);
        if (tips.length >= 4) break;
      }
    }
  }

  return tips;
}

function buildWhatYouGet(displayName, detected, hasReleaseAssets) {
  const { category, packagingStrategy, supportsSingleHtml, requiredRuntime } = detected;

  if (packagingStrategy === 'static-bundle') {
    if (category === 'game') {
      return supportsSingleHtml
        ? `The complete ${displayName} game plus a double-click launcher—play offline with zero setup, or download it as a single self-contained .html file.`
        : `The complete ${displayName} game plus a built-in double-click launcher—play offline in your browser with zero setup.`;
    }
    return supportsSingleHtml
      ? `A complete offline copy of ${displayName} with a double-click launcher—plus a single-file .html option you can open in any browser.`
      : `A complete offline copy of ${displayName} with a built-in double-click launcher—zero installation required.`;
  }

  if (packagingStrategy === 'react-component') {
    if (category === 'game') {
      return supportsSingleHtml
        ? `GitNoob automatically wraps the ${displayName} React game component in a runnable app with a double-click launcher—play offline immediately or download a single self-contained .html file, with zero HTML or coding setup.`
        : `GitNoob automatically wraps the ${displayName} React game component in a complete runnable app with a double-click launcher—play offline immediately with zero coding setup.`;
    }
    return supportsSingleHtml
      ? `GitNoob automatically wraps the ${displayName} React component in a complete runnable app with a double-click launcher—open and use it immediately (or grab the single-file .html artifact) with zero HTML or coding setup.`
      : `GitNoob automatically wraps the ${displayName} React component in a complete runnable app with a double-click launcher—open and use it immediately with zero HTML or coding setup.`;
  }

  if (packagingStrategy === 'node-portable') {
    return `The complete ${displayName} app, all of its dependencies, a portable Node.js ${requiredRuntime?.version || '22.14.0'} runtime, and a double-click launcher—no Node.js setup required.`;
  }

  if (packagingStrategy === 'python-portable') {
    return `The complete ${displayName} app, its required Python packages, a portable Python ${requiredRuntime?.version || '3.12'} runtime, and a double-click launcher—no Python setup required.`;
  }

  if (hasReleaseAssets) {
    return `Direct download links to official prebuilt ${displayName} installers published on GitHub Releases (no compiler or terminal required).`;
  }

  return `A compatibility overview for ${displayName}. Because this is native source code with no prebuilt GitHub Releases, GitNoob cannot auto-package a standalone binary.`;
}

function buildHowToRun(displayName, detected, hasReleaseAssets) {
  const { category, packagingStrategy } = detected;

  if (packagingStrategy === 'release-only') {
    if (hasReleaseAssets) {
      return [
        `Pick the official ${displayName} installer matching your computer (macOS, Windows, or Linux) from the releases list.`,
        'Download and open the installer file just like any regular app.',
        'Follow the on-screen prompt to launch it—no coding tools needed.',
      ];
    }
    return [
      `Open the ${displayName} repository page on GitHub to check for installation instructions or hosted demos.`,
      'Watch the Releases tab in case the author publishes prebuilt installers in the future.',
      'Or try pasting another web, Node.js, or Python repository into GitNoob for instant packaging.',
    ];
  }

  if (category === 'cli-tool') {
    return [
      'Download the ready-to-run .zip package and double-click to unzip it.',
      'Double-click the launcher inside the folder—it automatically loads the bundled runtime.',
      `Follow the prompts in the launcher window to run ${displayName}.`,
    ];
  }

  if (category === 'desktop-app' || (category === 'game' && packagingStrategy === 'python-portable')) {
    return [
      'Download the ready-to-run .zip package and unzip it anywhere on your computer.',
      `Double-click the native launcher ("Open ${displayName}") inside the folder.`,
      `${displayName} starts directly using its bundled runtime—no separate installation needed.`,
    ];
  }

  if (packagingStrategy === 'react-component') {
    return [
      'Download the ready-to-run .zip package (or single-file .html artifact)—GitNoob has automatically wrapped the React component into a working app.',
      'Double-click the launcher icon (or the .html file directly)—no HTML, Node.js, or coding setup needed.',
      `${displayName} opens straight in your browser, ready to use offline.`,
    ];
  }

  if (packagingStrategy === 'static-bundle' && detected.supportsSingleHtml) {
    return [
      'Download either the full .zip bundle (with native launcher) or the single-file .html artifact.',
      'Double-click the launcher icon (or the .html file directly)—zero setup or terminal commands needed.',
      `${displayName} opens straight in your browser, ready to use offline.`,
    ];
  }

  return [
    'Download the ready-to-run .zip package and unzip it anywhere on your computer.',
    `Double-click the native launcher ("Open ${displayName}") inside the extracted folder.`,
    'Wait a moment while the bundled runtime starts—your browser will open automatically.',
  ];
}

/**
 * Produce crisp, jargon-free plain-English explanations for non-coders.
 */
export function buildPlainEnglishSummary({ metadata = {}, readme = '', detected, releases = [] }) {
  const displayName = prettifyName(metadata.name || 'This App');
  const rawDesc = stripMarkdownNoise(metadata.description || '');
  const readmePara = extractFirstReadmeParagraph(readme);
  const hasReleaseAssets = Array.isArray(releases) && releases.some((r) => r.assets?.length > 0);

  let summary = '';
  if (rawDesc && readmePara) {
    const descLower = rawDesc.toLowerCase();
    const paraLower = readmePara.toLowerCase();
    // Avoid repeating the same sentence if README starts with the GitHub description
    if (paraLower.includes(descLower.slice(0, Math.min(40, descLower.length)))) {
      summary = truncateToSentences(readmePara, 240);
    } else if (rawDesc.length >= 65) {
      summary = truncateToSentences(rawDesc, 220);
    } else {
      const descSentence = /[.!?]$/.test(rawDesc) ? rawDesc : `${rawDesc}.`;
      summary = truncateToSentences(`${descSentence} ${readmePara}`, 240);
    }
  } else if (rawDesc) {
    summary = truncateToSentences(rawDesc, 240);
  } else if (readmePara) {
    summary = truncateToSentences(readmePara, 240);
  } else {
    const label = (detected?.categoryLabel || 'application').toLowerCase();
    summary = `${displayName} is an open-source ${label} built with ${detected?.framework || 'web technologies'}, packaged by GitNoob so you can run it with a double-click.`;
  }

  return {
    summary,
    whatYouGet: buildWhatYouGet(displayName, detected, hasReleaseAssets),
    howToRun: buildHowToRun(displayName, detected, hasReleaseAssets),
    controlsOrTips: extractControlsOrTips(readme),
  };
}
