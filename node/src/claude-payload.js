const MAX_RULES = 512;
const MAX_PATH_RESULTS = 1_024;
const MAX_QUERY_LENGTH = 512;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REGEX_CACHE_LIMIT = 1_024;
const regexCache = new Map();

// CLIProxyAPI applies the global payload rule engine after translation and
// provider-specific request shaping. Keep the Node representation JSON-native
// so an embedding application can pass the same rule shape without bringing a
// YAML parser into the gateway.
export function applyClaudePayloadConfig(payload, {
  config = null,
  original = payload,
  model = '',
  requestedModel = '',
  protocol = 'claude',
  fromProtocol = 'claude',
  headers = null,
  root = '',
  requestPath = ''
} = {}) {
  const rules = payloadConfig(config);
  if (!rules || !isObject(payload)) return payload;
  const modelCandidates = modelCandidatesFor(model, requestedModel);
  if (!modelCandidates.length) return payload;
  let out = cloneJson(payload);
  const source = isObject(original) ? original : out;
  const context = { modelCandidates, protocol, fromProtocol, headers, root, requestPath };

  out = applyValueRules(out, source, rules.default, context, false, true);
  out = applyValueRules(out, source, rules.defaultRaw, context, true, true);
  out = applyValueRules(out, source, rules.override, context, false, false);
  out = applyValueRules(out, source, rules.overrideRaw, context, true, false);
  out = applyFilterRules(out, rules.filter, context);
  return out;
}

function payloadConfig(config) {
  if (!isObject(config)) return null;
  const value = isObject(config.payload) ? config.payload : config;
  const result = {
    default: boundedArray(value.default),
    defaultRaw: boundedArray(value.defaultRaw ?? value['default-raw']),
    override: boundedArray(value.override),
    overrideRaw: boundedArray(value.overrideRaw ?? value['override-raw']),
    filter: boundedArray(value.filter)
  };
  return Object.values(result).some((items) => items.length) ? result : null;
}

function boundedArray(value) {
  return Array.isArray(value) ? value.slice(0, MAX_RULES) : [];
}

function applyValueRules(payload, source, rules, context, raw, defaultsOnly) {
  for (const rule of rules) {
    if (!isObject(rule) || !ruleMatches(rule, payload, context)) continue;
    const params = isObject(rule.params) ? rule.params : {};
    for (const [relativePath, configured] of Object.entries(params).slice(0, MAX_RULES)) {
      const path = joinPath(context.root, relativePath);
      if (!path || unsafePath(path)) continue;
      const targetPaths = resolveTargetPaths(payload, path);
      if (targetPaths.length) {
        const value = raw ? parseRaw(configured) : cloneJson(configured);
        if (value === INVALID) continue;
        for (const targetPath of targetPaths) {
          if (defaultsOnly && hasExisting(source, targetPath)) continue;
          setConcretePath(payload, targetPath, value);
        }
        continue;
      }
    }
  }
  return payload;
}

function applyFilterRules(payload, rules, context) {
  for (const rule of rules) {
    if (!isObject(rule) || !ruleMatches(rule, payload, context)) continue;
    const params = Array.isArray(rule.params) ? rule.params : [];
    for (const relativePath of params.slice(0, MAX_RULES)) {
      const path = joinPath(context.root, relativePath);
      if (!path || unsafePath(path)) continue;
      const targets = resolveExisting(payload, path);
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const target = targets[index];
        if (target.parent === null) continue;
        if (Array.isArray(target.parent)) target.parent.splice(Number(target.key), 1);
        else delete target.parent[target.key];
      }
    }
  }
  return payload;
}

function ruleMatches(rule, payload, context) {
  const models = Array.isArray(rule.models) ? rule.models : [];
  if (!models.length) return false;
  if (!models.some((entry) => modelRuleMatches(entry, context))) return false;
  if (!conditionsMatch(payload, rule, context.root)) return false;
  return true;
}

function modelRuleMatches(entry, context) {
  if (!isObject(entry) || !globMatch(String(entry.name || ''), context.modelCandidates)) return false;
  if (entry.protocol && !sameProtocol(entry.protocol, context.protocol)) return false;
  if (entry['from-protocol'] || entry.fromProtocol) {
    const expected = entry['from-protocol'] ?? entry.fromProtocol;
    if (!sameProtocol(expected, context.fromProtocol)) return false;
  }
  return headersMatch(context.headers, entry.headers);
}

function conditionsMatch(payload, rule, root = '') {
  const match = Array.isArray(rule.match) ? rule.match : [];
  const notMatch = Array.isArray(rule.notMatch ?? rule['not-match']) ? (rule.notMatch ?? rule['not-match']) : [];
  const exist = Array.isArray(rule.exist) ? rule.exist : [];
  const notExist = Array.isArray(rule.notExist ?? rule['not-exist']) ? (rule.notExist ?? rule['not-exist']) : [];
  return match.every((condition) => conditionObjectMatch(payload, condition, false, root))
    && notMatch.every((condition) => conditionObjectMatch(payload, condition, true, root))
    && exist.every((path) => resolveExisting(payload, joinPath(root, String(path))).length > 0)
    && notExist.every((path) => resolveExisting(payload, joinPath(root, String(path))).length === 0);
}

function conditionObjectMatch(payload, condition, inverted, root = '') {
  if (!isObject(condition)) return true;
  return Object.entries(condition).every(([path, expected]) => {
    if (!path || unsafePath(path)) return true;
    const targets = resolveExisting(payload, joinPath(root, path));
    const matched = targets.some((target) => equals(target.value, expected));
    return inverted ? !matched : matched;
  });
}

function headersMatch(headers, rules) {
  if (!isObject(rules)) return true;
  for (const [name, pattern] of Object.entries(rules)) {
    const values = headerValues(headers, name);
    if (!values.length || !values.some((value) => globMatch(String(pattern), [value]))) return false;
  }
  return true;
}

function headerValues(headers, wanted) {
  if (!headers || !wanted) return [];
  const result = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!name || name.toLowerCase() !== String(wanted).toLowerCase()) continue;
    if (Array.isArray(value)) result.push(...value.map(String));
    else if (value !== undefined && value !== null) result.push(String(value));
  }
  return result;
}

function sameProtocol(left, right) {
  const normalize = (value) => {
    const text = String(value || '').trim().toLowerCase();
    return ['openai-response', 'openai-responses', 'response'].includes(text) ? 'responses' : text;
  };
  return normalize(left) === normalize(right);
}

function globMatch(pattern, values) {
  const raw = String(pattern || '').trim();
  if (!raw) return false;
  const escaped = raw.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*');
  const expression = cachedRegExp(`^${escaped}$`, 'i', `glob:${raw}`);
  if (!expression) return false;
  return values.some((value) => expression.test(String(value)));
}

function cachedRegExp(pattern, flags = '', cacheKey = `regex:${flags}:${pattern}`) {
  const existing = regexCache.get(cacheKey);
  if (existing) return existing;
  try {
    const expression = new RegExp(pattern, flags);
    regexCache.set(cacheKey, expression);
    while (regexCache.size > REGEX_CACHE_LIMIT) regexCache.delete(regexCache.keys().next().value);
    return expression;
  } catch {
    return null;
  }
}

function modelCandidatesFor(model, requestedModel) {
  const result = [];
  const seen = new Set();
  for (const value of [model, requestedModel]) {
    const text = String(value || '').trim();
    if (!text) continue;
    const base = text.replace(/\([^()]*\)$/, '').trim();
    for (const candidate of [text, base]) {
      const key = candidate.toLowerCase();
      if (candidate && !seen.has(key)) {
        seen.add(key);
        result.push(candidate);
      }
    }
  }
  return result;
}

function resolveExisting(root, path, includeMissingLeaf = false) {
  const parts = splitPath(String(path || '').trim());
  if (!parts.length || parts.some((part) => UNSAFE_KEYS.has(part))) return [];
  let refs = [{ parent: null, key: null, value: root, path: '' }];
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    if (!part) continue;
    const query = parseQueryPart(part);
    if (query) {
      const next = [];
      for (const ref of refs) {
        if (!Array.isArray(ref.value)) continue;
        for (let index = 0; index < ref.value.length && next.length < MAX_PATH_RESULTS; index += 1) {
          if (queryMatches(ref.value[index], query.expression)) {
            next.push({ parent: ref.value, key: index, value: ref.value[index], path: joinPath(ref.path, String(index)) });
            if (!query.all) break;
          }
        }
      }
      refs = next;
      continue;
    }
    if (UNSAFE_KEYS.has(part)) return [];
    const next = [];
    for (const ref of refs) {
      if (!ref.value || typeof ref.value !== 'object' || !Object.hasOwn(ref.value, part)) continue;
      next.push({ parent: ref.value, key: part, value: ref.value[part], path: joinPath(ref.path, part) });
    }
    if (includeMissingLeaf && partIndex === parts.length - 1) {
      for (const ref of refs) {
        if (!ref.value || typeof ref.value !== 'object' || Object.hasOwn(ref.value, part)) continue;
        if (UNSAFE_KEYS.has(part)) continue;
        next.push({ parent: ref.value, key: part, value: undefined, path: joinPath(ref.path, part) });
      }
    }
    refs = next;
  }
  return refs.slice(0, MAX_PATH_RESULTS);
}

function resolveTargetPaths(root, path) {
  const parts = splitPath(String(path || '').trim());
  if (!parts.length || parts.some((part) => UNSAFE_KEYS.has(part))) return [];
  let states = [{ value: root, path: '' }];
  for (const part of parts) {
    if (!part) continue;
    const query = parseQueryPart(part);
    if (query) {
      const next = [];
      for (const state of states) {
        if (!Array.isArray(state.value)) continue;
        for (let index = 0; index < state.value.length && next.length < MAX_PATH_RESULTS; index += 1) {
          if (queryMatches(state.value[index], query.expression)) {
            next.push({ value: state.value[index], path: joinPath(state.path, String(index)) });
            if (!query.all) break;
          }
        }
      }
      states = next;
      continue;
    }
    const next = [];
    for (const state of states) {
      if (state.value !== null && typeof state.value === 'object' && Object.hasOwn(state.value, part)) {
        next.push({ value: state.value[part], path: joinPath(state.path, part) });
      } else {
        // Keep the concrete path even when a regular object segment is
        // absent. sjson.SetBytes creates these intermediate objects after a
        // query path has selected the array member.
        next.push({ value: undefined, path: joinPath(state.path, part) });
      }
    }
    states = next;
  }
  return states.map(({ path: targetPath }) => targetPath).filter(Boolean).slice(0, MAX_PATH_RESULTS);
}

function hasExisting(root, path) {
  return resolveExisting(root, path).some((ref) => ref.value !== null && ref.value !== undefined);
}

function setSimplePath(root, path, value) {
  const parts = splitPath(path);
  if (!parts.length || parts.some((part) => !part || part.startsWith('#(') || UNSAFE_KEYS.has(part))) return;
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isObject(current) && !Array.isArray(current)) return;
    if (UNSAFE_KEYS.has(part)) return;
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  if (isObject(current) || Array.isArray(current)) current[parts.at(-1)] = value;
}

function setConcretePath(root, path, value) {
  const parts = splitPath(path);
  if (!parts.length || parts.some((part) => !part || parseQueryPart(part) || UNSAFE_KEYS.has(part))) return;
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextPart = parts[index + 1];
    if (!current || typeof current !== 'object' || UNSAFE_KEYS.has(part)) return;
    if (!current[part] || typeof current[part] !== 'object') current[part] = /^\d+$/.test(nextPart) ? [] : {};
    current = current[part];
  }
  if (current && typeof current === 'object') current[parts.at(-1)] = value;
}

function splitPath(path) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); continue; }
    if (char === '.' && depth === 0) {
      parts.push(path.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(path.slice(start));
  return parts.filter(Boolean);
}

function parseQueryPart(part) {
  if (!part.startsWith('#(')) return null;
  const close = findQueryClose(part);
  if (close < 0 || (part.slice(close + 1) !== '' && part.slice(close + 1) !== '#')) return null;
  const expression = part.slice(2, close).trim();
  return expression && expression.length <= MAX_QUERY_LENGTH ? { expression, all: part.endsWith('#') } : null;
}

function findQueryClose(part) {
  let depth = 1;
  let quote = '';
  let escaped = false;
  for (let index = 2; index < part.length; index += 1) {
    const char = part[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function queryMatches(value, expression) {
  if (!isObject(value) && !Array.isArray(value)) return false;
  return splitLogical(expression, '||').some((orPart) => splitLogical(orPart, '&&').every((term) => queryTermMatches(value, term)));
}

function queryTermMatches(value, term) {
  const match = /^\s*([A-Za-z0-9_.-]+)\s*(==|!=|<=|>=|<|>|=~)\s*(.*?)\s*$/.exec(term);
  if (!match) return false;
  const actual = readSimple(value, match[1]);
  const expected = parseLiteral(match[3]);
  if (expected === INVALID) return false;
  switch (match[2]) {
    case '==': return equals(actual, expected);
    case '!=': return !equals(actual, expected);
    case '=~': {
      const expression = cachedRegExp(String(expected));
      return expression ? expression.test(String(actual ?? '')) : false;
    }
    case '<': return actual < expected;
    case '>': return actual > expected;
    case '<=': return actual <= expected;
    case '>=': return actual >= expected;
    default: return false;
  }
}

function splitLogical(value, operator) {
  const parts = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (value.startsWith(operator, index)) {
      parts.push(value.slice(start, index).trim());
      index += operator.length - 1;
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function readSimple(value, path) {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function parseLiteral(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  return text || INVALID;
}

function parseRaw(value) {
  if (typeof value !== 'string') return cloneJson(value);
  try { return JSON.parse(value); } catch { return INVALID; }
}

function joinPath(left, right) {
  const prefix = String(left || '').trim();
  const suffix = String(right || '').trim().replace(/^\./, '');
  return prefix ? suffix ? `${prefix}.${suffix}` : prefix : suffix;
}

function unsafePath(path) {
  return splitPath(path).some((part) => UNSAFE_KEYS.has(part));
}

function equals(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return Object.is(left, right) || left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const INVALID = Symbol('invalidPayloadValue');
