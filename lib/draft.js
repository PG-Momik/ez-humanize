'use strict';

const fs = require('fs');

class DraftError extends Error {}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
    if (typeof stream.resume === 'function') stream.resume();
  });
}

async function readDraft({ draftPath, stdin = process.stdin, log = () => {} }) {
  if (draftPath) {
    let text;
    try {
      text = fs.readFileSync(draftPath, 'utf8');
    } catch (err) {
      throw new DraftError(`Cannot read draft file ${draftPath}: ${err.message}`);
    }
    if (!text.trim()) throw new DraftError(`Draft file is empty: ${draftPath}`);
    return text;
  }
  if (stdin.isTTY) {
    log('Paste your draft below. When you are done, press Enter and then Ctrl+D.');
    log('');
  }
  const text = await readAll(stdin);
  if (!text.trim()) throw new DraftError('No draft received on stdin. Pass --draft <file> or paste text and finish with Ctrl+D.');
  if (stdin.isTTY) log(`\nReceived ${text.split('\n').length} lines.`);
  return text;
}

// ---------------------------------------------------------------------------
// Markdown structure

function normalizeTitle(t) {
  return String(t)
    .replace(/[*_`]/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A heading matches a required title when it equals it, or starts with it followed by a
// separator, so "Validation Notes / self check (field_self_check)" matches "Validation Notes".
function titleMatches(heading, required) {
  const h = normalizeTitle(heading);
  const r = normalizeTitle(required);
  return h === r || new RegExp(`^${escapeRe(r)}(?=[\\s/:,;-])`).test(h);
}

function matchTitle(heading, titles) {
  return titles.find((t) => titleMatches(heading, t)) || null;
}

function parseHeadings(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) fence = fm[1][0];
      else if (fm[1][0] === fence) fence = null;
      return;
    }
    const hm = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (hm) out.push({ line: i, level: hm[1].length, title: hm[2].trim() });
  });
  return { lines, headings: out };
}

// Splits a Markdown document into {preamble, sections:[{title, level, body}]} at headings
// up to `maxLevel`. Code fences are respected.
function splitSections(markdown, { maxLevel = 1 } = {}) {
  const { lines, headings } = parseHeadings(markdown);
  const cuts = headings.filter((h) => h.level <= maxLevel);
  const preamble = lines.slice(0, cuts.length ? cuts[0].line : lines.length).join('\n');
  const sections = cuts.map((h, i) => ({
    title: h.title,
    level: h.level,
    body: lines.slice(h.line + 1, i + 1 < cuts.length ? cuts[i + 1].line : lines.length).join('\n'),
  }));
  return { preamble, sections };
}

// Collects the bodies of the required sections, wherever they sit in the heading tree.
// A matched section's body runs until the next heading at the same or a shallower level,
// so its own sub-headings stay inside it, while sibling sections are kept apart.
// Returns { map: Map<requiredTitle, body>, matched: [{title, level}], preamble, extra: [titles] }.
function collectSections(markdown, titles) {
  const { lines, headings } = parseHeadings(markdown);
  const matched = headings.map((h) => ({ ...h, required: matchTitle(h.title, titles) })).filter((h) => h.required);
  const maxLevel = matched.length ? Math.max(...matched.map((h) => h.level)) : 1;
  const cuts = headings.filter((h) => h.level <= maxLevel);
  const map = new Map();
  const extra = [];
  const preamble = lines.slice(0, cuts.length ? cuts[0].line : lines.length).join('\n');
  cuts.forEach((h, i) => {
    const required = matchTitle(h.title, titles);
    if (!required) {
      // A deeper heading right after a matched section is part of that section.
      const prev = i > 0 ? cuts[i - 1] : null;
      if (!(prev && prev.absorbedInto && h.level > prev.absorbedLevel)) { extra.push(h.title); h.absorbedInto = null; return; }
      h.absorbedInto = prev.absorbedInto;
      h.absorbedLevel = prev.absorbedLevel;
      const body = lines.slice(h.line, i + 1 < cuts.length ? cuts[i + 1].line : lines.length).join('\n');
      map.set(h.absorbedInto, `${map.get(h.absorbedInto)}\n${body}`);
      return;
    }
    h.absorbedInto = required;
    h.absorbedLevel = h.level;
    const body = lines.slice(h.line + 1, i + 1 < cuts.length ? cuts[i + 1].line : lines.length).join('\n');
    map.set(required, map.has(required) ? `${map.get(required)}\n${body}` : body);
  });
  return { map, matched, preamble, extra, maxLevel };
}

// Finds which of the required section titles the draft contains (any heading level).
function findSections(markdown, required) {
  const { map } = collectSections(markdown, required);
  const found = required.filter((t) => map.has(t));
  const missing = required.filter((t) => !map.has(t));
  return { found, missing, structured: missing.length === 0 };
}

function stripOuterFence(text) {
  const t = String(text).trim();
  const m = t.match(/^(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/);
  return m ? m[2] : t;
}

function stripLeadingCommentary(text) {
  // Drop a lone "Here is the revised document:" style line before the first heading.
  return String(text).replace(/^\s*(?:here(?:'s| is) (?:the|your) (?:revised|edited|updated)[^\n]*:?\s*\n)+/i, '');
}

// Rebuilds the revision so that it has exactly the expected sections, in order.
// Strict mode (all required sections present in the original): exactly the required H1s.
// Loose mode: the original's own H1 set. Missing sections are restored from the original;
// text outside the sections is dropped.
function enforceStructure(revisedText, originalText, required) {
  const notes = [];
  const revised = stripLeadingCommentary(stripOuterFence(revisedText));
  const check = findSections(originalText, required);

  let titles;
  let origMap;
  let revMap;
  let revPreamble;
  let revExtra;
  if (check.structured) {
    titles = required;
    origMap = collectSections(originalText, required).map;
    const rev = collectSections(revised, required);
    revMap = rev.map;
    revPreamble = rev.preamble;
    revExtra = rev.extra;
  } else {
    const origParts = splitSections(originalText, { maxLevel: 1 });
    titles = origParts.sections.map((s) => s.title);
    if (titles.length === 0) return { text: revised.trim() + '\n', notes, strict: false };
    origMap = new Map(origParts.sections.map((s) => [s.title, s.body]));
    const rev = collectSections(revised, titles);
    revMap = rev.map;
    revPreamble = rev.preamble;
    revExtra = rev.extra;
    if (origParts.preamble.trim()) revPreamble = revPreamble.trim() || origParts.preamble;
  }

  const out = [];
  if (!check.structured && revPreamble && revPreamble.trim()) out.push(revPreamble.trim());
  else if (revPreamble && revPreamble.trim()) notes.push(`dropped ${revPreamble.trim().length} characters of text before the first section`);

  const restored = [];
  for (const title of titles) {
    let body = (revMap.get(title) || '').trim();
    if (!body) {
      body = (origMap.get(title) || '').trim();
      restored.push(title);
    }
    out.push(`# ${title}\n\n${body}`);
  }
  if (restored.length) notes.push(`restored original content for section(s) missing from the revision: ${restored.join(', ')}`);
  if (revExtra.length) notes.push(`dropped section(s) not present in the original: ${revExtra.join(', ')}`);

  return { text: out.join('\n\n').trim() + '\n', notes, strict: check.structured };
}

// Builds a clean document containing only the required sections as H1s, in order.
function extractSections(markdown, required) {
  const { map } = collectSections(markdown, required);
  return required.map((t) => `# ${t}\n\n${(map.get(t) || '').trim()}`).join('\n\n') + '\n';
}

function sectionSkeleton(required) {
  return required.map((t) => `# ${t}\n\n[Revised content for this section]`).join('\n\n');
}

module.exports = {
  DraftError,
  readDraft,
  readAll,
  splitSections,
  collectSections,
  titleMatches,
  findSections,
  extractSections,
  enforceStructure,
  stripOuterFence,
  normalizeTitle,
  sectionSkeleton,
};
