'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runPipeline, normalizeReview, needsRepair, editorSystem } = require('../lib/pipeline');
const { loadPrompts } = require('../lib/prompts');
const { buildConfig } = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const DRAFT = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-draft.md'), 'utf8');
const prompts = loadPrompts(path.join(ROOT, 'prompts'));
const config = buildConfig({ DEEPSEEK_API_KEY: 'k' }, { appDir: ROOT });

// A scripted chat function that answers by stage and records every call.
function scriptedChat({ edit, reviews }) {
  const calls = [];
  let reviewIdx = 0;
  const chat = async ({ system, user, json, temperature }) => {
    const stage = /editorial analyst/.test(system) ? 'style' : /careful technical reader/.test(system) ? 'context' : /skeptical reviewing editor/.test(system) ? 'review' : /Issues to fix/.test(user) ? 'repair' : 'edit';
    calls.push({ stage, system, user, json, temperature });
    let content;
    if (stage === 'style') content = JSON.stringify({ voice_summary: 'plain' });
    else if (stage === 'context') content = JSON.stringify({ draft_check: [{ draft_statement: 'ran mypy', status: 'contradicted', note: 'no mypy run' }] });
    else if (stage === 'review') content = JSON.stringify(reviews[Math.min(reviewIdx++, reviews.length - 1)]);
    else content = edit(user, stage);
    return { content, finishReason: 'stop', usage: null };
  };
  chat.calls = calls;
  return chat;
}

const lastBlock = (user) => { const m = [...user.matchAll(/<<<DRAFT\n([\s\S]*?)\nDRAFT>>>/g)]; return m[m.length - 1][1]; };

test('runs style, context, edit, review in order with the right prompts and temperatures', async () => {
  const chat = scriptedChat({
    edit: (user) => lastBlock(user).replace('utilize', 'use'),
    reviews: [{ verdict: 'accept', better_than_original: true, issues: [] }],
  });
  const logs = [];
  const r = await runPipeline({ draft: DRAFT, digest: 'DIGEST TEXT', chat, prompts, config, log: (m) => logs.push(m) });
  assert.deepEqual(chat.calls.map((c) => c.stage), ['style', 'context', 'edit', 'review']);
  assert.equal(chat.calls[0].system, prompts.styleAnalysis);
  assert.equal(chat.calls[0].json, true);
  assert.equal(chat.calls[0].temperature, config.analysisTemperature);
  assert.ok(chat.calls[1].user.includes('DIGEST TEXT') && chat.calls[1].user.includes('# High-Level Task Goal'));
  assert.ok(chat.calls[2].system.startsWith(prompts.naturalEditor));
  assert.ok(chat.calls[2].system.includes('# Validation Notes\n\n[Revised content for this section]'), 'section skeleton rendered into the editor prompt');
  assert.ok(chat.calls[2].user.includes('"voice_summary": "plain"'));
  assert.equal(chat.calls[2].json, false);
  assert.equal(chat.calls[2].temperature, config.temperature);
  assert.ok(chat.calls[3].user.includes('# Original draft') && chat.calls[3].user.includes('# Revised draft'));
  assert.ok(r.revised.includes('to use a huge retry count'));
  assert.equal(r.structured, true);
  assert.equal(r.review.verdict, 'accept');
  assert.equal(r.repairs.length, 0);
  assert.ok(r.warnings.some((w) => /contradicted: "ran mypy"/.test(w.text)), 'unsupported draft statements surface as warnings');
  assert.ok(logs.some((l) => /\[4\/4\]/.test(l)));
});

test('high-severity review issues trigger one repair round and a re-review', async () => {
  const chat = scriptedChat({
    edit: (user, stage) => (stage === 'repair' ? lastBlock(user).replace('INVENTED. ', '') : lastBlock(user).replace('# Validation Notes\n\n', '# Validation Notes\n\nINVENTED. ')),
    reviews: [
      { verdict: 'revise', better_than_original: true, issues: [{ severity: 'high', type: 'invented', section: 'Validation Notes', revised_quote: 'INVENTED.', problem: 'not in original', fix: 'remove' }] },
      { verdict: 'accept', better_than_original: true, issues: [] },
    ],
  });
  const r = await runPipeline({ draft: DRAFT, digest: 'd', chat, prompts, config, log: () => {} });
  assert.deepEqual(chat.calls.map((c) => c.stage), ['style', 'context', 'edit', 'review', 'repair', 'review']);
  const repair = chat.calls[4];
  assert.ok(repair.user.includes('[high] invented in Validation Notes'));
  assert.ok(repair.user.includes('## Original draft'));
  assert.ok(repair.temperature <= 0.4);
  assert.ok(!r.revised.includes('INVENTED.'));
  assert.equal(r.repairs.length, 1);
  assert.equal(r.review.verdict, 'accept');
  assert.ok(!r.warnings.some((w) => w.severity === 'high'));
});

test('repair rounds are capped and remaining high issues become warnings', async () => {
  const bad = { verdict: 'revise', better_than_original: false, issues: [{ severity: 'high', type: 'meaning', section: 'Decision Points', problem: 'changed meaning' }] };
  const chat = scriptedChat({ edit: (user) => lastBlock(user), reviews: [bad, bad, bad] });
  const r = await runPipeline({ draft: DRAFT, digest: 'd', chat, prompts, config: { ...config, repairRounds: 2 }, log: () => {} });
  assert.equal(chat.calls.filter((c) => c.stage === 'repair').length, 2);
  assert.ok(r.warnings.some((w) => w.severity === 'high' && /not better than the original/.test(w.text)));
  assert.ok(r.warnings.some((w) => w.severity === 'high' && /changed meaning/.test(w.text)));
});

test('a dropped section is restored from the original and the output keeps all four H1s', async () => {
  const chat = scriptedChat({
    edit: (user) => lastBlock(user).replace(/# Difficulty & Codebase Understanding[\s\S]*$/, '') + '\n\nNote from the editor: I shortened things.',
    reviews: [{ verdict: 'accept', better_than_original: true, issues: [] }],
  });
  const r = await runPipeline({ draft: DRAFT, digest: 'd', chat, prompts, config, log: () => {} });
  const h1s = r.revised.split('\n').filter((l) => l.startsWith('# '));
  assert.deepEqual(h1s, config.sections.map((s) => `# ${s}`));
  assert.ok(r.revised.includes('This one was easy.'));
  assert.ok(r.warnings.some((w) => /restored original content/.test(w.text)));
});

test('unstructured drafts use the plain editor prompt and keep their own headings', async () => {
  const draft = '# My Notes\n\nSome prose here.\n\n# Later\n\nMore prose.\n';
  const chat = scriptedChat({ edit: (user) => lastBlock(user).replace('Some prose', 'Some revised prose'), reviews: [{ verdict: 'accept', issues: [] }] });
  const r = await runPipeline({ draft, digest: 'd', chat, prompts, config, log: () => {} });
  assert.equal(r.structured, false);
  assert.equal(chat.calls[2].system, prompts.naturalEditor);
  assert.equal(r.revised, '# My Notes\n\nSome revised prose here.\n\n# Later\n\nMore prose.\n');
});

test('JSON stages retry once on unparsable output, then fail with the stage name', async () => {
  let n = 0;
  const chat = async () => { n++; return { content: 'not json', finishReason: 'stop' }; };
  await assert.rejects(runPipeline({ draft: DRAFT, digest: 'd', chat, prompts, config, log: () => {} }), /style analysis: Model did not return valid JSON/);
  assert.equal(n, 2);
});

test('truncated completions are reported instead of silently used', async () => {
  const chat = async ({ system }) => (/editorial analyst/.test(system)
    ? { content: '{"a":1}', finishReason: 'length' }
    : { content: '{}', finishReason: 'stop' });
  await assert.rejects(runPipeline({ draft: DRAFT, digest: 'd', chat, prompts, config, log: () => {} }), /cut off at DEEPSEEK_MAX_TOKENS/);
});

test('normalizeReview tolerates sloppy review JSON', () => {
  const r = normalizeReview({ verdict: 'REVISE', issues: [{ severity: 'HIGH' }, { severity: 'weird' }, null, 'x'] });
  assert.equal(r.verdict, 'revise');
  assert.deepEqual(r.issues.map((i) => i.severity), ['high', 'medium']);
  assert.equal(r.better_than_original, true);
  assert.equal(needsRepair(normalizeReview({ verdict: 'accept', issues: [{ severity: 'medium' }] })), false);
  assert.equal(needsRepair(normalizeReview(null)), false);
  assert.ok(editorSystem({ prompts, config, structured: true }).includes('Required document structure'));
});
