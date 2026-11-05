#!/usr/bin/env node
'use strict';
// Generates test/fixtures/sample-session.jsonl: a SYNTHETIC Claude Code session
// in the real export shape. Nothing in it comes from a real session.

const fs = require('fs');
const path = require('path');

const out = [];
let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 15, 10, 0, n++)).toISOString();
const base = () => ({ cwd: '/work/fetcher', sessionId: 'sample-session', version: '2.1.0', gitBranch: 'main', isSidechain: false });
const push = (o) => out.push(JSON.stringify(o));

const user = (content, extra = {}) => push({ ...base(), type: 'user', uuid: `u${n}`, parentUuid: null, timestamp: ts(), message: { role: 'user', content }, ...extra });
const assistantText = (text, extra = {}) => push({ ...base(), type: 'assistant', uuid: `a${n}`, parentUuid: null, timestamp: ts(), message: { role: 'assistant', model: 'claude-sample', content: [{ type: 'text', text }] }, ...extra });
const toolUse = (id, name, input) => push({ ...base(), type: 'assistant', uuid: `a${n}`, parentUuid: null, timestamp: ts(), message: { role: 'assistant', model: 'claude-sample', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content, { isError = false, toolUseResult } = {}) => push({ ...base(), type: 'user', uuid: `u${n}`, parentUuid: null, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...(toolUseResult !== undefined ? { toolUseResult } : {}) });
const bash = (id, command, description, stdout, { stderr = '', isError = false } = {}) => {
  toolUse(id, 'Bash', { command, description });
  const content = isError ? `Exit code 1\n${stdout}${stderr ? `\n${stderr}` : ''}` : `${stdout}${stderr ? `\n${stderr}` : ''}`;
  toolResult(id, content, { isError, toolUseResult: { stdout, stderr, interrupted: false, isImage: false } });
};

// Noise records that real exports contain.
push({ type: 'mode', mode: 'default', sessionId: 'sample-session' });
push({ type: 'ai-title', aiTitle: 'Add retry with backoff to HTTP client', sessionId: 'sample-session' });
push({ type: 'file-history-snapshot', messageId: 'x', snapshot: {}, isSnapshotUpdate: false });
push({ type: 'api-request-blob', hash: 'abc', sessionId: 'sample-session', message: { role: 'user', content: [{ type: 'text', text: 'SHOULD NOT APPEAR IN DIGEST' }] } });

user('Add retry with exponential backoff to the HTTP client in fetcher/client.py. Retries should only happen on 5xx and connection errors, and there must be tests for it.<system-reminder>injected reminder, not written by the user</system-reminder>');
user('<command-name>/model</command-name><command-message>model</command-message>', { isMeta: true });
assistantText('I will look at the current client first, then run the existing tests to get a baseline.');
toolUse('t1', 'Read', { file_path: '/work/fetcher/fetcher/client.py' });
toolResult('t1', '     1\timport requests\n     2\t\n     3\tdef get(url):\n     4\t    return requests.get(url, timeout=10)\n', { toolUseResult: { type: 'text', file: { filePath: '/work/fetcher/fetcher/client.py', content: 'import requests\n', numLines: 4 } } });
bash('t2', 'python -m pytest tests/ -q', 'Run the existing test suite', '...\n3 passed in 0.12s');
assistantText('Baseline is green. Adding the retry loop now.');
toolUse('t3', 'Edit', { file_path: '/work/fetcher/fetcher/client.py', old_string: 'def get(url):\n    return requests.get(url, timeout=10)', new_string: 'def get(url, retries=3):\n    delay = 0.5\n    for attempt in range(retries + 1):\n        try:\n            resp = requests.get(url, timeout=10)\n        except requests.ConnectionError:\n            if attempt == retries:\n                raise\n            time.sleep(delay)\n            delay *= 2\n            continue\n        if resp.status_code >= 500 and attempt < retries:\n            time.sleep(delay)\n            delay *= 2\n            continue\n        return resp' });
toolResult('t3', 'The file /work/fetcher/fetcher/client.py has been updated.', { toolUseResult: { filePath: '/work/fetcher/fetcher/client.py', oldString: 'def get(url):', newString: 'def get(url, retries=3):', originalFile: 'import requests\n', structuredPatch: [], userModified: false, replaceAll: false } });
toolUse('t4', 'Write', { file_path: '/work/fetcher/tests/test_retry.py', content: 'def test_backoff(monkeypatch):\n    ...\n' });
toolResult('t4', 'File created successfully at: /work/fetcher/tests/test_retry.py', { toolUseResult: { type: 'create', filePath: '/work/fetcher/tests/test_retry.py', content: 'def test_backoff(monkeypatch):\n    ...\n', structuredPatch: [] } });
bash('t5', 'python -m pytest tests/ -q', 'Run tests after adding retry', 'F...\nFAILED tests/test_retry.py::test_backoff - AssertionError: expected sleep(0.5) but got sleep(1.0)\n1 failed, 3 passed in 0.20s', { isError: true });
assistantText('The backoff test failed: the first sleep used the doubled delay because I multiplied before sleeping. Moving the multiplication after the sleep.');
toolUse('t6', 'Edit', { file_path: '/work/fetcher/fetcher/client.py', old_string: 'time.sleep(delay)\n            delay *= 2', new_string: 'time.sleep(delay)\n            delay = delay * 2', replace_all: true });
toolResult('t6', 'The file /work/fetcher/fetcher/client.py has been updated.', { toolUseResult: { filePath: '/work/fetcher/fetcher/client.py', oldString: 'x', newString: 'y', originalFile: '', structuredPatch: [], userModified: false, replaceAll: true } });
bash('t7', 'python -m pytest tests/ -q', 'Re-run tests after the fix', '....\n4 passed in 0.21s');
assistantText('All tests pass now. The build is clean as well.');
user('Good. Also cap the number of retries at 5 and make it configurable through an environment variable, FETCHER_MAX_RETRIES.');
toolUse('t8', 'Edit', { file_path: '/work/fetcher/fetcher/client.py', old_string: 'def get(url, retries=3):', new_string: 'MAX_RETRIES = min(int(os.environ.get("FETCHER_MAX_RETRIES", "3")), 5)\n\ndef get(url, retries=MAX_RETRIES):' });
toolResult('t8', 'The file /work/fetcher/fetcher/client.py has been updated.', { toolUseResult: { filePath: '/work/fetcher/fetcher/client.py', oldString: 'x', newString: 'y', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } });
toolUse('t9', 'Edit', { file_path: '/work/fetcher/fetcher/client.py', old_string: 'does not exist', new_string: 'x' });
toolResult('t9', 'String to replace not found in file.\nString: does not exist', { isError: true });
bash('t10', 'python -m pytest tests/ -q', 'Run tests after the cap change', '.....\n5 passed in 0.23s');
bash('t11', 'git add -A && git commit -m "Add retry with exponential backoff and FETCHER_MAX_RETRIES cap"', 'Commit the change', '[main 1a2b3c4] Add retry with exponential backoff and FETCHER_MAX_RETRIES cap\n 2 files changed, 31 insertions(+), 2 deletions(-)');
// Compaction, as a real long session would contain.
push({ ...base(), type: 'system', subtype: 'compact_boundary', uuid: 's1', parentUuid: null, timestamp: ts(), content: 'Conversation compacted', isMeta: true, level: 'info', compactMetadata: { trigger: 'auto' } });
user('Summary of earlier work: retry loop added to fetcher/client.py with exponential backoff, tests added, cap of 5 retries read from FETCHER_MAX_RETRIES.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
assistantText('Done. The retry logic lives in fetcher/client.py, tests pass, and the retry cap is configurable with FETCHER_MAX_RETRIES.');
// Unusual records: a sidechain message, an orphan tool result, an API error record, an unknown type.
user('Subagent: search for other call sites of get()', { isSidechain: true });
toolResult('orphan-id', 'result with no matching tool_use');
push({ ...base(), type: 'assistant', uuid: 'err', parentUuid: null, timestamp: ts(), isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } });
push({ type: 'some-future-record-type', data: { nested: true } });
push({ type: 'assistant', message: { role: 'assistant', content: 'plain string assistant content, older export shape' } });

const lines = out.join('\n') + '\n{this line is deliberately malformed\n\n';
const dest = path.join(__dirname, '..', 'fixtures', 'sample-session.jsonl');
fs.writeFileSync(dest, lines);
console.log(`wrote ${dest} (${out.length} records + 1 malformed line)`);
