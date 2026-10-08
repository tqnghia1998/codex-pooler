const CODES = new Set(['unsupported_value', 'invalid_value', 'unsupported_parameter', 'missing_required_parameter', 'invalid_type', 'string_above_max_length', 'unknown_parameter', 'invalid_parameter']);

export function validValidationParam(value) {
  return typeof value === 'string' && value.length <= 160
    && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]{0,3})\])*$/.test(value);
}

export function responseValidationError(body, path = '/v1/responses') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const source = body.error || body.response?.error;
  if ((!source && typeof body.detail !== 'string') || Buffer.byteLength(JSON.stringify(source || body.detail)) > 64 * 1024) return null;
  const reading = readRefusalMessage(source?.message ?? body.detail);
  const code = CODES.has(source?.code) ? source.code : reading?.code;
  if (!code || source?.type && source.type !== 'invalid_request_error') return null;
  const rawParam = validValidationParam(source?.param) ? source.param : reading?.param;
  const param = rawParam ? mapChatParam(rawParam, path) : null;
  const supported = ['unsupported_value', 'invalid_value'].includes(code) ? supportedValues(source?.message) : null;
  return {
    type: 'invalid_request_error', code, param,
    message: `upstream rejected${param ? ` parameter ${param}` : ' the request'} (${code})${supported ? `; supported values: ${supported.join(', ')}` : ''}`
  };
}

function readRefusalMessage(message) {
  if (typeof message !== 'string' || Buffer.byteLength(message) > 2_048) return null;
  if (message.startsWith('Unsupported parameter: ')) {
    const param = message.slice('Unsupported parameter: '.length);
    return validValidationParam(param) ? { code: 'unsupported_parameter', param } : null;
  }
  const bracket = message.match(/^\[[A-Za-z_][A-Za-z0-9_]{0,63}\] \[(.{1,200}?)\] \[([a-z_]{1,64})\] /);
  if (bracket) {
    const code = { invalid_enum_value: 'invalid_value', invalid_type: 'invalid_type', unknown_parameter: 'unknown_parameter', missing_required_parameter: 'missing_required_parameter', string_above_max_length: 'string_above_max_length' }[bracket[2]];
    return code && validValidationParam(bracket[1]) ? { code, param: bracket[1] } : null;
  }
  if (!message.startsWith('Invalid response.create payload: ')) return null;
  const inner = message.slice('Invalid response.create payload: '.length);
  if (inner.startsWith("Invalid value: '")) return { code: 'invalid_value', param: null };
  for (const [pattern, code] of [
    [/^Invalid type for '([^']{1,200})': /, 'invalid_type'],
    [/^Missing required parameter: '([^']{1,200})'\.?$/, 'missing_required_parameter'],
    [/^Unknown parameter: '([^']{1,200})'\.?$/, 'unknown_parameter'],
    [/^Invalid '([^']{1,200})': string too long\. /, 'string_above_max_length']
  ]) {
    const match = inner.match(pattern);
    if (match && validValidationParam(match[1])) return { code, param: match[1] };
  }
  return null;
}

function mapChatParam(param, path) {
  if (path !== '/v1/chat/completions') return param;
  if (/^input(?:[.[]|$)/.test(param)) return 'messages';
  return { 'reasoning.effort': 'reasoning_effort', max_output_tokens: 'max_completion_tokens', 'text.verbosity': 'verbosity', 'text.format': 'response_format' }[param] || param;
}

function supportedValues(message) {
  if (typeof message !== 'string' || Buffer.byteLength(message) > 2_048) return null;
  const marker = 'Supported values are: ';
  if (message.split(marker).length !== 2) return null;
  const values = message.match(/Supported values are: ('[A-Za-z0-9_.-]{1,32}'(?:(?:, and |, | and )'[A-Za-z0-9_.-]{1,32}')*)\.?$/)?.[1]
    ?.match(/'([^']+)'/g)?.map((value) => value.slice(1, -1)) || [];
  const quotedBefore = new Set((message.slice(0, message.indexOf(marker)).match(/'([^']+)'/g) || []).map((value) => value.slice(1, -1)));
  const unique = [...new Set(values.filter((value) => !quotedBefore.has(value)))];
  return unique.length && unique.length <= 12 ? unique : null;
}
