#!/usr/bin/env python3
"""claude-mem observer shim: speaks the claude CLI stream-json contract on
stdin/stdout, but answers every turn through a local oMLX server (Apple
Silicon MLX inference, OpenAI-compatible /v1/chat/completions), so the whole
claude-mem lane runs on a local model instead of any cloud quota.

Wiring: CLAUDE_CODE_PATH in ~/.claude-mem/settings.json points here.
State:  <data>/omlx-shim-state/<session_id>.json (stored instructions only)
Log:    <data>/logs/omlx-shim.log
<data> = $CLAUDE_MEM_DATA_DIR or ~/.claude-mem.
Sibling: agy-claude-shim.py (Gemini/agy backend) — same contract, kept as
rollback target.

The worker treats this as the claude binary and passes flags like
--output-format stream-json --input-format stream-json --verbose --model
--allowedTools --disallowedTools --permission-mode --resume <sid>.
Only --resume is honoured; the rest are consumed.

Stateless turns (probe 2026-09-29, baton docs/baton/research/
2026-09-29-claude-mem-local-observer-probe.md): no message history is sent.
The session's init/continuation prompt (carries <user_request>, no
<what_happened>) is stored once as `instructions` and answered locally with
empty text; every tool-event turn is one request of instructions + "\\n\\n"
+ the turn prompt, a summary turn is the summary prompt alone (it is
self-contained), both with <outcome>/<parameters> capped. A session-end
flush sends observations + summary as ONE prompt (kind=mixed): it is split
at the first line starting with SUMMARY_SPLIT: call 1 = instructions + the
observation part, call 2 = the FULL prompt bare (the summary needs the tool
events as context); the reply is observations then summary.

Worker reply contract (claude-mem ResponseProcessor): empty text = valid
skip; non-empty text without <observation>/<summary>/<skip_summary is marked
failed and retried, so prose never leaves this shim. Summary turns reply with
a <summary> block, else complete <observation> blocks (the worker coerces
them into a summary), else <skip_summary .../>.

Settings (env overrides settings.json, read per call):
CLAUDE_MEM_OMLX_MODEL, CLAUDE_MEM_OMLX_ENDPOINTS (comma-separated base URLs),
CLAUDE_MEM_OMLX_MAX_TOKENS, CLAUDE_MEM_OMLX_FIELD_CAP,
CLAUDE_MEM_OMLX_TIMEOUT_SECONDS, CLAUDE_MEM_OMLX_API_KEY (optional; sent as
`Authorization: Bearer`, needed when oMLX binds beyond localhost; never logged).

Security posture: pure text-in/text-out HTTP — no CLI, no tools, no
permission surface at all. Hostile transcript chunks have nothing to drive.

Known landmines:
- Gemma/Qwen chat templates double system-role content (2x prefill), so this
  shim never sends a system role; everything rides in one user turn.
- oMLX `sampling.max_context_window` caps request context; the field cap
  keeps single tool events from blowing it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DATA_DIR = Path(os.environ.get("CLAUDE_MEM_DATA_DIR", str(Path.home() / ".claude-mem")))
SETTINGS_PATH = DATA_DIR / "settings.json"
STATE_DIR = DATA_DIR / "omlx-shim-state"
LOG_PATH = DATA_DIR / "logs" / "omlx-shim.log"

INSTRUCTIONS_CAP = 12000
SUMMARY_MARKER = "MODE SWITCH: PROGRESS SUMMARY"
EVENT_MARKER = "<what_happened>"
SUMMARY_SPLIT = re.compile(r"^--- MODE SWITCH: PROGRESS SUMMARY", re.MULTILINE)
SKIP_SUMMARY = '<skip_summary reason="local observer returned no summary"/>'

FALLBACK_INSTRUCTIONS = """You are a memory observer for a coding session. For each tool event below, record only durable knowledge (discoveries, decisions, changes, bugfixes) as XML:
<observation>
  <type>discovery | decision | change | bugfix | feature | refactor</type>
  <title>short title</title>
  <narrative>what happened and why it matters</narrative>
  <facts><fact>one concrete fact</fact></facts>
  <concepts><concept>keyword</concept></concepts>
  <files_read><file>path</file></files_read>
</observation>
If nothing durable happened, return an empty response. Output only XML, never prose."""

OBS_RE = re.compile(r"<observation(?:\s[^>]*)?>.*?</observation>", re.DOTALL)
SUMMARY_RE = re.compile(r"<summary>.*?</summary>", re.DOTALL)
# Gemma echoes template placeholders: <title>[**title**: text]</title>.
FIELD_ECHO_RE = re.compile(
    r"<(title|subtitle|narrative|fact)>\s*(\[?)\*\*\1\*\*:\s*(.*?)\s*</\1>", re.DOTALL)
FIELD_RE = re.compile(r"<(outcome|parameters)>(.*?)</\1>", re.DOTALL)


# macOS Notification Center, errors and summary skips only (~400 turns/day).
# Fire-and-forget: a notification failure must never take the turn down.
NOTIFY = os.environ.get("OMLX_SHIM_NOTIFY", "1") != "0"


def notify(title: str, body: str) -> None:
    if not NOTIFY:
        return
    try:
        safe_body = body.replace('"', "'")[:120]
        safe_title = title.replace('"', "'")[:60]
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{safe_body}" with title "{safe_title}"'],
            timeout=5, capture_output=True)
    except Exception:
        pass


def log(kind: str, payload: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{os.getpid()}] {kind} {payload[:2000]}\n")
    except OSError:
        pass


def emit(event: dict) -> None:
    if sys.stdout is None:  # spawned without a stdout object: write fd 1 directly
        sys.stdout = os.fdopen(1, "w")
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _setting(key: str, default: str) -> str:
    env = os.environ.get(key)
    if env:
        return env
    try:
        value = json.loads(SETTINGS_PATH.read_text()).get(key)
        if value:
            return str(value)
    except Exception:
        pass
    return default


def _int_setting(key: str, default: int) -> int:
    try:
        return int(_setting(key, str(default)))
    except ValueError:
        return default


def model_name() -> str:
    return _setting("CLAUDE_MEM_OMLX_MODEL", "Qwen3.5-9B-MLX-4bit")


def parse_resume(argv: list[str]) -> str | None:
    for i, arg in enumerate(argv):
        if arg == "--resume" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--resume="):
            return arg.split("=", 1)[1]
    return None


def state_path(session_id: str) -> Path:
    return STATE_DIR / f"{session_id}.json"


def load_instructions(session_id: str) -> str | None:
    try:
        value = json.loads(state_path(session_id).read_text()).get("instructions")
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


def save_instructions(session_id: str, instructions: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        state_path(session_id).write_text(
            json.dumps({"instructions": instructions, "updated": int(time.time())})
        )
    except OSError as exc:
        log("state-error", str(exc))


def message_text(message: dict) -> str:
    content = (message or {}).get("content", "")
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, dict) and block.get("type") == "tool_result":
                inner = block.get("content", "")
                if isinstance(inner, str):
                    parts.append(inner)
    return "\n".join(p for p in parts if p)


def cap_fields(prompt: str, cap: int) -> str:
    def repl(m: re.Match) -> str:
        tag, body = m.group(1), m.group(2)
        if len(body) <= cap:
            return m.group(0)
        return f"<{tag}>{body[:cap]}…[truncated {len(body) - cap} chars]</{tag}>"
    return FIELD_RE.sub(repl, prompt)


def strip_field_echo(block: str) -> str:
    def repl(m: re.Match) -> str:
        tag, bracket, body = m.groups()
        if bracket and body.endswith("]"):
            body = body[:-1].rstrip()
        return f"<{tag}>{body}</{tag}>"
    return FIELD_ECHO_RE.sub(repl, block)


def call_omlx(prompt: str) -> dict:
    """One chat completion over the endpoint pool. Returns a dict with keys
    text, finish, usage, endpoint, is_error."""
    body = json.dumps({
        "model": model_name(),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": _int_setting("CLAUDE_MEM_OMLX_MAX_TOKENS", 3200),
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    timeout = _int_setting("CLAUDE_MEM_OMLX_TIMEOUT_SECONDS", 600)
    endpoints = [e.strip().rstrip("/") for e in
                 _setting("CLAUDE_MEM_OMLX_ENDPOINTS", "http://127.0.0.1:8400").split(",")
                 if e.strip()]
    headers = {"Content-Type": "application/json"}
    api_key = _setting("CLAUDE_MEM_OMLX_API_KEY", "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    last_error = "no endpoints configured"
    for endpoint in endpoints:
        req = urllib.request.Request(
            f"{endpoint}/v1/chat/completions",
            data=body,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            log("omlx-http-error", f"{endpoint} {exc.code} {detail}")
            last_error = f"omlx HTTP {exc.code} from {endpoint}: {detail}"
            if exc.code >= 500:
                continue
            break  # 4xx: the request itself is bad; another endpoint won't help
        except Exception as exc:  # timeout, conn refused (server down), bad JSON
            log("omlx-error", f"{endpoint} {exc!r}")
            last_error = f"omlx error from {endpoint}: {exc!r}"
            continue

        choice = (payload.get("choices") or [{}])[0]
        usage = payload.get("usage") or {}
        return {
            "text": ((choice.get("message") or {}).get("content") or "").strip(),
            "finish": choice.get("finish_reason") or "-",
            "usage": {
                "in": usage.get("prompt_tokens") or 0,
                "out": usage.get("completion_tokens") or 0,
                "cached": (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0,
            },
            "endpoint": endpoint,
            "is_error": False,
        }
    return {"text": last_error, "finish": "-", "usage": {"in": 0, "out": 0, "cached": 0},
            "endpoint": "-", "is_error": True}


def split_mixed(prompt: str) -> tuple[str, str] | None:
    """(observation part, summary part) when the prompt is a flush of tool
    events followed by the summary request, else None."""
    m = SUMMARY_SPLIT.search(prompt)
    if m and EVENT_MARKER in prompt[:m.start()]:
        return prompt[:m.start()].rstrip("\n"), prompt[m.start():]
    return None


def turn_kind(prompt: str, has_instructions: bool) -> str:
    if SUMMARY_MARKER in prompt:
        return "mixed" if split_mixed(prompt) else "summary"
    if EVENT_MARKER in prompt:
        return "observation"
    return "continuation" if has_instructions else "init"


def observation_call(instructions: str | None, prompt: str, cap: int,
                     fields: dict) -> tuple[str, bool]:
    res = call_omlx((instructions or FALLBACK_INSTRUCTIONS) + "\n\n" + cap_fields(prompt, cap))
    fields.update(res["usage"], endpoint=res["endpoint"], finish=res["finish"])
    if res["is_error"]:
        return res["text"], True
    raw = res["text"]
    # Only complete blocks survive, which also drops a trailing block
    # cut off by finish_reason == "length".
    blocks = [strip_field_echo(b) for b in OBS_RE.findall(raw)]
    reply = "\n".join(blocks)
    fields.update(obs=len(blocks), sanitized=reply != raw)
    return reply, False


def summary_call(session_id: str, prompt: str, cap: int, fields: dict) -> tuple[str, bool]:
    # The summary prompt is self-contained; the observer instructions in front
    # of it made Gemma answer with <observation> blocks instead (2026-09-30).
    full_prompt = cap_fields(prompt, cap)
    for _ in range(2):
        res = call_omlx(full_prompt)
        fields.update(res["usage"], endpoint=res["endpoint"], finish=res["finish"])
        if res["is_error"]:
            return res["text"], True
        raw = res["text"]
        match = SUMMARY_RE.search(raw)
        if match:
            fields["sanitized"] = match.group(0) != raw
            return match.group(0), False
        # The worker's parseSummary coerces <observation> content into a
        # summary when one was expected (claude-mem #1633), so forward them.
        blocks = OBS_RE.findall(raw)
        if blocks:
            reply = "\n".join(blocks)
            fields.update(obs=len(blocks), sanitized=reply != raw, coerced=True)
            log("summary-coerce", f"session={session_id} obs={len(blocks)}")
            return reply, False

    log("summary-skip", f"session={session_id} last={raw[:200]!r}")
    notify("claude-mem: summary-skip", f"sesja {session_id[:8]}: brak <summary> po 2 próbach")
    fields["sanitized"] = True
    return SKIP_SUMMARY, False


def run_turn(session_id: str, prompt: str) -> tuple[str, bool, dict]:
    """Returns (reply_text, is_error, log_fields)."""
    instructions = load_instructions(session_id)
    kind = turn_kind(prompt, instructions is not None)
    fields = {"kind": kind, "endpoint": "-", "in": 0, "out": 0, "cached": 0,
              "finish": "-", "obs": 0, "sanitized": False, "coerced": False}

    if kind == "init":
        save_instructions(session_id, prompt[:INSTRUCTIONS_CAP])
        return "", False, fields
    if kind == "continuation":
        return "", False, fields

    cap = _int_setting("CLAUDE_MEM_OMLX_FIELD_CAP", 4000)
    if kind == "observation":
        return (*observation_call(instructions, prompt, cap, fields), fields)
    if kind == "summary":
        return (*summary_call(session_id, prompt, cap, fields), fields)

    # kind == "mixed": the worker's ResponseProcessor parses <observation>
    # blocks and one <summary> from the same text, so both halves share a reply.
    # The summary call gets the whole prompt: alone, the summary part carries
    # no tool events and the model summarised nothing (session 14602).
    obs_part, _ = split_mixed(prompt)
    of, sf = dict(fields), dict(fields)
    obs_text, obs_err = observation_call(instructions, obs_part, cap, of)
    if obs_err:
        log("mixed-part-error", f"session={session_id} part=observation {obs_text[:300]}")
    sum_text, sum_err = summary_call(session_id, prompt, cap, sf)
    if sum_err:
        log("mixed-part-error", f"session={session_id} part=summary {sum_text[:300]}")
    endpoint = of["endpoint"] if of["endpoint"] == sf["endpoint"] else f"{of['endpoint']},{sf['endpoint']}"
    fields.update(endpoint=endpoint, finish=f"{of['finish']}/{sf['finish']}",
                  obs=of["obs"], sanitized=of["sanitized"] or sf["sanitized"],
                  coerced=sf["coerced"], extra=f" obs_error={obs_err} sum_error={sum_err}")
    for key in ("in", "out", "cached"):
        fields[key] = of[key] + sf[key]
    errors = [t for t, e in ((obs_text, obs_err), (sum_text, sum_err)) if e]
    if errors:
        fields["error_text"] = " | ".join(errors)
    # Error text stays in its slot so a fully failed turn is non-XML (retried).
    reply = "\n".join(t for t in (obs_text, sum_text) if t)
    return reply, bool(errors), fields


def main() -> int:
    session_id = parse_resume(sys.argv[1:]) or str(uuid.uuid4())
    log("start", f"session={session_id} instructions={load_instructions(session_id) is not None} auth={'yes' if _setting('CLAUDE_MEM_OMLX_API_KEY', '') else 'no'} argv={' '.join(sys.argv[1:])}")

    emit({
        "type": "system",
        "subtype": "init",
        "session_id": session_id,
        "cwd": str(DATA_DIR),
        "model": model_name(),
        "tools": [],
        "mcp_servers": [],
        "permissionMode": "default",
        "apiKeySource": "none",
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            log("stdin-unparsed", line)
            continue

        etype = event.get("type")
        if etype == "control_request":
            emit({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": event.get("request_id"),
                    "response": {},
                },
            })
            continue
        if etype != "user":
            log("stdin-ignored", etype or "?")
            continue

        prompt = message_text(event.get("message", {}))
        if not prompt:
            log("stdin-empty-user", line)
            continue

        started = time.time()
        text, is_error, f = run_turn(session_id, prompt)
        duration_ms = int((time.time() - started) * 1000)
        log("turn", f"session={session_id} kind={f['kind']} endpoint={f['endpoint']} "
                    f"error={is_error} ms={duration_ms} in={f['in']} out={f['out']} "
                    f"cached={f['cached']} finish={f['finish']} obs={f['obs']} "
                    f"len={len(text)} sanitized={f['sanitized']} coerced={f['coerced']}{f.get('extra', '')}")
        if is_error:
            notify("claude-mem ⚠ błąd", f.get("error_text", text)[:110])

        model = model_name()
        usage = {"input_tokens": f["in"], "output_tokens": f["out"]}
        emit({
            "type": "assistant",
            "message": {
                "id": f"msg_{uuid.uuid4().hex[:12]}",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": usage,
            },
            "parent_tool_use_id": None,
            "session_id": session_id,
        })
        emit({
            "type": "result",
            "subtype": "error_during_execution" if is_error else "success",
            "is_error": is_error,
            "duration_ms": duration_ms,
            "duration_api_ms": duration_ms,
            "num_turns": 1,
            "result": text,
            "session_id": session_id,
            "total_cost_usd": 0,
            "usage": usage,
        })

    log("eof", f"session={session_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
