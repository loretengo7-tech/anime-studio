#!/usr/bin/env node
/** Find which safeJs replacement breaks script#16. */
import { readFileSync } from 'fs'
import vm from 'vm'

const html = readFileSync('/home/z/my-project/download/anime-studio/index.html', 'utf8')
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g
const scripts = []
let m
while ((m = re.exec(html)) !== null) scripts.push({ attrs: m[1], code: m[2] })
const target = scripts.find(s => s.code.length === 369225)
const code = target.code

const tryParse = (label, src) => {
  try {
    new vm.SourceTextModule(src)
    console.log(`OK   ${label}`)
  } catch (err) {
    console.log(`FAIL ${label}: ${err.message}`)
  }
}

tryParse('as-is (with safeJs escapes)', code)
tryParse('revert both escapes', code.replace(/<\\!--/g, '<!--').replace(/<\\\//g, '<\\/').replace('<\\\\/script>', '</script>'))

// targeted: undo only <!-- escape
tryParse('undo <!-- escape only', code.replace(/<\\!--/g, '<!--'))
// targeted: undo only </script> escape (string form)
tryParse('undo </script> escape only', code.split('<\\/script>').join('</script>'))

// list escape positions with context
const show = (needle) => {
  let idx = 0, count = 0
  while ((idx = code.indexOf(needle, idx)) !== -1 && count < 10) {
    console.log(`--- ${needle} @${idx}: ${JSON.stringify(code.slice(Math.max(0, idx - 70), idx + 40))}`)
    idx += needle.length
    count++
  }
  console.log(`(${needle} total: ${(code.split(needle).length - 1)})`)
}
show('<\\!--')
show('<\\/script>')
