const PLACEHOLDER_PATTERNS = [
  /^your[_-]/i,
  /^my[_-]/i,
  /^enter[_-]/i,
  /^insert[_-]/i,
  /^replace[_-]/i,
  /^change[_-]?me/i,
  /^todo$/i,
  /^xxx+$/i,
  /^<.+>$/,
  /^\[.+\]$/,
  /^\{\{.+\}\}$/,
  /^sk-x+$/i,
  /^pk_test_x+$/i,
  /^example[_-]?key$/i,
  /^put[_-]/i,
];

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|auth[_-]?key)/i;

const KNOWN_KEY_DESCRIPTIONS = {
  PORT: 'Local port number the app listens on',
  HOST: 'Network address the app binds to',
  NODE_ENV: 'Application run mode (development or production)',
  DATABASE_URL: 'Connection address for an external database',
  REDIS_URL: 'Connection address for a Redis cache server',
  OPENAI_API_KEY: 'OpenAI API key used for AI features',
  ANTHROPIC_API_KEY: 'Anthropic Claude API key used for AI features',
  GEMINI_API_KEY: 'Google Gemini API key used for AI features',
  GOOGLE_API_KEY: 'Google API key for external services',
  STRIPE_SECRET_KEY: 'Stripe secret key for payment processing',
  JWT_SECRET: 'Secret phrase used to sign login sessions',
  SESSION_SECRET: 'Secret phrase used to encrypt browser sessions',
  SECRET_KEY: 'Secret key used by the app for security signing',
};

function isPlaceholderValue(value) {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

function humanizeEnvKey(key) {
  if (KNOWN_KEY_DESCRIPTIONS[key]) {
    return KNOWN_KEY_DESCRIPTIONS[key];
  }
  const words = key
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => {
      if (['api', 'url', 'uri', 'id', 'db', 'aws', 'jwt', 'http', 'https', 'smtp', 'oauth', 'llm', 'ai'].includes(w)) {
        return w.toUpperCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
  return words.length > 0 ? `${words.join(' ')} setting` : 'Configuration value';
}

function parseValueAndInlineComment(rawVal) {
  const trimmed = rawVal.trim();
  if (!trimmed) return { value: '', inlineComment: '' };

  // Double-quoted or single-quoted string
  const firstChar = trimmed[0];
  if (firstChar === '"' || firstChar === "'") {
    let i = 1;
    let unquoted = '';
    while (i < trimmed.length) {
      if (firstChar === '"' && trimmed[i] === '\\' && i + 1 < trimmed.length) {
        unquoted += trimmed[i + 1];
        i += 2;
        continue;
      }
      if (trimmed[i] === firstChar) {
        const rest = trimmed.slice(i + 1).trim();
        const inlineComment = rest.startsWith('#') ? rest.slice(1).trim() : '';
        return { value: unquoted, inlineComment };
      }
      unquoted += trimmed[i];
      i += 1;
    }
    return { value: unquoted, inlineComment: '' };
  }

  // Unquoted value: split on ` #` or `\t#`
  const commentMatch = trimmed.match(/\s+#\s*(.*)$/);
  if (commentMatch) {
    const value = trimmed.slice(0, commentMatch.index).trim();
    return { value, inlineComment: commentMatch[1].trim() };
  }

  return { value: trimmed, inlineComment: '' };
}

function isDecorativeComment(text) {
  return /^[-=_*#~+./\s]{3,}$/.test(text) || text.length === 0;
}

/**
 * Parse a single .env.example / .env.sample / .env.template file into structured entries.
 * Returns [{ key, defaultValue, description, required }].
 */
export function parseEnvFile(content) {
  if (typeof content !== 'string' || !content.trim()) return [];

  const lines = content.split(/\r?\n/);
  const results = [];
  const seen = new Set();
  let commentBuffer = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      // Blank line resets accumulated comments so section headers don't bleed into unrelated vars
      commentBuffer = [];
      continue;
    }

    if (line.startsWith('#')) {
      const cleaned = line.replace(/^#+\s*/, '').trim();
      if (!isDecorativeComment(cleaned)) {
        commentBuffer.push(cleaned);
      }
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      commentBuffer = [];
      continue;
    }

    const key = match[1];
    const rawVal = match[2] || '';
    const { value, inlineComment } = parseValueAndInlineComment(rawVal);

    const commentParts = [...commentBuffer];
    if (inlineComment) commentParts.push(inlineComment);
    commentBuffer = [];

    if (seen.has(key)) continue;
    seen.add(key);

    const rawDescription = commentParts.join(' — ').replace(/\s+/g, ' ').trim();
    const description = rawDescription || humanizeEnvKey(key);

    const placeholder = isPlaceholderValue(value);
    const mentionsOptional = /\boptional\b/i.test(rawDescription);
    const mentionsRequired = /\brequired\b/i.test(rawDescription);

    let required = false;
    if (mentionsOptional) {
      required = false;
    } else if (mentionsRequired) {
      required = true;
    } else if (placeholder && (SECRET_KEY_RE.test(key) || value === '' || /^your[_-]|^<.+>$/i.test(value))) {
      required = true;
    } else if (SECRET_KEY_RE.test(key) && placeholder) {
      required = true;
    }

    const defaultValue = placeholder ? '' : value;

    results.push({
      key,
      defaultValue,
      description,
      required,
    });
  }

  return results;
}

/**
 * Parse all discovered env template files in priority order and merge unique keys.
 */
export function parseEnvFiles(files = {}) {
  const candidates = [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.local.example',
    'env.example',
  ];

  const merged = [];
  const seen = new Set();

  for (const name of candidates) {
    const content = files[name];
    if (!content) continue;
    for (const item of parseEnvFile(content)) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        merged.push(item);
      }
    }
  }

  return merged;
}
