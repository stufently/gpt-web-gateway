# Веха: добить выживших мутантов шага TOTP (только тесты)

- Репозиторий: `~/github/gpt-web-gateway`, база — ветка `fix/totp-step`, коммит `b0092b3` («Fail closed when the TOTP prompt is missed»). Дата 2026-10-07.
- Исполнитель: `gk` — заход исправлений внутри вехи остаётся её исполнителю (код писал Grok).

## Где работать

Клон `/home/deploy/exec-clones/totp-tests`, ветка `fix/totp-tests`. Живое дерево
не трогать. **Push в origin запрещён**, работу заберёт постановщик через `git fetch`.
Всё — в Docker `node:20` под `-u 1002:1002`.

## Задача и почему

Независимый мутационный прогон Codex по `src/totp-step.js` (полный отчёт —
`/tmp/claude-1002/-home-deploy-gitlab-9qw-tg-claude-userbot/a2b1fed0-236e-40df-9810-6dff423c40f4/scratchpad/totp-mutations.md`,
там же точные замены) оставил живыми мутантов, которых тесты обязаны ловить:

1. M17 — `onAuthHost` перестаёт узнавать `auth0.com`.
2. M18 — `reachedApp` перестаёт узнавать `chat.openai.com`.
3. M25 — при отсутствии кнопки Enter жмётся в ПЕРВОМ сегменте, а не в последнем.
4. M26 — `mintCode` не проверяет, что код из шести цифр.
5. M27 — `mintCode` не приводит результат генератора к строке.
6. M31 — `mintCode` теряет ведущий ноль (код вида `012345`).

Плюс M03, M04, M30 (граничные таймеры): убей тестом или письменно обоснуй
эквивалентность в `note` критерия AC-002.

Допиши тесты в `scripts/test-totp-step.js` и добавь эти мутации (точные замены
из отчёта) в свою обвязку `scripts/mutate-totp-step.js`, чтобы они проверялись
постоянно. Боевой код `src/` НЕ меняй. Если какой-то мутант убить нельзя без
правки `src/` — остановись по контракту.

## Что проверено вживую

- Отчёт Codex: 32 мутации, 23 убито, 9 выжило, baseline 29 PASS; sha256
  `src/totp-step.js` = `3aa16b98731f1fc76e0e722fbb6dd2e15ae3eae91ff1fea80603c0b0e248d02c`.
- `scripts/mutate-totp-step.js` в базе убивает 4 мутации (бюджет, сегменты, тихий skip, `error=totp`).

## Авторевью

Перед `report.json` прогони перекрёстное ревью у Codex
(`bash ~/.claude/skills/ask-codex/scripts/run.sh result "<контекст>"`, он только
читает), исправь найденное, вердикт — в `note` AC-003.

## Не трогать

Всё, кроме `scripts/test-totp-step.js`, `scripts/mutate-totp-step.js` и этой
спеки. **Спеку `docs/specs/totp-tests.md` ЗАКОММИТЬ вместе с работой.**

## Критерии приёмки

- **AC-001. Полный сьют зелёный.**
  `bash -c 'docker run --rm -u 1002:1002 -e HOME=/tmp -e npm_config_cache=/tmp/.npm -v "$PWD":/app -w /app node:20 sh -c "npm ci --ignore-scripts >/dev/null && npm test"'`
- **AC-002. Обвязка убивает прежние четыре и новые мутации.** Шесть из списка выше обязательны; M03, M04, M30 — убиты или исключены с обоснованием. rc=0 только если все включённые убиты на своих ассертах.
  `bash -c 'docker run --rm -u 1002:1002 -v "$PWD":/app -w /app node:20 node scripts/mutate-totp-step.js'`
- **AC-003. Боевой код не тронут, состав и чистота.**
  `bash -c 'git diff --quiet b0092b3 HEAD -- src package.json && test -z "$(git status --porcelain -- . ":(exclude)report.json" ":(exclude)report-blocked.md" ":(exclude)node_modules")" && test -z "$(git diff --name-only b0092b3 HEAD | grep -vxE "scripts/test-totp-step.js|scripts/mutate-totp-step.js|docs/specs/totp-tests.md")"'`

## Контракт отчёта

`report.json` в корне клона: `{"criteria": [{"id": "AC-001", "status": "pass|fail|blocked", "command": "…", "rc": 0, "note": "…"}]}`, команды дословно как в спеке.

## Контракт на невыполнимое

Мутанта не убить без правки `src/`, или базовый сьют не зелёный — остановись, `report-blocked.md` с фактами.
