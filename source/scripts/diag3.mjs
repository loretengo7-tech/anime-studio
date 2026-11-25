#!/usr/bin/env node
/** Diff script#16 against every chunk file; vm-check each chunk raw. */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import vm from 'vm'

const DIR = '/home/z/my-project/dist-static/_next/static/chunks'
const html = readFileSync('/home/z/my-project/download/anime-studio/index.html', 'utf8')
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g
let m
let target = null
while ((m = re.exec(html)) !== null) {
  if (m[2].length === 369225) { target = m[2]; break }
}
if (!target) { console.log('script#16 not found'); process.exit(0) }

console.log('script#16 head:', JSON.stringify(target.slice(0, 120)))
console.log('script#16 tail:', JSON.stringify(target.slice(-120)))

const collect = (dir, acc = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) collect(p, acc)
    else acc.push(p)
  }
  return acc
}
const files = collect(DIR)
for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  const rel = f.split('/').pop()
  let ok = 'OK'
  try { new vm.SourceTextModule(raw) } catch (err) { ok = 'FAIL ' + err.message }
  console.log(`${rel} size=${raw.length} rawParse=${ok}`)
  if (target.slice(0, 60) === raw.slice(0, 60)) {
    // candidate: compare byte-by-byte
    let i = 0
    while (i < Math.min(target.length, raw.length) && target[i] === raw[i]) i++
    console.log(`  -> matches head of ${rel}; first diff at ${i}: target=${JSON.stringify(target.slice(i - 40, i + 60))} file=${JSON.stringify(raw.slice(i - 40, i + 60))}`)
  }
}
