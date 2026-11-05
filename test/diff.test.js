'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { unifiedDiff, diffStats } = require('../lib/diff');

test('identical inputs produce an empty diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n'), '');
  assert.deepEqual(diffStats('a\nb\n', 'a\nb\n'), { added: 0, removed: 0, oldLines: 2, newLines: 2 });
});

test('single changed line produces one hunk with context and correct headers', () => {
  const a = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n') + '\n';
  const b = a.replace('l5', 'L5');
  const d = unifiedDiff(a, b, { aName: 'x.md', bName: 'y.md', context: 2 });
  assert.equal(d, ['--- x.md', '+++ y.md', '@@ -3,5 +3,5 @@', ' l3', ' l4', '-l5', '+L5', ' l6', ' l7', ''].join('\n'));
  assert.deepEqual(diffStats(a, b), { added: 1, removed: 1, oldLines: 8, newLines: 8 });
});

test('insertions, deletions and multiple hunks', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 2\n', '').replace('line 20', 'line 20\nline 20b');
  const d = unifiedDiff(a, b);
  assert.equal((d.match(/^@@/gm) || []).length, 2);
  assert.ok(d.includes('-line 2\n'));
  assert.ok(d.includes('+line 20b\n'));
  assert.match(d, /@@ -1,6 \+1,5 @@/);
  assert.deepEqual(diffStats(a, b), { added: 1, removed: 1, oldLines: 30, newLines: 30 });
});

test('entirely different documents and empty inputs', () => {
  const d = unifiedDiff('old\n', 'new\n');
  assert.match(d, /@@ -1,1 \+1,1 @@\n-old\n\+new\n/);
  assert.match(unifiedDiff('', 'x\n'), /@@ -0,0 \+1,1 @@\n\+x\n/);
  assert.match(unifiedDiff('x\n', ''), /@@ -1,1 \+0,0 @@\n-x\n/);
});
