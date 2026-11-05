'use strict';

const { parseJsonCompletion, DeepSeekError } = require('./deepseek');
const { render } = require('./prompts');
const { enforceStructure, findSections, extractSections, sectionSkeleton, stripOuterFence } = require('./draft');

const DRAFT_OPEN = '<<<DRAFT';
const DRAFT_CLOSE = 'DRAFT>>>';

function wrap(label, text) {
  return `${label}\n${DRAFT_OPEN}\n${String(text).trim()}\n${DRAFT_CLOSE}`;
}

function wordCount(text) {
  return String(text).split(/\s+/).filter(Boolean).length;
}

async function jsonStage({ chat, system, user, temperature, maxTokens, model, stageName }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await chat({ system, user, temperature, maxTokens, json: true, model });
    if (res.finishReason === 'length') {
      throw new DeepSeekError(`${stageName}: the model's output was cut off at DEEPSEEK_MAX_TOKENS; raise it or shorten the input`);
    }
    try {
      return { data: parseJsonCompletion(res.content), raw: res };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new DeepSeekError(`${stageName}: ${lastErr.message}`);
}

async function analyzeStyle({ draft, chat, prompts, config }) {
  return jsonStage({
    chat,
    system: prompts.styleAnalysis,
    user: wrap('Draft to analyse:', draft),
    temperature: config.analysisTemperature,
    maxTokens: config.maxTokens,
    stageName: 'style analysis',
  });
}

async function analyzeContext({ digest, draft, chat, prompts, config }) {
  const user = [
    '# Session digest',
    '',
    digest,
    '',
    '# The author\'s draft about this session',
    '',
    wrap('Draft:', draft),
  ].join('\n');
  return jsonStage({
    chat,
    system: prompts.contextAnalysis,
    user,
    temperature: config.analysisTemperature,
    maxTokens: config.maxTokens,
    stageName: 'context analysis',
  });
}

function editorSystem({ prompts, config, structured }) {
  if (!structured) return prompts.naturalEditor;
  return `${prompts.naturalEditor}\n\n${render(prompts.outputFormat, { SECTION_SKELETON: sectionSkeleton(config.sections) })}`;
}

async function editDraft({ draft, styleProfile, context, chat, prompts, config, structured }) {
  const user = [
    '# Author style profile (JSON, derived from the draft)',
    '',
    JSON.stringify(styleProfile, null, 2),
    '',
    '# Work context (JSON, derived from the session; "basis" says whether something is evidence or a claim)',
    '',
    JSON.stringify(context, null, 2),
    '',
    '# The draft to revise',
    '',
    wrap('Draft:', draft),
    '',
    'Return the revised document now, as Markdown only.',
  ].join('\n');
  const res = await chat({
    system: editorSystem({ prompts, config, structured }),
    user,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    json: false,
  });
  if (res.finishReason === 'length') {
    throw new DeepSeekError('editing: the model\'s output was cut off at DEEPSEEK_MAX_TOKENS; raise it');
  }
  return { text: stripOuterFence(res.content), raw: res };
}

async function reviewRevision({ original, revised, styleProfile, context, chat, prompts, config }) {
  const user = [
    '# Author style profile (JSON)',
    '',
    JSON.stringify(styleProfile, null, 2),
    '',
    '# Work context (JSON, from the session)',
    '',
    JSON.stringify(context, null, 2),
    '',
    '# Original draft',
    '',
    wrap('Original:', original),
    '',
    '# Revised draft',
    '',
    wrap('Revised:', revised),
  ].join('\n');
  return jsonStage({
    chat,
    system: prompts.qualityReview,
    user,
    temperature: config.analysisTemperature,
    maxTokens: config.maxTokens,
    stageName: 'quality review',
  });
}

function formatIssues(issues) {
  return issues
    .map((it, i) => {
      const lines = [`${i + 1}. [${it.severity || 'high'}] ${it.type || 'issue'} in ${it.section || 'the document'}`];
      if (it.revised_quote) lines.push(`   Revised text: "${it.revised_quote}"`);
      if (it.original_quote) lines.push(`   Original text: "${it.original_quote}"`);
      if (it.problem) lines.push(`   Problem: ${it.problem}`);
      if (it.fix) lines.push(`   Fix: ${it.fix}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

async function repairRevision({ original, revised, issues, chat, prompts, config, structured }) {
  const user = render(prompts.repair, {
    ISSUES: formatIssues(issues),
    ORIGINAL: `${DRAFT_OPEN}\n${original.trim()}\n${DRAFT_CLOSE}`,
    REVISED: `${DRAFT_OPEN}\n${revised.trim()}\n${DRAFT_CLOSE}`,
  });
  const res = await chat({
    system: editorSystem({ prompts, config, structured }),
    user,
    temperature: Math.min(config.temperature, 0.4),
    maxTokens: config.maxTokens,
    json: false,
  });
  if (res.finishReason === 'length') {
    throw new DeepSeekError('repair: the model\'s output was cut off at DEEPSEEK_MAX_TOKENS; raise it');
  }
  return { text: stripOuterFence(res.content), raw: res };
}

function normalizeReview(review) {
  const r = review && typeof review === 'object' ? review : {};
  const issues = Array.isArray(r.issues) ? r.issues.filter((x) => x && typeof x === 'object') : [];
  for (const it of issues) {
    it.severity = ['high', 'medium', 'low'].includes(String(it.severity).toLowerCase()) ? String(it.severity).toLowerCase() : 'medium';
  }
  const verdict = String(r.verdict || '').toLowerCase() === 'revise' ? 'revise' : 'accept';
  return {
    verdict,
    better_than_original: r.better_than_original !== false,
    meaning_preserved: r.meaning_preserved !== false,
    voice_preserved: r.voice_preserved !== false,
    structure_ok: r.structure_ok !== false,
    issues,
    summary: typeof r.summary === 'string' ? r.summary : '',
  };
}

function needsRepair(review) {
  return review.verdict === 'revise' || review.issues.some((i) => i.severity === 'high');
}

async function runPipeline({ draft, digest, chat, prompts, config, log = () => {}, structured = null }) {
  const warnings = [];
  const notes = [];
  const t0 = Date.now();
  const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

  if (structured === null) structured = findSections(draft, config.sections).structured;
  // In strict mode every stage works on the required sections only, so headings are
  // normalised and other parts of a form (verbatim prompts, numbers, notes) are left alone.
  const fullDraft = draft;
  if (structured) draft = extractSections(fullDraft, config.sections);
  const stages = [];

  let t = Date.now();
  log(`[1/4] Analysing the author's style (${wordCount(draft)} words)`);
  const style = await analyzeStyle({ draft, chat, prompts, config });
  log(`      done in ${since(t)}`);

  t = Date.now();
  log(`[2/4] Reading the session context (${Math.round(digest.length / 1000)}k chars of digest)`);
  const ctx = await analyzeContext({ digest, draft, chat, prompts, config });
  const checks = Array.isArray(ctx.data.draft_check) ? ctx.data.draft_check : [];
  const flagged = checks.filter((c) => c && ['unsupported', 'contradicted'].includes(String(c.status).toLowerCase()));
  log(`      done in ${since(t)}${flagged.length ? `; ${flagged.length} draft statement(s) not supported by the session` : ''}`);
  for (const c of flagged) {
    warnings.push({ severity: 'medium', text: `Draft statement ${c.status}: "${c.draft_statement}"${c.note ? ` (${c.note})` : ''}` });
  }

  t = Date.now();
  log(`[3/4] Editing${structured ? '' : ' (free-form document; required sections not all present)'}`);
  const edited = await editDraft({ draft, styleProfile: style.data, context: ctx.data, chat, prompts, config, structured });
  stages.push({ name: 'edit', text: edited.text });
  let shaped = enforceStructure(edited.text, draft, config.sections);
  notes.push(...shaped.notes);
  let revised = shaped.text;
  log(`      done in ${since(t)}`);

  t = Date.now();
  log('[4/4] Reviewing the revision');
  let review = normalizeReview((await reviewRevision({ original: draft, revised, styleProfile: style.data, context: ctx.data, chat, prompts, config })).data);
  log(`      ${review.verdict}; ${review.issues.filter((i) => i.severity === 'high').length} high, ${review.issues.filter((i) => i.severity === 'medium').length} medium, ${review.issues.filter((i) => i.severity === 'low').length} low issue(s) in ${since(t)}`);

  const repairs = [];
  let rounds = 0;
  while (needsRepair(review) && rounds < config.repairRounds) {
    rounds++;
    const toFix = review.issues.filter((i) => i.severity === 'high');
    const issues = toFix.length ? toFix : review.issues;
    t = Date.now();
    log(`      repair round ${rounds}: fixing ${issues.length} issue(s)`);
    const repaired = await repairRevision({ original: draft, revised, issues, chat, prompts, config, structured });
    stages.push({ name: `repair-${rounds}`, text: repaired.text });
    shaped = enforceStructure(repaired.text, draft, config.sections);
    notes.push(...shaped.notes);
    revised = shaped.text;
    repairs.push({ round: rounds, issues, review });
    review = normalizeReview((await reviewRevision({ original: draft, revised, styleProfile: style.data, context: ctx.data, chat, prompts, config })).data);
    log(`      re-review: ${review.verdict}; ${review.issues.filter((i) => i.severity === 'high').length} high issue(s) remain in ${since(t)}`);
  }

  if (!review.better_than_original) warnings.push({ severity: 'high', text: 'The reviewer judged the revision not better than the original. Compare the diff before using it.' });
  for (const i of review.issues.filter((x) => x.severity === 'high')) {
    warnings.push({ severity: 'high', text: `${i.type || 'issue'} in ${i.section || 'document'}: ${i.problem || ''}${i.revised_quote ? ` ("${i.revised_quote}")` : ''}` });
  }
  for (const n of notes) warnings.push({ severity: 'low', text: `Structure: ${n}` });

  return {
    revised,
    original: draft,
    fullDraft,
    stages,
    styleProfile: style.data,
    context: ctx.data,
    review,
    repairs,
    warnings,
    structured,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  runPipeline,
  analyzeStyle,
  analyzeContext,
  editDraft,
  reviewRevision,
  repairRevision,
  normalizeReview,
  needsRepair,
  editorSystem,
  formatIssues,
};
