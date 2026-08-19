#!/bin/bash
# ChatGPT Web API wrapper — edit or generate images via Image 2.0
#
# Usage:
#   generate.sh edit <input.jpg> "<prompt>" <output.png> [flags]
#   generate.sh create "<prompt>" <output.png> [flags]
#   generate.sh capabilities
#
# Defaults: thinking_mode=instant (no thinking) for images — fast, cheap, fine for most cases.
# Pass --thinking to opt in.
#
# Flags (Image 2.0):
#   --n N              Batch generation, 1..10 (create only). Same chat → consistency.
#   --ratio W:H        Aspect ratio (e.g. 16:9, 3:2, 9:16, 3:1, 1:3). Else inferred from prompt.
#   --thinking         Enable thinking mode (slower, better composition + multilingual text).
#   --web-search       DEPRECATED no-op (GPT-5.6 auto-searches).
#   --ref FILE[,FILE]  Comma-separated reference images for style/brand transfer.
#   --quality Q        Pass-through (best-effort): low|medium|high.
#   --format F         Output extension preference: png|webp|jpg.
#   --json             Print JSON to stdout instead of human-readable lines.
#
# Examples:
#   generate.sh create "Bangkok skyline at dusk" out.jpg --ratio 16:9
#   generate.sh create "product on white" out.png --n 4 --ref brand1.png,brand2.png
#   generate.sh edit photo.jpg "remove watermark" out.png --thinking

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"
export CHATGPT_WEB_URL CHATGPT_WEB_USER CHATGPT_WEB_PASS

CREDENTIALS=$(echo -n "${CHATGPT_WEB_USER}:${CHATGPT_WEB_PASS}" | base64)

usage() {
    cat <<'EOF'
Usage:
  generate.sh edit   <input.jpg> "<prompt>" <output.png> [flags]
  generate.sh create "<prompt>" <output.png> [flags]
  generate.sh capabilities

Flags:
  --n N              Batch (create only, 1..10)
  --ratio W:H        Aspect ratio (16:9, 3:2, 9:16, 3:1, 1:3, ...)
  --thinking         Enable Image 2.0 thinking mode (default OFF — instant)
  --web-search       DEPRECATED no-op (auto-search)
  --ref FILE[,FILE]  Reference images (comma-separated)
  --quality Q        low|medium|high
  --format F         png|webp|jpg (output extension preference)
  --json             Machine-readable JSON output
EOF
    exit 1
}

[ $# -lt 1 ] && usage
MODE="$1"; shift

# ---------- capabilities ----------
if [ "$MODE" = "capabilities" ]; then
    curl -fsS -H "Authorization: Basic ${CREDENTIALS}" "${CHATGPT_WEB_URL}/v1/images/capabilities"
    echo
    exit 0
fi

# ---------- positional args ----------
INPUT=""
OUTPUT=""
PROMPT=""

case "$MODE" in
    edit)
        [ $# -lt 3 ] && usage
        INPUT="$1"; PROMPT="$2"; OUTPUT="$3"
        shift 3
        ;;
    create)
        [ $# -lt 2 ] && usage
        PROMPT="$1"; OUTPUT="$2"
        shift 2
        ;;
    *)
        usage
        ;;
esac

# ---------- flags ----------
N=1
RATIO=""
THINKING=false
REFS=""
QUALITY=""
FORMAT=""
JSON_OUT=false

while [ $# -gt 0 ]; do
    case "$1" in
        --n) N="$2"; shift 2 ;;
        --ratio) RATIO="$2"; shift 2 ;;
        --thinking) THINKING=true; shift ;;
        --extra-high|--extrahigh) THINKING_TIER="extra_high"; shift ;;
        --pro) THINKING_TIER="pro"; shift ;;
        # DEPRECATED no-op (2026-07-10): GPT-5.6 auto-searches; API ignores web_search
        --web-search) echo "WARN: --web-search deprecated — ignored (auto-search)" >&2; shift ;;
        --ref) REFS="$2"; shift 2 ;;
        --quality) QUALITY="$2"; shift 2 ;;
        --format) FORMAT="$2"; shift 2 ;;
        --json) JSON_OUT=true; shift ;;
        *) echo "Unknown flag: $1" >&2; usage ;;
    esac
done

# Detect orientation from prompt if --ratio not given
if [ -z "$RATIO" ]; then
    if echo "$PROMPT" | grep -qiE '3:4|4:5|vertical|portrait|вертикал'; then
        RATIO="1024x1536"
    elif echo "$PROMPT" | grep -qiE '1:1|square|квадрат'; then
        RATIO="1024x1024"
    else
        RATIO="1536x1024"
    fi
fi
# Convert WxH → W:H if user passed a Hugo-style size
if echo "$RATIO" | grep -qE '^[0-9]+x[0-9]+$'; then
    SIZE_HINT="$RATIO"
    RATIO=""
else
    SIZE_HINT=""
fi

# Derive thinking_mode for explicit `applied` echo:
# - default (no flag)        → instant
# - --thinking               → standard
# - --extra-high / --pro     → the top UI tiers (plan-dependent, and SLOW for images —
#                              a Pro image can take minutes; check your client timeout)
# - --web-search             → DEPRECATED no-op
if [ -n "${THINKING_TIER:-}" ]; then
    THINKING_MODE="$THINKING_TIER"
elif $THINKING; then
    THINKING_MODE="standard"
else
    THINKING_MODE="instant"
fi

# ---------- helpers ----------

emit_error() {
    if $JSON_OUT; then
        printf '{"ok":false,"error":%s}\n' "$(jq -Rn --arg m "$1" '$m')"
    else
        echo "ERROR: $1" >&2
    fi
}

handle_http() {
    # API v1.2.6+ structured error response: { ok, error_kind, should_retry, model_message, error:{...} }
    # HTTP codes:
    #   200/2xx — success
    #   422     — refused / policy_violation (НЕ retry, exit 3)
    #   429     — rate_limit / queue_full (retry after `retry_after`, exit 2)
    #   500     — generic server_error (retry-возможно, exit 1)
    #   503     — login_failed (admin alert, exit 4)
    #   504     — timeout (retry-возможно, exit 1)
    local code="$1"
    local body="$2"
    local kind model_msg should_retry retry_after msg
    kind=$(echo "$body" | jq -r '.error_kind // empty' 2>/dev/null)
    model_msg=$(echo "$body" | jq -r '.model_message // empty' 2>/dev/null)
    should_retry=$(echo "$body" | jq -r '.should_retry // empty' 2>/dev/null)
    msg=$(echo "$body" | jq -r '.error.message // empty' 2>/dev/null)
    retry_after=$(echo "$body" | jq -r '.error.retry_after // empty' 2>/dev/null)
    case "$code" in
        2*) ;;  # success — fall through, caller parses body
        422)
            local label="REFUSED"
            [ "$kind" = "policy_violation" ] && label="POLICY"
            echo "${label}: ${msg:-content refused}." >&2
            [ -n "$model_msg" ] && echo "  model_message: ${model_msg:0:300}" >&2
            echo "  hint: смените промпт; should_retry=${should_retry:-false}" >&2
            exit 3
            ;;
        429)
            if [ -n "$retry_after" ]; then
                local mins=$(( (retry_after + 59) / 60 ))
                echo "RATE_LIMITED: ${msg:-Rate limited}. Retry after ${mins} min (${retry_after}s). kind=${kind:-rate_limit}" >&2
            else
                echo "RATE_LIMITED: ${msg:-Server busy}. kind=${kind:-rate_limit}" >&2
            fi
            exit 2
            ;;
        503)
            # Since 2.10.0 an exhausted Pro quota is also a 503 — do not send the operator to
            # check credentials that are fine. Distinguish by error_kind.
            if [ "$kind" = "tier_limit" ]; then
                echo "TIER_LIMIT: ${msg:-tier quota exhausted}. Повторите — запрос уйдёт на fallback-тир." >&2
                exit 1
            fi
            echo "LOGIN_FAILED: ${msg:-ChatGPT Web auth failed}. Требуется ручная проверка credentials." >&2
            exit 4
            ;;
        504)
            echo "TIMEOUT: ${msg:-generation exceeded budget}. Можно попробовать другой промпт или Runware fallback." >&2
            exit 1
            ;;
        5*)
            emit_error "Server error (HTTP $code, kind=${kind:-server_error}): ${msg:-unknown}"
            exit 1
            ;;
        *)
            emit_error "Request failed (HTTP $code, kind=${kind:-unknown}): ${msg:-${body:0:200}}"
            exit 1
            ;;
    esac
}

download_to() {
    local url="$1"
    local out="$2"
    url="${url/http:\/\//https://}"
    local tmp; tmp=$(mktemp /tmp/chatgpt_img_XXXXXX)
    if ! curl -fsS -o "$tmp" -H "Authorization: Basic ${CREDENTIALS}" --max-time 120 "$url"; then
        echo "ERROR: download failed for $url" >&2
        rm -f "$tmp"
        return 1
    fi
    if [ ! -s "$tmp" ]; then
        echo "ERROR: empty download from $url" >&2
        rm -f "$tmp"
        return 1
    fi

    case "$out" in
        *.jpg|*.jpeg|*.JPG|*.JPEG)
            if command -v convert >/dev/null 2>&1; then
                convert "$tmp" -quality 90 -strip "$out" 2>/dev/null
            elif command -v magick >/dev/null 2>&1; then
                magick "$tmp" -quality 90 -strip "$out" 2>/dev/null
            elif command -v docker >/dev/null 2>&1; then
                local tdir odir; tdir=$(dirname "$tmp"); odir=$(cd "$(dirname "$out")" && pwd)
                docker run --rm --entrypoint="" -v "$tdir:$tdir" -v "$odir:/outdir" dpokidov/imagemagick \
                    convert "$tmp" -quality 90 -strip "/outdir/$(basename "$out")" 2>/dev/null \
                    || cp "$tmp" "$out"
            else
                cp "$tmp" "$out"
            fi
            ;;
        *) cp "$tmp" "$out" ;;
    esac
    rm -f "$tmp"
}

# ---------- create ----------

if [ "$MODE" = "create" ]; then
    JSON_BODY=$(jq -n \
        --arg prompt "$PROMPT" \
        --argjson n "$N" \
        --arg aspect_ratio "$RATIO" \
        --arg size "$SIZE_HINT" \
        --arg thinking_mode "$THINKING_MODE" \
        --argjson thinking "$THINKING" \
        --arg quality "$QUALITY" \
        --arg output_format "$FORMAT" \
        '{prompt: $prompt, n: $n, thinking_mode: $thinking_mode, thinking: $thinking}
         + (if $aspect_ratio != "" then {aspect_ratio: $aspect_ratio} else {} end)
         + (if $size != "" then {size: $size} else {} end)
         + (if $quality != "" then {quality: $quality} else {} end)
         + (if $output_format != "" then {output_format: $output_format} else {} end)')

    if [ -n "$REFS" ]; then
        PY_ARGS=(--multipart-create "$PROMPT" "$OUTPUT" --refs "$REFS" --n "$N")
        [ -n "$RATIO" ]      && PY_ARGS+=(--aspect-ratio "$RATIO")
        [ -n "$SIZE_HINT" ]  && PY_ARGS+=(--size "$SIZE_HINT")
        [ -n "$QUALITY" ]    && PY_ARGS+=(--quality "$QUALITY")
        [ -n "$FORMAT" ]     && PY_ARGS+=(--format "$FORMAT")
        $THINKING            && PY_ARGS+=(--thinking)
        $JSON_OUT            && PY_ARGS+=(--json)
        python3 "$SCRIPT_DIR/edit_image.py" "${PY_ARGS[@]}"
        exit $?
    fi

    RESP=$(curl -sS -w '\n%{http_code}' -X POST "${CHATGPT_WEB_URL}/v1/images/generations" \
        -H "Content-Type: application/json" \
        -H "Authorization: Basic ${CREDENTIALS}" \
        --max-time 1020 \
        -d "$JSON_BODY")
    HTTP_CODE=$(echo "$RESP" | tail -1)
    BODY=$(echo "$RESP" | sed '$d')
    handle_http "$HTTP_CODE" "$BODY"

    COUNT=$(echo "$BODY" | jq '.data | length' 2>/dev/null || echo 0)
    if [ "$COUNT" = "0" ]; then
        emit_error "No images returned: $BODY"
        exit 1
    fi

    OUT_PATHS=()
    for i in $(seq 0 $((COUNT - 1))); do
        URL=$(echo "$BODY" | jq -r ".data[$i].url" 2>/dev/null)
        if [ -z "$URL" ] || [ "$URL" = "null" ]; then continue; fi
        if [ "$i" = "0" ]; then
            TARGET="$OUTPUT"
        else
            BASE="${OUTPUT%.*}"; EXT="${OUTPUT##*.}"
            TARGET="${BASE}_$((i + 1)).${EXT}"
        fi
        if ! download_to "$URL" "$TARGET"; then
            emit_error "Failed to download image $((i + 1))"
            exit 1
        fi
        OUT_PATHS+=("$TARGET")
    done

    if $JSON_OUT; then
        printf '{"ok":true,"files":%s,"applied":%s}\n' \
            "$(printf '%s\n' "${OUT_PATHS[@]}" | jq -R . | jq -s .)" \
            "$(echo "$BODY" | jq '.applied // {}')"
    else
        for p in "${OUT_PATHS[@]}"; do
            echo "OK: $p ($(stat -c%s "$p") bytes)"
        done
    fi
    exit 0
fi

# ---------- edit ----------

if [ "$MODE" = "edit" ]; then
    PY_ARGS=("$INPUT" "$PROMPT" "$OUTPUT")
    if [ -n "$RATIO" ]; then PY_ARGS+=(--aspect-ratio "$RATIO"); fi
    if [ -n "$SIZE_HINT" ]; then PY_ARGS+=(--size "$SIZE_HINT"); fi
    if $THINKING; then PY_ARGS+=(--thinking); fi
    if [ -n "$REFS" ]; then PY_ARGS+=(--refs "$REFS"); fi
    if [ -n "$FORMAT" ]; then PY_ARGS+=(--format "$FORMAT"); fi
    if [ -n "$QUALITY" ]; then PY_ARGS+=(--quality "$QUALITY"); fi
    if $JSON_OUT; then PY_ARGS+=(--json); fi

    python3 "$SCRIPT_DIR/edit_image.py" "${PY_ARGS[@]}"
    exit $?
fi
