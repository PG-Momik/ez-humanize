'use strict';

const HELP = `humanize - natural-language writing engine backed by DeepSeek

Usage:
  humanize.js session: <session.jsonl>                     paste the draft, finish with Ctrl+D
  humanize.js session: <session.jsonl> --draft <draft.md>
  humanize.js session: <session.jsonl> --draft <draft.md> --output <revised.md>
  humanize.js --help

Options:
  session: <path>   Claude Code session export (.jsonl or .json).
                    Also accepted: session:<path>, --session <path>
  --draft <path>    Read the draft from a file instead of stdin
  --output <path>   Where to write the revised Markdown (default: revised.md).
                    A unified diff is written next to it as <name>.diff
  --report <path>   Also save the style profile, context analysis and review as JSON
  --force           Allow overwriting an existing output, diff or report file
  --no-diff         Do not print the unified diff to stdout (it is still saved)
  --prompts <dir>   Directory holding the system prompts (default: ./prompts)
  -h, --help        Show this help
  --version         Print the version

Configuration is read from the environment and from .env (current directory first,
then the tool's directory). See .env.example for every setting.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    session: null,
    draft: null,
    output: 'revised.md',
    report: null,
    prompts: null,
    force: false,
    diff: true,
    help: false,
    version: false,
  };

  const value = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && v.length > 1)) {
      throw new UsageError(`${name} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--version') opts.version = true;
    else if (a === 'session:' || a === '--session') { opts.session = value(i, a); i++; }
    else if (a.startsWith('session:')) opts.session = a.slice('session:'.length);
    else if (a.startsWith('--session=')) opts.session = a.slice('--session='.length);
    else if (a === '--draft' || a === '-d') { opts.draft = value(i, a); i++; }
    else if (a.startsWith('--draft=')) opts.draft = a.slice('--draft='.length);
    else if (a === '--output' || a === '-o') { opts.output = value(i, a); i++; }
    else if (a.startsWith('--output=')) opts.output = a.slice('--output='.length);
    else if (a === '--report') { opts.report = value(i, a); i++; }
    else if (a.startsWith('--report=')) opts.report = a.slice('--report='.length);
    else if (a === '--prompts') { opts.prompts = value(i, a); i++; }
    else if (a.startsWith('--prompts=')) opts.prompts = a.slice('--prompts='.length);
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--no-diff') opts.diff = false;
    else if (a.startsWith('-') && a.length > 1) throw new UsageError(`Unknown option: ${a}`);
    else throw new UsageError(`Unexpected argument "${a}". Did you mean: session: ${a}`);
  }

  if (opts.help || opts.version) return opts;
  if (opts.session === null) throw new UsageError('Missing session file. Usage: humanize.js session: <path>');
  if (opts.session === '') throw new UsageError('session: requires a path');
  if (!opts.output) throw new UsageError('--output requires a path');
  return opts;
}

module.exports = { parseArgs, HELP, UsageError };
