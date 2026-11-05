'use strict';

const fs = require('fs');
const path = require('path');

class PromptError extends Error {}

const PROMPT_FILES = {
  styleAnalysis: 'style-analysis.md',
  contextAnalysis: 'context-analysis.md',
  naturalEditor: 'natural-editor.md',
  qualityReview: 'quality-review.md',
  outputFormat: 'output-format.md',
  repair: 'repair.md',
};

function loadPrompts(dir) {
  const prompts = {};
  const missing = [];
  for (const [key, file] of Object.entries(PROMPT_FILES)) {
    const p = path.join(dir, file);
    try {
      const text = fs.readFileSync(p, 'utf8');
      if (!text.trim()) throw new PromptError(`Prompt file is empty: ${p}`);
      prompts[key] = text.trim();
    } catch (err) {
      if (err instanceof PromptError) throw err;
      missing.push(file);
    }
  }
  if (missing.length) {
    throw new PromptError(`Missing prompt file(s) in ${dir}: ${missing.join(', ')}`);
  }
  return prompts;
}

// Replaces {{NAME}} placeholders. Unknown placeholders are left as they are so a
// typo in a prompt is visible rather than silently blank.
function render(template, vars) {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

module.exports = { loadPrompts, render, PromptError, PROMPT_FILES };
