'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, UsageError } = require('../lib/args');

test('session: with a separate path argument', () => {
  const o = parseArgs(['session:', '/tmp/s.jsonl']);
  assert.equal(o.session, '/tmp/s.jsonl');
  assert.equal(o.output, 'revised.md');
  assert.equal(o.draft, null);
});

test('session:<path> joined, --session, --session=', () => {
  assert.equal(parseArgs(['session:/tmp/a.jsonl']).session, '/tmp/a.jsonl');
  assert.equal(parseArgs(['--session', '/tmp/b.jsonl']).session, '/tmp/b.jsonl');
  assert.equal(parseArgs(['--session=/tmp/c.jsonl']).session, '/tmp/c.jsonl');
});

test('draft, output, report, force, no-diff', () => {
  const o = parseArgs(['session:', 's.jsonl', '--draft', 'd.md', '--output', 'o.md', '--report', 'r.json', '--force', '--no-diff']);
  assert.deepEqual([o.draft, o.output, o.report, o.force, o.diff], ['d.md', 'o.md', 'r.json', true, false]);
  assert.equal(parseArgs(['session:', 's', '--draft=x.md', '--output=y.md']).output, 'y.md');
});

test('help and version do not require a session', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
});

test('errors: missing session, missing values, unknown options, stray args', () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['session:']), /requires a value/);
  assert.throws(() => parseArgs(['session:', 's', '--draft']), /requires a value/);
  assert.throws(() => parseArgs(['session:', 's', '--draft', '--force']), /requires a value/);
  assert.throws(() => parseArgs(['session:', 's', '--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['s.jsonl']), /Did you mean: session: s.jsonl/);
});
