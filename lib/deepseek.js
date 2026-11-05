'use strict';

class DeepSeekError extends Error {
  constructor(message, { status = null, retryable = false, cause = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function describeStatus(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = (parsed && parsed.error && (parsed.error.message || parsed.error)) || parsed.message || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = String(bodyText || '').slice(0, 300);
  }
  const hints = {
    400: 'invalid request (check DEEPSEEK_MODEL and DEEPSEEK_MAX_TOKENS)',
    401: 'authentication failed; check DEEPSEEK_API_KEY',
    402: 'insufficient balance on the DeepSeek account',
    404: 'endpoint not found; check DEEPSEEK_BASE_URL',
    422: 'invalid parameters',
    429: 'rate limited',
    500: 'server error',
    503: 'server overloaded',
  };
  const hint = hints[status] || 'request failed';
  return `DeepSeek API ${status}: ${hint}${detail ? ` (${detail.trim()})` : ''}`;
}

// Strips any accidental occurrence of the key from text destined for logs/errors.
function redact(text, apiKey) {
  if (!apiKey || !text) return text;
  return String(text).split(apiKey).join('[redacted]');
}

function createClient({
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-chat',
  thinking = '',
  timeoutMs = 120000,
  retries = 2,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
  if (!apiKey) throw new DeepSeekError('DEEPSEEK_API_KEY is not set');
  if (typeof fetchImpl !== 'function') throw new DeepSeekError('global fetch is not available; use Node 18 or newer');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };

  async function chat({ system, user, temperature = 0.7, maxTokens = 4096, json = false, model: modelOverride }) {
    const useModel = modelOverride || model;
    const reasoner = /reasoner/i.test(useModel);
    const body = {
      model: useModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      stream: false,
    };
    if (!reasoner) {
      body.temperature = temperature;
      if (json) body.response_format = { type: 'json_object' };
    }
    if (thinking === 'disabled' || thinking === 'enabled') body.thinking = { type: thinking };
    const payload = JSON.stringify(body);

    let attempt = 0;
    for (;;) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      let failure = null;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = err && (err.name === 'AbortError' || controller.signal.aborted);
        failure = new DeepSeekError(
          timedOut
            ? `DeepSeek request timed out after ${timeoutMs} ms (raise DEEPSEEK_TIMEOUT_MS)`
            : `Could not reach DeepSeek at ${url}: ${redact(err && err.message, apiKey)}`,
          { retryable: true, cause: err },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!failure) {
        if (res.ok) {
          let data;
          try {
            data = await res.json();
          } catch (err) {
            throw new DeepSeekError(`DeepSeek returned a non-JSON response: ${redact(err.message, apiKey)}`);
          }
          const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
          const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
          if (!content.trim()) throw new DeepSeekError('DeepSeek returned an empty completion');
          usage.calls++;
          if (data.usage) {
            usage.promptTokens += data.usage.prompt_tokens || 0;
            usage.completionTokens += data.usage.completion_tokens || 0;
          }
          return {
            content,
            finishReason: choice.finish_reason || null,
            usage: data.usage || null,
            model: data.model || useModel,
          };
        }
        const bodyText = redact(await res.text().catch(() => ''), apiKey);
        failure = new DeepSeekError(describeStatus(res.status, bodyText), {
          status: res.status,
          retryable: RETRYABLE_STATUS.has(res.status),
        });
      }

      if (!failure.retryable || attempt > retries) throw failure;
      const wait = Math.min(8000, 1000 * 2 ** (attempt - 1));
      log(`${failure.message}; retrying in ${wait / 1000}s (${attempt}/${retries})`);
      await sleep(wait);
    }
  }

  return { chat, usage, url, model };
}

// Pulls a JSON object out of a completion, tolerating code fences and stray prose.
function parseJsonCompletion(text) {
  const t = String(text).trim();
  const candidates = [t];
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  let lastErr = null;
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new DeepSeekError(`Model did not return valid JSON${lastErr ? ` (${lastErr.message})` : ''}`);
}

module.exports = { createClient, parseJsonCompletion, DeepSeekError, redact };
