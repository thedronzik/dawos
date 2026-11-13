/**
 * Диагностика: что dawos видит в конкретном проекте (только чтение).
 *
 *   node test/probe.mjs <project-dir>
 */

import path from 'node:path'
import {
  buildMessage,
  listProjectRoles,
  listSpecs,
  progressOf,
  resolvePrompt,
  resolveTemplatesDir,
} from '../lib/index.js'

const target = process.argv[2]
if (target === undefined) {
  console.error('Usage: node test/probe.mjs <project-dir>')
  process.exit(1)
}

const workspace = path.resolve(target)
const config = {}
const specsRoot = path.join(workspace, 'context', 'spec')

console.log(`проект: ${workspace}`)
const specs = await listSpecs(specsRoot)
console.log(`спеки (${specs.length}):`)
for (const spec of specs) {
  const progress = await progressOf(path.join(specsRoot, spec.dir))
  console.log(`  ${spec.dir} — ${progress.total === 0 ? 'нет tasks.md' : `${progress.done}/${progress.total}`}`)
}

const roles = await listProjectRoles(workspace)
console.log(`роли .claude/agents: ${roles.length === 0 ? 'нет' : roles.join(', ')}`)

const templates = await resolveTemplatesDir(workspace, config)
console.log(`шаблоны: ${templates.source} (${templates.dir})`)

for (const commandName of ['spec', 'tasks', 'implement']) {
  const prompt = await resolvePrompt(workspace, commandName, config)
  const message = buildMessage(prompt.text, { templatesDir: templates.dir, scriptsDir: path.join(import.meta.dirname, '..', 'scripts'), args: 'demo' })
  console.log(`${commandName}: ${prompt.source}, сообщение ${message.length} символов, $ARGUMENTS заменён: ${!message.includes('$ARGUMENTS')}`)
}
