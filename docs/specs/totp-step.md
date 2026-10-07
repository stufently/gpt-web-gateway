# Веха: шаг TOTP в автологине под новую вёрстку OpenAI

- Репозиторий: `~/github/gpt-web-gateway`, дата 2026-10-07.
- Базовый коммит: `9b03171b99f1f9cc74d68b52fc3244ced1a7f366` («Fix text extraction for current Chat UI and incomplete responses»).
- Исполнитель: `gk` (код не про промпты → Grok, правило владельца до 27.10).

## Где работать

Клон `/home/deploy/exec-clones/totp-step`, новая ветка `fix/totp-step`. Живое дерево
`~/github/gpt-web-gateway` не трогать. **Push в origin запрещён** — работу заберёт
постановщик через `git fetch` из клона. Зависимости: `npm ci` в Docker
(`node:20`, как в CI) — ставь сам внутри контейнера, на хост ничего не ставить.
Все команды — в Docker под `-u 1002:1002`.

## Задача и почему

07.10.2026 09:05 UTC прод-автологин ввёл почту и пароль, затем за 10 с не нашёл
поле кода TOTP (`[auto-login] TOTP prompt not found — skipping`), пропустил шаг и
через 5 мин упёрся в `https://auth.openai.com/mfa-challenge?error=totp`
(«Oops, an error occurred!»). Итог — ~10 мин 503 на всех запросах.

Сейчас шаг TOTP (`src/auto-login.js`, «Step 5») ждёт видимости локатора
`input[name="code"], input[autocomplete="one-time-code"], input[type="text"][maxlength="6"]`
ровно 10 000 мс и при неуспехе тихо идёт дальше. Нужно:

1. Вынести шаг в отдельный модуль `src/totp-step.js` с функцией
   `async function fillTotpStep(page, secret, opts)` (тестируется фейковой
   страницей, как `scripts/test-cf-navigate.js`), а `auto-login.js` зовёт её.
2. Ждать появления поля кода ИЛИ адреса страницы MFA (`/mfa-challenge` или
   `/mfa` в `page.url()`) — бюджет по умолчанию 30 с, env `TOTP_PROMPT_TIMEOUT_SEC`.
3. Искать поле шире. Одиночное поле — любой из: `input[name="code"]`,
   `input[autocomplete="one-time-code"]`, `input[inputmode="numeric"]`,
   `input[type="tel"]`, `input[maxlength="6"]` (type text/tel/number/без type).
   Сегментированный ввод — 6 видимых `input[maxlength="1"]` подряд: вводить код
   по одной цифре в каждое поле.
4. Отправка: `button[type="submit"]`, если видим; иначе `Enter` в последнем поле.
5. Если мы НА странице MFA (по URL или по тексту, ищущему код из приложения), а
   поле так и не нашлось — НЕ пропускать молча: бросить ошибку с
   `loginBlockerHint = 'login_form_changed'`, чтобы `step()` снял снимок
   (`captureLoginFailure` уже сохраняет json+jpg). Если ни URL, ни поле не
   появились за бюджет — TOTP не требуется, лог `TOTP prompt not found — skipping`
   как сейчас.
6. Если после ввода URL содержит `error=totp` — бросить ошибку с
   `loginBlockerHint = 'mfa_required'` (код отвергнут), а не идти в chat-ready.

## Проверено вживую / предположения

- Лог пода 07.10 (ns `gpt-web-gateway`): последовательность выше дословно; диаг
  `/app/auth/diag/login-fail-2026-10-07T09-15-13-758Z-chat-ready.json` с
  `url=https://auth.openai.com/mfa-challenge?error=totp`, `inputs ... otp:false`.
- `src/auto-login.js`: `step(page, name, fn)` (стр. ~102) ловит ошибку, зовёт
  `captureLoginFailure(page, {step, error, blockerHint: e.loginBlockerHint})`;
  `generateTOTP` экспортируется; `module.exports = { autoLogin, generateTOTP }`.
- `src/login-diagnostics.js` знает блокеры `mfa_required`, `login_form_changed`
  (константа `LOGIN_BLOCKERS`) — проверь чтением перед использованием.
- **Предположение:** точная вёрстка новой страницы MFA неизвестна (страницу без
  учётных данных не открыть). Поэтому — широкий поиск + обязательный снимок при промахе.

## Не трогать

Всё, кроме: `src/totp-step.js` (новый), `src/auto-login.js` (только шаг 5 → вызов
модуля), `scripts/test-totp-step.js` (новый), `package.json` (только добавить
тест в `npm test`), `CHANGELOG.md` (запись), эта спека.
**Спеку `docs/specs/totp-step.md` ЗАКОММИТЬ вместе с работой** — она приехала untracked. Версию/Chart не менять — релиз делает постановщик.

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -e npm_config_cache=/tmp/.npm -v "$PWD":/app -w /app node:20 sh -c "npm ci --ignore-scripts >/dev/null && npm test"'`
- **AC-002. Тесты модуля покрывают все ветки шага.** Одиночное поле по каждому из 5 селекторов; 6 сегментов (по цифре в каждое); поле появилось через 20 с виртуального времени (старые 10 с бы не дождались); страница MFA без поля даёт ошибку с hint `login_form_changed`; `error=totp` после ввода даёт hint `mfa_required`; ни URL, ни поля — skip без ошибки.
  `bash -c 'docker run --rm -u 1002:1002 -v "$PWD":/app -w /app node:20 node scripts/test-totp-step.js'`
- **AC-003. Четыре мутации убиты обвязкой.** Обвязка `scripts/mutate-totp-step.js` коммитится. Мутации: (a) бюджет 30 с → 10 с; (b) удалить ветку сегментов; (c) заменить бросок `login_form_changed` на тихий skip; (d) убрать проверку `error=totp`. Порядок: чистый прогон зелёный → заменяемый фрагмент встречается ровно один раз → тест упал на своём ассерте → откат с проверкой sha256. rc=0 только если убиты все четыре.
  `bash -c 'docker run --rm -u 1002:1002 -v "$PWD":/app -w /app node:20 node scripts/mutate-totp-step.js'`
- **AC-004. Состав и чистота.**
  `bash -c 'test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md" ":(exclude)node_modules")" && test -z "$(git diff --name-only 9b03171b99f1f9cc74d68b52fc3244ced1a7f366 HEAD | grep -vxE "src/totp-step.js|src/auto-login.js|scripts/test-totp-step.js|scripts/mutate-totp-step.js|package.json|CHANGELOG.md|docs/specs/totp-step.md")"'`

## Авторевью

Перед `report.json` прогони перекрёстное ревью своего результата у Codex
(`bash ~/.claude/skills/ask-codex/scripts/run.sh result "<контекст>"`, он только
читает клон), исправь найденное и коротко запиши вердикт в `note` критерия AC-004.

## Контракт отчёта

`report.json` в корне клона: `{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}` — по записи на каждый критерий, команды дословно как в спеке.

## Контракт на невыполнимое

Не сходится с кодом (нет `LOGIN_BLOCKERS` с нужными именами, `step()` устроен
иначе, `node:20` не тянет зависимости) — остановись, допиши `report-blocked.md`
с фактами и не обходи несовместимость.

## Стыки

Следующий шаг постановщика: релиз образа и проверка при ближайшем слёте сессии
(снимок новой вёрстки, если поле снова не найдётся).
