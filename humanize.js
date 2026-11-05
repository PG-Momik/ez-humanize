#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { parseArgs, HELP, UsageError } = require('./lib/args');
const { loadEnv } = require('./lib/env');
const { buildConfig, ConfigError } = require('./lib/config');
const { loadPrompts, PromptError } = require('./lib/prompts');
const { readSession, extractEvents, analyzeEvents, buildDigest, SessionError } = require('./lib/session');
const { createClient, DeepSeekError } = require('./lib/deepseek');
const { readDraft, findSections, DraftError } = require('./lib/draft');
const { runPipeline } = require('./lib/pipeline');
const { unifiedDiff, diffStats } = require('./lib/diff');
const pkg = require('./package.json');

const log = (m) => process.stderr.write(`${m}\n`);

function assertWritable(p, force) {
  if (!force && fs.existsSync(p)) {
    throw new UsageError(`${p} already exists. Choose another --output or pass --force to overwrite it.`);
  }
}

function writeFile(p, text, force) {
  fs.writeFileSync(p, text, { flag: force ? 'w' : 'wx' });
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.version) { process.stdout.write(`${pkg.name} ${pkg.version}\n`); return 0; }

  const appDir = __dirname;
  if (!process.env.HUMANIZE_NO_DOTENV) {
    loadEnv({ paths: [path.resolve('.env'), path.join(appDir, '.env')] });
  }
  const config = buildConfig(process.env, { appDir });
  if (opts.prompts) config.promptsDir = path.resolve(opts.prompts);

  // Validate everything that can fail before any network call or any typing.
  const sessionPath = path.resolve(opts.session);
  if (!fs.existsSync(sessionPath)) throw new UsageError(`Session file not found: ${sessionPath}`);
  const draftPath = opts.draft ? path.resolve(opts.draft) : null;
  if (draftPath && !fs.existsSync(draftPath)) throw new UsageError(`Draft file not found: ${draftPath}`);

  const outputPath = path.resolve(opts.output);
  const diffPath = outputPath.replace(/\.(md|markdown|txt)$/i, '') + '.diff';
  const reportPath = opts.report ? path.resolve(opts.report) : null;
  if (draftPath && draftPath === outputPath) throw new UsageError('The output path must differ from the draft path; the original draft is never overwritten.');
  if (draftPath && draftPath === diffPath) throw new UsageError('The diff path would overwrite the draft; choose another --output.');
  if (sessionPath === outputPath || sessionPath === diffPath) throw new UsageError('The output path must differ from the session path.');
  assertWritable(outputPath, opts.force);
  assertWritable(diffPath, opts.force);
  if (reportPath) assertWritable(reportPath, opts.force);

  if (!config.apiKey) {
    throw new ConfigError('DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key, or export it in the shell.');
  }
  const prompts = loadPrompts(config.promptsDir);
  const client = createClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    thinking: config.thinking,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    log: (m) => log(`      ${m}`),
  });

  // Session.
  log(`Reading session: ${sessionPath}`);
  const { records, malformed, format } = readSession(sessionPath);
  const { events, skipped } = extractEvents(records);
  const analysis = analyzeEvents(events);
  const s = analysis.stats;
  log(`      ${records.length} records (${format}); ${s.userMessages} user messages, ${s.assistantMessages} assistant messages, ${s.toolCalls} tool calls, ${s.filesChanged} files changed, ${s.tests} test runs (${s.testsPassed} passed, ${s.testsFailed} failed), ${s.errors} tool errors`);
  if (malformed) log(`      ${malformed} malformed record(s) skipped`);
  if (s.unsupportedClaims) log(`      ${s.unsupportedClaims} assistant outcome claim(s) without matching test evidence`);
  if (s.userMessages === 0 && s.toolCalls === 0) log('      Warning: no conversation or tool activity found; the session context will be thin.');
  const digest = buildDigest(analysis, { budgetChars: config.contextBudget });

  // Draft.
  if (draftPath) log(`Reading draft: ${draftPath}`);
  const draft = await readDraft({ draftPath, stdin: process.stdin, log });
  const sections = findSections(draft, config.sections);
  if (!sections.structured) {
    log(`      Note: the draft does not contain all required sections (missing: ${sections.missing.join(', ')}). The document's own headings will be preserved instead.`);
  }

  // Pipeline.
  log(`Model: ${config.model}${config.thinking ? ` (thinking ${config.thinking})` : ''} at ${config.baseUrl}`);
  const result = await runPipeline({ draft, digest, chat: client.chat, prompts, config, log, structured: sections.structured });

  // Output. The original draft is never touched.
  writeFile(outputPath, result.revised, opts.force);
  const diff = unifiedDiff(result.original, result.revised, {
    aName: draftPath ? path.basename(draftPath) : 'draft (stdin)',
    bName: path.basename(outputPath),
  });
  writeFile(diffPath, diff || `(no differences between the draft and ${path.basename(outputPath)})\n`, opts.force);
  if (reportPath) {
    writeFile(reportPath, JSON.stringify({
      model: config.model,
      structured: result.structured,
      styleProfile: result.styleProfile,
      context: result.context,
      review: result.review,
      repairs: result.repairs,
      stages: result.stages,
      original: result.original,
      warnings: result.warnings,
      sessionStats: s,
      usage: client.usage,
    }, null, 2) + '\n', opts.force);
  }

  // Report.
  if (opts.diff) {
    process.stdout.write(diff ? `${diff}\n` : 'No differences: the revision is identical to the draft.\n\n');
  }
  const st = diffStats(result.original, result.revised);
  const r = result.review;
  const count = (sev) => r.issues.filter((i) => i.severity === sev).length;
  const lines = [
    'Done.',
    `  Revised draft:  ${outputPath}`,
    `  Unified diff:   ${diffPath}`,
    reportPath ? `  Report:         ${reportPath}` : null,
    draftPath ? `  Original draft: ${draftPath} (unchanged)` : '  Original draft: stdin (not saved)',
    result.structured && result.original !== draft ? `  Scope:          the ${config.sections.length} required sections, extracted from the draft; other parts of the draft are not in the output` : null,
    `  Lines changed:  -${st.removed} +${st.added} of ${st.oldLines}`,
    `  Review:         ${r.verdict}${result.repairs.length ? ` after ${result.repairs.length} repair round(s)` : ''}; better than original: ${r.better_than_original ? 'yes' : 'NO'}; ${count('high')} high, ${count('medium')} medium, ${count('low')} low issue(s)`,
    r.summary ? `  Reviewer:       ${r.summary}` : null,
  ].filter(Boolean);
  for (const i of r.issues.filter((x) => x.severity !== 'low')) {
    lines.push(`    - [${i.severity}] ${i.section || 'document'}: ${i.problem || i.type}${i.revised_quote ? ` ("${i.revised_quote.slice(0, 120)}")` : ''}`);
  }
  for (const w of result.warnings.filter((x) => x.severity !== 'high' || !r.issues.length)) {
    if (w.severity === 'low') lines.push(`  Note: ${w.text}`);
    else if (w.severity === 'medium') lines.push(`  Warning: ${w.text}`);
    else lines.push(`  WARNING: ${w.text}`);
  }
  lines.push(`  DeepSeek usage: ${client.usage.calls} calls, ${client.usage.promptTokens} prompt tokens, ${client.usage.completionTokens} completion tokens, ${(result.elapsedMs / 1000).toFixed(1)}s`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      const known = err instanceof UsageError || err instanceof ConfigError || err instanceof PromptError
        || err instanceof SessionError || err instanceof DraftError || err instanceof DeepSeekError;
      log(`Error: ${err && err.message ? err.message : err}`);
      if (err instanceof UsageError) log(`\n${HELP}`);
      if (!known || process.env.HUMANIZE_DEBUG) log(err && err.stack ? err.stack : '');
      process.exit(err instanceof UsageError || err instanceof ConfigError ? 1 : 2);
    },
  );
}

module.exports = { main };
