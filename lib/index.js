/**
 * dawos — AWOS-пайплайн для DeepSeek Harness.
 *
 * Что важно:
 *   - Источник истины — `context/` (спеки, продукт, источники), как в AWOS.
 *   - `.awos/` и `.claude/` — необязательный слой совместимости: если в проекте
 *     лежат .awos/commands/*.md, .awos/templates/* или .awos/scripts/*, плагин
 *     использует их (работает как прокси), иначе берёт встроенные копии.
 *   - Плагин никогда не пишет в .awos/ и .claude/.
 *   - Нумерация спек не предполагается: подходят и `001-slug`, и `123456-slug`
 *     (номера задач трекера) — каталог определяется первой числовой группой.
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dawos'
export const inject = ['commands']

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const DEFAULTS = {
  specsDir: 'context/spec',
  productDir: 'context/product',
  sourcesDir: 'context/sources',
  stateFile: '.dawos/state.json',
  proxyProjectFiles: true,
  autoRun: true,
  specDirScript: '.awos/scripts/create-spec-directory.sh',
  bashPath: '',
  // Команды, которые только выводят состояние, дублируют его в чат через модель:
  // в DSH 0.2.x текст результата команды не рендерится в транскрипте.
  statusViaModel: true,
}

/** Восемь команд AWOS: id → краткое описание для меню. */
const AWOS_COMMANDS = [
  ['product', 'Продукт: определение, цели, рамки (context/product)'],
  ['architecture', 'Архитектура: компоненты, границы, решения'],
  ['tech', 'Технические решения: файлы, данные, риски'],
  ['spec', 'Функциональная спека: что видит и делает пользователь'],
  ['tasks', 'Задачи: вертикальные слайсы, [Agent: …], критерии проверки'],
  ['implement', 'Исполнение: делегирование задач субагентам, чекбоксы'],
  ['verify', 'Приёмка: проверки, тесты, критерии закрытия'],
  ['hire', 'Роли-эксперты: описания агентов для делегирования'],
]

/** Каталог спеки: первая числовая группа задаёт индекс (001, 123456, …). */
const SPEC_DIR = /^(\d+)-(.+)$/

/** Карта инструментов Claude Code → DSH. */
const PREFACE = [
  'Ты исполняешь команду методологии AWOS в DeepSeek Harness.',
  'Инструменты Claude Code заменены на нативные DSH:',
  '- AskUserQuestion → ask_user_question (не задавай вопросы простым текстом, используй инструмент);',
  '- Task / subagent → delegate с library_id: planner | coder | reviewer | devops;',
  '- Write → write, Edit → edit, Read → read, Glob → glob, Grep → grep;',
  '- Bash → pwsh (Windows), TodoWrite → todo_write;',
  '- SlashCommand /awos:x → команда /dawos-x этого же плагина.',
  'Маркеры [Agent: name] в tasks.md — роли конкретного проекта, а не id библиотеки.',
  'Правило делегирования: посмотри .claude/agents/<name>.md (если есть), передай его',
  'содержимое первым блоком промпта делегата, а library_id выбирай так:',
  'qa/test/review → reviewer; devops/infra/deploy → devops; остальное → coder.',
  'Файлы проекта: context/spec/<NNN|ПФ>-slug/{functional-spec,technical-considerations,tasks}.md,',
  'context/product/, context/sources/. Не создавай .awos/ и .claude/ — они не нужны.',
  'Все пути в тексте команды ниже уже переписаны под DSH.',
  'Отвечай по-русски, если пользователь пишет по-русски.',
].join('\n')

function workspaceOf(invocation) {
  const header = invocation?.agent?.session?.header
  const candidates = [header?.cwd, header?.workspace, header?.directory, process.cwd()]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return process.cwd()
}

async function isDir(target) {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Каталог шаблонов: .awos/templates, если он есть и прокси включён, иначе встроенный. */
export async function resolveTemplatesDir(workspace, config) {
  const project = path.resolve(workspace, '.awos', 'templates')
  if (config.proxyProjectFiles !== false && (await isDir(project))) {
    return { dir: project, source: 'project' }
  }
  return { dir: path.join(PLUGIN_DIR, 'templates'), source: 'bundled' }
}

/** Текст команды: .awos/commands/<name>.md, если есть, иначе встроенный. */
export async function resolvePrompt(workspace, commandName, config) {
  const project = path.resolve(workspace, '.awos', 'commands', `${commandName}.md`)
  if (config.proxyProjectFiles !== false && (await pathExists(project))) {
    return { text: await readFile(project, 'utf8'), source: 'project', file: project }
  }
  const bundled = path.join(PLUGIN_DIR, 'prompts', `${commandName}.md`)
  return { text: await readFile(bundled, 'utf8'), source: 'bundled', file: bundled }
}

/** Собрать сообщение модели: преамбула + адаптированный текст команды + аргументы. */
export function buildMessage(commandText, options) {
  const { templatesDir, scriptsDir, args } = options
  let body = commandText

  body = body.split('.awos/templates/').join(`${templatesDir}/`)
  body = body.split('.awos/commands/').join(`${PLUGIN_DIR}/prompts/`)
  body = body
    .split('.awos/scripts/create-spec-directory.sh')
    .join(`node "${path.join(scriptsDir, 'create-spec-directory.mjs')}"`)
  body = body.split('.claude/agents/').join('.claude/agents/')

  const filled = body.split('$ARGUMENTS').join(args)

  const tail =
    args.length > 0
      ? `\n\n---\nАргументы пользователя: ${args}`
      : '\n\n---\nАргументы пользователя не переданы — определи их из контекста сессии или спроси через ask_user_question.'

  return `${PREFACE}\n\n---\n\n${filled}${tail}`
}

/** Все папки спек в context/spec: служебные (_archive, .git) пропускаются. */
export async function listSpecs(root) {
  if (!(await isDir(root))) return []
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, match: SPEC_DIR.exec(entry.name) }))
    .filter(({ entry, match }) => match !== null && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map(({ match }) => ({ id: match[1], slug: match[2], dir: match[0] }))
    .sort((left, right) => Number(left.id) - Number(right.id) || left.dir.localeCompare(right.dir))
}

/** Прогресс по tasks.md спеки. */
export async function progressOf(specDir) {
  const file = path.join(specDir, 'tasks.md')
  if (!existsSync(file)) return { total: 0, done: 0, open: [], hasTasks: false }
  const text = await readFile(file, 'utf8')
  const open = []
  let total = 0
  let done = 0
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^(\s*)- \[( |x|X)\] (.*)$/.exec(line)
    if (match === null) return
    total += 1
    if (match[2].toLowerCase() === 'x') done += 1
    else open.push({ line: index + 1, indent: match[1].length, text: match[3].trim() })
  })
  return { total, done, open, hasTasks: true }
}

/** роли проекта из .claude/agents/*.md */
export async function listProjectRoles(workspace) {
  const dir = path.resolve(workspace, '.claude', 'agents')
  if (!(await isDir(dir))) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name.slice(0, -3))
}

async function readState(workspace, config) {
  const file = path.resolve(workspace, config.stateFile)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return typeof parsed?.spec === 'string' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeState(workspace, config, state) {
  const file = path.resolve(workspace, config.stateFile)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** Найти спеку: 2, 002, 123456, 002-slug, slug, фрагмент. */
function matchSpec(specs, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return undefined
  return (
    specs.find((spec) => spec.dir.toLowerCase() === needle) ??
    specs.find((spec) => spec.id === needle) ??
    specs.find((spec) => spec.slug.toLowerCase() === needle) ??
    specs.find((spec) => spec.dir.toLowerCase().startsWith(`${needle}-`)) ??
    specs.find((spec) => spec.dir.toLowerCase().includes(needle))
  )
}

/**
 * Отправить сообщение модели.
 *
 * `@deepseek-ai/dsh-llm` лежит внутри приложения и из профиля не резолвится
 * обычным ESM-загрузчиком, поэтому пробуем два пути: фабрику сообщения из ядра,
 * затем — объект пользовательского сообщения той же формы.
 */
export async function deliver(invocation, text) {
  const agent = invocation?.agent
  if (typeof agent?.followup !== 'function') return false
  const content = [{ type: 'text', text }]
  const source = { kind: 'dawos', form: 'command' }

  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    if (typeof createUserMessage === 'function') {
      await agent.followup(createUserMessage({ content, source }))
      return true
    }
  } catch {
    // пакет ядра недоступен из профиля — идём вторым путём
  }

  try {
    await agent.followup({ content, source })
    return true
  } catch {
    return false
  }
}

/** bash для запуска проектного скрипта: настройка, PATH, затем Git for Windows. */
async function findBash(config) {
  if (typeof config.bashPath === 'string' && config.bashPath !== '' && existsSync(config.bashPath)) return config.bashPath
  for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash']) {
    if (existsSync(candidate)) return candidate
  }
  return 'bash'
}

/**
 * Запустить проектный скрипт создания папки спеки (прокси-режим).
 * Возвращает { ok, out, err } — вывод как есть, чтобы правила проекта сохранялись.
 */
export async function runSpecScript(workspace, config, tokens) {
  const script = path.resolve(workspace, config.specDirScript)
  if (config.proxyProjectFiles === false || !(await pathExists(script))) return undefined
  const bash = await findBash(config)
  return new Promise((resolve) => {
    const child = spawn(bash, [script, ...tokens], { cwd: workspace })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      err += chunk.toString()
    })
    child.on('error', () => resolve({ ok: false, out: '', err: 'bash недоступен' }))
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim() }))
  })
}

/**
 * Показать результат пользователю.
 *
 * В DSH 0.2.x `command/done.text` пишется в журнал, но не попадает в транскрипт:
 * результат команды рендерится отдельным узлом потока, которого в компактном
 * виде нет. Поэтому информационные команды дублируют текст в чат через модель.
 */
export async function announce(invocation, config, text) {
  if (config.statusViaModel === false) return false
  return deliver(
    invocation,
    `dawos: результат команды, покажи его пользователю —\n\n${text}\n\nОтветь коротко, без вызова инструментов.`,
  )
}

/** каталог, созданный или найденный скриптом ("Created: …", "Exists: …"). */
function specDirFromScriptOutput(out) {
  const match = /^(?:Created|Exists):\s*(.+)$/m.exec(out)
  if (match === null) return undefined
  return match[1].trim().replace(/^\.\//, '')
}

/** Следующий свободный номер: ширина берётся по существующим (001 → 3, 123456 → 6). */
function nextIndex(specs) {
  if (specs.length === 0) return '001'
  const width = Math.max(3, ...specs.map((spec) => spec.id.length))
  const max = specs.reduce((acc, spec) => Math.max(acc, Number(spec.id)), 0)
  const next = max + 1
  if (next > 999999) throw new Error('следующий номер превышает 999999')
  return String(next).padStart(width, '0')
}

function slugify(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const specsRootOf = (workspace) => path.resolve(workspace, config.specsDir)
  const register = (definition) => ctx.commands.register(definition)

  /** Общий обработчик команд AWOS. */
  const runAwos = (commandName) => async (invocation) => {
    const workspace = workspaceOf(invocation)
    const args = (invocation.rawInput ?? '').trim()
    try {
      const prompt = await resolvePrompt(workspace, commandName, config)
      const templates = await resolveTemplatesDir(workspace, config)
      const message = buildMessage(prompt.text, {
        templatesDir: templates.dir,
        scriptsDir: path.join(PLUGIN_DIR, 'scripts'),
        args,
      })
      if (config.autoRun === false) {
        return { kind: 'success', text: `/dawos-${commandName}: промпт собран (${prompt.source}), автозапуск выключен.` }
      }
      const sent = await deliver(invocation, message)
      const source = prompt.source === 'project' ? '.awos/commands' : 'встроенный'
      return {
        kind: 'success',
        text: sent
          ? `/dawos-${commandName}: передано модели (промпт: ${source}, шаблоны: ${templates.source === 'project' ? '.awos/templates' : 'встроенные'}).`
          : `/dawos-${commandName}: промпт собран (${source}), но передать его в сессию не удалось — напиши «выполняй /dawos-${commandName}», и я продолжу по нему.`,
      }
    } catch (error) {
      return { kind: 'error', text: `/dawos-${commandName}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  for (const [commandName, description] of AWOS_COMMANDS) {
    register({
      name: `dawos-${commandName}`,
      description,
      input: { hint: 'аргументы команды (необязательно)' },
      handler: runAwos(commandName),
    })
  }

  register({
    name: 'dawos',
    description: 'AWOS: состояние проекта (спеки, прогресс, роли, следующий шаг)',
    async handler(invocation) {
      const workspace = workspaceOf(invocation)
      const root = specsRootOf(workspace)
      try {
        const specs = await listSpecs(root)
        const state = await readState(workspace, config)
        const hasContext = await isDir(path.resolve(workspace, 'context'))
        const hasAwos = await isDir(path.resolve(workspace, '.awos'))
        const roles = await listProjectRoles(workspace)
        const lines = []

        if (!hasContext) lines.push('Каталога context/ нет. Начни с /dawos-product — он создаст context/product/.')
        if (specs.length === 0) {
          lines.push('Спек нет. Создай первую: /dawos-new <short-name>')
        } else {
          lines.push(`Спеки в ${config.specsDir}/ (* активная):`)
          for (const spec of specs) {
            const progress = await progressOf(path.join(root, spec.dir))
            lines.push(`${state.spec === spec.dir ? '*' : ' '} ${spec.dir} — ${progress.total === 0 ? 'нет задач' : `${progress.done}/${progress.total}`}`)
          }
        }
        if (state.spec !== undefined) {
          const active = specs.find((spec) => spec.dir === state.spec)
          if (active !== undefined) {
            const progress = await progressOf(path.join(root, active.dir))
            const next = progress.open.slice(0, 3).map((item) => `  - ${item.text} (строка ${item.line})`)
            lines.push(`\nСледующие шаги в ${active.dir}:`, ...(next.length > 0 ? next : ['  - все задачи закрыты']))
          }
        }
        if (roles.length > 0) lines.push(`\nРоли проекта (.claude/agents): ${roles.join(', ')}`)
        if (hasAwos) lines.push('\nПроект содержит .awos/ — команды, шаблоны и скрипт создания папки берутся из него (прокси включён).')
        lines.push('\nКоманды: /dawos-new, /dawos-switch, /dawos-status, /dawos-spec, /dawos-tasks, /dawos-tech, /dawos-architecture, /dawos-product, /dawos-implement, /dawos-verify, /dawos-hire')
        const body = lines.join('\n')
        await announce(invocation, config, body)
        return { kind: 'success', text: body }
      } catch (error) {
        return { kind: 'error', text: `/dawos: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  register({
    name: 'dawos-new',
    description: 'Создать папку спеки: /dawos-new <slug> или /dawos-new <номер> <slug>',
    input: { hint: '<slug> | <id> <slug>' },
    async handler(invocation) {
      const workspace = workspaceOf(invocation)
      const root = specsRootOf(workspace)
      try {
        const tokens = (invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        if (tokens.length === 0) return { kind: 'error', text: 'Нужно имя: /dawos-new export-xlsx или /dawos-new 123456 export-xlsx' }

        // Прокси: если в проекте есть свой скрипт — правила проекта главнее.
        const script = await runSpecScript(workspace, config, tokens)
        if (script !== undefined) {
          const dir = specDirFromScriptOutput(script.out)
          if (!script.ok) {
            return { kind: 'error', text: [script.out, script.err].filter(Boolean).join('\n') || 'проектный скрипт завершился с ошибкой' }
          }
          if (dir !== undefined) {
            const created = path.basename(dir)
            await writeState(workspace, config, { ...(await readState(workspace, config)), spec: created })
            const body = `${script.out}\nАктивная спека: ${created}\nДальше: /dawos-spec ${created}`
            await announce(invocation, config, body)
            return { kind: 'success', text: body }
          }
          await announce(invocation, config, script.out)
          return { kind: 'success', text: script.out }
        }

        // Встроенное поведение: номер + slug, ширина по существующим спекам.
        const first = tokens[0]
        const numeric = /^\d+$/.test(first)
        if (numeric && tokens.length < 2) {
          return { kind: 'error', text: 'Похоже на номер без имени. Формат: /dawos-new 123456 export-xlsx' }
        }
        let id
        let slug
        if (numeric) {
          id = first
          slug = slugify(tokens.slice(1).join(' '))
        } else {
          id = nextIndex(await listSpecs(root))
          slug = slugify(tokens.join(' '))
        }
        if (slug === undefined || slug === '') return { kind: 'error', text: 'Не удалось разобрать короткое имя.' }
        const dir = `${id}-${slug}`
        await mkdir(path.join(root, dir), { recursive: true })
        await writeState(workspace, config, { ...(await readState(workspace, config)), spec: dir })
        const body = `Создано: ${config.specsDir}/${dir} (активная спека)\nДальше: /dawos-spec ${id}`
        await announce(invocation, config, body)
        return { kind: 'success', text: body }
      } catch (error) {
        return { kind: 'error', text: `/dawos-new: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  register({
    name: 'dawos-switch',
    description: 'Выбрать активную спеку и передать её контекст модели',
    input: { hint: 'номер или slug: 002, 2, 123456, 002-export, export' },
    async handler(invocation) {
      const workspace = workspaceOf(invocation)
      const root = specsRootOf(workspace)
      try {
        const specs = await listSpecs(root)
        if (specs.length === 0) return { kind: 'error', text: 'Спек нет: /dawos-new <short-name>' }
        const query = (invocation.rawInput ?? '').trim()
        if (query === '') return { kind: 'error', text: `Укажи спеку: ${specs.map((spec) => spec.dir).join(', ')}` }
        const spec = matchSpec(specs, query)
        if (spec === undefined) return { kind: 'error', text: `Спека "${query}" не найдена.` }
        await writeState(workspace, config, { ...(await readState(workspace, config)), spec: spec.dir })
        const progress = await progressOf(path.join(root, spec.dir))
        const text = [
          `Активная спека: ${config.specsDir}/${spec.dir} (${progress.done}/${progress.total}).`,
          'Прочитай functional-spec.md, technical-considerations.md и tasks.md этой спеки.',
          'Продолжай по /dawos-implement: первый незакрытый пункт — следующим шагом.',
        ].join('\n')
        const sent = await deliver(invocation, text)
        return {
          kind: 'success',
          text: sent
            ? `Активная спека: ${spec.dir} (${progress.done}/${progress.total})`
            : `Активная спека: ${spec.dir}. Напиши «продолжай», чтобы я прочитал её файлы.`,
        }
      } catch (error) {
        return { kind: 'error', text: `/dawos-switch: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  register({
    name: 'dawos-status',
    description: 'Прогресс активной спеки и незакрытые задачи',
    async handler(invocation) {
      const workspace = workspaceOf(invocation)
      const root = specsRootOf(workspace)
      try {
        const state = await readState(workspace, config)
        if (state.spec === undefined) return { kind: 'error', text: 'Активная спека не выбрана: /dawos-switch 002' }
        const progress = await progressOf(path.join(root, state.spec))
        const head = `${state.spec}: ${progress.total === 0 ? 'нет задач' : `${progress.done}/${progress.total}`}`
        if (!progress.hasTasks) {
          const body = `${head}\nВ спеке нет tasks.md — /dawos-tasks ${state.spec}`
          await announce(invocation, config, body)
          return { kind: 'success', text: body }
        }
        if (progress.open.length === 0) {
          const body = `${head}\nВсе задачи закрыты.`
          await announce(invocation, config, body)
          return { kind: 'success', text: body }
        }
        const rows = progress.open
          .slice(0, 15)
          .map((item) => `${' '.repeat(item.indent)}- [ ] ${item.text} (строка ${item.line})`)
        const more = progress.open.length > 15 ? `\n…ещё ${progress.open.length - 15}` : ''
        const body = `${head}\n\nНезакрытые:\n${rows.join('\n')}${more}`
        await announce(invocation, config, body)
        return { kind: 'success', text: body }
      } catch (error) {
        return { kind: 'error', text: `/dawos-status: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}
