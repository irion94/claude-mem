# oMLX observer shim

`plugin/scripts/omlx-claude-shim.py` lets the claude-mem observer run on a local
model. The worker spawns it as if it were the `claude` CLI. The shim speaks the
stream-json contract on stdin/stdout and answers each turn through an
OpenAI-compatible oMLX server (`/v1/chat/completions`). It is Python 3 stdlib
only, has no tools and no permission surface: text in, text out.

The shim ships inside the plugin, so it lands in the plugin cache with every
`claude plugin update`. No manual copy is needed.

## Turn classification

Turns are stateless. No message history is sent to the model.

| Turn | Detected by | What the shim does |
| --- | --- | --- |
| init | no `<what_happened>`, no summary marker, no saved instructions | Saves the prompt as the session's instructions, replies with empty text, no HTTP |
| continuation | same as init, instructions already saved | Replies with empty text, no HTTP |
| observation | contains `<what_happened>` | One call: saved instructions + the turn prompt. Reply keeps only complete `<observation>` blocks |
| summary | contains `--- MODE SWITCH: PROGRESS SUMMARY` | One call with the prompt alone (no instructions). Reply is the `<summary>` block |
| mixed | tool events followed by the summary marker | Two calls. Call 1 = instructions + the observation part. Call 2 = the FULL prompt bare, because the summary needs the tool events. Reply = observations, then summary |

Details that matter when reading replies:

- Empty text is a valid skip for the worker. Prose is never forwarded, since
  the worker marks non-XML replies as failed and retries them.
- A summary turn falls back to `<observation>` blocks (the worker coerces them
  into a summary), then to `<skip_summary .../>` after two attempts.
- `<outcome>` and `<parameters>` bodies are capped at the field cap before sending.
- Instructions are stored per session in `<data>/omlx-shim-state/<session_id>.json`.
  `<data>` is `$CLAUDE_MEM_DATA_DIR` or `~/.claude-mem`.

## Settings

Put these in `~/.claude-mem/settings.json`. Environment variables override the
file, and the file is read on every call.

| Key | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_CODE_PATH` | (empty) | Set to `@plugin/omlx-claude-shim.py` to use the shim from the installed plugin |
| `CLAUDE_MEM_OMLX_ENDPOINTS` | `http://127.0.0.1:8400` | Comma-separated base URLs. Tried in order, next one on connection error or 5xx |
| `CLAUDE_MEM_OMLX_MODEL` | `Qwen3.5-9B-MLX-4bit` | Model name sent to oMLX |
| `CLAUDE_MEM_OMLX_API_KEY` | (empty) | Sent as `Authorization: Bearer`. Never logged |
| `CLAUDE_MEM_OMLX_MAX_TOKENS` | `3200` | `max_tokens` per call |
| `CLAUDE_MEM_OMLX_FIELD_CAP` | `4000` | Max characters kept in each `<outcome>`/`<parameters>` body |
| `CLAUDE_MEM_OMLX_TIMEOUT_SECONDS` | `600` | HTTP timeout per call |

`@plugin/` is resolved by the worker against the directory of its own bundle,
which is the plugin's `scripts/` directory. The setting therefore keeps working
across plugin version bumps. Any other `CLAUDE_CODE_PATH` value is used as is.

## oMLX requirements

- **Non-loopback bind needs a key.** oMLX only starts on `0.0.0.0` with
  `auth.api_key` set. Mirror that key into `CLAUDE_MEM_OMLX_API_KEY` on every
  machine that calls it.
- **macOS application firewall.** The firewall must allow the Python binary
  that runs oMLX. Otherwise TCP connects but no bytes come back. Allow it with
  `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add <python binary>`
  and `--unblockapp <python binary>`.
- The shim never sends a system role. Gemma and Qwen chat templates double
  system content, so everything rides in one user message.

## Log

The shim appends to `<data>/logs/omlx-shim.log`. Each turn writes one line:

```
2026-10-01T10:00:00 [12345] turn session=<sid> kind=observation endpoint=http://127.0.0.1:8400 error=False ms=4210 in=5120 out=380 cached=0 finish=stop obs=2 len=1450 sanitized=False coerced=False
```

For `kind=mixed` the fields combine both calls:

- `endpoint` is one URL, or `obsURL,sumURL` when the calls used different endpoints.
- `finish` is `<observation finish>/<summary finish>`.
- `in`, `out` and `cached` are sums of both calls. `obs` counts the observation call only.
- Two extra fields follow: `obs_error=<bool> sum_error=<bool>`.

Other line kinds: `start`, `eof`, `omlx-http-error`, `omlx-error`,
`summary-coerce`, `summary-skip`, `mixed-part-error`, `state-error` and
`stdin-*`. Errors and summary skips also raise a macOS notification. Set
`OMLX_SHIM_NOTIFY=0` to turn that off.

## Tests

The suite is bash 3.2-safe and runs the shim against a fake HTTP server. It
needs only `bash` and `python3`.

```
bash tools/omlx-shim/tests/omlx-shim.test.sh
```

It tests `plugin/scripts/omlx-claude-shim.py` by default. Set `OMLX_SHIM` to
test another copy. The last line reports `PASS=<n> FAIL=<n>`.

## Deploy

1. Update the marketplace and the plugin:
   ```
   claude plugin marketplace update irion94
   claude plugin update claude-mem@irion94
   ```
   Confirm that `~/.claude/plugins/cache/irion94/claude-mem/<version>/scripts/omlx-claude-shim.py` exists.
2. Write the settings above into `~/.claude-mem/settings.json`, with
   `"CLAUDE_CODE_PATH": "@plugin/omlx-claude-shim.py"`.
3. Restart the worker with the login-shell `PATH`. A short `PATH` makes the
   worker resolve the wrong tools.
   ```
   PATH="$($SHELL -lc 'echo $PATH')" bun ~/.claude/plugins/cache/irion94/claude-mem/<version>/scripts/worker-service.cjs restart
   ```
4. Watch `~/.claude-mem/logs/omlx-shim.log` for `turn` lines with `error=False`.
