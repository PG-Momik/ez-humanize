# humanize

A small CLI that takes a draft you wrote about a coding-agent session and makes it read better, in your own voice. It runs a four-stage editing pipeline on DeepSeek, keeps your meaning and opinions intact, never touches the original file, and gives you a unified diff so you stay in control of the final text.

Plain Node.js, no dependencies.

## Install

Requires Node.js 20 or newer (it uses the built-in `fetch` and test runner).

```bash
git clone <this repo> humanize
cd humanize
chmod +x humanize.js        # already executable in the repo, harmless to repeat
npm test                    # optional: runs the offline test suite
```

There is nothing to `npm install`.

## Configure the DeepSeek API key

```bash
cp .env.example .env
```

Open `.env` and set `DEEPSEEK_API_KEY`. The key is read from `.env` in the current directory first, then from `.env` next to `humanize.js`, and a variable already exported in your shell always wins. The key is only ever sent in the `Authorization` header to the DeepSeek endpoint; it is never written to logs, the diff, the report, or the revised file, and any error body that echoes it is redacted.

Everything else in `.env.example` is optional and documented inline.

## Run

Paste the draft interactively:

```bash
./humanize.js session: ./transcript.jsonl
```

The tool prints a short summary of what it found in the session, then asks for your draft. Paste it, press Enter, then Ctrl+D.

Read the draft from a file:

```bash
./humanize.js session: ./session.jsonl --draft ./my-version.md
./humanize.js session: ./session.jsonl --draft ./my-version.md --output ./revised.md
```

What you get:

- `revised.md` (or whatever `--output` names): the revised document, as plain Markdown.
- `revised.diff`: a unified diff from your draft to the revision. It is also printed to stdout unless you pass `--no-diff`.
- Your draft, untouched. The tool refuses to write over an existing output or diff unless you pass `--force`, and it checks that before it spends any API calls.

Other flags: `--report <file>` saves the style profile, context analysis and review as JSON (useful when tuning prompts), `--prompts <dir>` points at another prompt set, `--help`.

Progress goes to stderr, the diff and the final summary to stdout, so `./humanize.js ... > out.txt` captures just the result.

A session is any JSONL transcript with one JSON record per line (user and assistant messages, tool calls and their output), as well as a plain JSON export — either an array of records, or an object with a `messages` array.

## How it works

1. **Style analysis.** DeepSeek reads your draft and writes a short profile: sentence length and variation, vocabulary, formality, tone, habits worth keeping, and sentences that already read well. The profile is used to preserve your voice, not to grade it.
2. **Context analysis.** The session is parsed locally into a digest: user messages, assistant text, shell commands with their recorded output, test runs with pass/fail parsed from the output, files edited, tool errors, compaction summaries. Every part is labelled as evidence (tool output) or claim (model text). DeepSeek then extracts the task, decisions, dead ends, verified outcomes, unverified claims, and checks your draft's statements against the session. A statement like "all tests pass" in the assistant's text is not evidence; only a recorded test command with its output is.
3. **Editing.** DeepSeek revises the draft with the profile and the context as references. The prompt tells it to leave good sentences alone, keep technical details verbatim, not add anything the session supports but you did not write, and not to introduce the usual machine-writing habits, nor fake "human" quirks.
4. **Review.** A separate pass compares original and revision statement by statement: changed meaning, invented content, technical drift, formality drift, generic phrasing, structure. High-severity findings trigger one repair round (configurable) followed by a re-review. Remaining problems are printed as warnings; the file is still written and the decision is yours.

After the editing and repair passes the tool normalises the document structure in code: if your draft has the four required sections, the output has exactly those four H1 headings in order, a section the model dropped is restored from your original, and anything outside the sections is removed. If your draft uses a different structure, its own H1 headings are preserved instead.

The required sections default to `High-Level Task Goal`, `Validation Notes`, `Decision Points`, `Difficulty & Codebase Understanding`. Change them with `HUMANIZE_SECTIONS` (separate titles with `|`).

## Modify the system prompts

All prompts live in `prompts/` as Markdown and are read at startup. No code changes needed.

| File | Used by |
| --- | --- |
| `style-analysis.md` | Stage 1, author profile (JSON) |
| `context-analysis.md` | Stage 2, session understanding (JSON) |
| `natural-editor.md` | Stage 3, the editing pass |
| `output-format.md` | Appended to the editor prompt when the draft has the required sections; `{{SECTION_SKELETON}}` is filled from `HUMANIZE_SECTIONS` |
| `quality-review.md` | Stage 4, the review (JSON) |
| `repair.md` | User message for the repair round; `{{ISSUES}}`, `{{ORIGINAL}}`, `{{REVISED}}` are filled in |

The JSON stages tell the model which keys to return. If you change a key name that the code reads (`draft_check`, `verdict`, `better_than_original`, `issues[].severity`, `issues[].type`, `issues[].section`, `issues[].revised_quote`, `issues[].problem`, `issues[].fix`, `summary`), update `lib/pipeline.js` as well. Everything else in those JSON objects is passed through to the next stage as-is, so you can add fields freely.

To try a different prompt set without touching the originals, copy the directory and point at it with `--prompts ./my-prompts` or `HUMANIZE_PROMPTS_DIR`.

## Change the DeepSeek model and settings

In `.env`:

```bash
DEEPSEEK_MODEL=deepseek-chat          # default
DEEPSEEK_TEMPERATURE=0.7              # editing and repair passes
DEEPSEEK_ANALYSIS_TEMPERATURE=0.2     # style, context and review passes
DEEPSEEK_MAX_TOKENS=8192              # per call
DEEPSEEK_TIMEOUT_MS=120000
DEEPSEEK_RETRIES=2                    # on 429, 5xx and network errors
HUMANIZE_CONTEXT_BUDGET=24000         # characters of session digest sent to the model
HUMANIZE_REPAIR_ROUNDS=1
```

`deepseek-reasoner` works too. It ignores temperature and JSON mode, so the tool sends neither and parses the JSON out of the text reply instead. Any OpenAI-compatible endpoint can be used by changing `DEEPSEEK_BASE_URL`.

## Testing

```bash
npm test
```

The suite is offline. It covers argument parsing, `.env` loading, session parsing (JSONL and JSON, malformed lines, noise records, test-result detection, claim checking, a 30,000-record session), draft input from a file and from stdin, section detection and structure enforcement, the unified diff, the DeepSeek client (JSON mode, retries, timeouts, 401/402/400 handling, key redaction) and every pipeline stage with scripted responses. The CLI tests run the real `humanize.js` against a local fake of the DeepSeek endpoint (`test/helpers/fake-deepseek.js`) and check that the original draft is byte-for-byte unchanged, that output files are never overwritten without `--force`, and that the key never appears in any output.

`test/fixtures/sample-session.jsonl` is **synthetic sample data** generated by `test/helpers/build-fixture.js`. It mirrors the record shapes of real agent-session exports but describes an invented task. `test/fixtures/sample-draft.md` is a matching invented write-up. Neither is real evaluation material; to evaluate writing quality, run the tool on your own sessions and drafts.

To see the whole pipeline run against the sample data with a real key:

```bash
./humanize.js session: test/fixtures/sample-session.jsonl --draft test/fixtures/sample-draft.md --output /tmp/sample-revised.md --report /tmp/sample-report.json
```

## Design notes

`docs/research-notes.md` summarises the reading on AI-text patterns and detection that shaped the prompts, and why the tool deliberately does not optimise against detectors.

## Limitations

- The session digest is budgeted (default 24k characters). Very long sessions are summarised by keeping the first and last items of each category in full and omitting the middle; the task statement, test results and errors are prioritised.
- Test-result detection is pattern based (pytest, jest, vitest, mocha, node --test, go test, cargo test, rspec and similar). Unrecognised runners show up as `unknown`.
- The reviewer is a model too. Read the diff.
