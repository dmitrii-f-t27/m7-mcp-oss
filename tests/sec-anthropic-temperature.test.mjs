/**
 * SEC-9 (MEDIUM): no `temperature` for Opus models.
 *
 * Before the fix seven Hive calls to the Anthropic Messages API sent a fixed
 * `temperature` (0.1 to 0.3) whatever the model. Newer Opus models are said to
 * reject a non-default sampling parameter, so a Hive call to such a model could
 * fail with a 400 error.
 *
 * WHAT THIS FILE DOES NOT PROVE. Whether the Anthropic API really rejects
 * `temperature` for these Opus models is not verified: that needs a live call
 * with a real key, and this repository's tests make no network call. The tests
 * prove only what M7 sends. After the fix M7 sends no `temperature` to a model
 * whose name starts with `claude-opus-`, and it still sends it to other models.
 *
 * Side effect that is on purpose: Opus 4.5 and 4.6 now run at the default
 * temperature instead of 0.1 to 0.3. That is a behaviour change without a
 * failure.
 *
 * Network rules of this file: none. Every Anthropic and OpenAI client in the
 * code under test is replaced by a stub that records the request parameters.
 * The APIManager is built without its constructor, because the constructor
 * starts model discovery, which calls the real APIs.
 *
 * Run: npm run build && node --test --test-force-exit tests/sec-anthropic-temperature.test.mjs
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { DynamicHiveOrchestrator } = await import('../dist/hive/orchestrator/dynamicOrchestrator.js');
const { APIManager } = await import('../dist/hive/api/apiManager.js');
const { PlannerAgent } = await import('../dist/hive/planner/plannerAgent.js');
const { HiveArchitect } = await import('../dist/hive/intelligence/hiveArchitect.js');
const { DebateEngine } = await import('../dist/hive/debate/debateEngine.js');

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Model names that src/ uses, plus two that are not there yet.
const OPUS_MODELS = ['claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5'];
const OTHER_MODELS = ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** An Anthropic client that records the parameters of every messages.create call. */
function anthropicStub() {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return {
          content: [{ type: 'text', text: '{}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        };
      },
    },
  };
}

/** An OpenAI client that fails the test if it is used. */
function openaiStub() {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error('the OpenAI stub must not be called');
        },
      },
    },
  };
}

const swallow = () => {};

// ---------------------------------------------------------------------------
// The call sites. `model` is set for a site that takes the model as a
// parameter; a site with a fixed model is run once. `temperature` is the value
// the site sends to a model that accepts one.
// ---------------------------------------------------------------------------

const FIXED_OPUS_SITES = [
  {
    name: 'DynamicOrchestrator.synthesizeProposals',
    async run() {
      const stub = anthropicStub();
      const orch = new DynamicHiveOrchestrator({ openai: 'sk-test-placeholder', anthropic: 'sk-ant-test-placeholder' }, {});
      orch.anthropicClient = stub;
      const proposal = (id) => ({
        agent: { id, role: `Role ${id}`, expertise: 'x', focus: 'y', perspective: 'z', domain: 'general' },
        model: 'm',
        provider: 'anthropic',
        proposal: 'p',
        reasoning: 'r',
        confidence: 0.5,
        implementationSteps: [],
        risks: [],
      });
      await orch.synthesizeProposals([proposal('a'), proposal('b')], { description: 'task' }).catch(swallow);
      return stub.calls;
    },
  },
  {
    name: 'PlannerAgent.decompose',
    async run() {
      const stub = anthropicStub();
      const planner = new PlannerAgent('sk-ant-test-placeholder');
      planner.client = stub;
      await planner.decompose('a goal').catch(swallow);
      return stub.calls;
    },
  },
  {
    name: 'HiveArchitect.createTeamBatch',
    async run() {
      const stub = anthropicStub();
      const architect = new HiveArchitect('sk-ant-test-placeholder');
      architect.client = stub;
      await architect.createTeamBatch(['task one', 'task two']).catch(swallow);
      return stub.calls;
    },
  },
  {
    name: 'HiveArchitect.createTeam',
    async run() {
      const stub = anthropicStub();
      const architect = new HiveArchitect('sk-ant-test-placeholder');
      architect.client = stub;
      await architect.createTeam('a task').catch(swallow);
      return stub.calls;
    },
  },
];

const MODEL_SITES = [
  {
    name: 'DynamicOrchestrator.callAnthropic',
    temperature: 0.1,
    async run(model) {
      const stub = anthropicStub();
      const orch = new DynamicHiveOrchestrator({ openai: 'sk-test-placeholder', anthropic: 'sk-ant-test-placeholder' }, {});
      orch.anthropicClient = stub;
      await orch.callAnthropic(model, 'system prompt', 'user prompt', 100);
      return stub.calls;
    },
  },
  {
    name: 'APIManager.callAnthropic',
    temperature: 0.1,
    async run(model) {
      const stub = anthropicStub();
      // No constructor: it would start model discovery against the real APIs.
      const manager = Object.create(APIManager.prototype);
      manager.anthropicClient = stub;
      const agentConfig = {
        id: 'architect',
        provider: 'anthropic',
        model,
        specialization: 'test specialist',
        strengths: ['a'],
        cost_tier: 'premium',
      };
      await manager.callAnthropic(agentConfig, 'user prompt', { task: 'a task' });
      return stub.calls;
    },
  },
  {
    name: 'DebateEngine.callLLM',
    temperature: 0.3,
    async run(model) {
      const stub = anthropicStub();
      const engine = new DebateEngine(openaiStub(), stub);
      await engine.callLLM(model, 'system prompt', 'user prompt', 100);
      return stub.calls;
    },
  },
];

function assertNoTemperature(calls, label) {
  assert.ok(calls.length >= 1, `${label}: the site made no messages.create call, so nothing was checked`);
  for (const params of calls) {
    assert.ok(
      params.model.startsWith('claude-opus-'),
      `${label}: expected a claude-opus-* model, got ${params.model}`,
    );
    assert.ok(
      !('temperature' in params),
      `${label}: sent temperature=${params.temperature} to ${params.model}`,
    );
  }
}

// ---------------------------------------------------------------------------
// What M7 sends
// ---------------------------------------------------------------------------

describe('SEC-9: no temperature is sent to an Opus model', () => {
  for (const site of FIXED_OPUS_SITES) {
    it(`${site.name} (fixed Opus model)`, async () => {
      assertNoTemperature(await site.run(), site.name);
    });
  }

  for (const site of MODEL_SITES) {
    for (const model of OPUS_MODELS) {
      it(`${site.name} with ${model}`, async () => {
        const calls = await site.run(model);
        assert.ok(calls.every((p) => p.model === model), `${site.name}: the model name changed on the way`);
        assertNoTemperature(calls, `${site.name} (${model})`);
      });
    }
  }
});

describe('SEC-9: Sonnet and Haiku keep their temperature', () => {
  for (const site of MODEL_SITES) {
    for (const model of OTHER_MODELS) {
      it(`${site.name} with ${model}`, async () => {
        const calls = await site.run(model);
        assert.equal(calls.length, 1, `${site.name}: expected one messages.create call`);
        assert.equal(calls[0].model, model);
        assert.equal(calls[0].temperature, site.temperature);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The decision itself: small pure functions in src/hive/api/anthropicParams.ts.
// They are loaded inside the tests, so a missing module fails these tests only.
// ---------------------------------------------------------------------------

describe('SEC-9: anthropicSampling (pure)', () => {
  it('modelTakesTemperature is false for every claude-opus-* model', async () => {
    const { modelTakesTemperature } = await import('../dist/hive/api/anthropicParams.js');
    for (const model of OPUS_MODELS) assert.equal(modelTakesTemperature(model), false, model);
  });

  it('modelTakesTemperature is true for other models', async () => {
    const { modelTakesTemperature } = await import('../dist/hive/api/anthropicParams.js');
    for (const model of OTHER_MODELS) assert.equal(modelTakesTemperature(model), true, model);
  });

  it('anthropicSampling returns an empty object for Opus and { temperature } for other models', async () => {
    const { anthropicSampling } = await import('../dist/hive/api/anthropicParams.js');
    assert.deepEqual(anthropicSampling('claude-opus-4-6', 0.3), {});
    assert.deepEqual(anthropicSampling('claude-sonnet-4-6', 0.3), { temperature: 0.3 });
    assert.deepEqual(anthropicSampling('claude-haiku-4-5-20251001', 0), { temperature: 0 });
  });
});

// ---------------------------------------------------------------------------
// Static check: no literal temperature in a messages.create call under src/hive
// ---------------------------------------------------------------------------

/** Every .ts file under a directory. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/**
 * The same text with comments, string literals and the text parts of template
 * literals replaced by spaces (newlines stay). Code inside `${ }` is kept. Its
 * length equals the input length, so offsets and line numbers still match.
 * Returns { text, balanced }: balanced is false when a quote or a brace is left
 * open, which means the scanner got lost (for example on a regex literal).
 */
function blankLiterals(src) {
  const out = src.split('');
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const braces = []; // one entry per open ${ }: how many plain { are open inside it
  let mode = 'code';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        blank(i, j);
        i = j;
      } else if (c === '/' && d === '*') {
        let j = src.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        blank(i, j);
        i = j;
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        blank(i + 1, j);
        i = j + 1;
      } else if (c === '`') {
        mode = 'template';
        i++;
      } else if (c === '{') {
        if (braces.length) braces[braces.length - 1]++;
        i++;
      } else if (c === '}') {
        if (braces.length && braces[braces.length - 1] === 0) {
          braces.pop();
          mode = 'template';
        } else if (braces.length) {
          braces[braces.length - 1]--;
        }
        i++;
      } else {
        i++;
      }
    } else if (c === '\\') {
      blank(i, i + 2);
      i += 2;
    } else if (c === '`') {
      mode = 'code';
      i++;
    } else if (c === '$' && d === '{') {
      braces.push(0);
      mode = 'code';
      i += 2;
    } else {
      blank(i, i + 1);
      i++;
    }
  }
  return { text: out.join(''), balanced: mode === 'code' && braces.length === 0 };
}

/** All `messages.create(...)` calls in a file: { line, code } with literals blanked. */
function messagesCreateCalls(file) {
  const src = readFileSync(file, 'utf8');
  const { text, balanced } = blankLiterals(src);
  assert.ok(balanced, `${file}: the scanner lost track of quotes or braces; the static check cannot be trusted`);
  const calls = [];
  const re = /messages\.create\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let j = open;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) break;
    }
    assert.ok(depth === 0, `${file}: unmatched parenthesis in a messages.create call`);
    calls.push({
      line: src.slice(0, m.index).split('\n').length,
      code: text.slice(open, j + 1),
    });
  }
  return calls;
}

describe('SEC-9: static check of src/hive', () => {
  // Scanned inside the tests, so a scanner failure fails a test, not the file.
  const findCalls = () =>
    tsFiles(path.join(REPO_ROOT, 'src', 'hive')).flatMap((file) =>
      messagesCreateCalls(file).map((c) => ({ ...c, file: path.relative(REPO_ROOT, file) })),
    );

  it('the scanner finds the messages.create calls (not an empty check)', () => {
    // 7 calls send a sampling parameter; modelDiscovery and streamingExecutor send none.
    const found = findCalls();
    assert.ok(found.length >= 9, `found only ${found.length} messages.create calls under src/hive`);
  });

  it('no literal temperature remains in a messages.create call under src/hive', () => {
    const offenders = findCalls()
      .filter((c) => /\btemperature\b/.test(c.code))
      .map((c) => `${c.file}:${c.line}`);
    assert.deepEqual(offenders, [], `literal temperature in messages.create at: ${offenders.join(', ')}`);
  });

  it('the seven calls that used to send a temperature go through anthropicSampling', () => {
    const users = findCalls().filter((c) => /\banthropicSampling\s*\(/.test(c.code)).map((c) => `${c.file}:${c.line}`);
    assert.equal(users.length, 7, `anthropicSampling is used in: ${users.join(', ') || 'no call'}`);
  });
});
