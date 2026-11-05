'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  readSession, parseSessionText, extractEvents, analyzeEvents, buildDigest, testOutcome, cleanUserText, SessionError,
} = require('../lib/session');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-session.jsonl');

function analyzeFixture() {
  const { records, malformed, format } = readSession(FIXTURE);
  const { events, skipped } = extractEvents(records);
  return { records, malformed, format, events, skipped, analysis: analyzeEvents(events) };
}

test('reads JSONL, counts malformed lines, skips noise records', () => {
  const r = analyzeFixture();
  assert.equal(r.format, 'jsonl');
  assert.equal(r.malformed, 1);
  assert.equal(r.records.length, 41);
  assert.ok(r.skipped >= 4, 'noise records are skipped');
});

test('extracts user messages, assistant text, tool calls and links results', () => {
  const { analysis: a } = analyzeFixture();
  assert.equal(a.stats.userMessages, 3);
  assert.ok(a.userMessages[0].text.startsWith('Add retry with exponential backoff'));
  assert.ok(!a.userMessages[0].text.includes('system-reminder'), 'system reminders are stripped');
  assert.equal(a.stats.assistantMessages, 6);
  assert.equal(a.stats.toolCalls, 11);
  assert.deepEqual(a.toolCounts, { Read: 1, Bash: 5, Edit: 4, Write: 1 });
  const read = a.toolUses.find((u) => u.name === 'Read');
  assert.ok(read.result && read.result.output.includes('import requests'));
});

test('classifies test runs with pass/fail from tool output, not from assistant text', () => {
  const { analysis: a } = analyzeFixture();
  assert.equal(a.stats.tests, 4);
  assert.deepEqual(a.tests.map((t) => t.outcome.result), ['passed', 'failed', 'passed', 'passed']);
  assert.deepEqual(a.tests[1].outcome.counts, { passed: 3, failed: 1 });
  assert.ok(a.tests[0].output.includes('3 passed'));
});

test('tracks files changed and failed edits', () => {
  const { analysis: a } = analyzeFixture();
  const client = a.filesChanged.find((f) => f.path.endsWith('client.py'));
  assert.deepEqual([client.actions, client.count, client.failed], [['edited'], 3, 1]);
  const created = a.filesChanged.find((f) => f.path.endsWith('test_retry.py'));
  assert.deepEqual(created.actions, ['created']);
  assert.equal(a.gitCommits, 1);
});

test('collects tool errors', () => {
  const { analysis: a } = analyzeFixture();
  assert.equal(a.stats.errors, 2);
  assert.ok(a.errors.some((e) => e.tool === 'Edit' && e.excerpt.includes('String to replace not found')));
  assert.ok(a.errors.some((e) => e.tool === 'Bash' && e.excerpt.includes('FAILED')));
});

test('assistant outcome claims are checked against recorded evidence', () => {
  const { analysis: a } = analyzeFixture();
  const byText = Object.fromEntries(a.claims.map((c) => [c.text, c.status]));
  assert.match(byText['All tests pass now.'], /^supported by test output/);
  assert.match(byText['The build is clean as well.'], /^no build, lint or type-check command recorded/);
  assert.equal(a.stats.unsupportedClaims, 1);
});

test('claim made before any test run is marked unverified; after a failed run is contradicted', () => {
  const recs = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'Tests: 1 failed, 2 passed', is_error: true }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests pass now.' }] } },
  ];
  const a = analyzeEvents(extractEvents(recs).events);
  assert.equal(a.claims.length, 2);
  assert.match(a.claims[0].status, /no test execution recorded/);
  assert.match(a.claims[1].status, /contradicted/);
});

test('testOutcome recognises common runners', () => {
  assert.equal(testOutcome('# tests 4\n# pass 4\n# fail 0', false).result, 'passed');
  assert.equal(testOutcome('# tests 4\n# pass 3\n# fail 1', false).result, 'failed');
  assert.equal(testOutcome('ok  \tgithub.com/x/y\t0.123s', false).result, 'passed');
  assert.equal(testOutcome('--- FAIL: TestX\nFAIL', false).result, 'failed');
  assert.equal(testOutcome('Tests: 3 passed, 3 total', false).result, 'passed');
  assert.equal(testOutcome('test result: ok. 12 passed; 0 failed', false).result, 'passed');
  assert.equal(testOutcome('12 examples, 0 failures', false).result, 'passed');
  assert.equal(testOutcome('12 examples, 2 failures', false).result, 'failed');
  assert.equal(testOutcome('some output', false).result, 'unknown');
  assert.equal(testOutcome('5 passed', true).result, 'failed', 'non-zero exit wins');
});

test('cleanUserText drops local command noise and strips injected tags', () => {
  assert.equal(cleanUserText('<command-name>/clear</command-name>'), '');
  assert.equal(cleanUserText('<local-command-stdout>x</local-command-stdout>'), '');
  assert.equal(cleanUserText('hello <system-reminder>secret</system-reminder> world'), 'hello  world');
  assert.equal(cleanUserText('<pasted_content id="1">pasted</pasted_content>'), 'pasted');
});

test('parses JSON array exports and wrapper objects', () => {
  const arr = parseSessionText(JSON.stringify([{ type: 'user', message: { role: 'user', content: 'hi' } }, 'junk']));
  assert.equal(arr.format, 'json');
  assert.equal(arr.records.length, 1);
  assert.equal(arr.malformed, 1);
  const wrapped = parseSessionText(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] }));
  assert.equal(wrapped.records.length, 2);
  const a = analyzeEvents(extractEvents(wrapped.records).events);
  assert.equal(a.stats.userMessages, 1);
  assert.equal(a.stats.assistantMessages, 1);
});

test('rejects empty, non-JSON and unrecognised input', () => {
  assert.throws(() => parseSessionText(''), SessionError);
  assert.throws(() => parseSessionText('this is a markdown file\nnot a session'), /No valid JSON records/);
  assert.throws(() => parseSessionText('{"foo": "bar"}'), /Unrecognised session JSON/);
  assert.throws(() => readSession('/nonexistent/path.jsonl'), /Cannot read session file/);
});

test('digest labels evidence vs claims, excludes noise, and stays within budget', () => {
  const { analysis: a } = analyzeFixture();
  const d = buildDigest(a, { budgetChars: 24000 });
  assert.ok(d.includes('[TOOL RESULT]'));
  assert.ok(d.includes('[ASSISTANT CLAIM]'));
  assert.ok(d.includes('FAILED tests/test_retry.py::test_backoff'));
  assert.ok(d.includes('The build is clean as well.'));
  assert.ok(!d.includes('SHOULD NOT APPEAR'));
  assert.ok(!d.includes('injected reminder'));
  assert.ok(d.length <= 24000);
  const small = buildDigest(a, { budgetChars: 3000 });
  assert.ok(small.length <= 3600, `small digest is ${small.length}`);
  assert.ok(small.includes('Add retry with exponential backoff'), 'the task statement survives truncation');
});

test('large session: 30k records parse quickly and the digest keeps first and last user messages', () => {
  const recs = [];
  for (let i = 0; i < 10000; i++) {
    recs.push({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `User message number ${i} ${'x'.repeat(300)}` } });
    recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `npm test -- case${i}` } }] } });
    recs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `# pass 1\n${'y'.repeat(2000)}` }] } });
  }
  const text = recs.map((r) => JSON.stringify(r)).join('\n');
  const t0 = Date.now();
  const { records } = parseSessionText(text);
  const a = analyzeEvents(extractEvents(records).events);
  const d = buildDigest(a, { budgetChars: 24000 });
  const ms = Date.now() - t0;
  assert.equal(records.length, 30000);
  assert.equal(a.stats.tests, 10000);
  assert.ok(d.length <= 24000, `digest ${d.length} chars`);
  assert.ok(d.includes('User message number 0 '));
  assert.ok(d.includes('User message number 9999 '));
  assert.ok(d.includes('omitted to fit the context budget'));
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test('heredoc bodies do not classify a command as a test run', () => {
  const { commandHead, TEST_COMMAND } = require('../lib/session');
  const cmd = "python3 - <<'EOF'\nimport pytest\nprint('npm test')\nEOF";
  assert.equal(commandHead(cmd), 'python3 - ');
  assert.equal(TEST_COMMAND.test(commandHead(cmd)), false);
  assert.equal(TEST_COMMAND.test(commandHead('uv run pytest -q')), true);
  const recs = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: cmd } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'FAILED something' }] } },
  ];
  assert.equal(analyzeEvents(extractEvents(recs).events).stats.tests, 0);
});
