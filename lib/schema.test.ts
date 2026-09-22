import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (entry === 'node_modules' || entry === '.next') return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })

const valueCount = (values: string): number => {
  let depth = 0
  let count = 1
  for (const character of values) {
    if ('([{'.includes(character)) depth += 1
    else if (')]}'.includes(character)) depth -= 1
    else if (character === ',' && depth === 0) count += 1
  }
  return count
}

const closingIndex = (text: string): number => {
  let depth = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') { depth -= 1; if (!depth) return index }
  }
  return -1
}

let checked = 0
for (const path of [...sourceFiles('lib'), ...sourceFiles('app')]) {
  const text = readFileSync(path, 'utf8')
  const pattern = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)\s*\n?\s*VALUES\s*\(/gi
  for (const match of text.matchAll(pattern)) {
    const [table, columns] = [match[1], match[2]]
    const tail = text.slice(match.index + match[0].length)
    const end = closingIndex(tail)
    if (end < 0) continue
    const expected = columns.split(',').filter(column => column.trim()).length
    const actual = valueCount(tail.slice(0, end))
    assert.equal(actual, expected, `${path}: INSERT INTO ${table} lists ${expected} columns but ${actual} values`)
    checked += 1
  }
}

assert.ok(checked > 20, `expected to check many inserts, checked ${checked}`)
console.log(`ok - ${checked} inserts balance their column and value lists`)
