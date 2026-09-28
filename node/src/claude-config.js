const MAX_CONFIG_BYTES = 512 * 1024;

// Node deliberately keeps deployment configuration JSON-native. This mirrors
// the CPA configuration objects while avoiding a second YAML configuration
// stack in the Node-first fork.
export function claudeConfigFromEnv(env = process.env, variable = 'CODEX_POOLER_CLAUDE_CONFIG_JSON') {
  const raw = env[variable];
  if (raw === undefined || raw === '') return {};
  if (Buffer.byteLength(String(raw), 'utf8') > MAX_CONFIG_BYTES) throw new Error(`${variable} is too large`);
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch { throw new Error(`${variable} must be valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${variable} must be a JSON object`);
  return parsed;
}

export function normalizeClaudeConfig(config) {
  if (config === undefined || config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config)) throw new TypeError('claudeConfig must be an object');
  return config;
}
