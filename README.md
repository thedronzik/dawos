# dawos

AWOS-пайплайн для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
команды `/dawos-*` работают поверх `context/` — спеки, продукт, источники —
и совместимы с проектами, где уже стоит AWOS.

```
/dawos-product          → context/product/
/dawos-spec 002         → context/spec/002-export-xlsx/functional-spec.md
/dawos-tasks 002        → …/tasks.md (слайсы + [Agent: coder] + критерии проверки)
/dawos-implement        → делегирование задач субагентам, чекбоксы
/dawos-verify           → приёмка и проверки
```

## Что важно

**Источник истины — `context/`.** Плагин читает и пишет только его:
`context/spec/<номер>-slug/`, `context/product/`, `context/sources/`.

**`.awos/` и `.claude/` — необязательный слой.** Они специфичны для Claude Code
и для работы не нужны. Но если они есть в проекте, плагин работает как прокси
и берёт оттуда:

| Что | Откуда | Если нет |
|---|---|---|
| Тексты команд | `.awos/commands/*.md` | встроенные копии из `prompts/` |
| Шаблоны документов | `.awos/templates/*.md` | встроенные из `templates/` |
| Создание папки спеки | `.awos/scripts/create-spec-directory.sh` | встроенная логика на Node |
| Роли субагентов | `.claude/agents/*.md` | `coder` по умолчанию |

В `.awos/` и `.claude/` плагин **ничего не пишет**.

## Нумерация спек

Плагин не навязывает схему. Индекс спеки — первая числовая группа имени каталога:

- `001-export-xlsx`, `002-auth-refresh` — порядковый номер;
- `123456-some-feature` — номер задачи из внешнего трекера, если в проекте
  так принято (плагин такие номера только читает).

Каталоги с `_` в начале (например `_archive`) и скрытые — пропускаются.
Если в проекте есть свой скрипт создания папки, вызывается он: правила проекта
главнее встроенных.

## Роли субагентов

Маркеры в `tasks.md` выглядят как `**[Agent: backend-dev]**` — это роли проекта.
Плагин передаёт модели правило: взять `.claude/agents/<name>.md`, положить его
текст в промпт делегата, а `library_id` выбрать по смыслу:

| Признак имени | library_id |
|---|---|
| `qa`, `test`, `review`, `verif` | `reviewer` |
| `devops`, `infra`, `deploy`, `seo` | `devops` |
| остальное (front, back, …) | `coder` |

## Команды

| Команда | Что делает |
|---|---|
| `/dawos` | состояние: спеки, прогресс, роли, активная спека, следующий шаг |
| `/dawos-new export-xlsx` | создать спеку с автономером |
| `/dawos-new 123456 export-xlsx` | создать спеку с явным номером |
| `/dawos-switch 002` | выбрать активную и передать её контекст модели |
| `/dawos-status` | незакрытые задачи активной спеки |
| `/dawos-product` | определение продукта |
| `/dawos-architecture` | архитектура: компоненты, границы, решения |
| `/dawos-tech` | технические решения: файлы, данные, риски |
| `/dawos-spec` | функциональная спека |
| `/dawos-tasks` | вертикальные слайсы и задачи |
| `/dawos-implement` | исполнение: по задаче на субагента |
| `/dawos-verify` | приёмка: тесты, проверки, критерии закрытия |
| `/dawos-hire` | роли-эксперты для делегирования |

Тексты команд не переписаны: перед ними подставляется карта инструментов —
`AskUserQuestion → ask_user_question`, `Task → delegate`,
`Write/Edit/Read → write/edit/read`, `Bash → pwsh`, `TodoWrite → todo_write`,
`/awos:x → /dawos-x`. Так проект с настроенным AWOS продолжает работать без миграций.

## Установка

Из GitHub:

```sh
dsh plugin --profile desktop add github:<owner>/dawos
```

Или в приложении: **Настройки → Плагины → Add plugin** → `github:<owner>/dawos`.

Из локальной папки:

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "dawos": "link:/path/to/dawos" },
  "dsh": { "profile": { "bundles": ["…", "dawos"] } }
}
```

После установки перезапустить DSH: меняется композиция профиля.

## Работа в существующем AWOS-проекте

1. Открыть проект в DSH.
2. `/dawos` — покажет спеки, прогресс и роли, отметит, что `.awos/` подхвачен.
3. `/dawos-switch <номер>` — продолжить с того же места, где остановился Claude Code.

Переносить и мигрировать нечего: файлы те же.

## Совместимость

Плагин проверен на метарепозиториях с разными соглашениями: порядковая
нумерация (`001-…`) и номера задач из трекера (`123456-…`), с кастомизированными
`.awos/commands` и собственными ролями в `.claude/agents`. Локальные проверки
на конкретных проектах в репозиторий не попадают — см. `.gitignore`.

## Настройки

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `specsDir` | `context/spec` | Каталог спек |
| `productDir` | `context/product` | Продуктовые артефакты |
| `sourcesDir` | `context/sources` | Внешние источники |
| `stateFile` | `.dawos/state.json` | Активная спека (в git не нужен) |
| `proxyProjectFiles` | `true` | Читать `.awos/*` и `.claude/agents` |
| `specDirScript` | `.awos/scripts/create-spec-directory.sh` | Проектный скрипт создания папки |
| `bashPath` | авто | bash для скрипта проекта |
| `autoRun` | `true` | Сразу отправлять промпт модели |
| `statusViaModel` | `true` | Информационные команды дублируют результат в чат |

## Проверка

```sh
node test/verify.mjs              # 30 проверок без запуска DSH
node test/probe.mjs <project-dir> # что плагин видит в конкретном проекте
```

## Лицензия

MIT. Тексты команд в `prompts/` и шаблоны в `templates/` — из
[provectus/awos](https://github.com/provectus/awos), © Provectus IT, Inc.,
MIT. Подробности в [NOTICE](NOTICE).
