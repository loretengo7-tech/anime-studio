/**
 * ANIME STUDIO — AI Video Enhancement (Topaz-style engine)
 *
 * Real WebGL processing pipeline (not just dimension changes):
 *  - Progressive Catmull-Rom bicubic upscaling in ≤2× steps with detail
 *    reinjection between steps (720p→1080p→4K paths)
 *  - Edge-aware bilateral denoise
 *  - Deblock: flat-area smoothing driven by local variance
 *  - Edge-directed line-art reconstruction: Sobel-orientation guided
 *    sharpening ACROSS edges, so anime lines gain crispness while flat
 *    regions stay clean
 *  - Detail reconstruction: high-frequency reinjection from a guided blur
 *  - Anime presets combining the above
 *
 * Honest classification: classical algorithmic enhancement. Neural
 * super-resolution is wired for backend integration (/api/jobs).
 */

export type EnhancePreset =
  | 'anime_hd' | 'anime_4k' | 'upscale_2x' | 'upscale_4x' | 'denoise' | 'deblock' | 'sharpen' | 'polish' | 'restore_lines'

export interface EnhanceParams {
  upscale: number      // target scale factor (1 = none)
  denoise: number      // 0..1
  deblock: number      // 0..1
  sharpen: number      // 0..1
  linePreserve: number // 0..1
  detail: number       // 0..1 — high-frequency detail reconstruction
}

export const ENHANCE_PRESETS: Record<EnhancePreset, { label: string; params: EnhanceParams; description: string }> = {
  anime_hd: { label: 'Anime HD (720p → 1080p)', description: 'Progressive upscale + line-art reconstruction', params: { upscale: 1.5, denoise: 0.25, deblock: 0.3, sharpen: 0.45, linePreserve: 0.8, detail: 0.3 } },
  anime_4k: { label: 'Anime 4K (1080p → 4K)', description: '2×-stepped upscale, denoise, line reconstruction', params: { upscale: 2, denoise: 0.3, deblock: 0.35, sharpen: 0.5, linePreserve: 0.9, detail: 0.45 } },
  upscale_2x: { label: 'Upscale 2× (bicubic chain)', description: 'Clean progressive 2× upscale', params: { upscale: 2, denoise: 0.15, deblock: 0.2, sharpen: 0.3, linePreserve: 0.6, detail: 0.25 } },
  upscale_4x: { label: 'Upscale 4× (bicubic chain)', description: 'Chain of 2× steps with detail reinjection', params: { upscale: 4, denoise: 0.3, deblock: 0.4, sharpen: 0.5, linePreserve: 0.85, detail: 0.5 } },
  denoise: { label: 'Denoise', description: 'Edge-aware noise reduction', params: { upscale: 1, denoise: 0.6, deblock: 0.1, sharpen: 0.1, linePreserve: 0.6, detail: 0.1 } },
  deblock: { label: 'Deblock', description: 'Compression artifact removal', params: { upscale: 1, denoise: 0.2, deblock: 0.7, sharpen: 0.2, linePreserve: 0.5, detail: 0.15 } },
  sharpen: { label: 'Sharpen', description: 'Detail + line crispness', params: { upscale: 1, denoise: 0, deblock: 0, sharpen: 0.6, linePreserve: 0.7, detail: 0.2 } },
  polish: { label: 'Polish', description: 'Gentle all-rounder: clean + crisp', params: { upscale: 1, denoise: 0.3, deblock: 0.35, sharpen: 0.35, linePreserve: 0.7, detail: 0.3 } },
  restore_lines: { label: 'Restore Line Art', description: 'Maximum line-art reconstruction pass', params: { upscale: 1, denoise: 0.35, deblock: 0.4, sharpen: 0.55, linePreserve: 1, detail: 0.35 } },
}

const ENH_VERT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const ENH_FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texRes;
uniform vec2 u_outRes;
uniform float u_denoise;
uniform float u_deblock;
uniform float u_sharpen;
uniform float u_linePreserve;
uniform float u_detail;
uniform float u_step; // 0=denoise+deblock, 1=upscale, 2=edge-directed sharpen, 3=detail reconstruct

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec4 sampleTex(vec2 uv) { return texture2D(u_tex, uv); }

float cubicWeight(float t) {
  t = abs(t);
  float t2 = t * t, t3 = t2 * t;
  if (t < 1.0) return 1.5 * t3 - 2.5 * t2 + 1.0;
  if (t < 2.0) return -0.5 * t3 + 2.5 * t2 - 4.0 * t + 2.0;
  return 0.0;
}

// Catmull-Rom bicubic (separable 4-tap per axis using cubic weights)
vec4 bicubic(vec2 uv) {
  vec2 texSize = u_texRes;
  vec2 coord = uv * texSize - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord);
  vec4 result = vec4(0.0);
  float wsum = 0.0;
  for (int dy = -1; dy <= 2; dy++) {
    for (int dx = -1; dx <= 2; dx++) {
      vec2 off = vec2(float(dx), float(dy));
      vec2 p = (base + off + 0.5) / texSize;
      float wx = cubicWeight(off.x - f.x);
      float wy = cubicWeight(off.y - f.y);
      float w = wx * wy;
      result += sampleTex(p) * w;
      wsum += w;
    }
  }
  return result / wsum;
}

void main() {
  vec2 px = 1.0 / u_texRes;
  if (u_step < 0.5) {
    // Pass 0: bilateral denoise + deblock (flat-area blur)
    vec3 center = sampleTex(v_uv).rgb;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    float centerLum = luma(center);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981;
      vec2 dir = vec2(cos(a), sin(a));
      vec3 s = sampleTex(v_uv + dir * px * (1.0 + u_denoise * 2.0)).rgb;
      float lum = luma(s);
      float spatial = 1.0;
      float range = exp(-abs(lum - centerLum) * (6.0 + 18.0 * (1.0 - u_denoise)));
      float w = spatial * range;
      acc += s * w;
      wsum += w;
    }
    vec3 denoised = acc / wsum;
    // deblock: 8-neighbor average weighted by inverse variance of block
    vec3 blockAvg = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 1.5707963;
      vec2 dir = vec2(cos(a), sin(a));
      blockAvg += sampleTex(v_uv + dir * px * 2.0).rgb;
    }
    blockAvg /= 4.0;
    // variance estimate around pixel
    float v = 0.0;
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 1.5707963;
      vec2 dir = vec2(cos(a), sin(a));
      v += abs(luma(sampleTex(v_uv + dir * px * 2.0).rgb) - centerLum);
    }
    v /= 4.0;
    float flatM = 1.0 - smoothstep(0.02, 0.12, v);
    vec3 outc = mix(center, denoised, u_denoise);
    outc = mix(outc, blockAvg, u_deblock * flatM * 0.8);
    gl_FragColor = vec4(outc, 1.0);
  } else if (u_step < 1.5) {
    // Pass 1: bicubic upscale
    gl_FragColor = bicubic(v_uv);
  } else if (u_step < 2.5) {
    // Pass 2: edge-DIRECTED line-art reconstruction.
    // Sobel gives gradient orientation; we sharpen ACROSS the line (along
    // the gradient) so anime ink lines re-crispen instead of halos forming.
    float tl = luma(sampleTex(v_uv + vec2(-px.x, -px.y)).rgb);
    float t  = luma(sampleTex(v_uv + vec2(0.0, -px.y)).rgb);
    float tr = luma(sampleTex(v_uv + vec2(px.x, -px.y)).rgb);
    float l  = luma(sampleTex(v_uv + vec2(-px.x, 0.0)).rgb);
    vec3 center = sampleTex(v_uv).rgb;
    float lum = luma(center);
    float r  = luma(sampleTex(v_uv + vec2(px.x, 0.0)).rgb);
    float bl = luma(sampleTex(v_uv + vec2(-px.x, px.y)).rgb);
    float b  = luma(sampleTex(v_uv + vec2(0.0, px.y)).rgb);
    float br = luma(sampleTex(v_uv + vec2(px.x, px.y)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float gmag = length(vec2(gx, gy));
    float edge = clamp(gmag * 1.4, 0.0, 1.0);
    // gradient direction (normalized)
    vec2 grad = gmag > 0.0001 ? vec2(gx, gy) / gmag : vec2(0.0);
    // sample along the gradient (across the line) for the unsharp pair
    vec3 across1 = sampleTex(v_uv + grad * px * 1.25).rgb;
    vec3 across0 = sampleTex(v_uv - grad * px * 1.25).rgb;
    vec3 alongBlur = (across1 + across0) * 0.5;
    vec3 detailC = center - alongBlur;
    float mask = mix(edge, max(edge, 0.22), 1.0 - u_linePreserve);
    vec3 outc = center + detailC * u_sharpen * 2.6 * mask;
    // flat-region deblock tail
    vec3 blurAvg = (sampleTex(v_uv + vec2(-px.x, 0.0)).rgb + sampleTex(v_uv + vec2(px.x, 0.0)).rgb +
                    sampleTex(v_uv + vec2(0.0, -px.y)).rgb + sampleTex(v_uv + vec2(0.0, px.y)).rgb) / 4.0;
    outc = mix(outc, blurAvg, u_deblock * (1.0 - edge) * 0.3);
    gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
  } else {
    // Pass 3: detail reconstruction — reinject high frequencies from a
    // wide guided blur (multi-scale unsharp, protects lines via linePreserve)
    vec3 center = sampleTex(v_uv).rgb;
    float lum = luma(center);
    vec3 fine = (sampleTex(v_uv + vec2(px.x, 0.0)).rgb + sampleTex(v_uv - vec2(px.x, 0.0)).rgb +
                 sampleTex(v_uv + vec2(0.0, px.y)).rgb + sampleTex(v_uv - vec2(0.0, px.y)).rgb) * 0.25;
    vec3 wide = (sampleTex(v_uv + vec2(px.x * 3.0, 0.0)).rgb + sampleTex(v_uv - vec2(px.x * 3.0, 0.0)).rgb +
                 sampleTex(v_uv + vec2(0.0, px.y * 3.0)).rgb + sampleTex(v_uv - vec2(0.0, px.y * 3.0)).rgb) * 0.25;
    vec3 fineBand = center - fine;
    vec3 midBand = fine - wide;
    // line mask: strong edges get fine-band boost, textures get mid-band
    float e2 = clamp(abs(lum - luma(wide)) * 3.0, 0.0, 1.0);
    float lineM = mix(0.45, clamp(e2 * 1.2, 0.0, 1.0), u_linePreserve);
    vec3 outc = center + fineBand * u_detail * 1.6 * lineM + midBand * u_detail * 0.9;
    gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
  }
}
`

export class EnhanceRenderer {
  private gl: WebGLRenderingContext | null = null
  private canvas: HTMLCanvasElement | null = null
  private prog: WebGLProgram | null = null
  private tex: WebGLTexture | null = null
  private vbo: WebGLBuffer | null = null
  private locs: Record<string, WebGLUniformLocation | null> = {}

  private ensure(): WebGLRenderingContext {
    if (this.gl) return this.gl
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl', { alpha: false, antialias: false, depth: false }) ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext
    if (!gl) throw new Error('WebGL unavailable for enhancement pipeline')
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`Enhance shader error: ${gl.getShaderInfoLog(sh)}`)
      }
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, ENH_VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, ENH_FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Enhance link error: ${gl.getProgramInfoLog(prog)}`)
    }
    this.canvas = canvas
    this.gl = gl
    this.prog = prog
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0,
    ]), gl.STATIC_DRAW)
    this.vbo = vbo
    return gl
  }

  /**
   * Enhance a source image through the preset pipeline. Returns a new
   * canvas at the enhanced resolution.
   */
  async process(
    source: TexImageSource & { width: number; height: number },
    preset: EnhancePreset,
    targetScale?: number
  ): Promise<HTMLCanvasElement> {
    return this.processParams(source, ENHANCE_PRESETS[preset].params, targetScale)
  }

  /**
   * Enhance with explicit params (custom sliders in the panel).
   */
  async processParams(
    source: TexImageSource & { width: number; height: number },
    params: EnhanceParams,
    targetScale?: number
  ): Promise<HTMLCanvasElement> {
    const gl = this.ensure()
    const scale = targetScale ?? params.upscale
    const srcW = source.width, srcH = source.height

    // upload source
    if (this.tex) gl.deleteTexture(this.tex)
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    this.tex = tex

    const runPass = (step: number, input: WebGLTexture, inW: number, inH: number, outW: number, outH: number): { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } => {
      const t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, outW, outH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const f = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, f)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      gl.viewport(0, 0, outW, outH)
      gl.useProgram(this.prog!)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
      const aPos = gl.getAttribLocation(this.prog!, 'a_pos')
      const aUv = gl.getAttribLocation(this.prog!, 'a_uv')
      gl.enableVertexAttribArray(aPos)
      gl.enableVertexAttribArray(aUv)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, input)
      const L = (n: string) => {
        if (!(n in this.locs)) this.locs[n] = gl.getUniformLocation(this.prog!, n)
        return this.locs[n]
      }
      gl.uniform1i(L('u_tex')!, 0)
      gl.uniform2f(L('u_texRes')!, inW, inH)
      gl.uniform2f(L('u_outRes')!, outW, outH)
      gl.uniform1f(L('u_denoise')!, params.denoise)
      gl.uniform1f(L('u_deblock')!, params.deblock)
      gl.uniform1f(L('u_sharpen')!, params.sharpen)
      gl.uniform1f(L('u_linePreserve')!, params.linePreserve)
      gl.uniform1f(L('u_detail')!, params.detail)
      gl.uniform1f(L('u_step')!, step)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return { tex: t, fbo: f, w: outW, h: outH }
    }

    let cur = { tex, fbo: null as WebGLFramebuffer | null, w: srcW, h: srcH }
    // Pass 0: denoise/deblock at source res
    if (params.denoise > 0.01 || params.deblock > 0.01) {
      const r = runPass(0, cur.tex, cur.w, cur.h, cur.w, cur.h)
      cur = { tex: r.tex, fbo: r.fbo, w: r.w, h: r.h }
    }
    // Progressive upscale: chain of ≤2× steps; between steps reinject detail
    // and re-crispen lines so the final image stays sharp (Topaz-style loop).
    if (scale > 1.01) {
      let remaining = scale
      const totalOutW = Math.round(srcW * scale)
      while (remaining > 1.001) {
        const stepScale = Math.min(2, remaining)
        remaining /= stepScale
        const outW = remaining <= 1.001 ? totalOutW : Math.round(cur.w * stepScale)
        const outH = Math.round(outW * (srcH / srcW))
        const r1 = runPass(1, cur.tex, cur.w, cur.h, outW, outH)
        cur = { tex: r1.tex, fbo: r1.fbo, w: r1.w, h: r1.h }
        // inter-step refresh (skip after the final step — detail pass handles it)
        if (remaining > 1.001 && (params.sharpen > 0.01 || params.detail > 0.01)) {
          const r2 = runPass(2, cur.tex, cur.w, cur.h, cur.w, cur.h)
          cur = { tex: r2.tex, fbo: r2.fbo, w: r2.w, h: r2.h }
          const r3 = runPass(3, cur.tex, cur.w, cur.h, cur.w, cur.h)
          cur = { tex: r3.tex, fbo: r3.fbo, w: r3.w, h: r3.h }
        }
      }
    }
    // Final: edge-directed line-art reconstruction
    if (params.sharpen > 0.01) {
      const r = runPass(2, cur.tex, cur.w, cur.h, cur.w, cur.h)
      cur = { tex: r.tex, fbo: r.fbo, w: r.w, h: r.h }
    }
    // Final: detail reconstruction (high-frequency reinjection)
    if (params.detail > 0.01) {
      const r = runPass(3, cur.tex, cur.w, cur.h, cur.w, cur.h)
      cur = { tex: r.tex, fbo: r.fbo, w: r.w, h: r.h }
    }

    // Read pixels from the final pass FBO into a 2D canvas
    const outCanvas = document.createElement('canvas')
    outCanvas.width = cur.w
    outCanvas.height = cur.h
    const ctx = outCanvas.getContext('2d')!
    gl.bindFramebuffer(gl.FRAMEBUFFER, cur.fbo)
    const pixels = new Uint8Array(cur.w * cur.h * 4)
    gl.readPixels(0, 0, cur.w, cur.h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const imgData = ctx.createImageData(cur.w, cur.h)
    // WebGL reads bottom-up; flip rows
    const rowBytes = cur.w * 4
    for (let y = 0; y < cur.h; y++) {
      const srcStart = (cur.h - 1 - y) * rowBytes
      const dstStart = y * rowBytes
      imgData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart)
    }
    ctx.putImageData(imgData, 0, 0)
    gl.deleteTexture(tex)
    return outCanvas
  }
}

export const enhanceRenderer = new EnhanceRenderer()

/**
 * Process a single frame from an asset for the enhancement preview UI.
 * `customParams` overrides the preset params (custom sliders).
 */
export async function enhanceFramePreview(
  assetId: string,
  sourceTime: number,
  preset: EnhancePreset,
  customParams?: Partial<EnhanceParams>
): Promise<{ before: HTMLCanvasElement; after: HTMLCanvasElement } | null> {
  const mm = (await import('../media/mediaManager')).mediaManager
  const asset = mm.assets.get(assetId)
  if (!asset) return null
  const frame = await mm.extractFrame(assetId, sourceTime, 720)
  if (!frame) return null
  const before = document.createElement('canvas')
  before.width = frame.width
  before.height = frame.height
  before.getContext('2d')!.drawImage(frame, 0, 0)
  try {
    const params = { ...ENHANCE_PRESETS[preset].params, ...(customParams ?? {}) }
    const after = await enhanceRenderer.processParams(frame, params)
    if ('close' in frame && typeof frame.close === 'function') frame.close()
    return { before, after }
  } catch (e) {
    if ('close' in frame && typeof frame.close === 'function') frame.close()
    throw e
  }
}
