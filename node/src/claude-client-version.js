export const DEFAULT_CLAUDE_CODE_VERSION = '2.1.280';

const configuredVersion = process.env.CODEX_POOLER_CLAUDE_CODE_VERSION;
export const CLAUDE_CODE_VERSION = /^\d+\.\d+\.\d+$/.test(configuredVersion || '')
  ? configuredVersion
  : DEFAULT_CLAUDE_CODE_VERSION;
