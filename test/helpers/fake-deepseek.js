'use strict';
// A tiny stand-in for the DeepSeek chat completions endpoint, used by the tests.
// It recognises each pipeline stage by its system prompt and returns canned data.

const http = require('http');

function lastDraftBlock(text) {
  const re = /<<<DRAFT\n([\s\S]*?)\nDRAFT>>>/g;
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m[1];
  return last;
}

function stageOf(system) {
  if (/editorial analyst/i.test(system)) return 'style';
  if (/careful technical reader/i.test(system)) return 'context';
  if (/skeptical reviewing editor/i.test(system)) return 'review';
  return 'edit';
}

function startFakeDeepSeek({ mode = 'ok', editor = null } = {}) {
  const requests = [];
  let reviewCount = 0;
  let flakyCount = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url !== '/chat/completions' || req.method !== 'POST') return send(404, { error: { message: 'not found' } });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, { error: { message: 'bad json' } }); }
      const auth = req.headers.authorization || '';
      requests.push({ body: parsed, auth, stage: stageOf(parsed.messages[0].content) });

      if (mode === 'unauthorized') return send(401, { error: { message: `Authentication Fails for ${auth}` } });
      if (mode === 'balance') return send(402, { error: { message: 'Insufficient Balance' } });
      if (mode === 'flaky' && flakyCount++ < 1) return send(429, { error: { message: 'Rate limit reached' } });
      if (mode === 'down') return send(503, { error: { message: 'overloaded' } });
      if (mode === 'hang') return; // never answers; the client must time out

      const stage = requests[requests.length - 1].stage;
      const userMsg = parsed.messages[1].content;
      let content;
      let finish = 'stop';
      if (stage === 'style') {
        content = JSON.stringify({ voice_summary: 'Plain, first person, slightly informal.', habits_to_preserve: ['first person'], leave_alone: ['This one was easy.'] });
      } else if (stage === 'context') {
        if (mode === 'malformed-json') content = 'Sure! Here is my analysis: not json at all';
        else content = JSON.stringify({ task: { goal: 'Add retry with backoff' }, draft_check: [{ draft_statement: 'I did not run mypy', status: 'supported', note: 'no mypy command in session' }, { draft_statement: 'cap test was added', status: 'unsupported', note: 'no dedicated cap test visible' }] });
      } else if (stage === 'review') {
        reviewCount++;
        if (mode === 'needs-repair' && reviewCount === 1) {
          content = JSON.stringify({ verdict: 'revise', better_than_original: true, issues: [{ severity: 'high', type: 'invented', section: 'Validation Notes', revised_quote: 'INVENTED SENTENCE.', original_quote: '', problem: 'not in the original', fix: 'remove it' }], summary: 'One invented sentence.' });
        } else if (mode === 'not-better') {
          content = JSON.stringify({ verdict: 'accept', better_than_original: false, issues: [], summary: 'Changed little.' });
        } else {
          content = JSON.stringify({ verdict: 'accept', better_than_original: true, issues: [{ severity: 'medium', type: 'formality', section: 'Decision Points', revised_quote: 'basically', problem: 'fine as is', fix: 'none' }], summary: 'Looks good.' });
        }
      } else {
        const draft = lastDraftBlock(userMsg) || '';
        if (editor) content = editor(draft, { userMsg, requests, mode });
        else {
          content = draft.replace(/\butilize\b/g, 'use');
          if (mode === 'needs-repair' && reviewCount === 0) content = content.replace('# Validation Notes\n\n', '# Validation Notes\n\nINVENTED SENTENCE. ');
          if (mode === 'needs-repair' && reviewCount > 0) content = content.replace('INVENTED SENTENCE. ', '');
          if (mode === 'drop-section') content = content.replace(/# Difficulty & Codebase Understanding[\s\S]*$/, '');
          if (mode === 'fenced') content = `Here is the revised document:\n\`\`\`markdown\n${content}\n\`\`\``;
          if (mode === 'truncated') finish = 'length';
        }
      }
      send(200, {
        id: 'cmpl-fake', object: 'chat.completion', model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startFakeDeepSeek, lastDraftBlock };
