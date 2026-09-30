# BRIEF — observer cadence + watcher fd cap (claude-mem fork, branch `rasphiai/feat-observer-cadence`)

You are the lead of a herdr session in this git worktree of `irion94/claude-mem` (fork branch `baton`,
base 12.3.9-baton.2). Runtime: bun. Tests: `bun test` (compare against the base commit before blaming
a patch: the baseline has pre-existing failures). Build: `bun run build` (bundles into `plugin/scripts/`).
**Do NOT deploy**: no `claude plugin update`, no worker restart, no edits under `~/.claude-mem/` or
`~/.claude/plugins/`. The operator deploys after reading your RESULT.md. **TRAP:** `bun test` in a repo
checkout can spawn a REAL daemon worker that hijacks port 37777 (the live worker). After the suite run
`pgrep -fl worker-service.cjs` and kill only processes whose path is THIS worktree.

Language: code, comments, commits and RESULT.md in English. Conventional commits, one line < 76 chars.

## Why (context)

The observer lane now runs on a local model (oMLX Qwen 9B) through a stateless shim; the cap and the
per-batch instructions live in the shim. What is still wrong is the CADENCE in the worker: too many
LLM calls, and one fd leak that killed the lane for a day. Evidence:
`~/baton/docs/baton/research/2026-09-29-claude-mem-local-observer-probe.md` and issue irion94/baton#566.
User ruling (Tom, 2026-09-29): summary only at session end is acceptable ("4 - to nie problem").

## Tasks (in this order; each = tests first, then code, then a commit)

### T1. Summary only at session end
Today `Stop` → `POST /api/sessions/summarize` → one LLM call per assistant stop (~100/day).
Add setting `CLAUDE_MEM_SUMMARY_CADENCE` = `every-stop` (current behaviour, default for upstream
compatibility) | `session-end`. In `session-end` mode a summarize request does NOT start a generator;
it only marks the session as "summary wanted". The summary is generated once, when the session is
flushed for exit/end (find the exit path: `flushSession(…, 'exit'…)` / session cleanup) or when the
session has been idle longer than `CLAUDE_MEM_SUMMARY_IDLE_SEC` (default 1800). Anchors:
`src/services/worker/http/routes/SessionRoutes.ts` (`handleSummarize`, `handleSummarizeByClaudeId`,
`ensureGeneratorRunning(…, 'summarize')`), `src/services/worker/SessionManager.ts`,
`src/shared/SettingsDefaultsManager.ts`. Keep `CLAUDE_MEM_SUMMARY_MODE` (batched|immediate) working.

### T2. Remove the "new session flushes every idle session" floor
Find the code path that, on every new session init, calls flush for all OTHER idle sessions
(`flushSession(<other>, 'new', …)` or similar in SessionRoutes/SessionManager; the 'startup' flush at
`src/services/worker-service.ts:1125` is a different, acceptable one-shot). Put it behind
`CLAUDE_MEM_FLUSH_ON_NEW_SESSION` (default `true` for compatibility; the operator will set `false`).
With it off, idle sessions must still flush by the age timer (`CLAUDE_MEM_BATCH_MAX_AGE_SEC`) — prove
that with a test.

### T3. Byte budget for a batch
`getBatchConfig()` in `src/services/worker/SessionManager.ts` flushes on `maxMessages` or `maxAgeMs`.
Add `CLAUDE_MEM_BATCH_MAX_BYTES` (default 200000 chars, sum of `tool_input` + `tool_response` of the
pending messages of the session): when the pending bytes exceed it, flush now even if fewer than
`maxMessages` are queued; and a single message larger than the budget flushes alone. Measured need:
20-40-event batches reach 40k tokens; p50 event is 2.9 KB, avg 12.7 KB, max 635 KB.

### T4. Transcript watcher: age filter + tailer cap (issue irion94/baton#566)
`src/services/transcripts/watcher.ts`: `setupWatch` tails EVERY file `resolveWatchFiles` returns with a
persistent `fsWatch` (one fd per file, 10 212 Codex rollouts on the Studio → fd exhaustion, observer lane
silent for a day). Add `CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS` (default 48): only files with mtime inside
the window get a tailer; on each rescan close tailers whose file mtime fell outside the window
(`tailer.close()`, delete from the map); hard cap `CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS` (default 512) with
a `logger.warn`. Test: 1 000 stale files + 1 fresh → exactly 1 tailer; a fresh file aging past the
window is closed on rescan.

### T5. Version + docs
Bump the plugin to `12.3.9-baton.3` in both manifests the way the repo does it (see
`scripts/sync-plugin-manifests.js` and the previous release commit `864990a9`), and document the four
new settings in the settings defaults comments. Run `bun run build` and confirm `plugin/scripts/` is
rebuilt (do not commit build artefacts unless the repo already tracks them; check `git status`).

## How to work
- Split if useful: helpers are `herdr` agents in your own workspace (`--model haiku
  --dangerously-skip-permissions` for sweeps/tests, Opus for code). Round cap: 3 review rounds per task.
- Each task: failing test → implementation → `bun test <file>` green → full `bun test` not worse than
  the base commit (record base tally first) → commit.
- Do not touch `src/sdk/prompts.ts` wording or the ResponseProcessor contract.

## Hand-back contract
Write `RESULT.md` in this directory: per task — commit sha, test files, tally before/after, deviations
from this brief with reasons, and the exact operator deploy steps + settings values to flip
(`CLAUDE_MEM_SUMMARY_CADENCE=session-end`, `CLAUDE_MEM_FLUSH_ON_NEW_SESSION=false`,
`CLAUDE_MEM_BATCH_MAX_BYTES`, `CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS`). Push the branch
`rasphiai/feat-observer-cadence` to `origin` and open a PR against `baton` (title conventional, body =
RESULT.md summary; end the body with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`).
Do NOT merge. Finish your last message with the single word: CADENCE-DONE
