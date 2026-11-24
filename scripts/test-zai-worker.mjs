// Test local del worker zai-proxy.js — simula: preflight OPTIONS, POST sin key, POST con key falsa
import worker from '/tmp/zai-proxy.mjs'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name} ${extra}`) }
  else { fail++; console.log(`FAIL  ${name} ${extra}`) }
}

// 1. Preflight OPTIONS (lo que manda Safari antes del POST)
const pre = await worker.fetch(new Request('https://w.example/v1/chat/completions', {
  method: 'OPTIONS',
  headers: { 'Origin': 'https://loretengo7-tech.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
}))
check('preflight status 204', pre.status === 204, `(got ${pre.status})`)
check('preflight ACAO *', pre.headers.get('access-control-allow-origin') === '*')
check('preflight allows authorization header', (pre.headers.get('access-control-allow-headers') ?? '').includes('authorization'))

// 2. POST sin Authorization → 401 claro
const noAuth = await worker.fetch(new Request('https://w.example/v1/chat/completions', { method: 'POST', body: '{}' }))
check('no-auth status 401', noAuth.status === 401, `(got ${noAuth.status})`)
check('no-auth has CORS header', !!noAuth.headers.get('access-control-allow-origin'))

// 3. POST con key falsa → reenvía a Z.ai y pasa el 401 real con CORS
const fake = await worker.fetch(new Request('https://w.example/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer FAKE-KEY-TEST' },
  body: JSON.stringify({ model: 'glm-4.5-air', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
}))
const fakeText = await fake.text()
check('fake-key passthrough 401', fake.status === 401, `(got ${fake.status})`)
check('fake-key body is Z.ai error', fakeText.includes('token expired or incorrect'))
check('fake-key has CORS header', !!fake.headers.get('access-control-allow-origin'))
check('content-type json', (fake.headers.get('content-type') ?? '').includes('json'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
