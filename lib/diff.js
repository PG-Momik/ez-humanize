'use strict';

// Line-based unified diff with no dependencies. Uses an LCS table, which is
// fine for documents of a few thousand lines.

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > 40e6) {
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function splitLines(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  if (t === '') return [];
  const lines = t.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function unifiedDiff(oldText, newText, { aName = 'original', bName = 'revised', context = 3 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = lcsOps(a, b);
  const changed = [];
  ops.forEach((op, idx) => { if (op[0] !== ' ') changed.push(idx); });
  if (changed.length === 0) return '';

  // Group changes into hunks.
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (let k = 1; k < changed.length; k++) {
    const c = changed[k];
    if (c - context <= end + 1) {
      end = Math.min(ops.length - 1, c + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, c - context);
      end = Math.min(ops.length - 1, c + context);
    }
  }
  hunks.push([start, end]);

  const out = [`--- ${aName}`, `+++ ${bName}`];
  let oldLine = 0;
  let newLine = 0;
  let cursor = 0;
  for (const [hs, he] of hunks) {
    for (; cursor < hs; cursor++) {
      if (ops[cursor][0] !== '+') oldLine++;
      if (ops[cursor][0] !== '-') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let k = hs; k <= he; k++) {
      const [t, line] = ops[k];
      if (t !== '+') oldCount++;
      if (t !== '-') newCount++;
      body.push(t + line);
    }
    out.push(`@@ -${oldCount === 0 ? oldLine : oldLine + 1},${oldCount} +${newCount === 0 ? newLine : newLine + 1},${newCount} @@`);
    out.push(...body);
    for (; cursor <= he; cursor++) {
      if (ops[cursor][0] !== '+') oldLine++;
      if (ops[cursor][0] !== '-') newLine++;
    }
  }
  return out.join('\n') + '\n';
}

function diffStats(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = lcsOps(a, b);
  let added = 0;
  let removed = 0;
  for (const [t] of ops) {
    if (t === '+') added++;
    else if (t === '-') removed++;
  }
  return { added, removed, oldLines: a.length, newLines: b.length };
}

module.exports = { unifiedDiff, diffStats, lcsOps };
