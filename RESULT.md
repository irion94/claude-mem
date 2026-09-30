# RESULT: observer cadence + watcher fd cap (`rasphiai/feat-observer-cadence`)

Base: `ee8000bd` (12.3.9-baton.2 + BRIEF). All four new behaviours are opt-in or have
defaults that keep upstream behaviour, except the watcher limits (T4). Those are on by
default because they fix the fd leak.

## Test tally

| Run | pass | skip | fail | files |
|---|---|---|---|---|
| Base `ee8000bd` (`bun test`) | 1488 | 3 | 31 | 108 |
| After T1-T5 + review fixes (`bun test`) | 1514 | 3 | 31 | 109 |

The 31 failures are the same set as on the base, compared by test name, with 0 new
failures. The base failures include `Version Consistency` (2),
`settings-defaults-manager` (port 37777 vs the uid-based default),
`logger-usage-standards` and `ResponseProcessor circuit breaker`.
The +26 passes are the new tests.

## Tasks

### T1: summary only at session end: `32abfa8a` + `5376cb84`
- Test: `tests/services/worker/session-batching.test.ts` (`SUMMARY_CADENCE` block, 11 tests).
- `CLAUDE_MEM_SUMMARY_CADENCE` = `every-stop` (default, unchanged) | `session-end`.
  `CLAUDE_MEM_SUMMARY_IDLE_SEC` defaults to `1800`, and `0` means exit only.
- In `session-end` mode, `queueSummarize` returns `'deferred'`. It sets `summaryRequested` and
  `lastAssistantMessage`, but enqueues no row and requests no flush. Both summarize routes
  then answer `{status:'deferred'}` and do **not** call `ensureGeneratorRunning`.
- The deferred summary becomes one durable summarize row, carrying the latest assistant
  message, in these cases:
  - **exit:** `flushAndWait(…, 'exit')`. This is the SessionEnd path through
    `/api/sessions/complete` and `completeByDbId`, and it is also used by the Codex
    transcript `handleSessionEnd`.
  - **idle:** after `SUMMARY_IDLE_SEC` without activity. The timer is re-armed by every
    Stop and every observation, and the flush reason is the new value `idle`.
  - **shutdown:** `shutdownAll` persists the row so the next worker's `startup` flush
    produces the summary.
- The reaper (`reapStaleSessions`) skips sessions with a deferred summary. Without this, the
  15-minute reaper would drop them before the 30-minute idle trigger fired.
- `5376cb84` (from review) protects the deferred summary on generator exit. The 3-minute
  generator idle exit used to finalize and remove the session, taking the summary with
  it. This happened in `WorkerService` `terminateSession('idle_timeout')` and in the
  `SessionRoutes` self-clean after a stored summary. Both now keep the session while
  `hasDeferredSummary()` is true.
- `CLAUDE_MEM_SUMMARY_MODE` (batched | immediate) is untouched. `session-end` bypasses it,
  because exit and idle always flush right away.

### T2: new-session flush floor: `2d4da8bd` (plus test fix `55d86eb1`)
- Test: `session-batching.test.ts` › `FLUSH_ON_NEW_SESSION=false leaves idle sessions to their age timer`.
  With the flag off, a new session does not flush the idle one, its age timer stays armed,
  and firing it flushes with reason `age`.
- `CLAUDE_MEM_FLUSH_ON_NEW_SESSION` defaults to `true`. `false` skips the `'new'` loop in
  `SessionManager.initializeSession`. The `startup` flush in `worker-service.ts` is unchanged.
- `55d86eb1` relaxes one delay assertion that could be off by one tick: pending rows are
  stamped with the real clock, the fixture uses a fake one.

### T3: byte budget: `af284fc7`
- Test: `session-batching.test.ts` (`BATCH_MAX_BYTES` block, 5 tests).
- `CLAUDE_MEM_BATCH_MAX_BYTES` defaults to `200000` chars, counted as the sum of
  `LENGTH(tool_input) + LENGTH(tool_response)` of pending rows.
- **Trigger:** when pending bytes exceed the budget, the batch flushes right away with
  reason `bytes`, even below `MAX_MESSAGES`.
- **Cap per batch:** `claimPendingBatch(id, limit, maxBytes)` stops before the message that
  would go over the budget, but always claims at least one. A message larger than the
  budget therefore goes out alone. Any rest left over by a truncated claim is flushed again
  with the same reason once the batch is processed (`truncatedFlushes`). This way an
  `exit` flush still drains completely.

### T4: transcript watcher age filter + tailer cap: `86555ac0` + `d0610634` + `70e572d5`
- Test: `tests/services/transcripts/watcher.test.ts` (9 tests). It covers 1 000 stale files
  plus 1 fresh file giving exactly 1 tailer, a fresh file aging out being closed on rescan,
  the cap keeping the freshest files, the warning deduplication, the resume offset for a
  startup file, and the `0`/unparsable settings values.
- `CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS` defaults to `48`. `0` or a negative value disables
  the filter, and an unparsable value falls back to 48.
- `CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS` defaults to `512`. A value below 1 or unparsable
  falls back to 512.
- Each rescan computes the target set (fresh files, freshest first, up to the cap), closes
  tailers outside it and opens the missing ones.
- `70e572d5` (from review) makes two changes:
  - Tailers are tracked per watch, so the tailer of a **deleted** file is now closed on
    rescan and frees its slot. Before this it leaked an fd and held a cap slot.
  - The persisted offset stops before a trailing partial line, so an evicted and later
    re-added tailer re-reads the line instead of losing it.

### T5: version + docs: `a17d38a7` + final rebuild commit
- Both baton manifests are bumped to `12.3.9-baton.3` (`.claude-plugin/marketplace.json`,
  `plugin/.claude-plugin/plugin.json`), the same way as `864990a9`. `package.json` stays
  at `12.3.9`, so the pre-existing `Version Consistency` failure is unchanged.
- The new settings are documented in the `SettingsDefaultsManager` comments (interface and
  defaults) and in `docs/public/configuration.mdx`.
- `bun run build` passes. The rebuilt `plugin/scripts/{worker-service,mcp-server,context-generator}.cjs`
  and `plugin/ui/viewer-bundle.js` are committed, because the repo tracks them (as in `864990a9`).

## Deviations from the brief

1. **T1 deferred state is in memory.** If the worker crashes (not a graceful shutdown)
   while a summary is deferred, that summary is lost. A graceful shutdown persists it.
   Tom accepted "summary at session end" and a lost summary is not a lost observation,
   so I did not add a DB status.
2. **T1 idle timer counts real activity.** It re-arms on every Stop *and* every
   observation, so "idle" means no activity at all rather than time since the last Stop.
3. **T1 new flush reason `idle` and T3 new flush reason `bytes`.** These extend the
   `FlushReason` union. They are only logged (`FLUSH reason=…`), and the ResponseProcessor
   contract is untouched.
4. **T4 evicts older tailers instead of refusing new ones at the cap.** Otherwise a
   brand-new session would be ignored for up to 48 h once the cap filled.
   `startAtEnd` now resumes a file present at startup from its **size at startup**. The
   helper's first version used the size at the moment it was tailed, which dropped the
   append that made the file fresh again (covered by a test). The cap warning fires only
   when the skipped count changes, not every 5 s.
5. **T4 log calls use the `WORKER` component, not `TRANSCRIPT`.** `TRANSCRIPT` is not in
   the logger's `Component` type (pre-existing type errors).
6. **Helpers.** T4 was implemented by a helper agent in an isolated worktree and
   cherry-picked (`3a7b9828` became `86555ac0`), then I reviewed it and fixed it in
   `d0610634`. I did T1-T3 myself, because all three edit `SessionManager`.

## Known, not changed

- **Sessions over the wall-clock limit get no summary (review finding, session-end
  only).** `ensureGeneratorRunning` refuses sessions older than
  `CLAUDE_MEM_SESSION_MAX_AGE_HOURS` (default 4) and abandons their pending rows. In
  `session-end` mode, a session that runs past that limit without a 30-minute idle gap
  therefore gets no summary, while `every-stop` still summarized its first hours.
  Mitigation: set `CLAUDE_MEM_SESSION_MAX_AGE_HOURS` high (for example `48`) or `0`.
  The guard is a pre-existing spend limit, so I left it alone.
- **Queue stall on a non-XML model reply (review finding, pre-existing).**
  `ResponseProcessor` returns early on a non-XML reply without calling
  `notifyQueueProcessed`, so a byte-truncated flush does not continue until the stale
  `processing` rows are reset by the next claim. A long exit drain with several batches
  can also exceed the 30 s `flushAndWait` timeout. `/complete` then returns an error, but
  the rows remain pending and nothing is lost. I did not change this, because the brief
  forbids touching the ResponseProcessor contract.
- **The suite restarts the live worker.** Both full `bun test` runs killed the live worker
  on :37777; a hook respawned it from the plugin cache (`12.3.9-baton.2`) within about a
  minute. The suspects are `tests/infrastructure/{graceful-shutdown,process-manager}.test.ts`,
  which read and write the real `~/.claude-mem/worker.pid` via `homedir()`. After the
  runs, no `worker-service.cjs` process from this worktree was running.
- **Watcher: rescan stat cost.** Each rescan stats every globbed file, about 10k files
  every 5 s on the Studio. This is cheap next to 10k open fds, but worth knowing.

## Operator deploy steps

1. Review and merge the PR into `baton`.
2. Update the installed plugin from the irion94 marketplace, for example
   `claude plugin marketplace update irion94 && claude plugin update claude-mem@irion94`.
   Then confirm that `~/.claude/plugins/cache/irion94/claude-mem/12.3.9-baton.3/` exists.
3. Add to `~/.claude-mem/settings.json`:
   ```json
   "CLAUDE_MEM_SESSION_MAX_AGE_HOURS": "48",
   "CLAUDE_MEM_SUMMARY_CADENCE": "session-end",
   "CLAUDE_MEM_SUMMARY_IDLE_SEC": "1800",
   "CLAUDE_MEM_FLUSH_ON_NEW_SESSION": "false",
   "CLAUDE_MEM_BATCH_MAX_BYTES": "200000",
   "CLAUDE_MEM_TRANSCRIPTS_MAX_AGE_HOURS": "48",
   "CLAUDE_MEM_TRANSCRIPTS_MAX_TAILERS": "512"
   ```
   `SESSION_MAX_AGE_HOURS` is only needed if it is not already raised (see Known).
   The last four are the defaults, written out so they are visible. Lower
   `BATCH_MAX_BYTES` (for example `120000`) if 200k chars still overflows the oMLX
   context.
4. Restart the worker:
   `bun ~/.claude/plugins/cache/irion94/claude-mem/12.3.9-baton.3/scripts/worker-service.cjs restart`.
5. Verify:
   - `lsof -p $(pgrep -f worker-service.cjs) | wc -l` stays in the hundreds, not about 10k.
   - `~/.claude-mem/logs` shows `DEFERRED | … cadence=session-end` on Stop,
     `FLUSH reason=exit … summary=true` on SessionEnd, and no `reason=new` flushes.
