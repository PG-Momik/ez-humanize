'use strict';

const fs = require('fs');

class SessionError extends Error {}

// Record types Claude Code writes that carry no conversation content.
const NOISE_TYPES = new Set([
  'last-prompt', 'mode', 'permission-mode', 'atis-latch', 'attachment',
  'file-history-snapshot', 'file-history-delta', 'api-request', 'api-request-blob',
  'api-request-shape', 'tools-used', 'ai-title', 'cost-state', 'progress',
  'queue-operation', 'custom-title', 'pr-link', 'agent-name',
]);

const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'Shell', 'execute_command', 'run_terminal_cmd', 'run_command']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'str_replace_editor', 'str_replace_based_edit_tool', 'create_file', 'edit_file', 'write_file']);

const TEST_COMMAND = new RegExp(
  '(?:^|[\\s;&|(])(?:' +
  [
    '(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|t|check)\\b',
    'npx\\s+(?:jest|vitest|mocha|ava|tap|playwright\\s+test|cypress\\s+run)\\b',
    '(?:jest|vitest|mocha|ava|tap|bats|tox|nox|rspec|phpunit|ctest|pytest|py\\.test)\\b',
    'cargo\\s+test\\b', 'go\\s+test\\b', 'mvn\\s+(?:[^\\n]*\\s)?test\\b', 'gradlew?\\s+(?:[^\\n]*\\s)?test\\b',
    'dotnet\\s+test\\b', 'make\\s+(?:test|check)\\b', 'node\\s+--test\\b',
    'python[0-9.]*\\s+-m\\s+(?:pytest|unittest)\\b', 'flutter\\s+test\\b', 'swift\\s+test\\b',
    'mix\\s+test\\b', 'rake\\s+(?:test|spec)\\b', 'deno\\s+test\\b', 'zig\\s+(?:build\\s+)?test\\b',
  ].join('|') +
  ')',
);

const FAIL_PATTERNS = [
  /\bFAILED\b/, /\bFAIL\b/, /\b[1-9]\d*\s+failing\b/i, /\b[1-9]\d*\s+(?:tests?\s+)?failed\b/i,
  /^#\s*fail\s+[1-9]/m, /\b[1-9]\d*\s+failures?\b/i, /\bfailures?=[1-9]/i, /\berrors?=[1-9]/i,
  /\bAssertionError\b/, /\bpanic:/, /Traceback \(most recent call last\)/, /\b[1-9]\d*\s+errors?\b/i,
  /\bnot ok\b/,
];
const PASS_PATTERNS = [
  /\b\d+\s+passed\b/i, /\b\d+\s+passing\b/i, /^#\s*pass\s+\d+/m, /\bPASS\b/, /^ok\b/m,
  /\bOK\s*\(\d+\s+tests?\)/, /\b0 failures?\b/i, /\ball tests passed\b/i, /✓|✔/,
  /\bTests?:\s+\d+ passed/i, /^#\s*fail\s+0\b/m, /\btest result: ok\b/,
];

const CHECK_COMMAND = /(?:^|[\s;&|(])(?:eslint|ruff|flake8|pylint|mypy|pyright|tsc|biome|golangci-lint|clippy|shellcheck|black\s+--check|prettier\s+--check|cargo\s+(?:clippy|check|build)|go\s+(?:vet|build)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|build|typecheck|type-check)|make\s+(?:lint|build)|gradlew?\s+build|mvn\s+(?:compile|package|verify)|dotnet\s+build|tsc\b)/;

const CLAIM_PATTERN = /\b(?:all\s+)?(?:the\s+)?tests?\s+(?:are\s+|is\s+|now\s+|still\s+|should\s+)?(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b|\bpassing\s+tests?\b|\b(?:build|lint(?:ing)?|type\s*check(?:ing)?|typecheck)\s+(?:is\s+|now\s+)?(?:passes|passed|succeeds|succeeded|clean|green)\b|\bno\s+(?:test\s+)?(?:failures|errors)\b|\bverified\b|\bworks\s+(?:as\s+expected|correctly|fine|now)\b|\bconfirmed\s+(?:that\s+)?(?:it|the|this)\b/i;

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function clip(text, max, { tail = false } = {}) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  if (max < 40) return s.slice(0, max);
  if (tail) return `[... ${s.length - max} chars omitted ...]\n${s.slice(s.length - max)}`;
  const head = Math.floor(max * 0.7);
  const rest = max - head;
  return `${s.slice(0, head)}\n[... ${s.length - max} chars omitted ...]\n${s.slice(s.length - rest)}`;
}

// ---------------------------------------------------------------------------
// Reading

function findRecordArray(obj) {
  for (const key of ['messages', 'records', 'entries', 'events', 'transcript', 'log', 'conversation']) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return null;
}

function parseSessionText(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new SessionError('Session file is empty');

  // Whole-file JSON (array, wrapper object, or a single record).
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    let whole = null;
    try {
      whole = JSON.parse(trimmed);
    } catch {
      whole = null;
    }
    if (whole !== null) {
      if (Array.isArray(whole)) {
        const records = whole.filter(isObj);
        if (records.length === 0) throw new SessionError('Session JSON array contains no records');
        return { records, malformed: whole.length - records.length, format: 'json' };
      }
      if (isObj(whole)) {
        const arr = findRecordArray(whole);
        if (arr) {
          const records = arr.filter(isObj);
          if (records.length === 0) throw new SessionError('Session JSON contains an empty record list');
          return { records, malformed: arr.length - records.length, format: 'json' };
        }
        if (whole.type || whole.role || whole.message) return { records: [whole], malformed: 0, format: 'json' };
        throw new SessionError('Unrecognised session JSON: expected an array of records or an object with a "messages" array');
      }
    }
  }

  // JSON Lines.
  const records = [];
  let malformed = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (isObj(r)) records.push(r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  if (records.length === 0) {
    throw new SessionError('No valid JSON records found; is this a Claude Code session export (.jsonl)?');
  }
  return { records, malformed, format: 'jsonl' };
}

function readSession(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new SessionError(`Cannot read session file ${filePath}: ${err.message}`);
  }
  return parseSessionText(text);
}

// ---------------------------------------------------------------------------
// Event extraction

function blocksOf(message) {
  if (!isObj(message)) return [];
  const c = message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (Array.isArray(c)) return c.filter(isObj);
  return [];
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!isObj(b)) return '';
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'image') return '[image]';
        if (typeof b.text === 'string') return b.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (isObj(content)) {
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return content == null ? '' : String(content);
}

function resultOutput(block, structured) {
  let text = textOf(block.content);
  if (isObj(structured)) {
    if (typeof structured.stdout === 'string' || typeof structured.stderr === 'string') {
      const parts = [];
      if (structured.stdout && structured.stdout.trim()) parts.push(structured.stdout.trim());
      if (structured.stderr && structured.stderr.trim()) parts.push(`[stderr]\n${structured.stderr.trim()}`);
      if (structured.interrupted) parts.push('[command interrupted]');
      const t = parts.join('\n');
      if (t.length > text.length) text = t;
    }
  } else if (typeof structured === 'string' && structured.length > text.length) {
    text = structured;
  }
  return text;
}

const LOCAL_NOISE = /^\s*<(?:command-name|local-command-stdout|local-command-caveat|command-message)>/;

function cleanUserText(t) {
  let s = String(t);
  if (LOCAL_NOISE.test(s)) return '';
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  s = s.replace(/<\/?pasted_content[^>]*>/g, '');
  s = s.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, '(ran in shell) $1');
  s = s.replace(/<\/?bash-(?:stdout|stderr)>/g, '');
  return s.trim();
}

function extractEvents(records) {
  const events = [];
  let skipped = 0;

  for (const r of records) {
    if (!isObj(r)) { skipped++; continue; }
    const type = r.type || (isObj(r.message) && r.message.role) || r.role;
    if (!type || NOISE_TYPES.has(type)) { skipped++; continue; }
    const msg = isObj(r.message) ? r.message : (r.role ? r : null);
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    const side = !!r.isSidechain;

    if (type === 'summary') {
      if (typeof r.summary === 'string' && r.summary.trim()) events.push({ kind: 'title', text: r.summary.trim(), ts, side });
      continue;
    }

    if (type === 'system') {
      const text = typeof r.content === 'string' ? r.content.trim() : '';
      if (r.subtype === 'compact_boundary') events.push({ kind: 'system', text: 'Context was compacted here (earlier history replaced by a model-written summary).', ts, side });
      else if (text && (r.level === 'error' || r.level === 'warning')) events.push({ kind: 'system', text: clip(text, 300), ts, side });
      continue;
    }

    if (type === 'user' || type === 'human') {
      if (r.isCompactSummary) {
        const text = textOf(msg && msg.content);
        if (text.trim()) events.push({ kind: 'summary', text: text.trim(), ts, side });
        continue;
      }
      const textParts = [];
      for (const b of blocksOf(msg)) {
        if (b.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            toolUseId: b.tool_use_id,
            isError: !!b.is_error,
            output: resultOutput(b, r.toolUseResult),
            structured: isObj(r.toolUseResult) ? r.toolUseResult : null,
            ts, side,
          });
        } else if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        }
      }
      const text = cleanUserText(textParts.join('\n'));
      if (text && !r.isMeta) events.push({ kind: 'user', text, ts, side });
      continue;
    }

    if (type === 'assistant') {
      if (r.isApiErrorMessage) {
        events.push({ kind: 'system', text: `API error during session: ${clip(textOf(msg && msg.content), 200)}`, ts, side });
        continue;
      }
      for (const b of blocksOf(msg)) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          events.push({ kind: 'assistant', text: b.text.trim(), ts, side });
        } else if (b.type === 'tool_use') {
          events.push({ kind: 'tool_use', id: b.id, name: typeof b.name === 'string' ? b.name : 'unknown', input: isObj(b.input) ? b.input : {}, ts, side });
        }
      }
      continue;
    }

    skipped++;
  }

  // Link results to the tool calls that produced them.
  const uses = new Map();
  events.forEach((e, i) => {
    e.index = i;
    if (e.kind === 'tool_use' && e.id) uses.set(e.id, e);
  });
  for (const e of events) {
    if (e.kind !== 'tool_result') continue;
    const u = uses.get(e.toolUseId);
    e.name = u ? u.name : 'unknown';
    e.input = u ? u.input : {};
    if (u && !u.result) u.result = e;
  }
  return { events, skipped };
}

// ---------------------------------------------------------------------------
// Analysis

function testOutcome(output, isError) {
  const o = String(output || '');
  const failed = isError || FAIL_PATTERNS.some((re) => re.test(o));
  const passed = !failed && PASS_PATTERNS.some((re) => re.test(o));
  const counts = {};
  let m;
  if ((m = o.match(/\b(\d+)\s+pass(?:ed|ing)\b/i) || o.match(/^#\s*pass\s+(\d+)/m))) counts.passed = Number(m[1]);
  if ((m = o.match(/\b(\d+)\s+fail(?:ed|ing)\b/i) || o.match(/^#\s*fail\s+(\d+)/m))) counts.failed = Number(m[1]);
  return { result: failed ? 'failed' : passed ? 'passed' : 'unknown', counts };
}

// The part of a shell command before any heredoc body, so text inside a heredoc
// (for example a Python script that mentions pytest) does not classify the command.
function commandHead(command) {
  const m = command.match(/<<-?\s*['"]?\w+/);
  return m ? command.slice(0, m.index) : command;
}

function callSummary(name, input) {
  if (SHELL_TOOLS.has(name)) return clip(String(input.command || input.cmd || ''), 200).replace(/\s+/g, ' ');
  const p = input.file_path || input.notebook_path || input.path;
  if (p) return `${name} ${p}`;
  const keys = Object.keys(input);
  if (keys.length === 0) return name;
  return `${name} ${clip(JSON.stringify(input), 160)}`;
}

function splitSentences(text) {
  return String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/).map((s) => s.trim()).filter(Boolean);
}

function analyzeEvents(events) {
  const userMessages = [];
  const assistantTexts = [];
  const summaries = [];
  const systemNotes = [];
  const toolUses = [];
  const toolCounts = {};
  const commands = [];
  const files = new Map();
  const errors = [];
  const claims = [];
  let title = null;
  let lastTest = null;
  let lastCheck = null;

  for (const e of events) {
    switch (e.kind) {
      case 'title': title = title || e.text; break;
      case 'user': userMessages.push({ index: e.index, text: e.text, side: e.side }); break;
      case 'summary': summaries.push({ index: e.index, text: e.text }); break;
      case 'system': systemNotes.push({ index: e.index, text: e.text }); break;
      case 'assistant': {
        if (!e.side) assistantTexts.push({ index: e.index, text: e.text });
        for (const s of splitSentences(e.text)) {
          if (!CLAIM_PATTERN.test(s)) continue;
          const aboutTests = /\btests?\b|\bpassing\b/i.test(s);
          const aboutCheck = /\b(?:build|lint(?:ing)?|type\s*check(?:ing)?|typecheck)\b/i.test(s);
          let status;
          if (aboutCheck && !aboutTests) {
            if (!lastCheck) status = 'no build, lint or type-check command recorded before this statement';
            else if (lastCheck.isError) status = `contradicted: the last recorded check command failed (${clip(lastCheck.command, 80)})`;
            else status = `supported by command output (${clip(lastCheck.command, 80)})`;
          } else if (!lastTest) {
            status = aboutTests ? 'no test execution recorded before this statement' : 'no test or verification command recorded before this statement';
          } else if (lastTest.outcome.result === 'passed') status = `supported by test output (${clip(lastTest.command, 80)})`;
          else if (lastTest.outcome.result === 'failed') status = `contradicted: the last recorded test run failed (${clip(lastTest.command, 80)})`;
          else status = `a test command ran (${clip(lastTest.command, 80)}) but its result is unclear`;
          claims.push({ index: e.index, text: clip(s, 240), status, side: e.side });
        }
        break;
      }
      case 'tool_use': {
        toolUses.push(e);
        toolCounts[e.name] = (toolCounts[e.name] || 0) + 1;
        const res = e.result || null;
        const output = res ? res.output : '';
        const isError = res ? res.isError : false;

        if (SHELL_TOOLS.has(e.name)) {
          const command = String(e.input.command || e.input.cmd || '');
          const probe = commandHead(command);
          const isTest = TEST_COMMAND.test(probe);
          const outcome = isTest ? testOutcome(output, isError) : null;
          const cmd = { index: e.index, command, description: typeof e.input.description === 'string' ? e.input.description : '', output, isError, hasResult: !!res, isTest, outcome, side: e.side };
          commands.push(cmd);
          if (isTest) lastTest = cmd;
          else if (CHECK_COMMAND.test(probe)) lastCheck = cmd;
          if (!isError && /Traceback \(most recent call last\)|npm ERR!|panic:|FATAL/.test(output)) {
            errors.push({ index: e.index, tool: e.name, call: callSummary(e.name, e.input), excerpt: clip(output, 400, { tail: true }), note: 'error text in command output' });
          }
        }

        if (EDIT_TOOLS.has(e.name)) {
          const p = e.input.file_path || e.input.notebook_path || e.input.path;
          if (p) {
            const entry = files.get(p) || { path: p, actions: new Set(), count: 0, failed: 0 };
            const created = e.name === 'Write' && res && res.structured && res.structured.type === 'create';
            const action = created ? 'created' : (e.name === 'Write' || e.name === 'write_file' || e.name === 'create_file' || (e.input.command === 'create')) ? 'wrote' : 'edited';
            if (res && res.isError) entry.failed++;
            else { entry.actions.add(action); entry.count++; }
            files.set(p, entry);
          }
        }

        if (res && res.isError) {
          errors.push({ index: e.index, tool: e.name, call: callSummary(e.name, e.input), excerpt: clip(output, 400, { tail: true }), note: 'tool reported an error' });
        }
        break;
      }
      default:
        break;
    }
  }

  const tests = commands.filter((c) => c.isTest);
  const filesChanged = [...files.values()].map((f) => ({ path: f.path, actions: [...f.actions], count: f.count, failed: f.failed }));
  const gitCommits = commands.filter((c) => /\bgit\s+commit\b/.test(c.command) && !c.isError).length;

  return {
    title,
    userMessages,
    assistantTexts,
    summaries,
    systemNotes,
    toolUses,
    toolCounts,
    commands,
    tests,
    filesChanged,
    errors,
    claims,
    gitCommits,
    stats: {
      events: events.length,
      userMessages: userMessages.length,
      assistantMessages: assistantTexts.length,
      toolCalls: toolUses.length,
      commands: commands.length,
      tests: tests.length,
      testsPassed: tests.filter((t) => t.outcome.result === 'passed').length,
      testsFailed: tests.filter((t) => t.outcome.result === 'failed').length,
      filesChanged: filesChanged.length,
      errors: errors.length,
      claims: claims.length,
      unsupportedClaims: claims.filter((c) => !c.status.startsWith('supported')).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Digest (what is sent to the model)

// Keeps head and tail items when a list is over budget.
function fitList(items, cap, { firstItemMax, itemMax }) {
  const rendered = items.map((it, i) => clip(it, i === 0 ? firstItemMax : itemMax));
  const total = rendered.reduce((n, s) => n + s.length + 1, 0);
  if (total <= cap) return rendered;
  const head = [];
  const tail = [];
  let used = 0;
  let i = 0;
  let j = rendered.length - 1;
  while (i <= j) {
    if (head.length <= tail.length) {
      if (used + rendered[i].length + 1 > cap) break;
      used += rendered[i].length + 1;
      head.push(rendered[i]);
      i++;
    } else {
      if (used + rendered[j].length + 1 > cap) break;
      used += rendered[j].length + 1;
      tail.unshift(rendered[j]);
      j--;
    }
  }
  const omitted = rendered.length - head.length - tail.length;
  if (omitted <= 0) return rendered;
  return [...head, `[... ${omitted} item(s) omitted to fit the context budget ...]`, ...tail];
}

function allocate(naturalSizes, shares, budget) {
  const keys = Object.keys(shares);
  const caps = {};
  let fixed = new Set();
  for (let round = 0; round < keys.length + 1; round++) {
    const free = keys.filter((k) => !fixed.has(k));
    const usedByFixed = [...fixed].reduce((n, k) => n + naturalSizes[k], 0);
    const remaining = Math.max(0, budget - usedByFixed);
    const shareSum = free.reduce((n, k) => n + shares[k], 0) || 1;
    let changed = false;
    for (const k of free) {
      const cap = Math.floor((remaining * shares[k]) / shareSum);
      if (naturalSizes[k] <= cap) { fixed.add(k); changed = true; }
      caps[k] = cap;
    }
    if (!changed) break;
  }
  for (const k of fixed) caps[k] = naturalSizes[k];
  return caps;
}

function buildDigest(a, { budgetChars = 24000 } = {}) {
  const s = a.stats;
  const overview = [
    '## Session overview',
    a.title ? `- Title: ${a.title}` : null,
    `- Events: ${s.events}; user messages: ${s.userMessages}; assistant messages: ${s.assistantMessages}; tool calls: ${s.toolCalls}`,
    `- Tools used: ${Object.entries(a.toolCounts).map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}`,
    `- Files changed: ${s.filesChanged}; shell commands: ${s.commands}; test runs: ${s.tests} (${s.testsPassed} passed, ${s.testsFailed} failed, ${s.tests - s.testsPassed - s.testsFailed} unclear); tool errors: ${s.errors}; git commits: ${a.gitCommits}`,
    '',
    'Labels: [USER] = written by the user. [TOOL RESULT] = actual recorded output of a tool execution (evidence). [ASSISTANT CLAIM] = text written by the model (a claim, not evidence). [COMPACTION SUMMARY] = model-written summary of earlier history (a claim).',
  ].filter((l) => l !== null).join('\n');

  const sections = {
    user: {
      title: '## User messages, in order [USER]',
      items: a.userMessages.map((m, i) => `[${i + 1}]${m.side ? ' (subagent)' : ''} ${m.text}`),
      firstItemMax: 6000, itemMax: 1500, share: 0.30,
      empty: 'No user messages found.',
    },
    tests: {
      title: '## Test executions [TOOL RESULT]',
      items: a.tests.map((t) => `$ ${clip(t.command, 300)}\nresult: ${t.outcome.result}${Object.keys(t.outcome.counts).length ? ` ${JSON.stringify(t.outcome.counts)}` : ''}${t.hasResult ? '' : ' (no output recorded)'}\n${clip(t.output, 1500, { tail: true })}`),
      firstItemMax: 2000, itemMax: 2000, share: 0.18,
      empty: 'No test commands were executed in this session. Any statement that tests passed is unverified.',
    },
    errors: {
      title: '## Errors and failed tool calls [TOOL RESULT]',
      items: a.errors.map((e) => `${e.tool}: ${e.call}\n(${e.note})\n${e.excerpt}`),
      firstItemMax: 800, itemMax: 800, share: 0.10,
      empty: 'No tool errors recorded.',
    },
    files: {
      title: '## Files changed [TOOL RESULT]',
      items: a.filesChanged.map((f) => `${f.path} (${f.actions.join('/') || 'attempted'} x${f.count}${f.failed ? `, ${f.failed} failed attempt(s)` : ''})`),
      firstItemMax: 300, itemMax: 300, share: 0.08,
      empty: 'No file edits recorded.',
    },
    commands: {
      title: '## Shell commands, in order [TOOL RESULT]',
      items: a.commands.map((c) => `$ ${clip(c.command, 220).replace(/\n/g, ' ')}  -> ${c.hasResult ? (c.isError ? 'error' : 'ok') : 'no result recorded'}${c.description ? `  (${clip(c.description, 100)})` : ''}`),
      firstItemMax: 400, itemMax: 400, share: 0.09,
      empty: 'No shell commands recorded.',
    },
    claims: {
      title: '## Assistant statements about outcomes, checked against test records',
      items: a.claims.map((c) => `"${c.text}"\n  -> ${c.status}`),
      firstItemMax: 500, itemMax: 500, share: 0.05,
      empty: 'No outcome claims detected.',
    },
    assistant: {
      title: '## Assistant narrative, in order [ASSISTANT CLAIM]',
      items: a.assistantTexts.map((m, i) => `[${i + 1}] ${m.text}`),
      firstItemMax: 1200, itemMax: 700, share: 0.14,
      empty: 'No assistant text found.',
    },
    summaries: {
      title: '## Compaction summaries and system notes [COMPACTION SUMMARY]',
      items: [...a.summaries.map((x) => x.text), ...a.systemNotes.map((x) => `(system) ${x.text}`)],
      firstItemMax: 3000, itemMax: 1000, share: 0.06,
      empty: null,
    },
  };

  const budget = Math.max(2000, budgetChars - overview.length - 200);
  const natural = {};
  const shares = {};
  for (const [k, sec] of Object.entries(sections)) {
    natural[k] = sec.items.reduce((n, it, i) => n + Math.min(it.length, i === 0 ? sec.firstItemMax : sec.itemMax) + 1, 0) + sec.title.length + 2;
    shares[k] = sec.share;
  }
  const caps = allocate(natural, shares, budget);

  const out = [overview];
  for (const [k, sec] of Object.entries(sections)) {
    if (sec.items.length === 0) {
      if (sec.empty) out.push(`${sec.title}\n${sec.empty}`);
      continue;
    }
    const body = fitList(sec.items, Math.max(200, caps[k] - sec.title.length - 2), sec);
    out.push(`${sec.title}\n${body.join('\n\n')}`);
  }
  return out.join('\n\n');
}

module.exports = {
  SessionError,
  parseSessionText,
  readSession,
  extractEvents,
  analyzeEvents,
  buildDigest,
  testOutcome,
  commandHead,
  cleanUserText,
  clip,
  TEST_COMMAND,
  CHECK_COMMAND,
  CLAIM_PATTERN,
};
