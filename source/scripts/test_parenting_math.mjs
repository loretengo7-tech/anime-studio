// Reproduces EXACTLY the compositor's matrix math (compositor.ts) to verify
// whether parenting (null -> child) maps coordinates correctly.
const W = 1920, H = 1080

function mat3Identity() { return [1, 0, 0, 0, 1, 0, 0, 0, 1] }
function mat3Mul(a, b) {
  const o = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return o
}
function mat3Translate(x, y) { return [1, 0, 0, 0, 1, 0, x, y, 1] }
function mat3Scale(sx, sy) { return [sx, 0, 0, 0, sy, 0, 0, 0, 1] }
function mat3Rotate(rad) {
  const c = Math.cos(rad), s = Math.sin(rad)
  return [c, s, 0, -s, c, 0, 0, 0, 1]
}

// apply: row-vector p·M with row-major arrays (translation in LAST ROW m[6],m[7])
function apply(m, x, y) {
  return [
    x * m[0] + y * m[3] + m[6],
    x * m[1] + y * m[4] + m[7],
  ]
}

// child matrix — verbatim composition from compositor.ts lines 1779-1791
// fullscreen video: srcW=W, srcH=H, fitScale=1, x,y=0, scale=1, rot=0, anchor 0,0
function childMatrix({ x = 0, y = 0, scale = 1, rot = 0, ax = 0, ay = 0, srcW = W, srcH = H } = {}) {
  const fitScale = Math.min(W / srcW, H / srcH)
  const pivotX = (srcW / 2 - ax) * fitScale
  const pivotY = (srcH / 2 - ay) * fitScale
  const C = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
  let m = mat3Identity()
  m = mat3Mul(mat3Scale(2 / W, 2 / H), m)
  m = mat3Mul(mat3Translate(x, y), m)
  m = mat3Mul(mat3Scale(scale, scale), m)
  m = mat3Mul(mat3Rotate(rot), m)
  m = mat3Mul(mat3Translate(-pivotX, -pivotY), m)
  m = mat3Mul(mat3Scale(fitScale * srcW, fitScale * srcH), m)
  m = mat3Mul(C, m)
  return m
}

// CURRENT parentChainMatrix — verbatim from compositor.ts lines 1958-1990
function parentMatrixCurrent({ x = 0, y = 0, scale = 1, rot = 0, pax = 0, pay = 0 } = {}) {
  const C0 = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
  let pm = mat3Identity()
  pm = mat3Mul(mat3Scale(2 / W, 2 / H), pm)
  pm = mat3Mul(mat3Translate(x, y), pm)
  pm = mat3Mul(mat3Scale(scale, scale), pm)
  pm = mat3Mul(mat3Rotate((rot * Math.PI) / 180), pm)
  pm = mat3Mul(mat3Translate(-(W / 2 - pax), -(H / 2 - pay)), pm)
  pm = mat3Mul(mat3Scale(W, H), pm)
  pm = mat3Mul(C0, pm)
  return pm
}

const clip = childMatrix()
const q = { center: [0, 0], corner: [-1, -1], corner2: [1, 1] }

console.log('== UNPARENTED fullscreen child (ground truth) ==')
for (const [k, [x, y]] of Object.entries(q)) console.log(` quad ${k} (${x},${y}) -> clip`, apply(clip, x, y).map(v => +v.toFixed(3)))

console.log('\n== CURRENT parent (default transform: should equal unparented!) ==')
const pm0 = parentMatrixCurrent()
const m0 = mat3Mul(clip, pm0) // compositor.ts:1796 m = mat3Mul(m, parentM)
for (const [k, [x, y]] of Object.entries(q)) console.log(` quad ${k} -> clip`, apply(m0, x, y).map(v => +v.toFixed(3)))

console.log('\n== CURRENT parent moved x=+400 (child should shift +400px right = +0.4167 clip) ==')
const pmX = parentMatrixCurrent({ x: 400 })
const mX = mat3Mul(clip, pmX)
console.log(' quad center -> clip', apply(mX, 0, 0).map(v => +v.toFixed(3)), '(expected ~1.4167, 1)')

console.log('\n== CANDIDATE FIX: parent transform in NDC/centered-px space ==')
// Child OUTPUT space is NDC [-1,1] (comp center = 0,0). Parent pipeline:
// NDC -> centered comp px -> anchor offset -> R -> S -> pos offset -> NDC.
function parentMatrixFixed({ x = 0, y = 0, scale = 1, rot = 0, pax = 0, pay = 0 } = {}) {
  let pm = mat3Identity()
  // prepend in REVERSE pipeline order — each mat3Mul(X, pm) makes X the
  // FIRST-applied (leftmost) stage of the row-vector pipeline:
  pm = mat3Mul(mat3Scale(2 / W, 2 / H), pm)                 // last: centered px → NDC
  pm = mat3Mul(mat3Translate(x, y), pm)                     // 5th: position (px offset from comp center)
  pm = mat3Mul(mat3Scale(scale, scale), pm)                 // 4th: scale around anchor
  pm = mat3Mul(mat3Rotate((rot * Math.PI) / 180), pm)       // 3rd: rotate around anchor
  pm = mat3Mul(mat3Translate(pax, pay), pm)                 // 2nd: anchor offset from parent center
  pm = mat3Mul(mat3Scale(W / 2, H / 2), pm)                 // 1st: NDC → centered comp px
  return pm
}
const fm0 = mat3Mul(clip, parentMatrixFixed())
console.log('-- default parent (must equal unparented EXACTLY) --')
for (const [k, [x, y]] of Object.entries(q)) console.log(` quad ${k} -> clip`, apply(fm0, x, y).map(v => +v.toFixed(4)))
const fmX = mat3Mul(clip, parentMatrixFixed({ x: 400 }))
console.log('-- parent x=+400: center ->', apply(fmX, 0, 0).map(v => +v.toFixed(4)), '(expected 0.4167, 0)')
const fmS = mat3Mul(clip, parentMatrixFixed({ scale: 2 }))
console.log('-- parent scale=2: corners ->', apply(fmS, -1, -1).map(v => +v.toFixed(3)), apply(fmS, 1, 1).map(v => +v.toFixed(3)), '(expected ±2 NDC)')
const fmR = mat3Mul(clip, parentMatrixFixed({ rot: 90 }))
console.log('-- parent rot=90°: center ->', apply(fmR, 0, 0).map(v => +v.toFixed(3)), 'corner(1,1) ->', apply(fmR, 1, 1).map(v => +v.toFixed(3)))
const fmA = mat3Mul(clip, parentMatrixFixed({ x: 100, y: 50, scale: 1.5, rot: 25, pax: 60, pay: -30 }))
console.log('-- combined: finite/plausible ->', apply(fmA, 0, 0).map(v => +v.toFixed(3)))
// multi-level: parent +100, grandparent +200
const two = mat3Mul(mat3Mul(clip, parentMatrixFixed({ x: 100 })), parentMatrixFixed({ x: 200 }))
console.log('-- chain: center ->', apply(two, 0, 0).map(v => +v.toFixed(4)), '(expected 0.3125, 0)')
