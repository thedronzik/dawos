#!/usr/bin/env node
/**
 * create-spec-directory.mjs — порт AWOS scripts/create-spec-directory.sh.
 *
 *   node create-spec-directory.mjs export-xlsx
 *   → context/spec/003-export-xlsx
 *
 * Нужен, чтобы промпты AWOS, ссылающиеся на .sh, работали на Windows без bash.
 */

import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const BASE_DIR = path.resolve(process.cwd(), 'context', 'spec')
const SPEC_DIR = /^([0-9]{3})-/

const raw = process.argv[2]
if (raw === undefined || raw.trim() === '') {
  console.error('Usage: create-spec-directory.mjs <short-name>')
  process.exit(1)
}

const shortName = raw
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

if (shortName === '') {
  console.error('short-name must contain latin letters or digits')
  process.exit(1)
}

let maxIndex = -1
try {
  const entries = await readdir(BASE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = SPEC_DIR.exec(entry.name)
    if (match === null) continue
    const value = Number.parseInt(match[1], 10)
    if (value > maxIndex) maxIndex = value
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const next = maxIndex < 0 ? 1 : maxIndex + 1
if (next > 999) {
  console.error('Error: next index would exceed 999.')
  process.exit(1)
}

const index = String(next).padStart(3, '0')
const target = path.join(BASE_DIR, `${index}-${shortName}`)
await mkdir(target, { recursive: true })
console.log(`Created: ${path.relative(process.cwd(), target)}`)
