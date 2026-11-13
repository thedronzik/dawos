/**
 * Проверка dawos без запуска DSH.
 *
 *   node test/verify.mjs
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  apply,
  buildMessage,
  listProjectRoles,
  listSpecs,
  name,
  inject,
  progressOf,
  resolvePrompt,
  resolveTemplatesDir,
} from '../lib/index.js'

const commands = new Map()
apply(
  {
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
      },
    },
  },
  {},
)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

async function run(command, rawInput, cwd) {
  const definition = commands.get(command)
  if (definition === undefined) throw new Error(`команда ${command} не зарегистрирована`)
  return definition.handler({
    rawInput,
    agent: { followup: async () => {}, session: { header: { cwd } } },
    attachments: [],
    signal: new AbortController().signal,
  })
}

const root = await mkdtemp(path.join(tmpdir(), 'dawos-'))

try {
  console.log('meta')
  check('name = dawos', name === 'dawos')
  check('inject commands', inject.includes('commands'))
  check('12 команд', commands.size === 12, `${commands.size}: ${[...commands.keys()].join(',')}`)
  check(
    'есть все восемь AWOS',
    ['product', 'architecture', 'tech', 'spec', 'tasks', 'implement', 'verify', 'hire'].every((id) => commands.has(`dawos-${id}`)),
  )

  console.log('/dawos на пустом проекте')
  let result = await run('dawos', '', root)
  check('предупреждает про context/', result.text.includes('Каталога context/ нет'), result.text)
  check('предлагает /dawos-new', result.text.includes('/dawos-new'), result.text)

  console.log('/dawos-new (автонумерация)')
  result = await run('dawos-new', 'Export XLSX', root)
  check('создано 001-export-xlsx', result.text.includes('001-export-xlsx'), result.text)
  const specsRoot = path.join(root, 'context', 'spec')
  let specs = await listSpecs(specsRoot)
  check('listSpecs видит спеку', specs.length === 1 && specs[0].id === '001', JSON.stringify(specs))

  console.log('нумерация как в трекере')
  await mkdir(path.join(specsRoot, '123456-marketplace-reviews'), { recursive: true })
  await mkdir(path.join(specsRoot, '_archive'), { recursive: true })
  specs = await listSpecs(specsRoot)
  check('шестизначный номер распознан', specs.some((spec) => spec.id === '123456'), JSON.stringify(specs))
  check('_archive пропущен', !specs.some((spec) => spec.dir === '_archive'), JSON.stringify(specs))
  result = await run('dawos-switch', '123456', root)
  check('переключение по номеру ПФ', result.text.includes('123456-marketplace-reviews'), result.text)

  result = await run('dawos-new', '123457 roborock', root)
  check('явный номер + slug', result.text.includes('123457-roborock'), result.text)

  console.log('/dawos-new: только номер — ошибка')
  result = await run('dawos-new', '777', root)
  check('просит имя', result.kind === 'error' && result.text.includes('номер без имени'), result.text)

  console.log('/dawos-switch')
  result = await run('dawos-switch', '1', root)
  check('переключение по короткому номеру', result.text.includes('001-export-xlsx'), result.text)
  result = await run('dawos-switch', 'export', root)
  check('переключение по slug', result.text.includes('001-export-xlsx'), result.text)
  result = await run('dawos-switch', 'нет', root)
  check('ошибка на неизвестной', result.kind === 'error', result.text)

  console.log('tasks.md прогресс')
  await writeFile(
    path.join(specsRoot, '001-export-xlsx', 'tasks.md'),
    ['- [ ] **Slice 1**', '  - [x] [Agent: backend-dev] шаг один', '  - [ ] [Agent: coder] шаг два'].join('\n'),
    'utf8',
  )
  const progress = await progressOf(path.join(specsRoot, '001-export-xlsx'))
  check('прогресс 1/3', progress.done === 1 && progress.total === 3, JSON.stringify(progress))
  result = await run('dawos-status', '', root)
  check('статус показывает 1/3', result.text.includes('1/3'), result.text)

  console.log('роли проекта')
  await mkdir(path.join(root, '.claude', 'agents'), { recursive: true })
  await writeFile(path.join(root, '.claude', 'agents', 'backend-dev.md'), '# qa', 'utf8')
  await writeFile(path.join(root, '.claude', 'agents', 'frontend-dev.md'), '# front', 'utf8')
  const roles = await listProjectRoles(root)
  check('роли прочитаны', roles.includes('backend-dev') && roles.includes('frontend-dev'), JSON.stringify(roles))
  result = await run('dawos', '', root)
  check('статус показывает роли', result.text.includes('backend-dev'), result.text)

  console.log('промпты и прокси .awos')
  const bundled = await resolvePrompt(root, 'spec', {})
  check('без .awos берётся встроенный', bundled.source === 'bundled', bundled.source)
  const templates = await resolveTemplatesDir(root, {})
  check('встроенные шаблоны', templates.source === 'bundled', templates.source)

  await mkdir(path.join(root, '.awos', 'commands'), { recursive: true })
  await mkdir(path.join(root, '.awos', 'templates'), { recursive: true })
  await writeFile(path.join(root, '.awos', 'commands', 'spec.md'), '# PROJECT_PROMPT_MARKER\n$ARGUMENTS', 'utf8')
  const proxied = await resolvePrompt(root, 'spec', {})
  check('.awos/commands подхвачен', proxied.source === 'project' && proxied.text.includes('PROJECT_PROMPT_MARKER'))
  const proxiedTemplates = await resolveTemplatesDir(root, {})
  check('.awos/templates подхвачен', proxiedTemplates.source === 'project', proxiedTemplates.source)
  const disabled = await resolvePrompt(root, 'spec', { proxyProjectFiles: false })
  check('прокси можно выключить', disabled.source === 'bundled', disabled.source)

  console.log('сборка сообщения')
  const message = buildMessage(
    'Шаблон: .awos/templates/functional-spec-template.md\nСкрипт: .awos/scripts/create-spec-directory.sh\nПромпт: <user_prompt>$ARGUMENTS</user_prompt>',
    { templatesDir: '/tpl', scriptsDir: '/scripts', args: '002-export-xlsx' },
  )
  check('путь шаблона переписан', message.includes('/tpl/functional-spec-template.md'), message.slice(0, 200))
  check('скрипт переписан на node', message.includes('create-spec-directory.mjs'))
  check('$ARGUMENTS подставлен', message.includes('002-export-xlsx') && !message.includes('$ARGUMENTS'))
  check('карта инструментов', message.includes('ask_user_question') && message.includes('delegate'))
  check('правило [Agent:]', message.includes('[Agent: name]') && message.includes('reviewer'))

  console.log('проектный скрипт создания папки (прокси)')
  const scriptDir = path.join(root, '.awos', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await writeFile(
    path.join(scriptDir, 'create-spec-directory.sh'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', 'PF=$1', 'NAME=$2', 'mkdir -p "context/spec/$PF-$NAME"', 'echo "Created: context/spec/$PF-$NAME"'].join('\n'),
    'utf8',
  )
  result = await run('dawos-new', '555555 custom-rule', root)
  check('скрипт проекта вызван', result.kind === 'success' && result.text.includes('Created:'), result.text)
  const created = await listSpecs(specsRoot)
  check('скрипт создал 555555-custom-rule', created.some((spec) => spec.dir === '555555-custom-rule'), JSON.stringify(created.map((spec) => spec.dir)))

  console.log('команда AWOS через плагин')
  result = await run('dawos-spec', 'export', root)
  check('промпт передан (fallback без ядра)', result.kind === 'success' && result.text.includes('передано модели'), result.text)

  const definition = commands.get('dawos-spec')
  result = await definition.handler({
    rawInput: 'export',
    agent: {
      followup: async () => {
        throw new Error('нет канала')
      },
      session: { header: { cwd: root } },
    },
    attachments: [],
    signal: new AbortController().signal,
  })
  check('если доставить нечем — честная подсказка', result.kind === 'success' && result.text.includes('не удалось'), result.text)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nVALIDATION: OK' : `\nVALIDATION: FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
