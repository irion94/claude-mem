#!/bin/bash
# omlx-claude-shim: stateless observer turns against an OpenAI-compatible oMLX.
# - init/continuation turns are stored/answered locally (no HTTP)
# - observation/summary turns = instructions + capped prompt, one request
# - replies are sanitised to complete XML blocks; empty is a valid skip
# - endpoint pool fails over on refused/5xx; all down = error result
# Seams: CLAUDE_MEM_OMLX_ENDPOINTS (fake server), CLAUDE_MEM_DATA_DIR
# (state/log/settings), OMLX_SHIM_NOTIFY=0 (no Notification Center).
set -u

SHIM="${OMLX_SHIM:-$(cd "$(dirname "$0")/../../../plugin/scripts" && pwd)/omlx-claude-shim.py}"
TMP="$(mktemp -d)"
SERVER_PIDS=""
cleanup() {
  for p in $SERVER_PIDS; do { kill "$p"; wait "$p"; } 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1 (expected [$2] got [$3])"; fi
}

cat >"$TMP/fake-omlx.py" <<'EOF'
import http.server, json, os, sys
d = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        reqdir = os.path.join(d, "req")
        idx = len(os.listdir(reqdir))
        with open(os.path.join(reqdir, "%d.json" % idx), "wb") as f:
            f.write(body)
        with open(os.path.join(d, "hdr", "%d.json" % idx), "w") as f:
            json.dump({k.lower(): v for k, v in self.headers.items()}, f)
        with open(os.path.join(d, "paths"), "a") as f:
            f.write(self.path + "\n")
        lines = open(os.path.join(d, "script.jsonl")).read().splitlines()
        spec = json.loads(lines[min(idx, len(lines) - 1)])
        resp = {
            "choices": [{"index": 0,
                         "message": {"role": "assistant", "content": spec.get("content", "")},
                         "finish_reason": spec.get("finish", "stop")}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10,
                      "prompt_tokens_details": {"cached_tokens": 64}},
        }
        data = json.dumps(resp).encode()
        self.send_response(spec.get("status", 200))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
with open(os.path.join(d, "port.tmp"), "w") as f:
    f.write(str(srv.server_address[1]))
os.rename(os.path.join(d, "port.tmp"), os.path.join(d, "port"))
srv.serve_forever()
EOF

# start_server <name> <script-line>... ; sets SRV_URL and SRV_DIR
start_server() {
  SRV_DIR="$TMP/$1-srv"; shift
  mkdir -p "$SRV_DIR/req" "$SRV_DIR/hdr"
  : >"$SRV_DIR/script.jsonl"
  for l in "$@"; do printf '%s\n' "$l" >>"$SRV_DIR/script.jsonl"; done
  python3 "$TMP/fake-omlx.py" "$SRV_DIR" &
  SERVER_PIDS="$SERVER_PIDS $!"
  i=0
  while [ ! -f "$SRV_DIR/port" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  SRV_URL="http://127.0.0.1:$(cat "$SRV_DIR/port")"
}

dead_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

user_event() {
  python3 -c 'import json,sys; print(json.dumps({"type":"user","message":{"role":"user","content":[{"type":"text","text":sys.argv[1]}]}}))' "$1"
}

# run_shim <name> <endpoints> <sid> <prompt>... ; data dir $TMP/<name>-mem (reused)
run_shim() {
  name=$1; endpoints=$2; sid=$3; shift 3
  RUN_MEM="$TMP/$name-mem"; mkdir -p "$RUN_MEM"
  RUN_OUT="$TMP/$name.out"
  for p in "$@"; do user_event "$p"; done |
    env -u CLAUDE_MEM_OMLX_MODEL -u CLAUDE_MEM_OMLX_MAX_TOKENS \
      -u CLAUDE_MEM_OMLX_FIELD_CAP -u CLAUDE_MEM_OMLX_TIMEOUT_SECONDS \
      -u CLAUDE_MEM_OMLX_API_KEY ${RUN_ENV:-} \
      CLAUDE_MEM_OMLX_ENDPOINTS="$endpoints" CLAUDE_MEM_DATA_DIR="$RUN_MEM" \
      OMLX_SHIM_NOTIFY=0 \
      python3 "$SHIM" --output-format stream-json --resume "$sid" >"$RUN_OUT" 2>"$TMP/$name.err"
}

result_at() { jq -rs --argjson n "$1" '[.[]|select(.type=="result")][$n].result' "$RUN_OUT"; }
error_at() { jq -rs --argjson n "$1" '[.[]|select(.type=="result")][$n].is_error' "$RUN_OUT"; }
subtype_at() { jq -rs --argjson n "$1" '[.[]|select(.type=="result")][$n].subtype' "$RUN_OUT"; }
assistant_at() { jq -rs --argjson n "$1" '[.[]|select(.type=="assistant")][$n].message.content[0].text' "$RUN_OUT"; }
req_count() { ls "$SRV_DIR/req" | wc -l | tr -d ' '; }
req_field() { jq -r "$2" "$SRV_DIR/req/$1.json"; }
hdr_of() { jq -r --arg h "$2" '.[$h] // "ABSENT"' "$SRV_DIR/hdr/$1.json"; }
content_of() { jq -r '.messages[0].content' "$SRV_DIR/req/$1.json"; }

INIT='You are a Claude-Mem observer. SYSTEM IDENTITY MARKER
<observed_from_primary_session>
  <user_request>fix the flaky test</user_request>
  <requested_at>2026-09-30</requested_at>
</observed_from_primary_session>
Output <observation> blocks only.'
CONT='Hello memory agent, you are continuing to observe.
<observed_from_primary_session>
  <user_request>second prompt</user_request>
</observed_from_primary_session>'
obs_prompt() { # $1 parameters body, $2 outcome body
  printf '<observed_from_primary_session>\n  <what_happened>Bash</what_happened>\n  <parameters>%s</parameters>\n  <outcome>%s</outcome>\n</observed_from_primary_session>\n\nReturn either one or more <observation>...</observation> blocks, or an empty response.' "$1" "$2"
}
OBS="$(obs_prompt '{"command":"ls"}' '"file-a"')"
SUMMARY='--- MODE SWITCH: PROGRESS SUMMARY ---
Wrap your response in <summary>...</summary>.'
OBS_BLOCK='<observation><type>discovery</type><title>T1</title></observation>'
OBS_BLOCK2='<observation><type>change</type><title>T2</title></observation>'
SUM_BLOCK='<summary><request>r</request><learned>l</learned></summary>'
ok() { jq -cn --arg c "$1" --arg f "${2:-stop}" '{content:$c, finish:$f}'; }

# 1. Init turn: no HTTP, empty success, instructions stored.
start_server init "$(ok "$OBS_BLOCK")"
run_shim init "$SRV_URL" s-init "$INIT"
check "init: no request" "0" "$(req_count)"
check "init: empty result" "" "$(result_at 0)"
check "init: not error" "false" "$(error_at 0)"
check "init: success subtype" "success" "$(subtype_at 0)"
check "init: instructions stored" "$INIT" "$(jq -r .instructions "$RUN_MEM/omlx-shim-state/s-init.json")"
check "init: no history in state" "null" "$(jq -r .messages "$RUN_MEM/omlx-shim-state/s-init.json")"

# 2. Continuation after init: no HTTP, empty success, instructions unchanged.
start_server cont "$(ok "$OBS_BLOCK")"
run_shim cont "$SRV_URL" s-cont "$INIT" "$CONT"
check "continuation: no request" "0" "$(req_count)"
check "continuation: empty result" "" "$(result_at 1)"
check "continuation: not error" "false" "$(error_at 1)"
check "continuation: instructions kept" "$INIT" "$(jq -r .instructions "$RUN_MEM/omlx-shim-state/s-cont.json")"

# 3. Observation after init: stateless request shape.
start_server obs "$(ok "$OBS_BLOCK")" "$(ok "$OBS_BLOCK2")"
run_shim obs "$SRV_URL" s-obs "$INIT" "$OBS" "$OBS"
check "obs: two requests (one per event turn)" "2" "$(req_count)"
check "obs: path" "/v1/chat/completions" "$(head -1 "$SRV_DIR/paths")"
check "obs: content = instructions + prompt" "$INIT

$OBS" "$(content_of 0)"
check "obs: second turn not carrying history" "$INIT

$OBS" "$(content_of 1)"
check "obs: single message" "1" "$(req_field 1 '.messages|length')"
check "obs: user role only" "user" "$(req_field 0 '[.messages[].role]|unique|join(",")')"
check "obs: thinking off" "false" "$(req_field 0 '.chat_template_kwargs.enable_thinking')"
check "obs: max_tokens" "3200" "$(req_field 0 .max_tokens)"
check "obs: temperature" "0.2" "$(req_field 0 .temperature)"
check "obs: default model" "Qwen3.5-9B-MLX-4bit" "$(req_field 0 .model)"
check "obs: reply block" "$OBS_BLOCK" "$(result_at 1)"
check "obs: assistant text" "$OBS_BLOCK" "$(assistant_at 1)"
check "obs: second reply" "$OBS_BLOCK2" "$(result_at 2)"
check "obs: model field" "Qwen3.5-9B-MLX-4bit" "$(jq -rs '[.[]|select(.type=="assistant")][1].message.model' "$RUN_OUT")"
check "obs: init event model" "Qwen3.5-9B-MLX-4bit" "$(jq -rs '[.[]|select(.type=="system")][0].model' "$RUN_OUT")"
log_line="$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep 'kind=observation' | head -1)"
check "obs: log line fields" "1" "$(printf '%s' "$log_line" | grep -c "session=s-obs kind=observation endpoint=$SRV_URL error=False ms=[0-9]* in=100 out=10 cached=64 finish=stop obs=1 len=${#OBS_BLOCK} sanitized=False")"
check "obs: init log kind" "1" "$(grep -c 'kind=init' "$RUN_MEM/logs/omlx-shim.log")"

# 4. Field cap: 10000-char outcome and 5000-char parameters capped to 4000.
BIG="$(python3 -c 'print("x"*10000)')"
MID="$(python3 -c 'print("y"*5000)')"
CAPPED_PROMPT="$(obs_prompt "$MID" "$BIG")
<outcome>short</outcome>"
start_server cap "$(ok "$OBS_BLOCK")"
run_shim cap "$SRV_URL" s-cap "$INIT" "$CAPPED_PROMPT"
got="$(content_of 0)"
X4000="$(python3 -c 'print("x"*4000)')"
Y4000="$(python3 -c 'print("y"*4000)')"
check "cap: outcome truncated" "1" "$(printf '%s' "$got" | grep -c "<outcome>${X4000}…\[truncated 6000 chars\]</outcome>")"
check "cap: parameters truncated" "1" "$(printf '%s' "$got" | grep -c "<parameters>${Y4000}…\[truncated 1000 chars\]</parameters>")"
check "cap: short block intact" "1" "$(printf '%s' "$got" | grep -c '<outcome>short</outcome>')"
check "cap: longest x run" "4000" "$(printf '%s' "$got" | python3 -c 'import re,sys; print(max(len(m) for m in re.findall("x+", sys.stdin.read())))')"

# 5. Field cap honours settings.json; max_tokens honours settings.json.
start_server capset "$(ok "$OBS_BLOCK")"
mkdir -p "$TMP/capset-mem"
printf '{"CLAUDE_MEM_OMLX_FIELD_CAP":"10","CLAUDE_MEM_OMLX_MAX_TOKENS":"1000","CLAUDE_MEM_OMLX_MODEL":"Other-Model"}\n' >"$TMP/capset-mem/settings.json"
run_shim capset "$SRV_URL" s-capset "$INIT" "$(obs_prompt 'abcdefghijKLMNOP' 'z')"
check "settings: cap 10" "1" "$(content_of 0 | grep -c '<parameters>abcdefghij…\[truncated 6 chars\]</parameters>')"
check "settings: max_tokens" "1000" "$(req_field 0 .max_tokens)"
check "settings: model" "Other-Model" "$(req_field 0 .model)"

# 6. Prose only on an observation turn -> empty success.
start_server prose "$(ok 'Skipping, nothing durable here.')"
run_shim prose "$SRV_URL" s-prose "$INIT" "$OBS"
check "prose: empty reply" "" "$(result_at 1)"
check "prose: not error" "false" "$(error_at 1)"
check "prose: sanitized logged" "1" "$(grep -c 'kind=observation.*obs=0 len=0 sanitized=True' "$RUN_MEM/logs/omlx-shim.log")"

# 7. Empty model text -> empty success, not an error.
start_server empty "$(ok '')"
run_shim empty "$SRV_URL" s-empty "$INIT" "$OBS"
check "empty: empty reply" "" "$(result_at 1)"
check "empty: not error" "false" "$(error_at 1)"

# 8. Prose + one observation -> exactly the block.
start_server mixed "$(ok "Here you go:
$OBS_BLOCK
Hope that helps.")"
run_shim mixed "$SRV_URL" s-mixed "$INIT" "$OBS"
check "mixed: only block" "$OBS_BLOCK" "$(result_at 1)"

# 9. finish=length with a trailing unclosed block -> keep complete, drop tail.
start_server len "$(ok "$OBS_BLOCK
<observation><type>change</type><title>cut mid" length)"
run_shim len "$SRV_URL" s-len "$INIT" "$OBS"
check "length: complete block kept" "$OBS_BLOCK" "$(result_at 1)"
check "length: finish logged" "1" "$(grep -c 'finish=length obs=1' "$RUN_MEM/logs/omlx-shim.log")"

# 10. Summary turn, summary present -> exactly the block, one request.
start_server sumok "$(ok "Sure. $SUM_BLOCK trailing")"
run_shim sumok "$SRV_URL" s-sumok "$INIT" "$SUMMARY"
check "summary ok: one request" "1" "$(req_count)"
check "summary ok: block" "$SUM_BLOCK" "$(result_at 1)"
check "summary ok: content is the summary prompt only" "$SUMMARY" "$(content_of 0)"
check "summary ok: log kind" "1" "$(grep -c 'kind=summary' "$RUN_MEM/logs/omlx-shim.log")"
check "summary ok: coerced=False logged" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=summary.*coerced=False')"

# 11. Summary turn, prose twice -> skip_summary, two requests.
start_server sumskip "$(ok 'No summary, sorry.')" "$(ok 'Still no summary.')"
run_shim sumskip "$SRV_URL" s-sumskip "$INIT" "$SUMMARY"
check "summary skip: two requests" "2" "$(req_count)"
check "summary skip: skip tag" "1" "$(result_at 1 | grep -c '^<skip_summary\( reason="[^"]*"\)\{0,1\} */>$')"
check "summary skip: not error" "false" "$(error_at 1)"
check "summary skip: logged" "1" "$(grep -c 'summary-skip' "$RUN_MEM/logs/omlx-shim.log")"
check "summary skip: no coerce" "0" "$(grep -c 'summary-coerce' "$RUN_MEM/logs/omlx-shim.log")"

# 12. Summary retry recovers on the second call.
start_server sumretry "$(ok 'prose')" "$(ok "$SUM_BLOCK")"
run_shim sumretry "$SRV_URL" s-sumretry "$INIT" "$SUMMARY"
check "summary retry: two requests" "2" "$(req_count)"
check "summary retry: block" "$SUM_BLOCK" "$(result_at 1)"

# 13. Endpoint pool: first refused, second serves.
DEAD="http://127.0.0.1:$(dead_port)"
start_server pool "$(ok "$OBS_BLOCK")"
run_shim pool "$DEAD,$SRV_URL" s-pool "$INIT" "$OBS"
check "pool: success" "$OBS_BLOCK" "$(result_at 1)"
check "pool: not error" "false" "$(error_at 1)"
check "pool: log names second endpoint" "1" "$(grep -c "kind=observation endpoint=$SRV_URL error=False" "$RUN_MEM/logs/omlx-shim.log")"

# 14. Endpoint pool: 5xx fails over too.
start_server p500 '{"status":500,"content":"boom"}'
FIVE="$SRV_URL"; FIVE_DIR="$SRV_DIR"
start_server p500b "$(ok "$OBS_BLOCK")"
run_shim p500 "$FIVE,$SRV_URL" s-p500 "$INIT" "$OBS"
check "5xx: failed over" "$OBS_BLOCK" "$(result_at 1)"
check "5xx: first endpoint was tried" "1" "$(ls "$FIVE_DIR/req" | wc -l | tr -d ' ')"

# 15. All endpoints down -> error result.
run_shim down "http://127.0.0.1:$(dead_port),http://127.0.0.1:$(dead_port)" s-down "$INIT" "$OBS"
check "down: is_error" "true" "$(error_at 1)"
check "down: subtype" "error_during_execution" "$(subtype_at 1)"
check "down: log error" "1" "$(grep -c 'kind=observation endpoint=- error=True' "$RUN_MEM/logs/omlx-shim.log")"

# 16. Resumed session reuses stored instructions without a new init.
start_server resume "$(ok "$OBS_BLOCK")"
run_shim resume "$SRV_URL" s-resume "$INIT"
check "resume: first run no request" "0" "$(req_count)"
run_shim resume "$SRV_URL" s-resume "$OBS"
check "resume: one request" "1" "$(req_count)"
check "resume: stored instructions prefixed" "$INIT

$OBS" "$(content_of 0)"
check "resume: reply" "$OBS_BLOCK" "$(result_at 0)"

# 17. No stored instructions -> built-in fallback prefix.
start_server fallback "$(ok "$OBS_BLOCK")"
run_shim fallback "$SRV_URL" s-fallback "$OBS"
got="$(content_of 0)"
check "fallback: prompt at the end" "1" "$(printf '%s' "$got" | tail -c ${#OBS} | grep -c 'Return either one or more')"
check "fallback: prefix present" "1" "$(printf '%s' "$got" | head -c 40 | grep -vc '<observed_from_primary_session>')"
check "fallback: names observation schema" "1" "$(printf '%s' "$got" | grep -c '<files_read>')"

# 18. Old history-format state file is ignored, not replayed.
start_server legacy "$(ok "$OBS_BLOCK")"
mkdir -p "$TMP/legacy-mem/omlx-shim-state"
printf '{"messages":[{"role":"user","content":"OLD"},{"role":"assistant","content":"OLDR"}],"updated":1}\n' >"$TMP/legacy-mem/omlx-shim-state/s-legacy.json"
run_shim legacy "$SRV_URL" s-legacy "$CONT" "$OBS"
check "legacy: history not sent" "0" "$(content_of 0 | grep -c 'OLD')"
check "legacy: continuation stored as instructions" "$CONT

$OBS" "$(content_of 0)"

# 19. Same session: observation turn carries instructions, summary turn does not.
start_server sumnoinst "$(ok "$OBS_BLOCK")" "$(ok "$SUM_BLOCK")"
run_shim sumnoinst "$SRV_URL" s-sumnoinst "$INIT" "$OBS" "$SUMMARY"
check "summary no-instr: two requests" "2" "$(req_count)"
check "summary no-instr: observation has instructions" "1" "$(content_of 0 | grep -c 'SYSTEM IDENTITY MARKER')"
check "summary no-instr: summary lacks instructions" "0" "$(content_of 1 | grep -c 'SYSTEM IDENTITY MARKER')"
check "summary no-instr: summary content" "$SUMMARY" "$(content_of 1)"
check "summary no-instr: reply" "$SUM_BLOCK" "$(result_at 2)"

# 20. Summary turn answered with observation blocks -> forwarded for worker
#     coercion (parseSummary coerceFromObservation), no retry, no skip.
start_server sumcoerce "$(ok "Here:
$OBS_BLOCK
$OBS_BLOCK2
done")"
run_shim sumcoerce "$SRV_URL" s-sumcoerce "$INIT" "$SUMMARY"
check "summary coerce: one request" "1" "$(req_count)"
check "summary coerce: reply is both blocks" "$OBS_BLOCK
$OBS_BLOCK2" "$(result_at 1)"
check "summary coerce: not error" "false" "$(error_at 1)"
check "summary coerce: logged with count" "1" "$(grep -c 'summary-coerce session=s-sumcoerce obs=2' "$RUN_MEM/logs/omlx-shim.log")"
check "summary coerce: no skip" "0" "$(grep -c 'summary-skip' "$RUN_MEM/logs/omlx-shim.log")"
check "summary coerce: single turn line" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=summary')"
check "summary coerce: turn line fields" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=summary .* obs=2 len=[0-9]* sanitized=True coerced=True')"

# 21. Mixed flush (worker: observationPrompt + "\n\n" + summaryPrompt, FLUSH
#     reason=exit): split at the marker line; call 1 = instructions +
#     observation part, call 2 = the full prompt bare; one reply =
#     observations then summary.
MIXED="$OBS

$SUMMARY"
start_server mix "$(ok "Here:
$OBS_BLOCK
$OBS_BLOCK2
done")" "$(ok "Sure. $SUM_BLOCK")"
run_shim mix "$SRV_URL" s-mix "$INIT" "$MIXED"
check "mixed flush: two requests" "2" "$(req_count)"
check "mixed flush: first = instructions + observation part" "$INIT

$OBS" "$(content_of 0)"
check "mixed flush: second = full prompt, bare" "$MIXED" "$(content_of 1)"
check "mixed flush: second carries the tool event" "1" "$(content_of 1 | grep -c '<what_happened>Bash</what_happened>')"
check "mixed flush: second carries the marker line" "1" "$(content_of 1 | grep -c '^--- MODE SWITCH: PROGRESS SUMMARY ---$')"
check "mixed flush: second has no instructions" "0" "$(content_of 1 | grep -c 'SYSTEM IDENTITY MARKER')"
check "mixed flush: first has no marker line" "0" "$(content_of 0 | grep -c 'MODE SWITCH')"
check "mixed flush: reply = observations then summary" "$OBS_BLOCK
$OBS_BLOCK2
$SUM_BLOCK" "$(result_at 1)"
check "mixed flush: not error" "false" "$(error_at 1)"
check "mixed flush: one mixed turn line" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=mixed')"
check "mixed flush: no pure kinds logged" "0" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=summary\|kind=observation')"
check "mixed flush: turn line fields" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c "session=s-mix kind=mixed endpoint=$SRV_URL error=False ms=[0-9]* in=200 out=20 cached=128 finish=stop/stop obs=2 len=$(result_at 1 | wc -c | tr -d ' ' | awk '{print $1-1}') sanitized=True coerced=False obs_error=False sum_error=False$")"

# 22. Mixed flush, summary part answers prose twice -> observations + skip.
start_server mixskip "$(ok "$OBS_BLOCK")" "$(ok 'No summary.')" "$(ok 'Still none.')"
run_shim mixskip "$SRV_URL" s-mixskip "$INIT" "$MIXED"
check "mixed skip: three requests" "3" "$(req_count)"
check "mixed skip: first line is the observation" "$OBS_BLOCK" "$(result_at 1 | head -1)"
check "mixed skip: second line is skip_summary" "1" "$(result_at 1 | sed -n 2p | grep -c '^<skip_summary reason="[^"]*" */>$')"
check "mixed skip: two lines" "2" "$(result_at 1 | wc -l | tr -d ' ')"
check "mixed skip: not error" "false" "$(error_at 1)"
check "mixed skip: summary-skip logged" "1" "$(grep -c 'summary-skip session=s-mixskip' "$RUN_MEM/logs/omlx-shim.log")"
check "mixed skip: obs count logged" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=mixed .* obs=1 ')"

# 23. Split only at a line STARTING with the marker; the words inside tool
#     output (inline or at a line start without the dashes) do not split.
TRICKY_OBS="$(obs_prompt '{"command":"grep -r \"MODE SWITCH: PROGRESS SUMMARY\" src"}' 'src/a.ts: const M = "--- MODE SWITCH: PROGRESS SUMMARY ---"
PROGRESS SUMMARY lines: 1')"
start_server mixtricky "$(ok "$OBS_BLOCK")" "$(ok "$SUM_BLOCK")"
run_shim mixtricky "$SRV_URL" s-mixtricky "$INIT" "$TRICKY_OBS

$SUMMARY"
check "mixed split: classified mixed" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=mixed')"
check "mixed split: observation part keeps whole tool output" "$INIT

$TRICKY_OBS" "$(content_of 0)"
check "mixed split: summary call gets the full prompt" "$TRICKY_OBS

$SUMMARY" "$(content_of 1)"
check "mixed split: reply" "$OBS_BLOCK
$SUM_BLOCK" "$(result_at 1)"

# 24. Pure kinds unchanged: summary prompt that mentions <what_happened> only
#     after the marker stays summary; plain event stays observation.
start_server purekinds "$(ok "$SUM_BLOCK")" "$(ok "$OBS_BLOCK")"
run_shim purekinds "$SRV_URL" s-purekinds "$INIT" "$SUMMARY
Ignore <what_happened> tags from earlier." "$OBS"
check "pure kinds: two requests" "2" "$(req_count)"
check "pure kinds: summary sent bare" "0" "$(content_of 0 | grep -c 'SYSTEM IDENTITY MARKER')"
check "pure kinds: summary logged" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=summary ')"
check "pure kinds: observation logged" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=observation ')"
check "pure kinds: no mixed" "0" "$(grep -c 'kind=mixed' "$RUN_MEM/logs/omlx-shim.log")"
check "pure kinds: no extra fields on pure lines" "0" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'obs_error=')"

# 25. Mixed flush, observation call fails (pool exhausted) -> summary still
#     attempted; reply keeps the summary XML.
start_server mixobserr '{"status":500,"content":"boom"}' "$(ok "$SUM_BLOCK")"
run_shim mixobserr "$SRV_URL" s-mixobserr "$INIT" "$MIXED"
check "mixed obs error: summary still requested" "2" "$(req_count)"
check "mixed obs error: summary in reply" "1" "$(result_at 1 | grep -c "^$SUM_BLOCK\$")"
check "mixed obs error: is_error" "true" "$(error_at 1)"
check "mixed obs error: part logged" "1" "$(grep -c 'mixed-part-error session=s-mixobserr part=observation' "$RUN_MEM/logs/omlx-shim.log")"
check "mixed obs error: turn line" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=mixed .* obs=0 .*obs_error=True sum_error=False$')"

# 26. Mixed flush, summary call fails -> observations kept in the reply.
start_server mixsumerr "$(ok "$OBS_BLOCK")" '{"status":500,"content":"boom"}'
run_shim mixsumerr "$SRV_URL" s-mixsumerr "$INIT" "$MIXED"
check "mixed sum error: two requests" "2" "$(req_count)"
check "mixed sum error: observation first in reply" "$OBS_BLOCK" "$(result_at 1 | head -1)"
check "mixed sum error: is_error" "true" "$(error_at 1)"
check "mixed sum error: part logged" "1" "$(grep -c 'mixed-part-error session=s-mixsumerr part=summary' "$RUN_MEM/logs/omlx-shim.log")"
check "mixed sum error: turn line" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=mixed .* obs=1 .*obs_error=False sum_error=True$')"

# 27. API key: unset -> no Authorization header (every request).
start_server noauth "$(ok "$OBS_BLOCK")" "$(ok "$SUM_BLOCK")"
run_shim noauth "$SRV_URL" s-noauth "$INIT" "$MIXED"
check "auth unset: no header on observation call" "ABSENT" "$(hdr_of 0 authorization)"
check "auth unset: no header on summary call" "ABSENT" "$(hdr_of 1 authorization)"
check "auth unset: content-type kept" "application/json" "$(hdr_of 0 content-type)"
check "auth unset: start log auth=no" "1" "$(grep -c ' start session=s-noauth .* auth=no ' "$RUN_MEM/logs/omlx-shim.log")"

# 28. API key from settings.json -> Bearer on every request, key never logged.
start_server authset "$(ok "$OBS_BLOCK")" "$(ok "$SUM_BLOCK")"
mkdir -p "$TMP/authset-mem"
printf '{"CLAUDE_MEM_OMLX_API_KEY":"sk-test-SECRET123"}\n' >"$TMP/authset-mem/settings.json"
run_shim authset "$SRV_URL" s-authset "$INIT" "$MIXED"
check "auth settings: observation call header" "Bearer sk-test-SECRET123" "$(hdr_of 0 authorization)"
check "auth settings: summary call header" "Bearer sk-test-SECRET123" "$(hdr_of 1 authorization)"
check "auth settings: reply intact" "$OBS_BLOCK
$SUM_BLOCK" "$(result_at 1)"
check "auth settings: start log auth=yes" "1" "$(grep -c ' start session=s-authset .* auth=yes ' "$RUN_MEM/logs/omlx-shim.log")"
check "auth settings: key not in log" "0" "$(grep -c 'SECRET123' "$RUN_MEM/logs/omlx-shim.log")"

# 29. API key from env overrides settings.json; failover endpoint gets it too.
start_server authenv "$(ok "$OBS_BLOCK")"
mkdir -p "$TMP/authenv-mem"
printf '{"CLAUDE_MEM_OMLX_API_KEY":"sk-from-settings"}\n' >"$TMP/authenv-mem/settings.json"
RUN_ENV="CLAUDE_MEM_OMLX_API_KEY=sk-from-env" run_shim authenv "http://127.0.0.1:$(dead_port),$SRV_URL" s-authenv "$INIT" "$OBS"
check "auth env: overrides settings" "Bearer sk-from-env" "$(hdr_of 0 authorization)"
check "auth env: key not in log" "0" "$(grep -c 'sk-from' "$RUN_MEM/logs/omlx-shim.log")"

# 30. Empty key in settings.json behaves as unset.
start_server authempty "$(ok "$OBS_BLOCK")"
mkdir -p "$TMP/authempty-mem"
printf '{"CLAUDE_MEM_OMLX_API_KEY":""}\n' >"$TMP/authempty-mem/settings.json"
run_shim authempty "$SRV_URL" s-authempty "$INIT" "$OBS"
check "auth empty: no header" "ABSENT" "$(hdr_of 0 authorization)"

# 31. Mixed flush: the summary call caps fields like a pure summary turn.
start_server mixcap "$(ok "$OBS_BLOCK")" "$(ok "$SUM_BLOCK")"
run_shim mixcap "$SRV_URL" s-mixcap "$INIT" "$(obs_prompt 'p' "$BIG")

$SUMMARY"
check "mixed cap: summary call outcome truncated" "1" "$(content_of 1 | grep -c "<outcome>${X4000}…\[truncated 6000 chars\]</outcome>")"
check "mixed cap: summary call ends with summary prompt" "1" "$(content_of 1 | tail -1 | grep -c 'Wrap your response')"

# 32. Field echo sanitiser (live Gemma shape): [**field**: text] and
#     **field**: text are unwrapped only when field == enclosing tag.
ECHO_RAW='<observation><type>discovery</type><title>[**title**: Completion of ZEBRA-2352 test task]</title><subtitle>**subtitle**: plain sub</subtitle><narrative>[**narrative**: Ran the task [twice].]</narrative><facts><fact>[**fact**: one]</fact><fact>keep [this]</fact><fact>[**title**: mismatch]</fact></facts></observation>'
ECHO_CLEAN='<observation><type>discovery</type><title>Completion of ZEBRA-2352 test task</title><subtitle>plain sub</subtitle><narrative>Ran the task [twice].</narrative><facts><fact>one</fact><fact>keep [this]</fact><fact>[**title**: mismatch]</fact></facts></observation>'
start_server echo "$(ok "$ECHO_RAW")"
run_shim echo "$SRV_URL" s-echo "$INIT" "$OBS"
check "field echo: unwrapped" "$ECHO_CLEAN" "$(result_at 1)"
check "field echo: sanitized logged" "1" "$(grep ' turn ' "$RUN_MEM/logs/omlx-shim.log" | grep -c 'kind=observation .*obs=1 .*sanitized=True')"
start_server echoclean "$(ok "$ECHO_CLEAN")"
run_shim echoclean "$SRV_URL" s-echoclean "$INIT" "$OBS"
check "field echo: clean block untouched" "$ECHO_CLEAN" "$(result_at 1)"

# 33. emit() survives sys.stdout = None (seen when spawned without a usable
#     stdout object): it falls back to fd 1.
got="$(CLAUDE_MEM_DATA_DIR="$TMP/emit-mem" OMLX_SHIM_NOTIFY=0 PYTHONDONTWRITEBYTECODE=1 python3 -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("shim", sys.argv[1])
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)
sys.stdout = None
shim.emit({"type": "probe"})
shim.emit({"type": "probe2"})
' "$SHIM" 2>&1)"
check "emit: stdout None falls back to fd 1" '{"type": "probe"}
{"type": "probe2"}' "$got"

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
