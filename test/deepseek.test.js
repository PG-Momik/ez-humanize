'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, parseJsonCompletion, DeepSeekError, redact } = require('../lib/deepseek');

const KEY = 'sk-SECRET-KEY-0000';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length, calls[calls.length - 1]);
  };
  fn.calls = calls;
  return fn;
}

const okResponse = (content, extra = {}) => ({
  ok: true, status: 200,
  json: async () => ({ model: 'deepseek-chat', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra }),
});
const errResponse = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body) });

test('sends an OpenAI-compatible request with JSON mode and reports usage', async () => {
  const fetchImpl = fakeFetch(() => okResponse('{"a":1}'));
  const c = createClient({ apiKey: KEY, baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', fetchImpl });
  const res = await c.chat({ system: 'sys', user: 'usr', json: true, temperature: 0.2, maxTokens: 500 });
  assert.equal(res.content, '{"a":1}');
  assert.equal(c.url, 'https://api.deepseek.com/chat/completions');
  const call = fetchImpl.calls[0];
  assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  assert.equal(call.body.temperature, 0.2);
  assert.equal(call.body.max_tokens, 500);
  assert.deepEqual(call.body.messages.map((m) => m.role), ['system', 'user']);
  assert.deepEqual(c.usage, { calls: 1, promptTokens: 10, completionTokens: 5 });
});

test('thinking parameter is sent only when configured', async () => {
  const f1 = fakeFetch(() => okResponse('x'));
  await createClient({ apiKey: KEY, model: 'deepseek-flash', thinking: 'disabled', fetchImpl: f1 }).chat({ system: 's', user: 'u' });
  assert.deepEqual(f1.calls[0].body.thinking, { type: 'disabled' });
  const f2 = fakeFetch(() => okResponse('x'));
  await createClient({ apiKey: KEY, model: 'deepseek-flash', fetchImpl: f2 }).chat({ system: 's', user: 'u' });
  assert.equal(f2.calls[0].body.thinking, undefined);
});

test('reasoner models get neither temperature nor response_format', async () => {
  const fetchImpl = fakeFetch(() => okResponse('x'));
  const c = createClient({ apiKey: KEY, model: 'deepseek-reasoner', fetchImpl });
  await c.chat({ system: 's', user: 'u', json: true });
  assert.equal(fetchImpl.calls[0].body.temperature, undefined);
  assert.equal(fetchImpl.calls[0].body.response_format, undefined);
});

test('401 is not retried and the key never leaks into the error', async () => {
  const fetchImpl = fakeFetch(() => errResponse(401, { error: { message: `bad key Bearer ${KEY}` } }));
  const c = createClient({ apiKey: KEY, fetchImpl, retries: 3 });
  await assert.rejects(c.chat({ system: 's', user: 'u' }), (err) => {
    assert.ok(err instanceof DeepSeekError);
    assert.equal(err.status, 401);
    assert.match(err.message, /authentication failed/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('402 and 400 produce actionable messages', async () => {
  const c402 = createClient({ apiKey: KEY, fetchImpl: fakeFetch(() => errResponse(402, { error: { message: 'Insufficient Balance' } })) });
  await assert.rejects(c402.chat({ system: 's', user: 'u' }), /insufficient balance.*Insufficient Balance/);
  const c400 = createClient({ apiKey: KEY, fetchImpl: fakeFetch(() => errResponse(400, { error: { message: 'Model Not Exist' } })) });
  await assert.rejects(c400.chat({ system: 's', user: 'u' }), /DEEPSEEK_MODEL.*Model Not Exist/);
});

test('429 and 5xx are retried with backoff, then succeed', async () => {
  const fetchImpl = fakeFetch((n) => (n === 1 ? errResponse(429, {}) : n === 2 ? errResponse(503, {}) : okResponse('fine')));
  const logs = [];
  const c = createClient({ apiKey: KEY, fetchImpl, retries: 2, log: (m) => logs.push(m) });
  const res = await c.chat({ system: 's', user: 'u' });
  assert.equal(res.content, 'fine');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /rate limited.*retrying/);
});

test('gives up after the configured retries', async () => {
  const fetchImpl = fakeFetch(() => errResponse(500, { error: { message: 'boom' } }));
  const c = createClient({ apiKey: KEY, fetchImpl, retries: 1 });
  await assert.rejects(c.chat({ system: 's', user: 'u' }), /DeepSeek API 500/);
  assert.equal(fetchImpl.calls.length, 2);
});

test('network failure and timeout are reported clearly', async () => {
  const down = createClient({ apiKey: KEY, fetchImpl: async () => { throw new Error('ECONNREFUSED 127.0.0.1:1'); }, retries: 0 });
  await assert.rejects(down.chat({ system: 's', user: 'u' }), /Could not reach DeepSeek.*ECONNREFUSED/);
  const hang = createClient({
    apiKey: KEY, retries: 0, timeoutMs: 1000,
    fetchImpl: (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); }),
  });
  await assert.rejects(hang.chat({ system: 's', user: 'u' }), /timed out after 1000 ms/);
});

test('empty and malformed responses are errors', async () => {
  const empty = createClient({ apiKey: KEY, fetchImpl: fakeFetch(() => okResponse('   ')) });
  await assert.rejects(empty.chat({ system: 's', user: 'u' }), /empty completion/);
  const bad = createClient({ apiKey: KEY, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } }) });
  await assert.rejects(bad.chat({ system: 's', user: 'u' }), /non-JSON response/);
  assert.throws(() => createClient({ apiKey: '' }), /DEEPSEEK_API_KEY/);
});

test('parseJsonCompletion tolerates fences and prose, rejects garbage', () => {
  assert.deepEqual(parseJsonCompletion('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonCompletion('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonCompletion('Sure:\n{"a":{"b":[1,2]}}\nDone.'), { a: { b: [1, 2] } });
  assert.throws(() => parseJsonCompletion('no json here'), /valid JSON/);
  assert.equal(redact(`x ${KEY} y`, KEY), 'x [redacted] y');
});
