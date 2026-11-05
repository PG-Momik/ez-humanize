'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDotenv, loadEnv } = require('../lib/env');
const { buildConfig, ConfigError } = require('../lib/config');

test('parseDotenv handles comments, quotes, export and inline comments', () => {
  const env = parseDotenv([
    '# comment',
    'DEEPSEEK_API_KEY=sk-123',
    'export DEEPSEEK_MODEL="deepseek-chat"',
    "QUOTED='a # not a comment'",
    'INLINE=value # comment',
    'EMPTY=',
    'bad line',
    '=novalue',
  ].join('\n'));
  assert.deepEqual(env, { DEEPSEEK_API_KEY: 'sk-123', DEEPSEEK_MODEL: 'deepseek-chat', QUOTED: 'a # not a comment', INLINE: 'value', EMPTY: '' });
});

test('loadEnv never overrides existing variables and uses the first file that sets a key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanize-env-'));
  const a = path.join(dir, 'a.env');
  const b = path.join(dir, 'b.env');
  fs.writeFileSync(a, 'X=from-a\nY=from-a\n');
  fs.writeFileSync(b, 'Y=from-b\nZ=from-b\n');
  const env = { X: 'preset' };
  const loaded = loadEnv({ paths: [path.join(dir, 'missing.env'), a, b], env });
  assert.deepEqual(loaded, [a, b]);
  assert.deepEqual(env, { X: 'preset', Y: 'from-a', Z: 'from-b' });
});

test('buildConfig defaults and validation', () => {
  const c = buildConfig({ DEEPSEEK_API_KEY: 'k' }, { appDir: '/app' });
  assert.equal(c.model, 'deepseek-chat');
  assert.equal(c.baseUrl, 'https://api.deepseek.com');
  assert.equal(c.temperature, 0.7);
  assert.equal(c.sections.length, 4);
  assert.equal(c.promptsDir, path.join('/app', 'prompts'));
  const custom = buildConfig({ DEEPSEEK_TEMPERATURE: '0.3', HUMANIZE_SECTIONS: 'A | B', DEEPSEEK_MAX_TOKENS: '4000' }, { appDir: '/app' });
  assert.deepEqual(custom.sections, ['A', 'B']);
  assert.equal(custom.temperature, 0.3);
  assert.equal(custom.maxTokens, 4000);
  assert.throws(() => buildConfig({ DEEPSEEK_TEMPERATURE: 'hot' }, { appDir: '/app' }), ConfigError);
  assert.throws(() => buildConfig({ DEEPSEEK_MAX_TOKENS: '12.5' }, { appDir: '/app' }), /whole number/);
  assert.throws(() => buildConfig({ DEEPSEEK_TIMEOUT_MS: '5' }, { appDir: '/app' }), ConfigError);
});
