'use strict';

const path = require('path');

class ConfigError extends Error {}

const DEFAULT_SECTIONS = [
  'High-Level Task Goal',
  'Validation Notes',
  'Decision Points',
  'Difficulty & Codebase Understanding',
];

function num(env, key, def, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    throw new ConfigError(`${key} must be a ${integer ? 'whole ' : ''}number between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function buildConfig(env, { appDir }) {
  const sections = env.HUMANIZE_SECTIONS
    ? env.HUMANIZE_SECTIONS.split('|').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SECTIONS.slice();
  if (sections.length === 0) throw new ConfigError('HUMANIZE_SECTIONS must list at least one section');

  return {
    apiKey: (env.DEEPSEEK_API_KEY || '').trim(),
    model: (env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
    // 'disabled' | 'enabled' | '' (omit the parameter). Models such as deepseek-flash think
    // by default; 'disabled' turns that off and makes the call cheaper and faster.
    thinking: (env.DEEPSEEK_THINKING || '').trim().toLowerCase(),
    baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim(),
    temperature: num(env, 'DEEPSEEK_TEMPERATURE', 0.7, { min: 0, max: 2 }),
    analysisTemperature: num(env, 'DEEPSEEK_ANALYSIS_TEMPERATURE', 0.2, { min: 0, max: 2 }),
    maxTokens: num(env, 'DEEPSEEK_MAX_TOKENS', 8192, { min: 256, max: 131072, integer: true }),
    timeoutMs: num(env, 'DEEPSEEK_TIMEOUT_MS', 120000, { min: 1000, max: 3600000, integer: true }),
    retries: num(env, 'DEEPSEEK_RETRIES', 2, { min: 0, max: 10, integer: true }),
    contextBudget: num(env, 'HUMANIZE_CONTEXT_BUDGET', 24000, { min: 2000, max: 400000, integer: true }),
    repairRounds: num(env, 'HUMANIZE_REPAIR_ROUNDS', 1, { min: 0, max: 3, integer: true }),
    sections,
    promptsDir: env.HUMANIZE_PROMPTS_DIR ? path.resolve(env.HUMANIZE_PROMPTS_DIR) : path.join(appDir, 'prompts'),
  };
}

module.exports = { buildConfig, ConfigError, DEFAULT_SECTIONS };
