'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { startFakeDeepSeek } = require('./helpers/fake-deepseek');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'humanize.js');
const SESSION = path.join(__dirname, 'fixtures', 'sample-session.jsonl');
const DRAFT = path.join(__dirname, 'fixtures', 'sample-draft.md');
const KEY = 'sk-SECRET-KEY-1234567890';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function run(args, { cwd, env = {}, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HUMANIZE_NO_DOTENV: '1', DEEPSEEK_RETRIES: '0', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'humanize-cli-'));

test('--help and --version exit 0', async () => {
  const h = await run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage:/);
  const v = await run(['--version']);
  assert.match(v.stdout, /^humanize \d/);
});

test('usage errors exit 1 with a message and no output files', async () => {
  const cwd = tmp();
  const none = await run([], { cwd });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Missing session file/);
  const missing = await run(['session:', 'nope.jsonl'], { cwd, env: { DEEPSEEK_API_KEY: KEY } });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Session file not found/);
  const noDraft = await run(['session:', SESSION, '--draft', 'nope.md'], { cwd, env: { DEEPSEEK_API_KEY: KEY } });
  assert.match(noDraft.stderr, /Draft file not found/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('missing API key is reported before any draft is requested', async () => {
  const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd: tmp() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /DEEPSEEK_API_KEY is not set/);
});

test('malformed session export is rejected', async () => {
  const cwd = tmp();
  fs.writeFileSync(path.join(cwd, 'bad.jsonl'), 'this is not a session\nneither is this\n');
  const r = await run(['session:', 'bad.jsonl', '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No valid JSON records/);
});

test('missing prompts directory is reported', async () => {
  const r = await run(['session:', SESSION, '--draft', DRAFT, '--prompts', '/nonexistent'], { cwd: tmp(), env: { DEEPSEEK_API_KEY: KEY } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Missing prompt file/);
});

test('end to end with a draft file: writes revised.md and a diff, leaves the draft untouched', async () => {
  const server = await startFakeDeepSeek();
  try {
    const cwd = tmp();
    const draftCopy = path.join(cwd, 'my-version.md');
    fs.copyFileSync(DRAFT, draftCopy);
    const before = sha(draftCopy);
    const r = await run(['session:', SESSION, '--draft', 'my-version.md', '--report', 'report.json'], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sha(draftCopy), before, 'original draft unchanged');
    const revised = fs.readFileSync(path.join(cwd, 'revised.md'), 'utf8');
    const h1s = revised.split('\n').filter((l) => l.startsWith('# '));
    assert.deepEqual(h1s, ['# High-Level Task Goal', '# Validation Notes', '# Decision Points', '# Difficulty & Codebase Understanding']);
    assert.ok(revised.includes('to use a huge retry count'));
    assert.ok(!revised.includes('utilize'));
    const diff = fs.readFileSync(path.join(cwd, 'revised.diff'), 'utf8');
    assert.match(diff, /^--- my-version\.md\n\+\+\+ revised\.md\n@@/);
    assert.ok(diff.split('\n').some((l) => l.startsWith('-') && l.includes('utilize')));
    assert.ok(diff.split('\n').some((l) => l.startsWith('+') && l.includes('to use a huge')));
    assert.ok(r.stdout.includes(diff), 'diff printed to stdout');
    assert.match(r.stdout, /Done\./);
    assert.match(r.stdout, /Review:\s+accept; better than original: yes; 0 high, 1 medium/);
    assert.match(r.stdout, /Warning: Draft statement unsupported/);
    assert.match(r.stdout, /DeepSeek usage: 4 calls/);
    assert.match(r.stderr, /41 records \(jsonl\)/);
    assert.match(r.stderr, /1 malformed record/);
    assert.match(r.stderr, /\[1\/4\][\s\S]*\[2\/4\][\s\S]*\[3\/4\][\s\S]*\[4\/4\]/);
    const report = JSON.parse(fs.readFileSync(path.join(cwd, 'report.json'), 'utf8'));
    assert.equal(report.review.verdict, 'accept');
    assert.ok(report.styleProfile && report.context);
    assert.deepEqual(server.requests.map((q) => q.stage), ['style', 'context', 'edit', 'review']);
    assert.ok(server.requests.every((q) => q.auth === `Bearer ${KEY}`));
    assert.ok(server.requests[1].body.messages[1].content.includes('[TOOL RESULT]'));
    assert.ok(!JSON.stringify(server.requests).includes('SHOULD NOT APPEAR'));
    assert.ok(!(r.stdout + r.stderr).includes(KEY), 'key never printed');
  } finally {
    await server.close();
  }
});

test('end to end with the draft on stdin, custom output, and --no-diff', async () => {
  const server = await startFakeDeepSeek();
  try {
    const cwd = tmp();
    const draft = fs.readFileSync(DRAFT, 'utf8');
    const r = await run(['session:', SESSION, '--output', 'out/final.md', '--no-diff'], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url }, stdin: draft });
    // The output directory does not exist, so this must fail cleanly...
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ENOENT/);
    fs.mkdirSync(path.join(cwd, 'out'));
    const ok = await run(['session:', SESSION, '--output', 'out/final.md', '--no-diff'], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url }, stdin: draft });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(fs.existsSync(path.join(cwd, 'out', 'final.md')));
    assert.ok(fs.existsSync(path.join(cwd, 'out', 'final.diff')));
    assert.ok(!ok.stdout.includes('@@'), 'diff not printed with --no-diff');
    assert.match(ok.stdout, /Original draft: stdin/);
    assert.match(fs.readFileSync(path.join(cwd, 'out', 'final.diff'), 'utf8'), /^--- draft \(stdin\)/);
  } finally {
    await server.close();
  }
});

test('existing output is never overwritten without --force', async () => {
  const server = await startFakeDeepSeek();
  try {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, 'revised.md'), 'precious\n');
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /revised\.md already exists.*--force/);
    assert.equal(fs.readFileSync(path.join(cwd, 'revised.md'), 'utf8'), 'precious\n');
    assert.equal(server.requests.length, 0, 'fails before spending any API calls');
    const forced = await run(['session:', SESSION, '--draft', DRAFT, '--force'], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url } });
    assert.equal(forced.code, 0, forced.stderr);
    assert.notEqual(fs.readFileSync(path.join(cwd, 'revised.md'), 'utf8'), 'precious\n');
    fs.copyFileSync(DRAFT, path.join(cwd, 'd.md'));
    const same = await run(['session:', SESSION, '--draft', 'd.md', '--output', 'd.md'], { cwd, env: { DEEPSEEK_API_KEY: KEY } });
    assert.match(same.stderr, /must differ from the draft path/);
  } finally {
    await server.close();
  }
});

test('API errors: 401 and 402 exit 2 with a clear message and no output file; the key is redacted', async () => {
  for (const [mode, re] of [['unauthorized', /401: authentication failed/], ['balance', /402: insufficient balance/]]) {
    const server = await startFakeDeepSeek({ mode });
    try {
      const cwd = tmp();
      const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url } });
      assert.equal(r.code, 2);
      assert.match(r.stderr, re);
      assert.ok(!r.stderr.includes(KEY), 'the server echoed the key, but it must be redacted');
      assert.ok(!fs.existsSync(path.join(cwd, 'revised.md')));
    } finally {
      await server.close();
    }
  }
});

test('API errors: timeout, flaky 429 with retry, and unparsable JSON stage', async () => {
  const hang = await startFakeDeepSeek({ mode: 'hang' });
  try {
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd: tmp(), env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: hang.url, DEEPSEEK_TIMEOUT_MS: '1000' } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /timed out after 1000 ms/);
  } finally {
    await hang.close();
  }
  const flaky = await startFakeDeepSeek({ mode: 'flaky' });
  try {
    const cwd = tmp();
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: flaky.url, DEEPSEEK_RETRIES: '2' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /rate limited.*retrying in 1s/);
    assert.ok(fs.existsSync(path.join(cwd, 'revised.md')));
  } finally {
    await flaky.close();
  }
  const bad = await startFakeDeepSeek({ mode: 'malformed-json' });
  try {
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd: tmp(), env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: bad.url } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /context analysis: Model did not return valid JSON/);
  } finally {
    await bad.close();
  }
});

test('review-driven repair, fenced output, dropped sections and truncation are handled end to end', async () => {
  const repair = await startFakeDeepSeek({ mode: 'needs-repair' });
  try {
    const cwd = tmp();
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: repair.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(repair.requests.map((q) => q.stage), ['style', 'context', 'edit', 'review', 'edit', 'review']);
    assert.ok(!fs.readFileSync(path.join(cwd, 'revised.md'), 'utf8').includes('INVENTED'));
    assert.match(r.stdout, /accept after 1 repair round/);
  } finally {
    await repair.close();
  }
  for (const mode of ['fenced', 'drop-section']) {
    const server = await startFakeDeepSeek({ mode });
    try {
      const cwd = tmp();
      const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url } });
      assert.equal(r.code, 0, r.stderr);
      const out = fs.readFileSync(path.join(cwd, 'revised.md'), 'utf8');
      assert.ok(out.startsWith('# High-Level Task Goal\n'));
      assert.ok(!out.includes('```markdown'));
      assert.equal(out.split('\n').filter((l) => l.startsWith('# ')).length, 4);
      if (mode === 'drop-section') assert.match(r.stdout, /restored original content/);
    } finally {
      await server.close();
    }
  }
  const trunc = await startFakeDeepSeek({ mode: 'truncated' });
  try {
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd: tmp(), env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: trunc.url } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cut off at DEEPSEEK_MAX_TOKENS/);
  } finally {
    await trunc.close();
  }
});

test('reviewer saying "not better" produces a loud warning but still writes the file', async () => {
  const server = await startFakeDeepSeek({ mode: 'not-better' });
  try {
    const cwd = tmp();
    const r = await run(['session:', SESSION, '--draft', DRAFT], { cwd, env: { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /better than original: NO/);
    assert.match(r.stdout, /WARNING: The reviewer judged the revision not better/);
    assert.ok(fs.existsSync(path.join(cwd, 'revised.md')));
  } finally {
    await server.close();
  }
});
