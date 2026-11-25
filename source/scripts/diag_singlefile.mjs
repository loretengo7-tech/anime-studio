#!/usr/bin/env node
/** Diagnose: extract every inline <script> from index.html and module-parse it. */
import { readFileSync } from 'fs'
import vm from 'vm'

const html = readFileSync('/home/z/my-project/download/anime-studio/index.html', 'utf8')

const scripts = []
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g
let m
while ((m = re.exec(html)) !== null) {
  scripts.push({ attrs: m[1], code: m[2], start: m.index })
}

console.log(`total script blocks: ${scripts.length}`)
let i = 0
for (const s of scripts) {
  i++
  if (!s.code.trim()) continue
  const isModule = s.attrs.includes('type="module"')
  try {
    if (isModule) new vm.SourceTextModule(s.code, { identifier: `script#${i}` })
    else new vm.Script(s.code, { identifier: `script#${i}` })
  } catch (err) {
    const pos = err.stack?.match(/script#\d+:(\d+)/)?.[1]
    let lineInfo = ''
    if (pos) {
      const line = Number(pos)
      const lines = s.code.split('\n')
      const snip = lines[line - 1]?.slice(0, 300) ?? ''
      lineInfo = `\n  line ${line}: ${snip}`
    }
    console.log(`FAIL script#${i} (${isModule ? 'module' : 'classic'}, ${s.code.length} chars, htmlOffset ${s.start}): ${err.message}${lineInfo}`)
  }
}
console.log('done')
