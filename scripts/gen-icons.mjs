/**
 * ANIME STUDIO — PWA icon generator (sharp)
 * Generates 192/512/maskable/apple-touch PNGs from an inline SVG.
 */
import sharp from 'sharp'
import { mkdirSync } from 'fs'

const svg = (size, maskable = false) => {
  const pad = maskable ? size * 0.12 : 0
  const inner = size - pad * 2
  const r = maskable ? 0 : size * 0.22
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12122b"/>
      <stop offset="0.55" stop-color="#1a1240"/>
      <stop offset="1" stop-color="#0b1a2e"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.2" cy="0.15" r="0.6">
      <stop offset="0" stop-color="#7c3aed" stop-opacity="0.75"/>
      <stop offset="1" stop-color="#7c3aed" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.85" cy="0.85" r="0.65">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbbf24"/>
      <stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
  </defs>
  <rect x="${maskable ? 0 : 0}" y="0" width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="url(#glow1)"/>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" fill="url(#glow2)"/>
  <g transform="translate(${pad}, ${pad})">
    <!-- film frame -->
    <rect x="${inner * 0.18}" y="${inner * 0.3}" width="${inner * 0.64}" height="${inner * 0.42}" rx="${inner * 0.06}" fill="none" stroke="url(#amber)" stroke-width="${inner * 0.045}"/>
    <!-- film perforations -->
    ${[0, 1, 2].map(i => `<rect x="${inner * (0.28 + i * 0.16)}" y="${inner * 0.22}" width="${inner * 0.09}" height="${inner * 0.05}" rx="${inner * 0.02}" fill="#fbbf24"/>`).join('\n    ')}
    ${[0, 1, 2].map(i => `<rect x="${inner * (0.28 + i * 0.16)}" y="${inner * 0.76}" width="${inner * 0.09}" height="${inner * 0.05}" rx="${inner * 0.02}" fill="#fbbf24"/>`).join('\n    ')}
    <!-- play triangle -->
    <path d="M ${inner * 0.42} ${inner * 0.42} L ${inner * 0.62} ${inner * 0.51} L ${inner * 0.42} ${inner * 0.6} Z" fill="url(#amber)"/>
    <!-- sparkle -->
    <path d="M ${inner * 0.76} ${inner * 0.24} l ${inner * 0.03} ${inner * 0.09} l ${inner * 0.09} ${inner * 0.03} l ${-inner * 0.09} ${inner * 0.03} l ${-inner * 0.03} ${inner * 0.09} l ${-inner * 0.03} ${-inner * 0.09} l ${-inner * 0.09} ${-inner * 0.03} l ${inner * 0.09} ${-inner * 0.03} Z" fill="#e9d5ff"/>
  </g>
</svg>`
}

const out = 'public/icons'
mkdirSync(out, { recursive: true })

const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
]

for (const [name, size, maskable] of jobs) {
  await sharp(Buffer.from(svg(size, maskable))).png().toFile(`${out}/${name}`)
  console.log('generated', name)
}
console.log('done')
