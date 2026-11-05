'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { splitSections, findSections, enforceStructure, stripOuterFence, readDraft, DraftError } = require('../lib/draft');
const { DEFAULT_SECTIONS } = require('../lib/config');

const DRAFT = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-draft.md'), 'utf8');

test('splitSections respects code fences and heading levels', () => {
  const md = 'intro\n\n# A\n\nbody a\n```\n# not a heading\n```\n\n## sub\n\n# B\n\nbody b\n';
  const r = splitSections(md, { maxLevel: 1 });
  assert.equal(r.preamble, 'intro\n');
  assert.deepEqual(r.sections.map((s) => s.title), ['A', 'B']);
  assert.ok(r.sections[0].body.includes('# not a heading'));
  assert.ok(r.sections[0].body.includes('## sub'));
});

test('findSections matches required titles loosely (level, case, colon, ampersand)', () => {
  assert.equal(findSections(DRAFT, DEFAULT_SECTIONS).structured, true);
  const alt = '## high-level task goal:\n\nx\n\n## Validation notes\n\ny\n\n### Decision Points\n\nz\n\n# Difficulty and Codebase Understanding\n\nw\n';
  assert.equal(findSections(alt, DEFAULT_SECTIONS).structured, true);
  const missing = findSections('# High-Level Task Goal\n\nonly one\n', DEFAULT_SECTIONS);
  assert.deepEqual(missing.missing, DEFAULT_SECTIONS.slice(1));
});

test('enforceStructure normalises to exact H1 headings in order and restores missing sections', () => {
  const revised = 'Here is the revised document:\n\n## Validation Notes\n\nrevised validation\n\n# High-Level Task Goal\n\nrevised goal\n\n# Extra Section\n\nshould go\n';
  const r = enforceStructure(revised, DRAFT, DEFAULT_SECTIONS);
  assert.equal(r.strict, true);
  const titles = r.text.split('\n').filter((l) => l.startsWith('# '));
  assert.deepEqual(titles, DEFAULT_SECTIONS.map((t) => `# ${t}`));
  assert.ok(r.text.includes('revised goal'));
  assert.ok(r.text.includes('revised validation'));
  assert.ok(r.text.includes('The main decision was to keep the retry logic'), 'missing section restored from the original');
  assert.ok(!r.text.includes('should go'));
  assert.ok(!r.text.includes('Here is the revised'));
  assert.ok(r.notes.some((n) => /restored original content/.test(n)));
  assert.ok(r.notes.some((n) => /dropped section/.test(n)));
});

test('enforceStructure in loose mode keeps the original H1 set, and passes through unstructured text', () => {
  const original = 'preamble\n\n# One\n\nold one\n\n# Two\n\nold two\n';
  const r = enforceStructure('new preamble\n\n# One\n\nnew one\n', original, DEFAULT_SECTIONS);
  assert.equal(r.strict, false);
  assert.ok(r.text.startsWith('new preamble\n\n# One\n\nnew one\n\n# Two\n\nold two'));
  const plain = enforceStructure('```markdown\njust prose\n```', 'just prose, original', DEFAULT_SECTIONS);
  assert.equal(plain.text, 'just prose\n');
});

test('stripOuterFence removes a wrapping code fence only', () => {
  assert.equal(stripOuterFence('```markdown\n# A\n\n```js\ncode\n```\n```'), '# A\n\n```js\ncode\n```');
  assert.equal(stripOuterFence('no fence'), 'no fence');
});

test('readDraft reads a file, or stdin until end, and rejects empty input', async () => {
  const fromFile = await readDraft({ draftPath: path.join(__dirname, 'fixtures', 'sample-draft.md') });
  assert.equal(fromFile, DRAFT);
  const stdin = Readable.from(['line 1\n', 'line 2\n']);
  stdin.isTTY = false;
  assert.equal(await readDraft({ stdin }), 'line 1\nline 2\n');
  await assert.rejects(readDraft({ stdin: Readable.from(['  \n']) }), DraftError);
  await assert.rejects(readDraft({ draftPath: '/nonexistent.md' }), /Cannot read draft file/);
});

test('form-style drafts: suffixed headings, mixed levels, sibling sections kept out', () => {
  const { collectSections, titleMatches } = require('../lib/draft');
  assert.ok(titleMatches('High-Level Task Goal (field_high_level_goal)', 'High-Level Task Goal'));
  assert.ok(titleMatches('Validation Notes / self check (field_self_check)', 'Validation Notes'));
  assert.ok(!titleMatches('Validation Run', 'Validation Notes'));
  assert.ok(!titleMatches('Decision Pointsss', 'Decision Points'));
  const md = [
    '# Form', '', 'intro', '',
    '## Opening Prompt (x)', '', 'verbatim', '',
    '## High-Level Task Goal (field_high_level_goal)', '', 'goal body', '', '### sub detail', '', 'sub body', '',
    '## Decision Points (f)', '', 'decisions', '',
    '## Difficulty & Codebase Understanding (f)', '', 'difficulty', '',
    '## Validation Run', '', 'numbers', '',
    '### Validation Notes / self check (f)', '', 'notes body', '',
    '### Writer submission notes (f)', '', 'writer notes', '',
  ].join('\n');
  const r = collectSections(md, DEFAULT_SECTIONS);
  assert.equal(r.map.get('High-Level Task Goal').trim(), 'goal body\n\n### sub detail\n\nsub body');
  assert.equal(r.map.get('Validation Notes').trim(), 'notes body');
  assert.equal(r.map.get('Difficulty & Codebase Understanding').trim(), 'difficulty');
  assert.deepEqual(r.extra, ['Form', 'Opening Prompt (x)', 'Validation Run', 'Writer submission notes (f)']);
  assert.equal(findSections(md, DEFAULT_SECTIONS).structured, true);
  const out = enforceStructure('# High-Level Task Goal\n\nrevised goal\n\n# Validation Notes\n\nrevised notes\n\n# Decision Points\n\nrevised decisions\n\n# Difficulty & Codebase Understanding\n\nrevised difficulty\n', md, DEFAULT_SECTIONS);
  assert.equal(out.text, '# High-Level Task Goal\n\nrevised goal\n\n# Validation Notes\n\nrevised notes\n\n# Decision Points\n\nrevised decisions\n\n# Difficulty & Codebase Understanding\n\nrevised difficulty\n');
});
