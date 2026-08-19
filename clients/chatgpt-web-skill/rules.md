## ChatGPT Web API (картинки + текстовые чаты)

Global skill `chatgpt-web` для нашего сервиса `gpt-web-gateway` (бывш. `chatgpt-web-image-api`, ренейминг 2026-07-19; ns/сервис `gpt-web-gateway`, URL `https://gpt-web-gateway.example.com`, репо `github.com/stufently/gpt-web-gateway`) — обёртки ChatGPT Web через Playwright. Доступен из любого проекта.

Сервис умеет:

1. **Картинки** — Image 2.0 generation + edit, batch до 10, references, aspect ratios
2. **Текст** — chat completions + responses, режимы мышления (instant/standard/extended). Свежие факты: GPT-5.6 авто-ищет в сети сам (web_search deprecated)
3. **Capabilities probe** — что реально включено в текущем UI ChatGPT

### Расположение

- Скрипт картинок: `~/.claude/skills/chatgpt-web/generate.sh`
- Python helper для edits: `~/.claude/skills/chatgpt-web/edit_image.py`
- Скрипт текстового чата: `~/.claude/skills/chatgpt-web/chat.sh`
- Креды: `~/.claude/skills/chatgpt-web/.env` (`CHATGPT_WEB_URL`, `CHATGPT_WEB_USER`, `CHATGPT_WEB_PASS`)
- Исходник API: `github.com/stufently/gpt-web-gateway`

### Использование — картинки

**Дефолт: `thinking_mode=instant`** (без thinking). Опт-ин через `--thinking`.

```bash
# Создание (instant — быстро, дёшево, ок для cover/иллюстраций)
~/.claude/skills/chatgpt-web/generate.sh create "<prompt>" out.jpg --ratio 16:9

# Редактирование существующего фото (instant)
~/.claude/skills/chatgpt-web/generate.sh edit photo.jpg "<prompt>" out.jpg

# Capabilities probe
~/.claude/skills/chatgpt-web/generate.sh capabilities
```

#### Флаги generate.sh

| Флаг | Описание |
|---|---|
| `--n N` | Batch 1..10 (только `create`). Один чат → consistency между картинками |
| `--ratio W:H` | `1:1`, `3:2`, `16:9`, `9:16`, `3:1`, `1:3` (или `WxH`) |
| `--thinking` | Thinking mode. Default OFF (instant) |
| `--web-search` | DEPRECATED no-op — GPT-5.6 авто-ищет сам; API игнорирует поле |
| `--ref FILE[,FILE]` | Reference images (до 10) для style/brand transfer |
| `--quality Q` | low / medium / high (best-effort) |
| `--format F` | png / webp / jpg (предпочтение расширения) |
| `--json` | Machine-readable JSON output |

### Использование — текстовые чаты

**Дефолт: `thinking_mode=standard`** (с thinking — текстовые ответы выигрывают от reasoning).

> **UI ChatGPT сменился (~2026-06):** старый toggle thinking заменён плоским дропдауном «Интеллект» (`Instant / Medium / High / Extra High / Pro`). Сервис адаптирован.
>
> **UI сменился СНОВА (2026-08-08, сервис ≥2.12.0).** Плоского дропдауна больше нет. Пилюля
> композера открывает поповер с ДВУМЯ лицами: свёрнутое — позиционный **слайдер** (по делению
> на тир, без подписей); развёрнутое через **«Advanced»** — строки **Model** и **Effort**, и
> вот Effort открывает подменю с прежними именованными уровнями. Сервис ходит именно этим
> путём (Advanced → Effort → клик по имени), слайдер — фолбэк.
>
> ⚠️ **Пока сервис не был адаптирован (до 2.12.0), тир не выставлялся ВООБЩЕ:** `thinking_mode`
> принимался, эхо-блок его возвращал, а запрос молча уходил на том уровне, что остался в
> композере от прошлого раза. Единственный признак — `applied.thinking_verified: false`.
> Мораль для пайплайнов: **проверяй `thinking_verified`, а не `applied.thinking_mode`** —
> второй показывает, что реально активно, но не то, что этого добились ПО ТВОЕЙ просьбе.
>
> **ВСЕ ПЯТЬ ТИРОВ ДОСТУПНЫ (сервис ≥2.9.0, 2026-07-27).** Маппинг: `instant→Instant`, `standard→Medium`, `extended→High`, `extra_high→Extra High`, `pro→Pro`. Флаги: `--instant/--standard/--extended/--extra-high/--pro`.
>
> **АВТО-ПОНИЖЕНИЕ ТИРА (сервис ≥2.10.0, 2026-07-28).** Лимиты Pro периодически кончаются.
> Если запрошен `pro`, а тир реально недоступен (пункт отсутствует / disabled / клик не
> применился), запрос выполняется на **`extra_high`**, а не молча на том уровне, который
> случайно стоял в композере. В ответе: `applied.thinking_mode=extra_high`,
> `applied.requested_verified=false`, `applied.thinking_fallback={from,to,reason}`, при этом
> `requested.thinking_mode` остаётся `pro`. `chat.sh` печатает `NOTE:` в stderr.
>
> ⚠️ `applied.thinking_verified` относится к ПРИМЕНЁННОМУ тиру: после успешного понижения он
> `true` (Extra High действительно включён). Чтобы проверить именно запрошенный тир —
> смотри `applied.requested_verified`.
>
> Если ChatGPT сообщает о лимите только ПОСЛЕ отправки промпта, текущий запрос падает с
> `error_kind: tier_limit` (HTTP 503, `should_retry: true`, `chat.sh` → exit 1, НЕ exit 4):
> повторного автоотправления нет, но тир запоминается, и повтор уже уходит на `extra_high`.
> Отключается на сервере: `TIER_FALLBACK_PRO=off`.
>
> ⚠️ **BREAKING:** раньше строка `pro` была алиасом `extended` и молча давала High. Теперь `pro` = настоящий тир Pro. Обобщённые синонимы (`advanced`, `deep`, `расширенный`) по-прежнему означают `extended`.
>
> ⚠️ До 2.9.0 верхние тиры не только были недоступны через API — сервис ПРИНУДИТЕЛЬНО СБИВАЛ их вниз до High, если находил аккаунт на Extra High / Pro. Теперь выставленный тир не сбивается.
>
> Набор тиров **зависит от тарифа**: Plus показывает только нижние три. Если тир недоступен, клик не проходит, `applied.thinking_verified` = `false`, а `applied.thinking_mode` честно показывает, что реально активно.
>
> **UI 2026-07 (сервис ≥1.2.28 адаптирован; про маппинг тиров см. блок выше — он новее):** (1) набор тиров «Интеллект» план-зависим — Plus: 3 (`Instant 5.5`/Средний/Высокий), другие: 5 (+Extra High/Pro); сабменю модели `GPT-5.6 Sol` (default) / 5.5 / 5.4 (до 23 июля 2026) / 5.3 / o3 — сервис модель не переключает, `model` в API игнорируется. (2) web_search: см. блок ниже — УДАЛЁН в ≥1.2.29. (3) Вкладки Chat|Work — сервис принудительно работает на Chat (`ensureChatMode`). (4) Stuck-guard `CHAT_STALL_WINDOW_SEC=120` (×2 для thinking): зависшая страница со stop-button больше не тянет запрос до 480с — быстрее отдаёт `504 timeout` (`should_retry:true`).
>
> **web_search УДАЛЁН (2026-07-10, сервис ≥1.2.29):** GPT-5.6 авто-ищет в сети сам, когда вопрос требует свежих данных (проверено на проде). Принудительный поиск и UI-автоматизация удалены; поле `web_search` в API принимается и игнорируется (не 400, лог `[deprecated]`), `applied.web_search` всегда `false` («не форсировали», модель может искать сама). Флаг `--web-search` в chat.sh/generate.sh — no-op с warning (шим убрать после 1-2 cron-циклов). Известный артефакт авто-поиска: при виджетах (погода) в текст может попасть innerText виджета.

```bash
# Базовый запрос
~/.claude/skills/chatgpt-web/chat.sh "Сколько спален в типичной кондо-студии в Бангкоке?"

# Instant (быстрее, без thinking) — для коротких ответов / классификации
~/.claude/skills/chatgpt-web/chat.sh "Переведи: ขอบคุณ" --instant

# Свежие факты — GPT-5.6 авто-ищет сам, флаг не нужен
~/.claude/skills/chatgpt-web/chat.sh "Курс THB к RUB сегодня?"

# С системным промптом
~/.claude/skills/chatgpt-web/chat.sh "Дай факт о Бангкоке" --system "Отвечай одним предложением"

# Промпт из файла / stdin
~/.claude/skills/chatgpt-web/chat.sh --file /tmp/prompt.txt
cat doc.md | ~/.claude/skills/chatgpt-web/chat.sh - --instant

# JSON output (для пайплайнов)
~/.claude/skills/chatgpt-web/chat.sh "1+1?" --json
# → {"ok":true,"text":"2","applied":{...},"requested":{...}}

# Альтернативный endpoint /v1/responses
~/.claude/skills/chatgpt-web/chat.sh "Список 3 фактов" --responses
```

#### Флаги chat.sh

| Флаг | Описание |
|---|---|
| `--instant` | `thinking_mode=instant` (без thinking) |
| `--standard` | `thinking_mode=standard` (это default) |
| `--extended` | `thinking_mode=extended` → UI **High** |
| `--extra-high` | `thinking_mode=extra_high` → UI **Extra High** (не на Plus) |
| `--pro` | `thinking_mode=pro` → UI **Pro**, самый медленный (не на Plus) |
| `--web-search` | DEPRECATED no-op (авто-поиск) |
| `--system "..."` | Системное сообщение |
| `--file PATH` | Прочитать prompt из файла |
| `-` | Прочитать prompt из stdin |
| `--responses` | POST на `/v1/responses` вместо `/v1/chat/completions` |
| `--json` | JSON output вместо plain text |

### Примеры (картинки)

```bash
# Cover для статьи в Hugo (instant — default, быстро):
~/.claude/skills/chatgpt-web/generate.sh create \
  "Bangkok skyline at dusk, neon signs, realistic photo" cover.jpg --ratio 16:9

# Постер с многострочным русским текстом — нужен thinking:
~/.claude/skills/chatgpt-web/generate.sh create \
  "Russian poster: 'Скидки -50%' big bold cyrillic" poster.jpg \
  --ratio 3:4 --thinking

# 4 консистентные иллюстрации (один чат → одинаковый стиль):
~/.claude/skills/chatgpt-web/generate.sh create \
  "Thai street food vendor, top-down shot, 35mm" hero.jpg --n 4

# Style transfer через references:
~/.claude/skills/chatgpt-web/generate.sh edit photo.jpg \
  "match the style of references" out.png --ref brand1.jpg,brand2.jpg
```

### Когда что включать

**Картинки:**
- **Без флагов (instant — default)** — большинство случаев: cover, realistic photo, простая правка. 10-25 с, дёшево
- **`--thinking`** — длинный текст в картинке, многоязычные постеры, сложные композиции >5 элементов, infografics
- **Свежие факты в картинке** — GPT-5.6 авто-ищет сам (`--web-search` deprecated no-op)
- **`--n N`** — серия одного стиля для поста (галерея, шаги)
- **`--ref`** — мудборд / brand guidelines

**Текст:**
- **Без флагов (standard — default)** — reasoning-ответы по умолчанию
- **`--instant`** — простые переводы, классификация, парсинг
- **Актуальные факты (курсы, цены, новости)** — авто-поиск, флаг не нужен
- **`--extended`** — сложный анализ (UI High)
- **`--extra-high`** — задачи, где High не хватает; заметно дольше
- **`--pro`** — максимум рассуждений, минуты на ответ. Проверь, что клиентский таймаут это переживёт: серверный максимум `CHAT_COMPLETION_TIMEOUT_SEC` (360) + продление (120) = 480 с, у `chat.sh` `--max-time 900` (поднят 2026-07-27 под тир Pro)

### API Endpoints

- Base URL: `$CHATGPT_WEB_URL` (Basic auth `$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS`)
- `POST /v1/images/generations` — JSON или multipart (если reference_images[] файлами)
- `POST /v1/images/edits` — multipart (`image` + опц. `reference_images[]`)
- `POST /v1/chat/completions` — OpenAI-compatible chat completions
- `POST /v1/responses` — Responses-style endpoint
- `GET /v1/images/capabilities` — UI toggles probe (кеш 60с)
- `GET /v1/images/status` — queue + rate limit + batch metric
- `GET /health` — health check
- `GET /metrics` — Prometheus metrics
- Default size: 1536×1024. 2K через `--ratio` (1536-пиксельный длинный край)
- Max upload: 50 MB

### Параметры запроса

JSON для `/v1/images/generations` (и multipart в edits):
```json
{
  "prompt": "...",
  "n": 1..10,
  "thinking_mode": "instant|standard|extended|extra_high|pro",
  "thinking": true|false,
  "web_search": false,  // DEPRECATED — принимается и игнорируется
  "aspect_ratio": "16:9",
  "size": "1536x1024",
  "output_format": "png|webp|jpg",
  "quality": "low|medium|high",
  "reference_images": ["data:image/jpeg;base64,...", "..."]
}
```

JSON для `/v1/chat/completions`:
```json
{
  "messages": [{"role":"user","content":"..."}],
  "thinking_mode": "instant|standard|extended|extra_high|pro",
  "web_search": false
}
```

Ответ всегда содержит `applied` echo-блок (реально применено) и `requested` (что запросили) — клиент видит расхождения. Success-ответ дополнительно содержит `ok: true`.

### Проверка реальной активации thinking (важно для пайплайнов)

В `applied` (с 2026-05-11) появилось поле `applied.thinking_verified`:

- `true` — сервис подтвердил, что в UI ChatGPT реально нажалась кнопка thinking
- `false` или отсутствует — селектор soft-fail'нул (UI ChatGPT поменялся / опция за paywall), фактически был instant. `applied.thinking:true` без `thinking_verified:true` — ненадёжно, это echo запроса.

Если пайплайн критически зависит от reasoning (например двухэтапный draft в собственном пайплайне) — проверяй явно:

```bash
~/.claude/skills/chatgpt-web/chat.sh "промпт" --extended --json > out.json
if [ "$(jq -r '.applied.thinking_verified' out.json)" != "true" ]; then
    echo "thinking не активирован — fallback на legacy путь"
fi
```

Эмпирически в боевом режиме `--extended` с активным thinking: ~60-120 сек, длина ответа 1000-5000 char. `instant` без thinking: 10-30 сек, 200-500 char.

### Adaptive timeout (картинки — с 1.2.6, 2026-05-15)

- Базовый таймаут генерации 240 сек (был 180)
- Если истёк и страница показывает прогресс (`creating image…`, `думаю`, `генерирую`, виден `stop-button`) — продлевается ещё на 90 сек
- Если прогресса нет — `504 timeout` (отдельный bucket в метриках, не `server_error`)
- Env: `GENERATION_TIMEOUT_SEC` (default 240), `GENERATION_RETRY_TIMEOUT_SEC` (default 90)

### Adaptive timeout для текста (chat/responses — с 1.2.15, 2026-06-03)

Аналог для текстовых ответов — раньше был жёсткий бюджет без продления, из-за чего долгий/extended thinking обрывался по `timeout`.

- Базовый таймаут текстового ответа 360 сек (был 300)
- Если истёк, но на границе виден `stop-button` (модель ещё стримит/думает) — окно **один раз** продлевается на 120 сек
- Если прогресса нет — `504 timeout`
- Env: `CHAT_COMPLETION_TIMEOUT_SEC` (default 360), `CHAT_COMPLETION_RETRY_TIMEOUT_SEC` (default 120)
- Клиентский `chat.sh` имеет `--max-time 900` (поднят 2026-07-27 под тир Pro) — покрывает серверный максимум 360+120=480 сек и оставляет запас, если серверные бюджеты поднимут

### Структура ошибок (2026-05-15+)

Все endpoint'ы возвращают единый JSON при ошибке:

```json
{
  "ok": false,
  "error_kind": "refused",
  "should_retry": false,
  "model_message": "...дословный текст отлупа из UI ChatGPT (refusal-баннер «We're so sorry, but …» для 422; текст тоста/баннера ошибки для upload_failed/page_load_failed/timeout)...",
  "error": {
    "message": "ChatGPT refused to generate this image",
    "type": "server_error",
    "retry_after": 1500
  }
}
```

| HTTP | `error_kind` | `should_retry` | Когда |
|---|---|---|---|
| 400 | `invalid_request` | false | Нет обязательного поля |
| 422 | `refused` / `policy_violation` | **false** | Content policy / guardrails — менять промпт |
| 429 | `rate_limit` | false | Квота ChatGPT — ждать `Retry-After` |
| 429 | `queue_full` | true | Очередь полна — повторить |
| 500 | `server_error` | true | Прочее |
| 503 | `login_failed` | true | Сессия отвалилась |
| 504 | `timeout` | true | Превышен адаптивный таймаут |

`should_retry` — машинно-читаемый hint: вызывающий пайплайн НЕ должен ретраить тот же промпт при `false`. Legacy блок `error: { message, type, retry_after? }` сохраняется — скрипты skill (`generate.sh` / `chat.sh`) продолжают парсить его как раньше.

### Rate Limits

ChatGPT Plus / Pro: soft cap (точные цифры OpenAI не публикует).
- Скорость: instant 10-25 с/img, thinking дольше, текст обычно <30 с
- Очередь: max 5 параллельных (`MAX_QUEUE_SIZE`); больше → 429 с `Retry-After`
- Batch `--n 10` = 1 generation в счётчике (выгоднее чем 10 отдельных)
- Undocumented monthly cap — сервер кепит cooldown до 24 ч

**Exit codes (generate.sh / chat.sh / edit_image.py, API v1.2.6+):**
- `0` — success
- `1` — timeout / server error / network / другое (retry возможен)
- `2` — rate limited / queue full (ждать `retry_after` секунд из stderr)
- `3` — refused / policy_violation (422) — **НЕ retry**, менять промпт
- `4` — login_failed (503) — сессия ChatGPT отвалилась, проверить креды
  (⚠️ 503 с `error_kind=tier_limit` — это НЕ логин, а исчерпанный лимит тира: exit 1, повторить)

### Прямые curl-примеры

**Generate image (instant):**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  -X POST "$CHATGPT_WEB_URL/v1/images/generations" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Bangkok at dusk","aspect_ratio":"16:9","thinking_mode":"instant"}'
```

**Chat completion (instant):**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  -X POST "$CHATGPT_WEB_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"OK?"}],"thinking_mode":"instant"}'
```

**Edit с reference_images через multipart:**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  -F "image=@photo.jpg" \
  -F "reference_images=@brand1.jpg" \
  -F "prompt=match style" \
  -F "thinking_mode=standard" \
  "$CHATGPT_WEB_URL/v1/images/edits"
```

**Capabilities probe:**
```bash
curl -u "$CHATGPT_WEB_USER:$CHATGPT_WEB_PASS" \
  "$CHATGPT_WEB_URL/v1/images/capabilities"
# {"model":"gpt-image-2-via-chatgpt-web","supported":{"n_max":10,"thinking":true,...}}
```

### Требования

- `python3` (stdlib only, без pip)
- `curl` и `jq` (для bash-обёрток)
- Docker (опционально, только для resize крупных файлов >6 MB в edit_image.py)

### Риски / ограничения

- Automation поверх ChatGPT Web, не официальный OpenAI API
- CSS/ARIA-селекторы toggles thinking/reference могут ломаться при редизайне ChatGPT. Adapter soft-fail'ит. Проверять через `/v1/images/capabilities`
- Conversation persistence в API не реализована (каждый запрос — новый чат). Multi-turn только внутри одного `--n`
- Streaming не поддерживается ни для картинок, ни для текста
- 4K не обещаем — UI не даёт явного контроля, максимум 2K
- Бренд-логотипы Image 2.0 не воспроизводит точно
- В одном чате после refusal — может палить bypass
