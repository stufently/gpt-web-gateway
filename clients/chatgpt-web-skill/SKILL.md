---
name: chatgpt-web
description: Личный ChatGPT Web API (gpt-web-gateway). Картинки + текстовые чаты через ChatGPT Web. Включает generate.sh (image gen/edit), edit_image.py (multipart edit), chat.sh (chat completions / responses). По умолчанию для картинок — instant без thinking. Креды в ~/.claude/skills/chatgpt-web/.env (CHATGPT_WEB_URL/USER/PASS).
---

# chatgpt-web

Глобальный скилл для нашего личного `gpt-web-gateway` (`github.com/stufently/gpt-web-gateway`;
ns/сервис `gpt-web-gateway`, URL `https://gpt-web-gateway.example.com`). Ренейминг из
`chatgpt-web-image-api` 2026-07-19 — API-контракт прежний, менялись только имена/URL.
Сервис — обёртка над ChatGPT Web через Playwright, OpenAI-compatible REST API.

Умеет:

1. **Картинки** (generation + edit) — Image 2.0, batch до 10, references, aspect ratios
2. **Текст** (chat completions + responses) — без указания модели, режимы мышления. Свежие факты: GPT-5.6 ищет в сети автоматически (web_search deprecated)
3. **Capabilities probe** — что реально включено в текущем UI ChatGPT

## Расположение

- **Скилл — реальные файлы в `~/.claude/skills/chatgpt-web/`** (standalone, с 2026-07-19 после
  удаления старого репо `chatgpt-web-image-api`; раньше был симлинк в `skill/` того репо).
  Полный справочник (флаги, тиры thinking, коды ошибок, curl) — `rules.md` рядом;
  читать по надобности. С 2026-09-24 он НЕ грузится в каждую сессию: симлинк
  `~/.claude/rules/chatgpt-web.md` снят, в `~/.claude/CLAUDE.md` — указатель на скил.
  API-сервис — `github.com/stufently/gpt-web-gateway`, с 2026-08-19 публичный (MIT).
  Эти обёртки лежат в нём же, в `clients/chatgpt-web-skill/`. Хост в примерах —
  плейсхолдер `gpt-web-gateway.example.com`: свой адрес держи в `.env`, не в файлах скила.
- Скрипт картинок: `~/.claude/skills/chatgpt-web/generate.sh`
- Python helper для edits: `~/.claude/skills/chatgpt-web/edit_image.py`
- Скрипт текстового чата: `~/.claude/skills/chatgpt-web/chat.sh`
- Креды: `~/.claude/skills/chatgpt-web/.env` (`CHATGPT_WEB_URL`, `CHATGPT_WEB_USER`, `CHATGPT_WEB_PASS`); шаблон `.env.example`
- Исходник API: `github.com/stufently/gpt-web-gateway`

## Картинки

**Дефолт — `instant` (без thinking).** Thinking включается только явным `--thinking`.

```bash
# Генерация с нуля (instant, быстрее, дешевле в лимите)
~/.claude/skills/chatgpt-web/generate.sh create "Bangkok skyline at dusk" out.jpg --ratio 16:9

# Редактирование существующего фото (instant)
~/.claude/skills/chatgpt-web/generate.sh edit photo.jpg "Slightly modify this photo" out.jpg

# Опционально — thinking mode (медленнее, лучше длинный текст / multilingual)
~/.claude/skills/chatgpt-web/generate.sh create "Russian poster: 'Скидки -50%'" out.jpg --ratio 3:4 --thinking

# Batch 4 картинки в одном чате → consistency
~/.claude/skills/chatgpt-web/generate.sh create "Thai street food, 35mm" hero.jpg --n 4

# Style transfer через references
~/.claude/skills/chatgpt-web/generate.sh edit photo.jpg "match style" out.png --ref brand1.jpg,brand2.jpg

# Capabilities probe
~/.claude/skills/chatgpt-web/generate.sh capabilities
```

### Флаги generate.sh

| Флаг | Описание |
|---|---|
| `--n N` | Batch 1..10 (только для `create`). Все картинки в одном чате → consistency |
| `--ratio W:H` | `1:1`, `3:2`, `16:9`, `9:16`, `3:1`, `1:3` (или передать `WxH`) |
| `--thinking` | Включить thinking mode. По умолчанию OFF (instant) |
| `--web-search` | DEPRECATED no-op — GPT-5.6 авто-ищет сам; API игнорирует поле |
| `--ref FILE[,FILE]` | Reference images (до 10) для style transfer |
| `--quality Q` | low / medium / high (best-effort) |
| `--format F` | png / webp / jpg (предпочтение для расширения файла) |
| `--json` | Machine-readable JSON output вместо текста |

## Текстовый чат

```bash
# Один вопрос — один ответ
~/.claude/skills/chatgpt-web/chat.sh "Ответь ровно одним словом: OK"

# Свежие факты — авто-поиск, флаг не нужен
~/.claude/skills/chatgpt-web/chat.sh "Найди свежий курс THB к RUB"

# Instant (без thinking) для коротких ответов
~/.claude/skills/chatgpt-web/chat.sh "Переведи: ขอบคุณ" --instant

# Чтение промпта из файла или stdin
~/.claude/skills/chatgpt-web/chat.sh --file /tmp/prompt.txt
echo "Напиши TL;DR этого текста: ..." | ~/.claude/skills/chatgpt-web/chat.sh -

# JSON output (для скриптов)
~/.claude/skills/chatgpt-web/chat.sh "1+1?" --json
# → {"ok":true,"text":"2","applied":{"thinking":true,"thinking_mode":"standard","web_search":false}}

# Альтернативный endpoint /v1/responses
~/.claude/skills/chatgpt-web/chat.sh "Список 3 фактов о Бангкоке" --responses
```

### Флаги chat.sh

| Флаг | Описание |
|---|---|
| `--instant` | Режим `instant` (без thinking). Default для текста — `standard` |
| `--standard` | `Thinking` в UI ChatGPT (это default) |
| `--extended` | `extended` → UI **High** |
| `--extra-high` | `extra_high` → UI **Extra High** (нет на Plus) |
| `--pro` | `pro` → UI **Pro**, самый медленный (нет на Plus). При исчерпанном лимите Pro сервис (≥2.10.0) сам выполняет запрос на `extra_high` — см. `applied.thinking_fallback` |
| `--web-search` | DEPRECATED no-op (авто-поиск) |
| `--system "..."` | Системное сообщение |
| `--file PATH` | Прочитать prompt из файла |
| `-` | Прочитать prompt из stdin |
| `--responses` | Использовать `/v1/responses` вместо `/v1/chat/completions` |
| `--json` | JSON output `{ok, text, applied}` вместо plain text |

## Когда что использовать

- **Картинки instant (default)** — большинство случаев: cover для статьи, простая правка, генерация realistic photo. 10-25 сек, дешевле лимита
- **Картинки `--thinking`** — длинный текст в картинке, многоязычные постеры, сложные композиции >5 элементов, infografics
- **Картинки `--n N`** — серия одного стиля (галерея, шаги рецепта, до/после)
- **Картинки `--ref`** — есть мудборд / brand guidelines, нужен консистентный стиль
- **Текст standard (default)** — нормальные ответы с reasoning
- **Текст `--instant`** — простые переводы, парсинг, классификация (быстрее)
- **Свежие факты (курсы, новости)** — флаг не нужен: GPT-5.6 авто-ищет в сети сам

## API Endpoints

Base: `$CHATGPT_WEB_URL` (Basic auth `$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS`)

| Endpoint | Назначение |
|---|---|
| `POST /v1/images/generations` | Image generation (JSON или multipart с refs) |
| `POST /v1/images/edits` | Image edit (multipart с `image` + опц. refs) |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `POST /v1/responses` | OpenAI Responses-style endpoint |
| `GET /v1/images/capabilities` | Probe текущих UI toggles (кеш 60 сек) |
| `GET /v1/images/status` | Queue + rate limit + batch metric |
| `GET /health` | Health check |
| `GET /metrics` | Prometheus metrics |

## Параметры запроса (JSON)

```json
{
  "prompt": "...",
  "n": 1..10,
  "thinking_mode": "instant|standard|extended",
  "thinking": true|false,            // legacy alias for instant/standard
  "web_search": false,  // DEPRECATED — игнорируется
  "aspect_ratio": "16:9",
  "size": "1536x1024",
  "output_format": "png|webp|jpg",
  "quality": "low|medium|high",
  "reference_images": ["data:image/jpeg;base64,...", "..."]
}
```

Ответ содержит `applied` echo-блок с реально применёнными параметрами + `requested` для сравнения. Success-ответ дополнительно содержит `ok: true`.

## Структура ошибок (2026-05-15+)

JSON-ответ при ошибке:
```json
{
  "ok": false,
  "error_kind": "refused",          // refused|policy_violation|rate_limit|queue_full|timeout|login_failed|server_error|invalid_request
  "should_retry": false,            // true → ретраить можно; false → менять промпт / уважать Retry-After
  "model_message": "...",           // ~300 chars текста ChatGPT с объяснением (если есть)
  "error": { "message": "...", "type": "server_error", "retry_after": 1500 }  // legacy, парсится generate.sh/chat.sh
}
```

HTTP-коды: `400` invalid_request, `422` refused/policy_violation, `429` rate_limit/queue_full, `500` server_error, `503` login_failed, `504` timeout.

## Rate Limits

- ChatGPT Plus / Pro: soft cap (OpenAI не публикует точные цифры)
- Очередь сервиса: max 5 параллельных, при превышении → 429 c `Retry-After`
- Скорость: instant 10-25 с/img, thinking дольше, текст обычно <30 с
- Batch `--n 10` = одна «генерация» в счётчике (10 картинок) — выгоднее чем 10 отдельных
- `MAX_QUEUE_SIZE`, `RATE_LIMIT_COOLDOWN_MINUTES` — настройки сервера

**Exit codes generate.sh / chat.sh / edit_image.py (API v1.2.6+):**

| Exit | HTTP | error_kind | Что значит | Что делать |
|---|---|---|---|---|
| `0` | 200 | — | success | — |
| `1` | 504 | `timeout` | генерация превысила бюджет (240+90 сек) | retry с другим промптом или Runware fallback |
| `1` | 500 | `server_error` | generic ошибка сервера | retry возможен |
| `1` | 4xx | другое | network / invalid request | проверить запрос |
| `2` | 429 | `rate_limit` / `queue_full` | очередь сервиса заполнена / cooldown | ждать `retry_after` секунд |
| `3` | 422 | `refused` / `policy_violation` | ChatGPT отказался (контент / copyright) | **НЕ retry**, сменить промпт |
| `4` | 503 | `login_failed` | auth fail | проверить creds ChatGPT_WEB_USER/PASS |

API v1.2.6 (2026-05-15) добавила structured response: `{ ok, error_kind, should_retry, model_message, error:{...legacy...} }`. `should_retry:false` → точно не ретраить (refusal/policy). Поле `model_message` содержит цитату ответа модели — полезно для дебага refusals.

## Прямые curl-примеры

**Generate image (instant — без thinking):**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  -X POST "$CHATGPT_WEB_URL/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Bangkok at dusk","aspect_ratio":"16:9"}'
```

**Chat completion:**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  -X POST "$CHATGPT_WEB_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"OK?"}],"thinking_mode":"instant"}'
```

**Image edit (multipart с references):**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  -F "image=@photo.jpg" \
  -F "reference_images=@brand1.jpg" \
  -F "prompt=match this style" \
  "$CHATGPT_WEB_URL/v1/images/edits"
```

**Capabilities probe:**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  "$CHATGPT_WEB_URL/v1/images/capabilities"
```

## Требования

- `python3` (stdlib only, без pip)
- `curl` и `jq` (для bash-обёрток)
- Docker (опционально, только для resize крупных файлов >6 MB в `edit_image.py`)

## Проверка реальной активации thinking

⚠️ С 2.10.0 `thinking_verified` относится к ПРИМЕНЁННОМУ тиру. Если запрашивали `pro`, а
лимит кончился, ответ придёт на `extra_high` с `thinking_verified=true` — «Pro подтверждён»
это НЕ означает. Признак понижения: `applied.requested_verified=false` и непустой
`applied.thinking_fallback`.

В ответе JSON (`--json`) есть поле `applied.thinking_verified`:

- `true` — сервис подтвердил что нашёл и нажал кнопку thinking в UI ChatGPT
- `false` или отсутствует — селектор soft-fail'нул, thinking фактически не активировался (хотя `applied.thinking` может быть `true` — это echo запроса, ненадёжно)

**Эмпирические маркеры реальной активации extended thinking в текстовом чате:**
- Время ответа 30-120 сек (instant обычно 10-30 сек)
- Длина ответа 1000-5000 char вместо 200-500
- Конкретные имена настроек/флагов, ссылки на источники (RFC/GitHub/docs)

Если важна именно активация thinking — проверяй `thinking_verified=true` после вызова, иначе считай что был instant с другим промптом:
```bash
~/.claude/skills/chatgpt-web/chat.sh "промпт" --extended --json > out.json
if [ "$(jq -r '.applied.thinking_verified' out.json)" != "true" ]; then
    echo "thinking не активирован — fallback на что-то другое"
fi
```

## Риски / ограничения

- Это automation поверх ChatGPT Web, а не официальный OpenAI API
- DOM ChatGPT часто меняется; селекторы best-effort. Toggle thinking soft-fail при отсутствии кнопки (см. `/v1/images/capabilities` для image-toggles, и `applied.thinking_verified` в ответе для chat-toggle)
- Conversation persistence в API не реализована (каждый запрос — новый чат). Multi-turn editing работает только внутри одного `--n`
- Streaming не поддерживается
- Бренд-логотипы Image 2.0 не воспроизводит точно
- В одном чате после refusal — может палить bypass

## Миграция со старого скила `chatgpt-image`

Старый скилл удалён 2026-05-11. Изменения:

| Старое | Новое |
|---|---|
| `~/.claude/skills/chatgpt-image/generate.sh` | `~/.claude/skills/chatgpt-web/generate.sh` |
| `~/.claude/skills/chatgpt-image/edit_image.py` | `~/.claude/skills/chatgpt-web/edit_image.py` |
| `~/.claude/rules/chatgpt-image.md` | `~/.claude/rules/chatgpt-web.md` (снят 2026-09-24, теперь `skills/chatgpt-web/rules.md`) |
| env `CHATGPT_IMAGE_URL/USER/PASS` | env `CHATGPT_WEB_URL/USER/PASS` |
| (нет text-чата) | `~/.claude/skills/chatgpt-web/chat.sh` |
| картинки default = `--thinking` (false) | картинки default явно `instant` (как было), но явный mapping `thinking_mode` |
