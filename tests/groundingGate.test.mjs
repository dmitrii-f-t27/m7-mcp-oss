/**
 * Grounding gate tests (Sprint 3)
 * Run: npm run build && node tests/groundingGate.test.mjs
 */
import assert from 'node:assert/strict';

const {
  parseGroundingSpec,
  warningSeverity,
  buildGroundingReport,
  runGroundingCheck,
  resolvePremiseRef,
} = await import('../dist/core/orchestrator/groundingGate.js');
const { getEpistemicStatus } = await import('../dist/memory/auto/unified-memory-core.js');
const { mkdtemp, writeFile, mkdir, rm } = await import('fs/promises');
const { tmpdir } = await import('os');
const path = await import('path');
const { resetMemoryCore } = await import('../dist/memory/auto/unified-memory-core.js');
const { resetProjectPathStateForTests } = await import('../dist/core/utils/projectPath.js');

console.log('groundingGate tests');

const VALID_SPEC_JSON = `\`\`\`json
{
  "grounding": {
    "premises": [
      { "id": "p1", "ref": "mem_test", "claim": "auth validates jwt" }
    ],
    "steps": [
      {
        "id": "s1",
        "description": "revert config",
        "reversibility": "reversible",
        "premise_ids": ["p1"]
      },
      {
        "id": "s2",
        "description": "deploy prod",
        "reversibility": "irreversible",
        "premise_ids": ["p1"]
      }
    ]
  }
}
\`\`\``;

// G1 — parse valid grounding JSON
const spec = parseGroundingSpec(VALID_SPEC_JSON);
assert.ok(spec);
assert.equal(spec.premises.length, 1);
assert.equal(spec.steps.length, 2);

// G2 — parse ignores unrelated json "operation" block
const dual = `\`\`\`json
{ "tag": "operation", "children": [] }
\`\`\`
${VALID_SPEC_JSON}`;
const spec2 = parseGroundingSpec(dual);
assert.ok(spec2);
assert.equal(spec2.premises[0].ref, 'mem_test');

// G3 — ASSUMED + reversible → soft
assert.equal(warningSeverity('ASSUMED', 'reversible'), 'soft');

// G4 — ASSUMED + irreversible → strong
assert.equal(warningSeverity('ASSUMED', 'irreversible'), 'strong');

// G5 — KNOWN → none
assert.equal(warningSeverity('KNOWN', 'irreversible'), 'none');

// G6 — HUMAN_CONFIRMED → none
assert.equal(warningSeverity('HUMAN_CONFIRMED', 'reversible'), 'none');

// G7 — missing spec
const missing = await runGroundingCheck(null, 'full');
assert.equal(missing.stats.softWarnings, 1);
assert.ok(missing.warnings[0].message.includes('No grounding JSON'));

// G8 — light mode filters to irreversible steps only
const specLight = parseGroundingSpec(VALID_SPEC_JSON);
assert.ok(specLight);
// runGroundingCheck will hit resolve - mem_test not found → warnings on irreversible step only for p1
const light = await runGroundingCheck(specLight, 'light');
assert.equal(light.stats.steps, 1);

// G9 — NOT_FOUND ref severity
assert.equal(warningSeverity('NOT_FOUND', 'irreversible'), 'strong');

// G10 — buildGroundingReport table
const report = buildGroundingReport(missing);
assert.ok(report.includes('Epistemic Grounding Report'));
assert.ok(report.includes('| 0 | 0 |'));

// G11 — path: existing file without fog → KNOWN
{
  const dir = await mkdtemp(path.join(tmpdir(), 'gate1-exists-'));
  const prev = process.env.M7_PROJECT_PATH;
  const prevWs = process.env.CURSOR_WORKSPACE;
  process.env.M7_PROJECT_PATH = dir;
  process.env.CURSOR_WORKSPACE = dir;
  try {
    resetProjectPathStateForTests();
    resetMemoryCore();
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'foo.ts'), 'export const x = 1;\n');
    const now = Date.now();
    const rec = await resolvePremiseRef('path:src/foo.ts', now);
    assert.ok(rec, 'expected filesystem premise record');
    assert.equal(getEpistemicStatus(rec, now), 'KNOWN');
  } finally {
    process.env.M7_PROJECT_PATH = prev;
    process.env.CURSOR_WORKSPACE = prevWs;
    resetMemoryCore();
    await rm(dir, { recursive: true, force: true });
  }
}

// G12 — path: missing file → null
{
  const dir = await mkdtemp(path.join(tmpdir(), 'gate1-miss-'));
  const prev = process.env.M7_PROJECT_PATH;
  const prevWs = process.env.CURSOR_WORKSPACE;
  process.env.M7_PROJECT_PATH = dir;
  process.env.CURSOR_WORKSPACE = dir;
  try {
    resetProjectPathStateForTests();
    resetMemoryCore();
    const rec = await resolvePremiseRef('path:src/does-not-exist.ts');
    assert.equal(rec, null);
  } finally {
    process.env.M7_PROJECT_PATH = prev;
    process.env.CURSOR_WORKSPACE = prevWs;
    resetMemoryCore();
    await rm(dir, { recursive: true, force: true });
  }
}

// G13 — path traversal outside project → null
{
  const dir = await mkdtemp(path.join(tmpdir(), 'gate1-escape-'));
  const prev = process.env.M7_PROJECT_PATH;
  const prevWs = process.env.CURSOR_WORKSPACE;
  process.env.M7_PROJECT_PATH = dir;
  process.env.CURSOR_WORKSPACE = dir;
  try {
    resetProjectPathStateForTests();
    resetMemoryCore();
    const rec = await resolvePremiseRef('path:../../../etc/passwd');
    assert.equal(rec, null);
  } finally {
    process.env.M7_PROJECT_PATH = prev;
    process.env.CURSOR_WORKSPACE = prevWs;
    resetMemoryCore();
    await rm(dir, { recursive: true, force: true });
  }
}

// G14 — runGroundingCheck: path premise FOUND, reversible step → no warnings
{
  const dir = await mkdtemp(path.join(tmpdir(), 'gate1-check-'));
  const prev = process.env.M7_PROJECT_PATH;
  const prevWs = process.env.CURSOR_WORKSPACE;
  process.env.M7_PROJECT_PATH = dir;
  process.env.CURSOR_WORKSPACE = dir;
  try {
    resetProjectPathStateForTests();
    resetMemoryCore();
    await writeFile(path.join(dir, 'evidence.md'), '# proof\n');
    const spec = parseGroundingSpec(`\`\`\`json
{
  "grounding": {
    "premises": [{ "id": "p1", "ref": "path:evidence.md", "claim": "file exists" }],
    "steps": [{
      "id": "s1",
      "description": "doc only",
      "reversibility": "reversible",
      "premise_ids": ["p1"]
    }]
  }
}
\`\`\``);
    assert.ok(spec);
    const result = await runGroundingCheck(spec, 'full');
    assert.equal(result.resolved[0].found, true);
    assert.equal(result.resolved[0].status, 'KNOWN');
    assert.equal(result.warnings.length, 0);
  } finally {
    process.env.M7_PROJECT_PATH = prev;
    process.env.CURSOR_WORKSPACE = prevWs;
    resetMemoryCore();
    await rm(dir, { recursive: true, force: true });
  }
}

// G15 — GATE-2: irreversible step with empty premise_ids → one strong warning
{
  const spec = parseGroundingSpec(`\`\`\`json
{
  "grounding": {
    "premises": [],
    "steps": [{
      "id": "deploy_prod",
      "description": "ship to prod",
      "reversibility": "irreversible",
      "premise_ids": []
    }]
  }
}
\`\`\``);
  assert.ok(spec);
  const result = await runGroundingCheck(spec, 'full');
  assert.equal(result.stats.strongWarnings, 1);
  assert.ok(result.warnings.some(w =>
    w.severity === 'strong' && w.stepIds.includes('deploy_prod')
  ));
}

// G16 — a file that exists is KNOWN however the clock ticks inside the check.
// The check stamps the premise record with the time it builds it and judges the record
// with the time it asks. When a millisecond boundary fell between the two, a file that
// exists decayed below the KNOWN threshold, turned STALE and drew a warning (a strong one
// on an irreversible step). A clock that moves one millisecond on every read makes that
// boundary fall every time; one `now` per premise makes the answer independent of the clock.
{
  const dir = await mkdtemp(path.join(tmpdir(), 'grounding-clock-'));
  const prev = { M7_PROJECT_PATH: process.env.M7_PROJECT_PATH, CURSOR_WORKSPACE: process.env.CURSOR_WORKSPACE };
  const realNow = Date.now;
  process.env.M7_PROJECT_PATH = dir;
  process.env.CURSOR_WORKSPACE = dir;
  try {
    resetProjectPathStateForTests();
    resetMemoryCore();
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'present.ts'), 'export const x = 1;\n');
    for (const reversibility of ['reversible', 'irreversible']) {
      const spec = parseGroundingSpec(`\`\`\`json
{
  "grounding": {
    "premises": [{ "id": "p1", "ref": "path:src/present.ts", "claim": "file exists" }],
    "steps": [{
      "id": "s1",
      "description": "edit the file",
      "reversibility": "${reversibility}",
      "premise_ids": ["p1"]
    }]
  }
}
\`\`\``);
      assert.ok(spec);
      for (let run = 1; run <= 5; run++) {
        let tick = realNow.call(Date);
        Date.now = () => (tick += 1);
        let result;
        try {
          result = await runGroundingCheck(spec, 'full');
        } finally {
          Date.now = realNow;
        }
        const label = `${reversibility} step, run ${run}`;
        assert.equal(result.resolved[0].found, true, `${label}: the file exists`);
        assert.equal(result.resolved[0].status, 'KNOWN', `${label}: status of an existing file`);
        assert.equal(result.warnings.length, 0, `${label}: no warning for an existing file`);
      }
    }
  } finally {
    Date.now = realNow;
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProjectPathStateForTests();
    resetMemoryCore();
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('All groundingGate tests passed');
