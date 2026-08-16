import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 45_000;

export async function runCompatibilityReleaseClient({
  family,
  version,
  executable,
  capturePath,
  workingDirectory,
  spawnImpl = spawn
}) {
  if (!['codex', 'claude-code'].includes(family)) throw new Error('unsupported_client_family');
  if (!executable || (basename(executable) === executable && !executable.includes('/'))) throw new Error('invalid_client_executable');
  const capture = deferred();
  const server = createServer((req, res) => {
    void handleHarnessRequest(req, res, { family, version, capture }).catch(() => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"invalid_request_error","code":"invalid_request","message":"Invalid request","param":null}}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let processResult;
  try {
    const command = clientCommand({ family, executable, baseUrl });
    processResult = await boundedSpawn(command.command, command.args, {
      cwd: workingDirectory,
      env: clientEnvironment({ family, baseUrl, workingDirectory }),
      spawnImpl
    });
    if (processResult.timedOut) throw new Error('client_timeout');
    if (processResult.outputLimitExceeded) throw new Error('client_output_limit');
    const rawCapture = await Promise.race([
      capture.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('capture_missing')), 250))
    ]);
    await writeFile(capturePath, `${JSON.stringify(rawCapture)}\n`, { flag: 'wx', mode: 0o600 });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  return {
    captured: true,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    outputLimitExceeded: processResult.outputLimitExceeded,
    timedOut: processResult.timedOut
  };
}

async function handleHarnessRequest(req, res, { family, version, capture }) {
  if (!loopback(req.socket.remoteAddress)) throw new Error('non_loopback_request');
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname.endsWith('/models')) {
    sendJson(res, 200, { object: 'list', data: [{ id: 'fixture-model', object: 'model', owned_by: 'fixture' }] });
    return;
  }
  const expectedSuffix = family === 'codex' ? '/responses' : '/messages';
  if (req.method !== 'POST' || !pathname.endsWith(expectedSuffix)) {
    sendJson(res, 404, { error: { type: 'invalid_request_error', code: 'unsupported_endpoint', message: 'Unsupported endpoint', param: null } });
    return;
  }
  const body = await readJsonBody(req);
  capture.resolve({
    schemaVersion: 1,
    profile: family === 'codex' ? 'codex-public-sse' : 'compass-anthropic-messages',
    client: { family, version },
    request: {
      path: family === 'codex' ? '/v1/responses' : '/v1/messages',
      headers: normalizedHeaders(req.headers),
      body
    }
  });
  if (family === 'codex') sendCodexResponse(res, body);
  else sendClaudeResponse(res, body);
}

function clientCommand({ family, executable, baseUrl }) {
  if (family === 'codex') {
    return {
      command: executable,
      args: [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        'fixture-model',
        '--config',
        'model_provider="release_gate"',
        '--config',
        `model_providers.release_gate={ name = "Release Gate", base_url = "${baseUrl}/v1", env_key = "OPENAI_API_KEY", wire_api = "responses" }`,
        'Return exactly fixture-ok without using tools.'
      ]
    };
  }
  return {
    command: executable,
    args: [
      '--bare',
      '--safe-mode',
      '--print',
      '--model',
      'fixture-model',
      '--tools',
      '',
      '--no-session-persistence',
      '--output-format',
      'json',
      'Return exactly fixture-ok without using tools.'
    ]
  };
}

function clientEnvironment({ family, baseUrl, workingDirectory }) {
  const env = {
    HOME: workingDirectory,
    TMPDIR: workingDirectory,
    XDG_CACHE_HOME: workingDirectory,
    XDG_CONFIG_HOME: workingDirectory,
    XDG_DATA_HOME: workingDirectory,
    XDG_STATE_HOME: workingDirectory,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    NO_COLOR: '1',
    TERM: 'dumb',
    COMPATIBILITY_RELEASE_GATE_URL: baseUrl
  };
  if (family === 'codex') {
    env.CODEX_HOME = workingDirectory;
    env.OPENAI_API_KEY = 'fixture-api-key';
  } else {
    env.ANTHROPIC_API_KEY = 'fixture-api-key';
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.CLAUDE_CONFIG_DIR = workingDirectory;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
  }
  return env;
}

function boundedSpawn(command, args, { cwd, env, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let bytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const consume = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES && !outputLimitExceeded) {
        outputLimitExceeded = true;
        stop();
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.once('error', (error) => finish(reject, error));
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, PROCESS_TIMEOUT_MS);
    child.once('close', (exitCode, signal) => {
      finish(resolve, {
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null,
        outputLimitExceeded,
        timedOut
      });
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  const timeout = setTimeout(() => req.destroy(new Error('request_timeout')), REQUEST_TIMEOUT_MS);
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) throw new Error('request_too_large');
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timeout);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('request_body_invalid');
  return body;
}

function normalizedHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') output[name.toLowerCase()] = value;
    else if (Array.isArray(value)) output[name.toLowerCase()] = value.join(',');
  }
  return output;
}

function sendCodexResponse(res, request) {
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 0,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: request.model || 'fixture-model',
    output: [{
      id: 'msg_fixture',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }]
    }],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: 'medium', summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
    user: null,
    metadata: {}
  };
  if (request.stream !== true) {
    sendJson(res, 200, response);
    return;
  }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'fixture-ok' },
    { type: 'response.output_text.done', item_id: 'msg_fixture', output_index: 0, content_index: 0, text: 'fixture-ok' },
    { type: 'response.content_part.done', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: response.output[0].content[0] },
    { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
    { type: 'response.completed', response }
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function sendClaudeResponse(res, request) {
  const message = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: request.model || 'fixture-model',
    content: [{ type: 'text', text: 'fixture-ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  };
  if (request.stream !== true) {
    sendJson(res, 200, message);
    return;
  }
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function loopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('configuration_required');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const result = await runCompatibilityReleaseClient(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || 'release_client_failed').replace(/[^a-z0-9_ -]/gi, '_')}\n`);
    process.exitCode = 1;
  });
}
