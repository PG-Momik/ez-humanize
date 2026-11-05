'use strict';

const fs = require('fs');

// Minimal .env parser: KEY=VALUE, optional "export", quotes, # comments.
function parseDotenv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    } else if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

// Loads the first existing files in order. Never overrides variables that are
// already set, so the shell environment wins over .env, and an earlier .env
// wins over a later one.
function loadEnv({ paths, env = process.env }) {
  const loaded = [];
  for (const p of paths) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseDotenv(text);
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in env)) env[k] = v;
    }
    loaded.push(p);
  }
  return loaded;
}

module.exports = { parseDotenv, loadEnv };
