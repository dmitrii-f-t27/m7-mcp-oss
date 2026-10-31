/**
 * SEC-3 (MEDIUM): task text stays on the machine unless remote classification
 * is switched on with M7_ALLOW_REMOTE_CLASSIFICATION=true.
 *
 * Every test starts the real MCP server (`node dist/index.js`) over stdio on a
 * throwaway project and points the OpenAI and Anthropic SDKs at a fake provider
 * with OPENAI_BASE_URL and ANTHROPIC_BASE_URL. The fake provider listens on
 * 127.0.0.1 only and records every request it gets. No real key and no real
 * network are used.
 *
 * The fake provider also receives the requests the server sends on its own at
 * start (model discovery: a model list call and a 1-token "Hi" call per
 * Anthropic model). They carry no task text. They are written to the request
 * list in the log and are not asserted on.
 *
 * Set SEC_CLASSIFIER_DUMP_DIR to also write the full request list of each
 * scenario as JSON into that directory.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-classifier.test.mjs
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeProject, removeProject, startServer } from './helpers/deepScanHarness.mjs';

const T = { timeout: 90_000 };
const SETTLE_MS = 800; // let the start-up model discovery and late writes finish
const sleep = ms => new Promise(r => setTimeout(r, ms));

const newCanary = () => `CANARY-${randomBytes(6).toString('hex')}`;
const taskWith = canary => `Add retry to the HTTP client wrapper in network layer ${canary}`;

/** The answer line that states the approach. It changes with `allowCode`. */
const NO_CODE = /без кода|no code/i;
const approachLine = text => /^- \*\*Suggested Approach:\*\* (.*)$/m.exec(text)?.[1] ?? null;

// ---------------------------------------------------------------------------
// Fake provider (pure routing + thin HTTP shell)
// ---------------------------------------------------------------------------

/**
 * What the fake remote classifier answers. It says allowCode=false, which the
 * default local intent never does, so the answer shows which one was used.
 */
const REMOTE_INTENT = {
  intent: 'PLAN',
  phase: 'PLANNING',
  route: 'medium',
  confidence: 0.9,
  reasoning: 'fake remote classification',
  allowCode: false,
  suggestedAgents: ['architecture'],
  estimatedFiles: 2,
  estimatedMinutes: 30,
  risks: [],
  requiresFullCycle: false,
  patternsToScan: [],
  fileExtensions: [],
};

/** Pure: status and JSON body for one request. `chat` is 'ok' | 'http500' | 'http401'. */
function fakeRoute(method, pathname, requestBody, chat) {
  if (method === 'POST' && pathname.endsWith('/chat/completions')) {
    if (chat === 'http500') return { status: 500, body: { error: { message: 'fake upstream failure', type: 'server_error' } } };
    if (chat === 'http401') return { status: 401, body: { error: { message: 'fake: incorrect API key', type: 'invalid_request_error' } } };
    return {
      status: 200,
      body: {
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4o-mini',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(REMOTE_INTENT), refusal: null },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    };
  }
  if (method === 'GET' && pathname.endsWith('/models')) {
    return {
      status: 200,
      body: {
        object: 'list',
        data: ['gpt-4o-mini', 'gpt-4.1-mini'].map(id => ({ id, object: 'model', created: 0, owned_by: 'fake' })),
      },
    };
  }
  if (method === 'POST' && pathname.endsWith('/messages')) {
    return {
      status: 200,
      body: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: requestBody?.model ?? 'claude-fake',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  }
  return { status: 404, body: { error: { message: `fake provider: no route for ${method} ${pathname}`, type: 'not_found' } } };
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function startFakeProvider({ chat = 'ok' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = SECRET_HEADERS.has(k) ? '[redacted]' : v;
      requests.push({ n: requests.length + 1, method: req.method, url: req.url, headers, body: raw });
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      const { status, body } = fakeRoute(req.method, pathname, tryJson(raw), chat);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1', 'the fake provider must listen on 127.0.0.1 only');
  return {
    requests,
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    anthropicBaseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Request list helpers (pure)
// ---------------------------------------------------------------------------

const isChat = r => r.method === 'POST' && new URL(r.url, 'http://127.0.0.1').pathname.endsWith('/chat/completions');
const hasCanary = (r, canary) => JSON.stringify(r).includes(canary);

/** One log line per request: what was asked, of which model, with which user text. */
function summarize(r, canary) {
  const body = tryJson(r.body);
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const user = msgs.filter(m => m.role === 'user').at(-1)?.content;
  const userText = typeof user === 'string' ? user : user == null ? '' : JSON.stringify(user);
  return `${String(r.n).padStart(2)} ${r.method} ${r.url} body=${Buffer.byteLength(r.body)}B`
    + `${body?.model ? ` model=${body.model}` : ''}`
    + `${userText ? ` user=${JSON.stringify(userText.slice(0, 80))}` : ''}`
    + ` canary=${hasCanary(r, canary) ? 'YES' : 'no'}`;
}

async function reportRequests(scenario, requests, canary) {
  console.log(`[requests] ${scenario}: ${requests.length} request(s) to the fake provider`);
  for (const r of requests) console.log(`[requests]   ${summarize(r, canary)}`);
  const dir = process.env.SEC_CLASSIFIER_DUMP_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    const full = requests.map(r => ({ ...r, body: tryJson(r.body) ?? r.body }));
    await writeFile(path.join(dir, `${scenario}-requests.json`), JSON.stringify(full, null, 1));
  }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/** Start a fake provider and the server, make one analyze_task call, stop both, return what happened. */
async function runAnalyzeTask(scenario, { optIn, chat = 'ok' }) {
  const canary = newCanary();
  const fake = await startFakeProvider({ chat });
  const dir = await makeProject('sec-classifier-');
  let server;
  try {
    server = await startServer(dir, {
      env: {
        OPENAI_BASE_URL: fake.openaiBaseUrl,
        ANTHROPIC_BASE_URL: fake.anthropicBaseUrl,
        M7_ALLOW_REMOTE_CLASSIFICATION: optIn ? 'true' : undefined,
      },
    });
    const res = await server.call('mcp_m7_analyze_task', { task_description: taskWith(canary) });
    await sleep(SETTLE_MS);
    return { res, canary, requests: fake.requests.slice(), scenario };
  } finally {
    if (server) await server.stop('close');
    await fake.close();
    await removeProject(dir);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('task text and the intent classifier', () => {
  it('by default no outgoing request contains task text', T, async () => {
    const { res, canary, requests, scenario } = await runAnalyzeTask('default', { optIn: false });
    await reportRequests(scenario, requests, canary);
    assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);
    assert.ok(approachLine(res.text), `the answer has no Suggested Approach line:\n${res.text.slice(0, 600)}`);

    const leaks = requests.filter(r => hasCanary(r, canary));
    assert.deepEqual(
      leaks.map(r => summarize(r, canary)),
      [],
      'a request that carries the task text left the server although remote classification is off',
    );
  });

  it('with M7_ALLOW_REMOTE_CLASSIFICATION=true the text is sent exactly once per analyze_task', T, async () => {
    const { res, canary, requests, scenario } = await runAnalyzeTask('opt-in', { optIn: true });
    await reportRequests(scenario, requests, canary);
    assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

    const carrying = requests.filter(r => hasCanary(r, canary));
    assert.equal(
      carrying.length,
      1,
      `the task text must be sent exactly once, got ${carrying.length}:\n${carrying.map(r => summarize(r, canary)).join('\n')}`,
    );
    const [sent] = carrying;
    assert.ok(isChat(sent), `the one request with the text must be the chat completion, got ${sent.method} ${sent.url}`);
    const body = tryJson(sent.body);
    assert.equal(body?.model, 'gpt-4o-mini');
    assert.equal(body?.response_format?.type, 'json_schema', 'the classifier must ask for a structured response');
    assert.equal(body?.messages?.at(-1)?.content, taskWith(canary), 'the user message must be the task text, unchanged');

    // The answer comes from the remote classification: the fake says allowCode=false.
    const approach = approachLine(res.text);
    assert.ok(approach, `the answer has no Suggested Approach line:\n${res.text.slice(0, 600)}`);
    assert.match(approach, NO_CODE, `the remote result was not used (approach: ${approach})`);
  });

  it('a failing remote falls back and the tool still answers', T, async () => {
    const { res, canary, requests, scenario } = await runAnalyzeTask('opt-in-failing', { optIn: true, chat: 'http500' });
    await reportRequests(scenario, requests, canary);
    assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);
    assert.ok(requests.some(r => isChat(r) && hasCanary(r, canary)), 'opt-in was on, so the classifier must have tried the remote');

    const approach = approachLine(res.text);
    assert.ok(approach, `the answer has no Suggested Approach line:\n${res.text.slice(0, 600)}`);
    // A failed remote call falls back to the cautious default intent: analysis only.
    assert.match(approach, NO_CODE, `expected the fallback intent after a failed remote call (approach: ${approach})`);
  });

  it('by default the result does not report a classification failure', T, async () => {
    // The fake rejects chat completions like a provider rejecting a placeholder key.
    // With remote classification off nothing may call it, so nothing may fail.
    const { res, canary, requests, scenario } = await runAnalyzeTask('default-remote-rejecting', { optIn: false, chat: 'http401' });
    await reportRequests(scenario, requests, canary);
    assert.ok(!res.isError, `analyze_task failed:\n${res.text.slice(0, 400)}`);

    assert.ok(!/Classification failed/i.test(res.text), 'the answer reports a classification failure');
    assert.ok(!/Fallback to default intent/i.test(res.text), 'the answer shows the failure fallback text');
    const approach = approachLine(res.text);
    assert.ok(approach, `the answer has no Suggested Approach line:\n${res.text.slice(0, 600)}`);
    assert.ok(!NO_CODE.test(approach), `the default path must not mark the task as analysis only (approach: ${approach})`);
    assert.ok(!/Задача требует анализа\/планирования без кода/.test(res.text), 'the interpretation says the task is analysis only');
  });
});
