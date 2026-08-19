#!/bin/bash
# ChatGPT Web text-chat wrapper — POST /v1/chat/completions (or /v1/responses).
#
# Usage:
#   chat.sh "<prompt>" [flags]
#   chat.sh --file <path> [flags]
#   chat.sh - [flags]                 # read prompt from stdin
#
# Defaults: thinking_mode=standard.
#
# Flags:
#   --instant            Use thinking_mode=instant (faster, no reasoning)
#   --standard           Use thinking_mode=standard (default)
#   --extended           Try thinking_mode=extended (falls back to standard if UI has no extended)
#   --extra-high         thinking_mode=extra_high (UI "Extra High"; non-Plus plans only)
#   --pro                thinking_mode=pro (UI "Pro"; slowest, non-Plus plans only)
#   --web-search         DEPRECATED no-op (GPT-5.6 auto-searches; API ignores the field)
#   --system "<text>"    Add a system message
#   --file <path>        Read prompt from file
#   --responses          Hit /v1/responses instead of /v1/chat/completions
#   --json               Print machine JSON {ok,text,applied}
#
# Exit codes: 0 ok, 1 error, 2 rate limited, 3 refused/policy (не ретраить), 4 login failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"
export CHATGPT_WEB_URL CHATGPT_WEB_USER CHATGPT_WEB_PASS

CREDENTIALS=$(echo -n "${CHATGPT_WEB_USER}:${CHATGPT_WEB_PASS}" | base64)

usage() {
    cat <<'EOF'
Usage:
  chat.sh "<prompt>" [flags]
  chat.sh --file <path> [flags]
  chat.sh - [flags]                # read prompt from stdin

Flags:
  --instant            thinking_mode=instant
  --standard           thinking_mode=standard (default)
  --extended           thinking_mode=extended (best-effort)
  --extra-high         thinking_mode=extra_high (UI "Extra High", plan-dependent)
  --pro                thinking_mode=pro (UI "Pro", slowest, plan-dependent)
  --web-search         DEPRECATED no-op (auto-search)
  --system "<text>"    system message
  --file <path>        read prompt from file
  --responses          POST /v1/responses (not /v1/chat/completions)
  --json               machine-readable JSON output
EOF
    exit 1
}

[ $# -lt 1 ] && usage

PROMPT=""
THINKING_MODE="standard"
SYSTEM_MSG=""
ENDPOINT="/v1/chat/completions"
JSON_OUT=false
FROM_FILE=""
FROM_STDIN=false

# Positional or sentinel
case "$1" in
    -)
        FROM_STDIN=true
        shift
        ;;
    --file)
        FROM_FILE="$2"
        shift 2
        ;;
    --help|-h)
        usage
        ;;
    --*)
        # No positional prompt — flags only (probably --file later)
        ;;
    *)
        PROMPT="$1"
        shift
        ;;
esac

while [ $# -gt 0 ]; do
    case "$1" in
        --instant) THINKING_MODE="instant"; shift ;;
        --standard) THINKING_MODE="standard"; shift ;;
        --extended) THINKING_MODE="extended"; shift ;;
        --extra-high|--extrahigh) THINKING_MODE="extra_high"; shift ;;
        --pro) THINKING_MODE="pro"; shift ;;
        # DEPRECATED no-op shim (2026-07-10): GPT-5.6 auto-searches on its own; the API
        # ignores web_search. Kept so in-flight cron prompts don't break; remove after 1-2 cycles.
        --web-search) echo "WARN: --web-search deprecated — ignored (GPT-5.6 auto-search)" >&2; shift ;;
        --system) SYSTEM_MSG="$2"; shift 2 ;;
        --file) FROM_FILE="$2"; shift 2 ;;
        --responses) ENDPOINT="/v1/responses"; shift ;;
        --json) JSON_OUT=true; shift ;;
        --help|-h) usage ;;
        *) echo "Unknown flag: $1" >&2; usage ;;
    esac
done

# Resolve prompt
if [ -n "$FROM_FILE" ]; then
    [ -r "$FROM_FILE" ] || { echo "ERROR: cannot read $FROM_FILE" >&2; exit 1; }
    PROMPT="$(cat "$FROM_FILE")"
elif $FROM_STDIN; then
    PROMPT="$(cat)"
fi

[ -n "$PROMPT" ] || { echo "ERROR: empty prompt" >&2; usage; }

# Build request body
if [ "$ENDPOINT" = "/v1/responses" ]; then
    # Responses-style: input string + optional system as first message
    if [ -n "$SYSTEM_MSG" ]; then
        BODY=$(jq -n \
            --arg sys "$SYSTEM_MSG" \
            --arg user "$PROMPT" \
            --arg mode "$THINKING_MODE" \
            '{input: [{role:"system", content:$sys}, {role:"user", content:$user}],
              thinking_mode: $mode}')
    else
        BODY=$(jq -n \
            --arg user "$PROMPT" \
            --arg mode "$THINKING_MODE" \
            '{input: $user, thinking_mode: $mode}')
    fi
else
    if [ -n "$SYSTEM_MSG" ]; then
        BODY=$(jq -n \
            --arg sys "$SYSTEM_MSG" \
            --arg user "$PROMPT" \
            --arg mode "$THINKING_MODE" \
            '{messages: [{role:"system", content:$sys}, {role:"user", content:$user}],
              thinking_mode: $mode}')
    else
        BODY=$(jq -n \
            --arg user "$PROMPT" \
            --arg mode "$THINKING_MODE" \
            '{messages: [{role:"user", content:$user}], thinking_mode: $mode}')
    fi
fi

RESP=$(curl -sS -w '\n%{http_code}' -X POST "${CHATGPT_WEB_URL}${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Basic ${CREDENTIALS}" \
    --max-time 1020 \
    -d "$BODY")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY_RESP=$(echo "$RESP" | sed '$d')

emit_error() {
    if $JSON_OUT; then
        printf '{"ok":false,"error":%s}\n' "$(jq -Rn --arg m "$1" '$m')"
    else
        echo "ERROR: $1" >&2
    fi
}

# API v1.2.6+ structured errors: { error_kind, should_retry, model_message, error:{...} }
kind=$(echo "$BODY_RESP" | jq -r '.error_kind // empty' 2>/dev/null)
model_msg=$(echo "$BODY_RESP" | jq -r '.model_message // empty' 2>/dev/null)
msg=$(echo "$BODY_RESP" | jq -r '.error.message // empty' 2>/dev/null)
case "$HTTP_CODE" in
    2*) ;;
    422)
        label="REFUSED"
        [ "$kind" = "policy_violation" ] && label="POLICY"
        echo "${label}: ${msg:-content refused}." >&2
        [ -n "$model_msg" ] && echo "  model_message: ${model_msg:0:300}" >&2
        exit 3
        ;;
    429)
        retry_after=$(echo "$BODY_RESP" | jq -r '.error.retry_after // empty' 2>/dev/null)
        if [ -n "$retry_after" ]; then
            mins=$(( (retry_after + 59) / 60 ))
            echo "RATE_LIMITED: ${msg:-Rate limited}. Retry after ${mins} min (${retry_after}s). kind=${kind:-rate_limit}" >&2
        else
            echo "RATE_LIMITED: ${msg:-Server busy}. kind=${kind:-rate_limit}" >&2
        fi
        exit 2
        ;;
    503)
        # 503 is not always the session: since 2.10.0 an exhausted Pro quota lands here too,
        # and telling the operator to "check credentials" for it sends them to the one place
        # that is definitely fine. Branch on error_kind, keep the old text for everything else.
        if [ "$kind" = "tier_limit" ]; then
            echo "TIER_LIMIT: ${msg:-tier quota exhausted}. Повторите запрос — он уйдёт на fallback-тир (Extra High)." >&2
            [ -n "$model_msg" ] && echo "  model_message: ${model_msg:0:300}" >&2
            exit 1
        fi
        echo "LOGIN_FAILED: ${msg:-auth failed}. Проверьте credentials." >&2
        exit 4
        ;;
    504)
        echo "TIMEOUT: ${msg:-exceeded budget}. Можно попробовать снова." >&2
        exit 1
        ;;
    5*)
        emit_error "Server error (HTTP $HTTP_CODE, kind=${kind:-server_error}): ${msg:-unknown}"
        exit 1
        ;;
    *)
        emit_error "Request failed (HTTP $HTTP_CODE, kind=${kind:-unknown}): ${msg:-${BODY_RESP:0:200}}"
        exit 1
        ;;
esac

# A downgrade is a success, not an error — but silently getting Extra High when you asked
# and budgeted for Pro is exactly the kind of thing that should never be invisible.
fb_to=$(echo "$BODY_RESP" | jq -r '.applied.thinking_fallback.to // empty' 2>/dev/null)
if [ -n "$fb_to" ]; then
    fb_from=$(echo "$BODY_RESP" | jq -r '.applied.thinking_fallback.from // empty' 2>/dev/null)
    fb_reason=$(echo "$BODY_RESP" | jq -r '.applied.thinking_fallback.reason // empty' 2>/dev/null)
    echo "NOTE: тир понижен ${fb_from} → ${fb_to} (${fb_reason}) — ответ получен на ${fb_to}." >&2
fi

# Extract text
if [ "$ENDPOINT" = "/v1/responses" ]; then
    TEXT=$(echo "$BODY_RESP" | jq -r '.output_text // .output[0].content[0].text // empty')
else
    TEXT=$(echo "$BODY_RESP" | jq -r '.choices[0].message.content // empty')
fi

if [ -z "$TEXT" ] || [ "$TEXT" = "null" ]; then
    emit_error "Empty response text: $BODY_RESP"
    exit 1
fi

if $JSON_OUT; then
    printf '{"ok":true,"text":%s,"applied":%s,"requested":%s}\n' \
        "$(jq -Rn --arg t "$TEXT" '$t')" \
        "$(echo "$BODY_RESP" | jq '.applied // {}')" \
        "$(echo "$BODY_RESP" | jq '.requested // {}')"
else
    printf '%s\n' "$TEXT"
fi
