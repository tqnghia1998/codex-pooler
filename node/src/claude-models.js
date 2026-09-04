import { claudeMetadataModelConfigs, claudeMetadataModelExcluded, isClaudeOAuthUpstream, STATIC_MODEL_CATALOG } from './domain.js';

const CLAUDE_LIST_PREFIX = 'claude-fable-5-dd-';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export function isClaudeModelsRequest(req) {
  const headers = req?.headers || {};
  const hasAnthropicVersion = Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'anthropic-version' && firstHeaderValue(value));
  return hasAnthropicVersion || /^claude-cli\//i.test(firstHeaderValue(Object.entries(headers).find(([name]) => name.toLowerCase() === 'user-agent')?.[1]));
}

export function resolveClaudeModelListId(value) {
  const raw = typeof value === 'string' ? value : '';
  const { base, suffix } = splitSuffix(raw);
  if (!base.startsWith(CLAUDE_LIST_PREFIX)) return raw;
  const encoded = base.slice(CLAUDE_LIST_PREFIX.length);
  if (!encoded) return raw;
  const model = [...encoded].reverse().join('');
  return `${model}${suffix ? `(${suffix})` : ''}`;
}

export function buildClaudeModelsResponse(store, scopeId = 'default', claudeConfig = null) {
  const upstreams = typeof store?.listForModelCatalog === 'function'
    ? store.listForModelCatalog(scopeId).filter((entry) => entry?.type === 'claude')
    : (store?.list?.(scopeId) || [])
      .filter((entry) => entry?.type === 'claude')
      .map((entry) => store.get(entry.id, scopeId))
      .filter(Boolean);
  const rows = new Map();
  const staticModels = STATIC_MODEL_CATALOG.filter((model) => model.id.startsWith('claude-'));
  const add = (id, source = null, overrides = {}) => {
    const normalized = typeof id === 'string' ? id.trim() : '';
    if (!normalized || !MODEL_ID_PATTERN.test(normalized)) return;
    const row = rows.get(normalized) || {
      id: normalized,
      object: 'model',
      type: 'model',
      owned_by: 'claude',
      display_name: normalized,
      max_input_tokens: DEFAULT_MAX_INPUT_TOKENS,
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS
    };
    rows.set(normalized, { ...row, ...(source || {}), ...overrides, id: normalized });
  };

  const addModelWithAliases = (upstream, sourceId, source = null) => {
    const aliases = claudeAliases(upstream, claudeConfig)
      .filter((alias) => alias.name.toLowerCase() === String(sourceId).toLowerCase());
    // CPA's `fork` flag controls the listing only: a fork keeps the original
    // model alongside the alias, while a rename replaces the original ID.
    if (!aliases.length || aliases.some((alias) => alias.fork)) add(sourceId, source, { owned_by: 'claude' });
    for (const alias of aliases) {
      add(alias.alias, source, {
        owned_by: 'claude',
        ...(alias.displayName ? { display_name: alias.displayName } : {})
      });
    }
  };

  if (!upstreams.length) {
    for (const model of staticModels) add(model.id, model, { owned_by: 'claude' });
  } else {
    for (const upstream of upstreams) {
      const configuredModels = claudeMetadataModelConfigs(upstream);
      if (configuredModels.length) {
        // CPA's non-empty ClaudeKey.models list replaces the provider catalog;
        // it is not merely an allowlist. The request path still uses the same
        // alias records, so listing and dispatch cannot disagree.
        for (const configured of configuredModels) {
          if (!claudeMetadataModelExcluded(upstream, configured.alias || configured.name, claudeConfig)) {
            addModelWithAliases(upstream, configured.name, {
              owned_by: 'claude',
              ...(configured.displayName ? { display_name: configured.displayName } : {}),
              ...(configured.maxContextLength ? { max_input_tokens: configured.maxContextLength } : {})
            });
          }
        }
      } else {
        for (const model of staticModels) {
          if (!claudeMetadataModelExcluded(upstream, model.id, claudeConfig)) {
            addModelWithAliases(upstream, model.id, model);
          }
        }
        const configured = Array.isArray(upstream.routing?.models) ? upstream.routing.models : [];
        for (const model of configured) {
          if (!String(model).includes('*') && !claudeMetadataModelExcluded(upstream, model, claudeConfig)) {
            addModelWithAliases(upstream, model);
          }
        }
      }
    }
  }

  const disableCloaking = claudeConfig?.disableClaudeCloakMode === true
    || claudeConfig?.['disable-claude-cloak-mode'] === true;
  let models = [...rows.values()];
  if (!disableCloaking) {
    models = models.map((model) => ({ ...model, id: cloakClaudeModelId(model.id) }));
  }
  models.sort((left, right) => String(left.display_name).localeCompare(String(right.display_name)) || left.id.localeCompare(right.id));
  return {
    data: models,
    has_more: false,
    first_id: models[0]?.id || '',
    last_id: models.at(-1)?.id || ''
  };
}

function cloakClaudeModelId(id) {
  return id.startsWith('claude-') ? id : `${CLAUDE_LIST_PREFIX}${[...id].reverse().join('')}`;
}

function claudeAliases(upstream, claudeConfig) {
  const result = [];
  const add = (raw) => {
    let entries = raw;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { entries = []; }
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(0, 128)) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const alias = typeof entry?.alias === 'string' ? entry.alias.trim() : '';
      if (name && alias && name.toLowerCase() !== alias.toLowerCase()) {
        result.push({
          name,
          alias,
          fork: entry.fork === true,
          displayName: typeof entry.displayName === 'string'
            ? entry.displayName.trim()
            : typeof entry['display-name'] === 'string'
              ? entry['display-name'].trim()
              : typeof entry.display_name === 'string'
                ? entry.display_name.trim()
                : ''
        });
      }
    }
  };
  add(upstream?.metadata?.model_aliases ?? upstream?.metadata?.['model-aliases']);
  add(upstream?.metadata?.models ?? upstream?.metadata?.['model-configs'] ?? upstream?.metadata?.model_configs);
  if (isClaudeOAuthUpstream(upstream)) {
    const global = claudeConfig?.oauthModelAlias ?? claudeConfig?.['oauth-model-alias'];
    if (global && typeof global === 'object' && !Array.isArray(global)) add(global.claude ?? global.anthropic);
  }
  return result;
}

function splitSuffix(value) {
  const match = /^(.*)\(([^()]*)\)$/.exec(value);
  return match ? { base: match[1], suffix: match[2] } : { base: value, suffix: '' };
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? String(value[0] || '').trim() : typeof value === 'string' ? value.trim() : '';
}
