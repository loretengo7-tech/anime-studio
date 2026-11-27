/**
 * ANIME STUDIO — WebGL Compositor
 *
 * Real GPU composition engine:
 *  - Layered rendering (bottom→top track order) with per-layer transforms
 *  - One statically-compiled mega fragment shader implementing the full
 *    effect chain (color grading, blur, distortion, lighting, anime FX)
 *  - In-shader blend modes via ping-pong framebuffers (backdrop sampling)
 *  - Adjustment layers re-process the composite of layers below
 *  - Masks, motion-blur-from-motion vectors, feedback trails
 *  - Tiled .cube LUT support (works in WebGL1 / iOS Safari)
 */

import type { Precomp, PrecompClip } from './types'
import type { Clip, ProjectDoc, VideoClip, TextClip, AdjustmentClip, ImageClip, SolidClip, ShapeClip, CameraClip, CameraSettings, Composition, BlendMode, EffectInstance, Mask, MaskPoint, TrackMatte } from './types'
import { evalProperty, evalEffectParam, setExpressionFps } from './keyframes'
import { evalMaskPoints } from './types'
import { clipSourceTime } from './speed'
import { EFFECT_MAP } from './effects'
import { getPluginShaderChunk, pluginSelectionIndex, sanitizeParamKey, onPluginsChanged } from './plugins'
import { layerHomography, type CamState } from './camera'
import { getSolidCanvas, getShapeCanvas } from './proceduralSources'
import { FxChain } from './fxpack'
import { matteAt } from './cutout'
import { clipHasOfx, ofxLayerSource } from './ofx'

export type TextureSource = HTMLVideoElement | HTMLImageElement | ImageBitmap | HTMLCanvasElement

export interface RenderSourceRequest {
  clip: Clip
  compTime: number
  /** Exact source time the caller wants (already remapped). */
  sourceTime: number
}

/** Provider interface implemented by the media manager. */
export interface SourceProvider {
  /** Returns a drawable for the given clip at sourceTime, or null if not ready. */
  get(clip: Clip, sourceTime: number): TextureSource | null
  /** Text renderer for text clips. */
  getTextCanvas(clip: TextClip, localTime: number, compFps: number): HTMLCanvasElement | null
}

interface PingPong {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
}

export interface RenderOptions {
  time: number
  /** 0..1 — bypass effects (before/after compare). */
  bypassEffects?: boolean
  /** Only draw up to this track index (for progressive preview). */
  maxLayer?: number
  /** Internal: render a single matte source into the ping-pong target without blitting. */
  mattePass?: boolean
}

const VERT_SRC = `
attribute vec2 a_pos;   // unit quad corners (-1..1)
attribute vec2 a_uv;
uniform mat3 u_matrix;  // layer model-projection matrix (affine, or homography for 3D layers)
uniform float u_flipY;
uniform vec2 u_expand;  // motion blur: grow the quad (uv units) so the smear can leave the layer bounds
varying vec2 v_uv;
void main() {
  v_uv = (a_uv - 0.5) * (1.0 + 2.0 * u_expand) + 0.5;
  vec3 p = u_matrix * vec3(a_pos * (1.0 + 2.0 * u_expand), 1.0);
  // For 2D layers p.z == 1 (affine mat3). For 3D layers u_matrix is a full
  // homography: using p.z as gl_Position.w gives perspective-correct UV
  // interpolation across the warped quad.
  gl_Position = vec4(p.xy, 0.0, p.z);
}
`

const FRAG_SRC_BASE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_back;      // backdrop (composite so far)
uniform sampler2D u_prev;      // previous composite (trails)
uniform float u_hasTex;
uniform vec2 u_layerSize;      // layer pixel size
uniform vec2 u_compRes;        // comp pixel resolution (render res)
uniform float u_time;
uniform float u_localTime;
uniform float u_opacity;
uniform float u_blend;         // blend mode index
uniform float u_efEnabled;
uniform sampler2D u_matte;     // track matte source (unit 4)
uniform float u_matteMode;     // 0 off · 1 alpha · 2 alphaInv · 3 luma · 4 lumaInv
uniform float u_matteRender;   // 1 while rendering the matte source itself
uniform float u_srcFlip;       // 1 when u_tex is an FBO (adjustment pass)

// ---- grading (combined CPU-side from all color effects)
uniform float u_exposure, u_contrast, u_saturation, u_temperature, u_tint;
uniform float u_lift, u_gamma, u_gain, u_vibrance;
uniform float u_vigAmount, u_vigSoft;

// ---- blur
uniform float u_blurRadius;
uniform vec2 u_blurDir;
uniform vec2 u_motionVec;
uniform vec2 u_expand;
uniform float u_zoomBlur;
uniform float u_radialBlur;

// ---- distortion
uniform vec2 u_rgbSplit;
uniform float u_waveAmount, u_waveFreq, u_waveSpeed;
uniform float u_glitch, u_glitchSpeed, u_glitchBlock;
uniform float u_crtCurve, u_crtScan;

// ---- lighting
uniform float u_glowThreshold, u_glowIntensity, u_glowRadius;
uniform float u_auraThreshold, u_auraIntensity, u_auraHue, u_auraPulse;
uniform float u_flareX, u_flareY, u_flareIntensity, u_flareStreak;
uniform float u_leakIntensity, u_leakHue, u_leakAngle;

// ---- anime
uniform float u_slIntensity, u_slCount, u_slSpeed, u_slCX, u_slCY;
uniform float u_flashAmount, u_flashMode;
uniform float u_burstProgress, u_burstIntensity, u_burstHue;
uniform float u_boltIntensity, u_boltCount, u_boltSpeed;
uniform float u_partDensity, u_partSize, u_partSpeed, u_partHue;
uniform float u_halfMix, u_halfScale, u_halfAngle;
uniform float u_trailsDecay;

// ---- mask
uniform float u_maskEnabled, u_maskType, u_maskX, u_maskY, u_maskW, u_maskH, u_maskFeather, u_maskInvert;
// pen mask: flattened closed polygon in layer-uv aspect space (CPU-side bezier flatten)
uniform vec2 u_maskPts[24];
uniform sampler2D u_maskTex; // pen masks rendered on the CPU (any number of points, exact curves)
uniform float u_maskPtsN;
uniform float u_maskAspect;

// ---- perspective (AE-style)
uniform float u_bulgeAmount, u_bulgeRadius, u_bulgeCX, u_bulgeCY;
uniform float u_twirlAngle, u_twirlRadius, u_twirlCX, u_twirlCY;
uniform float u_ripAmount, u_ripWave, u_ripSpeed;
uniform float u_fisheyeAmount;
uniform float u_kaleidoSeg, u_kaleidoRot;
uniform float u_tiltX, u_tiltY;
uniform float u_mirrorMode, u_mirrorPos, u_tileN, u_bzAmt, u_bzRate;
uniform float u_keyTol, u_keySoft, u_keyHue;
uniform float u_tsAmt, u_tsPos, u_tsWidth;
uniform float u_dsX, u_dsY, u_dsOpacity, u_dsSoft;

// ---- stylize
uniform float u_posterLevels;
uniform float u_pixSize;
uniform float u_sketchAmount, u_sketchThresh;
uniform float u_neonIntensity, u_neonHue, u_neonThresh;
uniform float u_oilRadius, u_oilMix;
uniform float u_duoHueA, u_duoHueB, u_duoMix;

// ---- generate
uniform float u_grainAmount, u_grainSize, u_grainSpeed;
uniform float u_starDensity, u_starSpeed, u_starTwinkle;
uniform float u_rainIntensity, u_rainAngle, u_rainSpeed;
uniform float u_sakuraDensity, u_sakuraSpeed, u_sakuraSway, u_sakuraSize;
uniform float u_auroraIntensity, u_auroraHue, u_auroraSpeed;
uniform float u_gridSpacing, u_gridOpacity, u_gridGlow;

// ---- time
uniform float u_echoDecay, u_echoX, u_echoY;
uniform float u_shakeIntensity, u_shakeFreq, u_shakeRot;

// ---- lighting extra
uniform float u_bloomThresh, u_bloomIntensity;
uniform float u_godIntensity, u_godX, u_godY, u_godRays;
uniform float u_rimIntensity, u_rimHue;

// ---- color extra
uniform float u_hueDegrees;
uniform float u_cbR, u_cbG, u_cbB;
uniform float u_scAmount, u_scPivot;
uniform float u_sharpenAmount, u_sharpenRadius;
uniform float u_cartoonMix, u_cartoonLevels, u_cartoonEdge;
uniform float u_turbAmount, u_turbScale, u_turbSpeed;

// ---- plugin system (AE-style third-party effects)
uniform float u_pluginSel;
/*__PLUGIN_CHUNK__*/

// ---- LUT (tiled 3D in a 2D atlas)
uniform float u_lutEnabled;
uniform float u_lutSize;
uniform sampler2D u_lutTex;

const float PI = 3.14159265;

// pen-mask helpers: segment SDF + closed polygon SDF (crossing-number inside test)
float asSdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
float asSdPolygon(vec2 p, float n) {
  float nn = max(min(n, 24.0), 3.0);
  vec2 a0 = u_maskPts[0];
  vec2 prevPt = a0;
  float dMin = 1e5;
  int inside = 0;
  // strictly bare loop index (WebGL1 constant-index-expression safe)
  for (int i = 1; i <= 24; i++) {
    if (float(i) > nn) break;
    vec2 curPt = a0;                      // wrap segment closes back to vertex 0
    if (float(i) < nn) curPt = u_maskPts[i];
    dMin = min(dMin, asSdSeg(p, prevPt, curPt));
    if ((prevPt.y > p.y) != (curPt.y > p.y)) {
      float xint = (curPt.x - prevPt.x) * (p.y - prevPt.y) / (curPt.y - prevPt.y) + prevPt.x;
      if (p.x < xint) inside = 1 - inside;
    }
    prevPt = curPt;
  }
  return inside == 1 ? -dMin : dMin;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float hash1(float n) { return fract(sin(n) * 43758.5453); }
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p = p * 2.02 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}
vec3 hueShift(vec3 c, float deg) {
  float a = deg * PI / 180.0;
  vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 applyLUT(vec3 c) {
  float n = u_lutSize;
  // Tiled atlas: width = n*n, height = n. Blue channel picks the tile.
  float b = clamp(c.b, 0.0, 0.999) * (n - 1.0);
  float tile = floor(b);
  float frac = b - tile;
  float tileX = mod(tile, n);
  float tileY = floor(tile / n);
  float tile2 = min(tile + 1.0, n - 1.0);
  float tileX2 = mod(tile2, n);
  float tileY2 = floor(tile2 / n);
  float uu = (tileX * n + clamp(c.r, 0.0, 0.999) * (n - 1.0)) / (n * n);
  float vv = (tileY * n + clamp(c.g, 0.0, 0.999) * (n - 1.0)) / n;
  float uu2 = (tileX2 * n + clamp(c.r, 0.0, 0.999) * (n - 1.0)) / (n * n);
  float vv2 = (tileY2 * n + clamp(c.g, 0.0, 0.999) * (n - 1.0)) / n;
  vec3 s0 = texture2D(u_lutTex, vec2(uu, vv)).rgb;
  vec3 s1 = texture2D(u_lutTex, vec2(uu2, vv2)).rgb;
  return mix(s0, s1, frac);
}

void main() {
  vec2 uv = v_uv;
  vec2 res = u_compRes;
  vec2 px = 1.0 / res;
  // adjustment layers sample the composite FBO through u_tex — mirror the
  // sample coordinates into screen orientation for that pass only
  if (u_srcFlip > 0.5) uv = vec2(uv.x, 1.0 - uv.y);

  // ---------------- distortions (uv space) ----------------
  if (u_efEnabled > 0.5) {
    // turbulent displace (fractal noise warp)
    if (u_turbAmount > 0.01) {
      float evo = u_time * u_turbSpeed;
      vec2 np = uv * max(u_turbScale, 0.5);
      float nx = fbm(np + vec2(evo, -evo * 0.7));
      float ny = fbm(np + vec2(5.2 - evo, 1.3 + evo * 0.9));
      uv += (vec2(nx, ny) - 0.5) * (u_turbAmount * px * 2.0);
    }
    // CRT curve
    if (u_crtCurve > 0.001) {
      vec2 c = uv * 2.0 - 1.0;
      c *= 1.0 + u_crtCurve * 0.18 * (c.x * c.x + c.y * c.y);
      uv = c * 0.5 + 0.5;
    }
    // pixelate (uv quantize)
    if (u_pixSize > 1.5) {
      vec2 blocks = res / max(u_pixSize, 2.0);
      uv = (floor(uv * blocks) + 0.5) / blocks;
    }
    // camera shake (procedural jitter + rotation)
    if (u_shakeIntensity > 0.001) {
      float st = u_time * max(u_shakeFreq, 0.1);
      float sx = (noise2(vec2(st, 3.7)) - 0.5) * 2.0 * u_shakeIntensity;
      float sy = (noise2(vec2(st + 17.3, 9.1)) - 0.5) * 2.0 * u_shakeIntensity;
      float ang = (noise2(vec2(st + 31.7, 5.2)) - 0.5) * 2.0 * u_shakeRot * PI / 180.0;
      uv -= 0.5;
      float cs = cos(ang), sn = sin(ang);
      uv = vec2(uv.x * cs - uv.y * sn, uv.x * sn + uv.y * cs) + 0.5;
      uv += vec2(sx, sy) * px;
    }
    // bulge / pinch
    if (abs(u_bulgeAmount) > 0.001) {
      vec2 bc = vec2(0.5 + u_bulgeCX * 0.5, 0.5 - u_bulgeCY * 0.5);
      vec2 c = uv - bc;
      c.x *= res.x / max(res.y, 1.0);
      float r = length(c);
      float rr = u_bulgeRadius * 0.9;
      if (r < rr) {
        float k = 1.0 - u_bulgeAmount * 0.85 * pow(1.0 - r / rr, 2.0);
        vec2 cuv = vec2(c.x * k / (res.x / max(res.y, 1.0)), c.y * k);
        uv = bc + cuv;
      }
    }
    // twirl
    if (abs(u_twirlAngle) > 0.5) {
      vec2 tc = vec2(0.5 + u_twirlCX * 0.5, 0.5 - u_twirlCY * 0.5);
      vec2 c = uv - tc;
      c.x *= res.x / max(res.y, 1.0);
      float r = length(c);
      if (r < u_twirlRadius) {
        float ang = u_twirlAngle * PI / 180.0 * (1.0 - r / u_twirlRadius);
        float cs = cos(ang), sn = sin(ang);
        c = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
        uv = tc + vec2(c.x / (res.x / max(res.y, 1.0)), c.y);
      }
    }
    // ripple
    if (u_ripAmount > 0.001) {
      vec2 c = uv - 0.5;
      float r = length(c) * res.y;
      float wv = sin(r / max(u_ripWave, 4.0) * PI * 2.0 - u_time * u_ripSpeed * PI * 2.0) * u_ripAmount * 7.0;
      uv += normalize(c + vec2(1e-5)) * wv * px;
    }
    // fisheye
    if (abs(u_fisheyeAmount) > 0.001) {
      vec2 c = uv * 2.0 - 1.0;
      float r2 = dot(c, c);
      float k = 1.0 - u_fisheyeAmount * 0.42 * r2;
      uv = (c * k) * 0.5 + 0.5;
    }
    // beat zoom: punch-in pulse at a steady rate
    if (u_bzAmt > 0.001) {
      float bzPh = fract(u_time * max(u_bzRate, 0.1));
      float bzS = 1.0 + u_bzAmt * pow(1.0 - bzPh, 4.0);
      uv = 0.5 + (uv - 0.5) / bzS;
    }
    // mirror: 1 = horizontal, 2 = vertical, 3 = both
    if (u_mirrorMode > 0.5) {
      if (u_mirrorMode < 1.5 || u_mirrorMode > 2.5) { if (uv.x > u_mirrorPos) uv.x = 2.0 * u_mirrorPos - uv.x; }
      if (u_mirrorMode > 1.5) { if (uv.y > u_mirrorPos) uv.y = 2.0 * u_mirrorPos - uv.y; }
    }
    // tile / split screen (NxN copies)
    if (u_tileN > 1.5) {
      uv = fract(uv * floor(u_tileN + 0.5));
    }
    // kaleidoscope
    if (u_kaleidoSeg > 1.5) {
      float segs = max(2.0, u_kaleidoSeg);
      vec2 c = uv - 0.5;
      float ang = atan(c.y, c.x) + u_kaleidoRot * PI / 180.0;
      float r = length(c);
      float seg = PI * 2.0 / segs;
      float a2 = mod(ang, seg);
      a2 = min(a2, seg * 2.0 - a2);
      uv = vec2(0.5 + cos(a2) * r, 0.5 + sin(a2) * r);
    }
    // 2D tilt (shear)
    if (abs(u_tiltX) > 0.001 || abs(u_tiltY) > 0.001) {
      uv.x += u_tiltX * (0.5 - uv.y) * 0.35;
      uv.y += u_tiltY * (uv.x - 0.5) * 0.35;
    }
    // wave
    if (u_waveAmount > 0.01) {
      float w = sin(uv.y * u_waveFreq * PI * 2.0 + u_time * u_waveSpeed) * u_waveAmount * px.x;
      uv.x += w;
    }
    // glitch: slice displacement + block noise
    if (u_glitch > 0.001) {
      float t = floor(u_time * u_glitchSpeed * 8.0);
      float band = floor(uv.y * 24.0);
      float r1 = hash(vec2(band, t));
      if (r1 > 1.0 - u_glitch * 0.5) {
        uv.x += (hash(vec2(band, t + 7.0)) - 0.5) * u_glitch * 0.15;
      }
      float blk = u_glitchBlock / res.x;
      vec2 cell = floor(uv / vec2(blk, blk * 0.6));
      float r2 = hash(cell + t);
      if (r2 > 1.0 - u_glitch * 0.22) {
        uv.x += (hash(cell + t + 3.0) - 0.5) * blk * u_glitch * 2.0;
        uv.y += (hash(cell + t + 11.0) - 0.5) * blk * u_glitch * 1.2;
      }
    }
  }

  // ---------------- base sample (with RGB split) ----------------
  vec2 splitOff = vec2(0.0);
  if (u_efEnabled > 0.5 && (u_rgbSplit.x != 0.0 || u_rgbSplit.y != 0.0)) splitOff = u_rgbSplit * px;

  vec3 col;
  float texA = 1.0;
  if (u_hasTex > 0.5) {
    vec4 tR = texture2D(u_tex, uv + splitOff);
    vec4 tG = texture2D(u_tex, uv);
    vec4 tB = texture2D(u_tex, uv - splitOff);
    col = vec3(tR.r, tG.g, tB.b);
    texA = (tR.a + tG.a + tB.a) / 3.0;
    // grown quad (motion blur): nothing exists outside the layer itself
    if (u_expand.x + u_expand.y > 0.0 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) { col = vec3(0.0); texA = 0.0; }
  } else {
    col = vec3(0.0);
    texA = 0.0;
  }

  // ---------------- chroma key ----------------
  if (u_efEnabled > 0.5 && u_keyTol > 0.001 && u_hasTex > 0.5) {
    vec3 keyRgb = clamp(abs(fract(u_keyHue / 360.0 + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    vec2 keyC = vec2(dot(col, vec3(-0.169, -0.331, 0.5)), dot(col, vec3(0.5, -0.419, -0.081)));
    vec2 keyK = vec2(dot(keyRgb, vec3(-0.169, -0.331, 0.5)), dot(keyRgb, vec3(0.5, -0.419, -0.081)));
    float keyA = smoothstep(u_keyTol, u_keyTol + u_keySoft + 0.001, distance(keyC, keyK));
    float keyL = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(keyL), col, mix(0.35, 1.0, keyA));   // suppress key-color spill on edges
    texA *= keyA;
  }

  // ---------------- sharpen + cartoon (source-space) ----------------
  if (u_efEnabled > 0.5 && u_hasTex > 0.5) {
    // unsharp-mask sharpen
    if (u_sharpenAmount > 0.001) {
      vec2 so = vec2(u_sharpenRadius, u_sharpenRadius) * px;
      vec3 nb = texture2D(u_tex, clamp(uv + vec2(so.x, 0.0), vec2(0.001), vec2(0.999))).rgb
              + texture2D(u_tex, clamp(uv - vec2(so.x, 0.0), vec2(0.001), vec2(0.999))).rgb
              + texture2D(u_tex, clamp(uv + vec2(0.0, so.y), vec2(0.001), vec2(0.999))).rgb
              + texture2D(u_tex, clamp(uv - vec2(0.0, so.y), vec2(0.001), vec2(0.999))).rgb;
      col = mix(col, col + (col - nb * 0.25) * u_sharpenAmount * 2.0, clamp(u_sharpenAmount, 0.0, 1.0));
    }
    // cartoon / cel shade: posterized colors + ink edges
    if (u_cartoonMix > 0.001) {
      float lv = max(u_cartoonLevels, 2.0);
      vec3 post = floor(clamp(col, 0.0, 1.0) * lv + 0.5) / lv;
      vec2 e = px * 1.6;
      float lap = abs(luma(texture2D(u_tex, clamp(uv + vec2(e.x, 0.0), vec2(0.001), vec2(0.999))).rgb) - luma(col))
                + abs(luma(texture2D(u_tex, clamp(uv - vec2(e.x, 0.0), vec2(0.001), vec2(0.999))).rgb) - luma(col))
                + abs(luma(texture2D(u_tex, clamp(uv + vec2(0.0, e.y), vec2(0.001), vec2(0.999))).rgb) - luma(col))
                + abs(luma(texture2D(u_tex, clamp(uv - vec2(0.0, e.y), vec2(0.001), vec2(0.999))).rgb) - luma(col));
      float ink = smoothstep(0.10, 0.30, lap * 2.0);
      vec3 toon = mix(post, vec3(0.02), ink * u_cartoonEdge);
      col = mix(col, toon, u_cartoonMix);
    }
  }

  // ---------------- blur ----------------
  if (u_efEnabled > 0.5) {
    // combined directional/gaussian/motion blur — 12 taps
    float blurAmt = max(u_blurRadius, 0.0);
    vec2 dir = u_blurDir + u_motionVec;
    float dirLen = length(dir);
    if (length(u_motionVec) > 0.5) {
      // MOTION BLUR (shutter): 24 evenly spaced samples along the movement,
      // alpha-weighted so the layer's edges smear too (was 12 sparse taps →
      // visible copies of the layer instead of a blur)
      vec4 macc = vec4(0.0);
      for (int i = 0; i < 24; i++) {
        float tt = (float(i) + 0.5) / 24.0 * 2.0 - 1.0;
        vec2 suv = uv + dir * tt * px;
        vec4 sm = texture2D(u_tex, suv);
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) sm = vec4(0.0);
        macc += vec4(sm.rgb * sm.a, sm.a);
      }
      texA = macc.a / 24.0;
      if (macc.a > 0.0001) col = macc.rgb / macc.a;
    } else if (blurAmt > 0.5 || dirLen > 0.5) {
      vec3 acc = col;
      float wsum = 1.0;
      for (int i = 1; i <= 6; i++) {
        float fi = float(i);
        float g = exp(-0.35 * fi * fi);
        vec2 o = (dir / max(dirLen, 1.0)) * fi * max(blurAmt, dirLen / 6.0) * px;
        acc += texture2D(u_tex, uv + o).rgb * g;
        acc += texture2D(u_tex, uv - o).rgb * g;
        wsum += 2.0 * g;
      }
      col = acc / wsum;
    }
    // tilt-shift: blur grows with distance from a focus band
    if (u_tsAmt > 0.01) {
      float tsM = smoothstep(u_tsWidth, u_tsWidth + 0.25, abs(uv.y - u_tsPos));
      float tsR = u_tsAmt * tsM;
      if (tsR > 0.3) {
        vec3 tsAcc = col;
        float tsW = 1.0;
        for (int i = 1; i <= 4; i++) {
          float fi = float(i);
          float g = exp(-0.25 * fi * fi);
          vec2 ox = vec2(fi * tsR * 1.5 * px.x, 0.0);
          vec2 oy = vec2(0.0, fi * tsR * 1.5 * px.y);
          tsAcc += (texture2D(u_tex, uv + ox).rgb + texture2D(u_tex, uv - ox).rgb
                  + texture2D(u_tex, uv + oy).rgb + texture2D(u_tex, uv - oy).rgb) * g;
          tsW += 4.0 * g;
        }
        col = tsAcc / tsW;
      }
    }
    // zoom blur — 6 taps toward center
    if (u_zoomBlur > 0.001) {
      vec2 center = vec2(0.5) ;
      vec3 acc = col;
      for (int i = 1; i <= 6; i++) {
        float fi = float(i) / 6.0;
        vec2 o = (uv - center) * u_zoomBlur * 0.25 * fi;
        acc += texture2D(u_tex, uv - o).rgb;
      }
      col = acc / 7.0;
    }
    // radial (rotational) blur — 6 taps
    if (u_radialBlur > 0.001) {
      vec3 acc = col;
      vec2 rel = uv - 0.5;
      for (int i = 1; i <= 6; i++) {
        float fi = float(i) / 6.0;
        float ang = u_radialBlur * 0.12 * fi;
        float cs = cos(ang), sn = sin(ang);
        vec2 rot = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs) + 0.5;
        acc += texture2D(u_tex, rot).rgb;
      }
      col = acc / 7.0;
    }
  }

  // ---------------- grading ----------------
  if (u_efEnabled > 0.5) {
    // exposure (stops)
    col *= pow(2.0, u_exposure);
    // lift / gamma / gain
    col = col * u_gain + u_lift;
    col = pow(max(col, vec3(0.0)), vec3(1.0 / max(u_gamma, 0.01)));
    // contrast around mid grey
    col = (col - 0.5) * (1.0 + u_contrast) + 0.5;
    // temperature / tint
    col.r += u_temperature * 0.18;
    col.b -= u_temperature * 0.18;
    col.g += u_tint * 0.14;
    col.r -= u_tint * 0.05;
    col.b -= u_tint * 0.05;
    // saturation
    float l = luma(col);
    col = mix(vec3(l), col, 1.0 + u_saturation);
    // vibrance: boost low-sat pixels more
    if (abs(u_vibrance) > 0.001) {
      float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
      col = mix(vec3(l), col, 1.0 + u_vibrance * (1.0 - sat));
    }
    // hue rotate
    if (abs(u_hueDegrees) > 0.5) {
      col = hueShift(col, u_hueDegrees);
    }
    // color balance
    if (abs(u_cbR) + abs(u_cbG) + abs(u_cbB) > 0.001) {
      col += vec3(u_cbR, u_cbG, u_cbB) * 0.3;
    }
    // S-curve contrast (filmic)
    if (u_scAmount > 0.001) {
      vec3 pc = pow(max(col, vec3(0.0)), vec3(log(max(u_scPivot, 0.1)) / log(0.5)));
      col = mix(pc, pc * pc * (3.0 - 2.0 * pc), clamp(u_scAmount * 1.6, 0.0, 1.0));
    }
    // posterize
    if (u_posterLevels >= 1.5) {
      float lv = max(2.0, u_posterLevels);
      col = floor(clamp(col, 0.0, 1.0) * lv + 0.5) / lv;
    }
    // duotone
    if (u_duoMix > 0.001) {
      float dl = luma(col);
      vec3 duo = hueShift(vec3(0.16, 0.22, 0.55), u_duoHueA) * (1.0 - dl) + hueShift(vec3(1.0, 0.82, 0.42), u_duoHueB) * dl;
      col = mix(col, duo, u_duoMix);
    }
    // vignette
    if (u_vigAmount > 0.001) {
      vec2 vq = (uv - 0.5) * vec2(res.x / max(res.y, 1.0), 1.0);
      float d = length(vq) / (0.5 * sqrt(1.0 + (res.x / max(res.y, 1.0)) * (res.x / max(res.y, 1.0))));
      float v = smoothstep(1.0 - u_vigSoft, 1.0 + u_vigSoft * 0.4, d * (1.0 + u_vigAmount));
      col *= 1.0 - v * u_vigAmount;
    }
  }

  // ---------------- lighting: glow (bright-pass blur) ----------------
  if (u_efEnabled > 0.5 && u_glowIntensity > 0.001 && u_hasTex > 0.5) {
    vec3 acc = vec3(0.0);
    float r = u_glowRadius / res.x * 8.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * PI / 4.0;
      vec2 o = vec2(cos(a), sin(a)) * r * px;
      vec3 s = texture2D(u_tex, uv + o).rgb;
      float b = max(0.0, luma(s) - u_glowThreshold);
      acc += s * b;
    }
    vec3 bright = max(vec3(0.0), col - vec3(u_glowThreshold)) * 2.0;
    col += (acc / 8.0 + bright) * u_glowIntensity * 0.85;
  }

  // ---------------- stylize: sketch / neon / oil ----------------
  float shAlpha = 0.0;
  if (u_efEnabled > 0.5) {
    // drop shadow (shadow alpha carried to blend stage)
    if (u_dsOpacity > 0.001 && u_hasTex > 0.5) {
      vec2 so = vec2(u_dsX, -u_dsY) * px;
      float sacc = 0.0;
      for (int i = 0; i < 5; i++) {
        float fi = float(i) * 1.2566;
        vec2 o = vec2(cos(fi), sin(fi)) * max(u_dsSoft, 0.5) * px;
        sacc += texture2D(u_tex, clamp(uv + so + o, vec2(0.001), vec2(0.999))).a;
      }
      shAlpha = clamp(sacc * 0.2, 0.0, 1.0) * u_dsOpacity * (1.0 - texA);
    }
    // pencil sketch
    if (u_sketchAmount > 0.001 && u_hasTex > 0.5) {
      vec2 e = px * 1.5;
      float lumC = luma(col);
      float lap = abs(luma(texture2D(u_tex, uv + vec2(e.x, 0.0)).rgb) - lumC)
                + abs(luma(texture2D(u_tex, uv - vec2(e.x, 0.0)).rgb) - lumC)
                + abs(luma(texture2D(u_tex, uv + vec2(0.0, e.y)).rgb) - lumC)
                + abs(luma(texture2D(u_tex, uv - vec2(0.0, e.y)).rgb) - lumC);
      float line = smoothstep(u_sketchThresh, u_sketchThresh + 0.22, lap * 2.2);
      vec3 sk = mix(vec3(0.96), vec3(0.07), line);
      col = mix(col, sk, u_sketchAmount);
    }
    // neon edges
    if (u_neonIntensity > 0.001 && u_hasTex > 0.5) {
      vec2 e = px * 2.0;
      float lap = luma(texture2D(u_tex, uv + vec2(e.x, 0.0)).rgb) + luma(texture2D(u_tex, uv - vec2(e.x, 0.0)).rgb)
                + luma(texture2D(u_tex, uv + vec2(0.0, e.y)).rgb) + luma(texture2D(u_tex, uv - vec2(0.0, e.y)).rgb)
                - 4.0 * luma(col);
      float edge = max(0.0, lap - u_neonThresh * 0.5);
      vec3 ncol = hueShift(vec3(0.85, 0.2, 1.0), u_neonHue);
      col += ncol * edge * u_neonIntensity * 2.4;
    }
    // oil paint (4-sector kuwahara, radius ≤ 3)
    if (u_oilMix > 0.001 && u_hasTex > 0.5) {
      const int R = 3;
      vec3 bestMean = col;
      float bestVar = 1e5;
      for (int q = 0; q < 4; q++) {
        vec2 qs = vec2(q == 0 || q == 3 ? -1.0 : 1.0, q < 2 ? -1.0 : 1.0);
        vec3 acc = vec3(0.0);
        vec3 acc2 = vec3(0.0);
        float cnt = 0.0;
        for (int dy = 0; dy <= R; dy++) {
          for (int dx = 0; dx <= R; dx++) {
            vec2 o = vec2(float(dx), float(dy)) * qs * max(u_oilRadius, 1.0) * px;
            vec3 s = texture2D(u_tex, clamp(uv + o, vec2(0.001), vec2(0.999))).rgb;
            acc += s;
            acc2 += s * s;
            cnt += 1.0;
          }
        }
        vec3 mean = acc / cnt;
        vec3 variance = abs(acc2 / cnt - mean * mean);
        float v = variance.r + variance.g + variance.b;
        if (v < bestVar) { bestVar = v; bestMean = mean; }
      }
      col = mix(col, bestMean, u_oilMix);
    }
  }

  // ---------------- anime aura ----------------
  if (u_efEnabled > 0.5 && u_auraIntensity > 0.001 && u_hasTex > 0.5) {
    vec2 e = px * 2.0;
    float lap = luma(texture2D(u_tex, uv + vec2(e.x, 0.0)).rgb) + luma(texture2D(u_tex, uv - vec2(e.x, 0.0)).rgb)
              + luma(texture2D(u_tex, uv + vec2(0.0, e.y)).rgb) + luma(texture2D(u_tex, uv - vec2(0.0, e.y)).rgb)
              - 4.0 * luma(col);
    float edge = max(0.0, lap);
    float pulse = 0.75 + 0.25 * sin(u_time * u_auraPulse * PI * 2.0);
    vec3 auraCol = hueShift(vec3(0.35, 0.75, 1.0), u_auraHue);
    col += auraCol * edge * u_auraIntensity * 2.2 * pulse;
    // outer bloom tinted
    vec2 o2 = px * 8.0;
    float outer = max(0.0, luma(texture2D(u_tex, uv + o2).rgb) - u_auraThreshold);
    col += auraCol * outer * u_auraIntensity * 0.8 * pulse;
  }

  // ---------------- lighting extras: soft bloom / god rays / rim ----------------
  if (u_efEnabled > 0.5) {
    if (u_bloomIntensity > 0.001 && u_hasTex > 0.5) {
      vec3 acc = vec3(0.0);
      float rb = 14.0 / res.x * 8.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * PI / 4.0;
        vec2 o = vec2(cos(a), sin(a)) * rb * px;
        vec3 s = texture2D(u_tex, uv + o).rgb;
        acc += s;
      }
      vec3 wide = acc / 8.0;
      vec3 bright = max(vec3(0.0), wide - u_bloomThresh);
      col += bright * u_bloomIntensity * 1.1;
    }
    if (u_godIntensity > 0.001) {
      vec2 sp = vec2(0.5 + u_godX * 0.5, 0.5 - u_godY * 0.5);
      vec2 d = uv - sp;
      float ang = atan(d.y, d.x);
      float r = length(d);
      float rays = floor((ang / PI * 0.5 + 0.5) * max(u_godRays, 2.0));
      float rayOn = step(0.45, hash1(rays));
      float fade = exp(-r * 3.2);
      col += vec3(1.0, 0.96, 0.86) * rayOn * fade * u_godIntensity * 0.6 * smoothstep(0.0, 0.18, r);
    }
    if (u_rimIntensity > 0.001 && u_hasTex > 0.5) {
      vec2 e = px * 2.5;
      float lap = luma(texture2D(u_tex, uv + vec2(e.x, 0.0)).rgb) + luma(texture2D(u_tex, uv - vec2(e.x, 0.0)).rgb)
                + luma(texture2D(u_tex, uv + vec2(0.0, e.y)).rgb) + luma(texture2D(u_tex, uv - vec2(0.0, e.y)).rgb)
                - 4.0 * luma(col);
      float edge = max(0.0, lap);
      col += hueShift(vec3(1.0, 0.86, 0.62), u_rimHue) * edge * u_rimIntensity * 2.0;
    }
  }

  // ---------------- anime overlays ----------------
  if (u_efEnabled > 0.5) {
    // speed lines
    if (u_slIntensity > 0.001) {
      vec2 fc = uv - vec2(0.5 + u_slCX * 0.5, 0.5 - u_slCY * 0.5);
      float ang = atan(fc.y, fc.x);
      float rad = length(fc);
      float idx = floor((ang / PI * 0.5 + 0.5) * u_slCount);
      float line = hash1(idx);
      float on = step(1.0 - u_slIntensity * 0.65, hash1(idx + floor(u_time * u_slSpeed)));
      float thick = 0.35 + 0.65 * hash1(idx * 3.7);
      float inner = smoothstep(0.06, 0.22, rad);
      float m = on * thick * inner * smoothstep(0.9, 0.35, rad);
      col = mix(col, vec3(1.0), m * u_slIntensity * 0.9);
    }
    // impact flash
    if (u_flashAmount > 0.001) {
      if (u_flashMode > 0.5) {
        vec3 inv = 1.0 - col;
        col = mix(col, inv * 1.2, u_flashAmount);
      } else {
        col = mix(col, vec3(1.0), u_flashAmount);
      }
    }
    // energy burst rings
    if (u_burstIntensity > 0.001) {
      vec2 fc = uv - 0.5;
      float rad = length(fc) * 2.0;
      float ring = abs(rad - u_burstProgress * 1.4);
      float ringM = smoothstep(0.08, 0.0, ring) * (1.0 - u_burstProgress * 0.7);
      vec3 bcol = hueShift(vec3(0.2, 0.9, 1.0), u_burstHue);
      col += bcol * ringM * u_burstIntensity;
      col += bcol * smoothstep(0.03, 0.0, ring) * u_burstIntensity * 1.5;
    }
    // lightning
    if (u_boltIntensity > 0.001) {
      for (int i = 0; i < 4; i++) {
        if (float(i) >= u_boltCount) break;
        float fi = float(i);
        float t = floor(u_time * u_boltSpeed + fi * 17.0);
        float seed = hash1(t + fi * 31.0);
        float x0 = mix(-0.2, 1.2, hash1(seed * 91.7));
        float seg = floor(uv.x * 14.0);
        float dx = x0 + (hash1(seg * 7.3 + seed) - 0.5) * 0.16 + uv.x * 0.1 - 0.05;
        float d = abs(uv.y - dx);
        float bolt = smoothstep(0.006, 0.0, d) * step(hash1(t * 3.3 + fi), u_boltIntensity);
        col += vec3(0.85, 0.9, 1.0) * bolt * u_boltIntensity;
      }
    }
    // particles
    if (u_partDensity > 0.001) {
      vec3 pcol = hueShift(vec3(1.0, 0.65, 0.25), u_partHue);
      float acc = 0.0;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        vec2 g = uv * vec2(24.0, 18.0) + fi * 13.7;
        g.y -= u_time * u_partSpeed * (6.0 + fi * 3.0);
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        float rnd = hash(id + fi);
        if (rnd < u_partDensity * 0.35) {
          vec2 off = (vec2(hash(id + 3.0), hash(id + 7.0)) - 0.5) * 0.7;
          float d = length(f - off);
          acc += smoothstep(u_partSize * 0.014 * (0.5 + rnd), 0.0, d);
        }
      }
      col += pcol * acc * 0.85;
    }
    // manga halftone
    if (u_halfMix > 0.001) {
      float a = u_halfAngle * PI / 180.0;
      vec2 rp = vec2(uv.x * cos(a) - uv.y * sin(a), uv.x * sin(a) + uv.y * cos(a)) * res.y / u_halfScale;
      vec2 f = fract(rp) - 0.5;
      float dotM = smoothstep(0.35, 0.25, length(f));
      float l = luma(col);
      vec3 inked = mix(vec3(0.0), vec3(1.0), step(dotM, l));
      col = mix(col, inked, u_halfMix);
    }
    // CRT scanlines
    if (u_crtScan > 0.001) {
      col *= 1.0 - u_crtScan * 0.5 * step(0.5, fract(uv.y * res.y / 3.0));
    }
    // film grain
    if (u_grainAmount > 0.001) {
      float g = noise2(uv * res * (0.6 * max(u_grainSize, 0.3)) + vec2(u_time * u_grainSpeed * 13.0, u_time * u_grainSpeed * 7.0));
      col += (g - 0.5) * u_grainAmount * 0.4;
    }
    // starfield
    if (u_starDensity > 0.001) {
      vec2 g = uv * vec2(42.0, 24.0);
      g.y += u_time * u_starSpeed * 2.0;
      vec2 id = floor(g);
      vec2 f = fract(g) - 0.5;
      float rnd = hash(id);
      if (rnd < u_starDensity * 0.5) {
        vec2 off = (vec2(hash(id + 1.0), hash(id + 2.0)) - 0.5) * 0.6;
        float d = length(f - off);
        float tw = 0.55 + 0.45 * sin(u_time * u_starTwinkle * 3.0 + rnd * 40.0);
        col += vec3(1.0, 0.98, 0.9) * smoothstep(0.05 + rnd * 0.06, 0.0, d) * tw;
      }
    }
    // rain
    if (u_rainIntensity > 0.001) {
      float ra = u_rainAngle * PI / 180.0;
      vec2 rp = uv * vec2(70.0, 10.0);
      rp += vec2(u_time * u_rainSpeed * sin(ra) * 4.0, u_time * u_rainSpeed);
      float xid = floor(rp.x);
      float phase = fract(rp.y);
      float on = step(0.94 - u_rainIntensity * 0.12, hash(vec2(xid, floor(rp.y))));
      float streak = smoothstep(0.5, 0.0, abs(phase - 0.5) - 0.32);
      col += vec3(0.78, 0.84, 0.96) * on * streak * u_rainIntensity * 0.75;
    }
    // sakura petals
    if (u_sakuraDensity > 0.001) {
      for (int layer = 0; layer < 2; layer++) {
        float fl = float(layer);
        vec2 g = uv * vec2(9.0 + fl * 3.0, 6.0 + fl * 2.0);
        g.y += u_time * u_sakuraSpeed * (1.0 + fl * 0.5);
        g.x += sin(u_time * u_sakuraSway + g.y * 1.7) * 0.35;
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        float rnd = hash(id + fl * 7.0);
        if (rnd < u_sakuraDensity * 0.35) {
          vec2 off = (vec2(hash(id + 3.0), hash(id + 5.0)) - 0.5) * 0.5;
          vec2 p = (f - off) / max(u_sakuraSize * 0.12, 0.02);
          p.x *= 1.35;
          float d = length(p);
          float petal = smoothstep(0.62, 0.3, d) * smoothstep(0.12, 0.3, abs(p.x));
          col = mix(col, vec3(1.0, 0.74, 0.8), petal * 0.85);
        }
      }
    }
    // aurora
    if (u_auroraIntensity > 0.001) {
      float y1 = 0.38 + 0.16 * sin(uv.x * 4.2 + u_time * u_auroraSpeed) + 0.08 * sin(uv.x * 11.0 - u_time * u_auroraSpeed * 1.7);
      float band = exp(-abs(uv.y - y1) * 8.5);
      float ray = 0.6 + 0.4 * sin(uv.x * 38.0 + u_time * u_auroraSpeed * 3.0);
      vec3 acol = hueShift(vec3(0.12, 1.0, 0.55), u_auroraHue);
      col += acol * band * ray * u_auroraIntensity * 0.9;
    }
    // grid / HUD
    if (u_gridOpacity > 0.001) {
      vec2 gg = uv * res / max(u_gridSpacing, 4.0);
      vec2 gf = abs(fract(gg) - 0.5);
      float line = smoothstep(0.07, 0.02, min(gf.x, gf.y));
      float scan = exp(-abs(fract(uv.y * 2.0 - u_time * 0.3) - 0.5) * 12.0) * u_gridGlow;
      vec3 gcol = vec3(0.35, 0.9, 0.75);
      col = mix(col, gcol, line * u_gridOpacity * 0.55);
      col += gcol * scan * u_gridOpacity * 0.6;
    }
  }

  // ---------------- trails (feedback) ----------------
  vec2 fboUv = vec2(v_uv.x, 1.0 - v_uv.y); // FBO textures are stored NDC-y-up
  if (u_efEnabled > 0.5 && u_trailsDecay > 0.001) {
    vec3 prevCol = texture2D(u_prev, fboUv).rgb;
    col = max(col, prevCol * u_trailsDecay);
  }
  // motion echo (directional feedback)
  if (u_efEnabled > 0.5 && u_echoDecay > 0.05) {
    vec2 eo = vec2(u_echoX, -u_echoY) * px * 3.0;
    vec3 prevCol = texture2D(u_prev, clamp(fboUv + eo, vec2(0.001), vec2(0.999))).rgb;
    col = max(col, prevCol * u_echoDecay);
  }
  if (u_efEnabled > 0.5) {
    // lens flare
    if (u_flareIntensity > 0.001) {
      vec2 sp = vec2(0.5 + u_flareX * 0.5, 0.5 - u_flareY * 0.5);
      vec2 d = uv - sp;
      d.x *= res.x / max(res.y, 1.0);
      float core = exp(-length(d) * 14.0);
      float streak = exp(-abs(d.y) * (60.0 - u_flareStreak * 40.0)) * exp(-abs(d.x) * 1.8);
      vec3 fcol = vec3(1.0, 0.92, 0.8);
      col += fcol * (core * 1.2 + streak * u_flareStreak * 1.4) * u_flareIntensity;
      // ghosts
      vec2 gd = (sp - uv) * 1.8;
      float g1 = exp(-length(d + gd) * 22.0);
      float g2 = exp(-length(d + gd * 2.3) * 26.0);
      col += (vec3(0.4, 0.7, 1.0) * g1 + vec3(1.0, 0.5, 0.4) * g2) * u_flareIntensity * 0.5;
    }
    // light leak
    if (u_leakIntensity > 0.001) {
      float a = u_leakAngle * PI / 180.0;
      vec2 dirv = vec2(cos(a), sin(a));
      float grad = dot(uv - 0.5, dirv) + 0.75;
      vec3 lcol = hueShift(vec3(1.0, 0.6, 0.3), u_leakHue);
      col += lcol * max(0.0, grad) * u_leakIntensity * 0.55;
    }
  }

  // ---------------- plugin dispatch (AE-style third-party effects) ----------------
  if (u_efEnabled > 0.5 && u_pluginSel > 0.5) {
    col = applyPlugin(col, uv, res, u_time);
  }

  // ---------------- LUT ----------------
  if (u_lutEnabled > 0.5 && u_lutSize > 1.5) {
    col = applyLUT(clamp(col, 0.0, 1.0));
  }

  // ---------------- mask ----------------
  float alpha = u_opacity;
  if (u_efEnabled > 0.5 && u_maskEnabled > 0.5) {
    float aspect = res.x / max(res.y, 1.0);
    float d;
    if (u_maskType > 2.5) {
      // pen mask as a texture: exact bezier path + real feather, unlimited points
      float mt = texture2D(u_maskTex, clamp(uv, vec2(0.0), vec2(1.0))).r;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) mt = 0.0;
      d = 0.5 - mt; // remapped below
    } else if (u_maskType > 1.5) {
      // pen (bezier flattened to polygon on CPU, points in layer-uv aspect space)
      vec2 pp = vec2(uv.x * max(u_maskAspect, 0.01), uv.y);
      d = asSdPolygon(pp, max(u_maskPtsN, 3.0));
    } else {
      vec2 mc = uv - vec2(0.5 + u_maskX * 0.5, 0.5 - u_maskY * 0.5);
      mc *= vec2(aspect, 1.0);
      float w = u_maskW * 0.5, h = u_maskH * 0.5;
      if (u_maskType < 0.5) {
        vec2 q = abs(mc) - vec2(w * aspect * 0.5 * 2.0, h);
        d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
      } else {
        vec2 nrm = mc / vec2(w * aspect, h);
        d = length(nrm) - 1.0;
      }
    }
    float aa = max(u_maskFeather, 0.001);
    float m = u_maskType > 2.5 ? clamp(0.5 - d, 0.0, 1.0) : 1.0 - smoothstep(-aa, aa, d);
    if (u_maskInvert > 0.5) m = 1.0 - m;
    alpha *= m;
  }

  // ---------------- track matte gating ----------------
  if (u_efEnabled > 0.5 && u_matteMode > 0.5) {
    vec4 mt = texture2D(u_matte, fboUv);
    float mf = u_matteMode < 1.5 ? mt.a
             : u_matteMode < 2.5 ? 1.0 - mt.a
             : u_matteMode < 3.5 ? luma(mt.rgb)
             : 1.0 - luma(mt.rgb);
    alpha *= clamp(mf, 0.0, 1.0);
  }

  // ---------------- blend with backdrop ----------------
  if (u_matteRender > 0.5) {
    // matte source pass: no backdrop blending — output straight color + alpha
    float saM = clamp(alpha * max(texA, shAlpha), 0.0, 1.0);
    gl_FragColor = vec4(col, saM);
    return;
  }
  vec3 back = texture2D(u_back, fboUv).rgb;
  vec3 outc;
  float bm = u_blend;
  float layerA = texA;
  float sa = alpha * max(layerA, shAlpha); // combined layer alpha (+ drop shadow)
  if (bm < 0.5) {
    outc = mix(back, col, sa);
  } else if (bm < 1.5) { // add
    outc = back + col * sa;
  } else if (bm < 2.5) { // screen
    outc = mix(back, 1.0 - (1.0 - back) * (1.0 - col), sa);
  } else if (bm < 3.5) { // multiply
    outc = mix(back, back * col, sa);
  } else if (bm < 4.5) { // overlay
    vec3 ov = mix(2.0 * back * col, 1.0 - 2.0 * (1.0 - back) * (1.0 - col), step(0.5, back));
    outc = mix(back, ov, sa);
  } else if (bm < 5.5) { // lighten
    outc = mix(back, max(back, col), sa);
  } else { // difference
    outc = mix(back, abs(back - col), sa);
  }

  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`

/**
 * Build the mega fragment shader. `pluginChunk` carries GLSL from installed
 * third-party plugins (uniforms + applyPlugin dispatch), generated by the
 * plugin registry at program-build time.
 */
function buildFragSrc(pluginChunk: string): string {
  return FRAG_SRC_BASE.replace('/*__PLUGIN_CHUNK__*/', pluginChunk)
}

// Identity program for final blit
const BLIT_FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_lutEnabled;
uniform float u_lutSize;
uniform sampler2D u_lutTex;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 applyLUT(vec3 c) {
  float n = u_lutSize;
  float b = clamp(c.b, 0.0, 0.999) * (n - 1.0);
  float tile = floor(b);
  float frac = b - tile;
  float tileX = mod(tile, n);
  float tileY = floor(tile / n);
  float tile2 = min(tile + 1.0, n - 1.0);
  float tileX2 = mod(tile2, n);
  float tileY2 = floor(tile2 / n);
  float uu = (tileX * n + clamp(c.r, 0.0, 0.999) * (n - 1.0)) / (n * n);
  float vv = (tileY * n + clamp(c.g, 0.0, 0.999) * (n - 1.0)) / n;
  float uu2 = (tileX2 * n + clamp(c.r, 0.0, 0.999) * (n - 1.0)) / (n * n);
  float vv2 = (tileY2 * n + clamp(c.g, 0.0, 0.999) * (n - 1.0)) / n;
  vec3 s0 = texture2D(u_lutTex, vec2(uu, vv)).rgb;
  vec3 s1 = texture2D(u_lutTex, vec2(uu2, vv2)).rgb;
  return mix(s0, s1, frac);
}
void main() {
  vec4 c = texture2D(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
  if (u_lutEnabled > 0.5 && u_lutSize > 1.5) {
    c.rgb = applyLUT(clamp(c.rgb, 0.0, 1.0));
  }
  gl_FragColor = c;
}
`

const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0, add: 1, screen: 2, multiply: 3, overlay: 4, lighten: 5, difference: 6,
}

function mat3Identity(): number[] { return [1, 0, 0, 0, 1, 0, 0, 0, 1] }
function mat3Mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return o
}
function mat3Translate(x: number, y: number): number[] { return [1, 0, 0, 0, 1, 0, x, y, 1] }
function mat3Scale(sx: number, sy: number): number[] { return [sx, 0, 0, 0, sy, 0, 0, 0, 1] }
function mat3Rotate(rad: number): number[] {
  const c = Math.cos(rad), s = Math.sin(rad)
  return [c, s, 0, -s, c, 0, 0, 0, 1]
}

/** Per-layer uniform block the CPU composes; consumed by the mega shader. */
export interface LayerUniforms {
  hasTex: number
  layerSize: [number, number]
  opacity: number
  blend: number
  exposure: number; contrast: number; saturation: number; temperature: number; tint: number
  lift: number; gamma: number; gain: number; vibrance: number
  vigAmount: number; vigSoft: number
  blurRadius: number; blurDir: [number, number]; motionVec: [number, number]
  zoomBlur: number; radialBlur: number
  rgbSplit: [number, number]
  waveAmount: number; waveFreq: number; waveSpeed: number
  glitch: number; glitchSpeed: number; glitchBlock: number
  crtCurve: number; crtScan: number
  glowThreshold: number; glowIntensity: number; glowRadius: number
  auraThreshold: number; auraIntensity: number; auraHue: number; auraPulse: number
  flareX: number; flareY: number; flareIntensity: number; flareStreak: number
  leakIntensity: number; leakHue: number; leakAngle: number
  slIntensity: number; slCount: number; slSpeed: number; slCX: number; slCY: number
  flashAmount: number; flashMode: number
  burstProgress: number; burstIntensity: number; burstHue: number
  boltIntensity: number; boltCount: number; boltSpeed: number
  partDensity: number; partSize: number; partSpeed: number; partHue: number
  halfMix: number; halfScale: number; halfAngle: number
  trailsDecay: number
  // perspective
  bulgeAmount: number; bulgeRadius: number; bulgeCX: number; bulgeCY: number
  twirlAngle: number; twirlRadius: number; twirlCX: number; twirlCY: number
  ripAmount: number; ripWave: number; ripSpeed: number
  fisheyeAmount: number
  kaleidoSeg: number; kaleidoRot: number
  mirrorMode: number; mirrorPos: number; tileN: number; bzAmt: number; bzRate: number
  keyTol: number; keySoft: number; keyHue: number
  tsAmt: number; tsPos: number; tsWidth: number
  tiltX: number; tiltY: number
  dsX: number; dsY: number; dsOpacity: number; dsSoft: number
  // stylize
  posterLevels: number; pixSize: number
  sketchAmount: number; sketchThresh: number
  neonIntensity: number; neonHue: number; neonThresh: number
  oilRadius: number; oilMix: number
  duoHueA: number; duoHueB: number; duoMix: number
  // generate
  grainAmount: number; grainSize: number; grainSpeed: number
  starDensity: number; starSpeed: number; starTwinkle: number
  rainIntensity: number; rainAngle: number; rainSpeed: number
  sakuraDensity: number; sakuraSpeed: number; sakuraSway: number; sakuraSize: number
  auroraIntensity: number; auroraHue: number; auroraSpeed: number
  gridSpacing: number; gridOpacity: number; gridGlow: number
  // time
  echoDecay: number; echoX: number; echoY: number
  shakeIntensity: number; shakeFreq: number; shakeRot: number
  // lighting extra
  bloomThresh: number; bloomIntensity: number
  godIntensity: number; godX: number; godY: number; godRays: number
  rimIntensity: number; rimHue: number
  // color extra
  hueDegrees: number; cbR: number; cbG: number; cbB: number
  scAmount: number; scPivot: number
  // stylize extra
  sharpenAmount: number; sharpenRadius: number
  cartoonMix: number; cartoonLevels: number; cartoonEdge: number
  // distortion extra
  turbAmount: number; turbScale: number; turbSpeed: number
  // plugin dispatch
  pluginSel: number
  pluginParams: Record<string, number>
  maskEnabled: number; maskType: number; maskX: number; maskY: number; maskW: number; maskH: number; maskFeather: number; maskInvert: number
  /** Pen mask flattened polygon (uv aspect space); set in render() per layer. */
  maskPts: number[]; maskPtsN: number; maskAspect: number
  lutEnabled: number; lutSize: number
}

export function blankUniforms(): LayerUniforms {
  return {
    hasTex: 0, layerSize: [16, 16], opacity: 1, blend: 0,
    exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0,
    lift: 0, gamma: 1, gain: 1, vibrance: 0, vigAmount: 0, vigSoft: 0.5,
    blurRadius: 0, blurDir: [0, 0], motionVec: [0, 0], zoomBlur: 0, radialBlur: 0,
    rgbSplit: [0, 0], waveAmount: 0, waveFreq: 8, waveSpeed: 2,
    glitch: 0, glitchSpeed: 6, glitchBlock: 24,
    crtCurve: 0, crtScan: 0,
    glowThreshold: 0.55, glowIntensity: 0, glowRadius: 12,
    auraThreshold: 0.4, auraIntensity: 0, auraHue: 210, auraPulse: 2,
    flareX: 0, flareY: 0, flareIntensity: 0, flareStreak: 0.6,
    leakIntensity: 0, leakHue: 30, leakAngle: 45,
    slIntensity: 0, slCount: 80, slSpeed: 3, slCX: 0, slCY: 0,
    flashAmount: 0, flashMode: 1,
    burstProgress: 0.5, burstIntensity: 0, burstHue: 190,
    boltIntensity: 0, boltCount: 3, boltSpeed: 8,
    partDensity: 0, partSize: 2, partSpeed: 0.6, partHue: 35,
    halfMix: 0, halfScale: 8, halfAngle: 45,
    trailsDecay: 0,
    bulgeAmount: 0, bulgeRadius: 0.7, bulgeCX: 0, bulgeCY: 0,
    twirlAngle: 0, twirlRadius: 0.6, twirlCX: 0, twirlCY: 0,
    ripAmount: 0, ripWave: 60, ripSpeed: 1.5,
    fisheyeAmount: 0,
    kaleidoSeg: 0, kaleidoRot: 0,
    mirrorMode: 0, mirrorPos: 0.5, tileN: 1, bzAmt: 0, bzRate: 2,
    keyTol: 0, keySoft: 0.08, keyHue: 120,
    tsAmt: 0, tsPos: 0.5, tsWidth: 0.15,
    tiltX: 0, tiltY: 0,
    dsX: 10, dsY: 10, dsOpacity: 0, dsSoft: 8,
    posterLevels: 0, pixSize: 0,
    sketchAmount: 0, sketchThresh: 0.35,
    neonIntensity: 0, neonHue: 320, neonThresh: 0.3,
    oilRadius: 3, oilMix: 0,
    duoHueA: 230, duoHueB: 45, duoMix: 0,
    grainAmount: 0, grainSize: 1.2, grainSpeed: 2,
    starDensity: 0, starSpeed: 0.3, starTwinkle: 1,
    rainIntensity: 0, rainAngle: 12, rainSpeed: 2.5,
    sakuraDensity: 0, sakuraSpeed: 0.5, sakuraSway: 1, sakuraSize: 1.4,
    auroraIntensity: 0, auroraHue: 150, auroraSpeed: 0.8,
    gridSpacing: 32, gridOpacity: 0, gridGlow: 0.4,
    echoDecay: 0, echoX: -14, echoY: 0,
    shakeIntensity: 0, shakeFreq: 12, shakeRot: 0.8,
    bloomThresh: 0.5, bloomIntensity: 0,
    godIntensity: 0, godX: -0.3, godY: 0.4, godRays: 10,
    rimIntensity: 0, rimHue: 40,
    hueDegrees: 0, cbR: 0, cbG: 0, cbB: 0,
    scAmount: 0, scPivot: 0.5,
    sharpenAmount: 0, sharpenRadius: 1,
    cartoonMix: 0, cartoonLevels: 5, cartoonEdge: 0,
    turbAmount: 0, turbScale: 6, turbSpeed: 0.6,
    pluginSel: 0,
    pluginParams: {},
    maskEnabled: 0, maskType: 0, maskX: 0, maskY: 0, maskW: 1, maskH: 1, maskFeather: 0.08, maskInvert: 0,
    maskPts: [], maskPtsN: 0, maskAspect: 1,
    lutEnabled: 0, lutSize: 0,
  }
}

/** Build the per-layer uniform set from all enabled effects on the clip. */
export function computeLayerUniforms(clip: Clip, localTime: number, out: LayerUniforms = blankUniforms()): LayerUniforms {
  const u = out
  for (const key of Object.keys(u) as (keyof LayerUniforms)[]) {
    // skip structural fields
    if (key === 'hasTex' || key === 'layerSize' || key === 'opacity' || key === 'blend' || key.startsWith('lut')) continue
  }
  const fx = clip.effects.filter(e => e.enabled)
  for (const e of fx) {
    const v = (p: string) => evalEffectParam(e, p, localTime)
    switch (e.type) {
      case 'directional_blur': {
        const amount = v('amount'), ang = (v('angle') * Math.PI) / 180
        u.blurDir = [Math.cos(ang) * amount, -Math.sin(ang) * amount]
        break
      }
      case 'gaussian_blur': u.blurRadius = Math.max(u.blurRadius, v('amount')); break
      case 'zoom_blur': u.zoomBlur = Math.max(u.zoomBlur, v('amount')); break
      case 'radial_blur': u.radialBlur = Math.max(u.radialBlur, v('amount')); break
      case 'motion_trails': u.trailsDecay = v('decay'); break
      case 'glow': u.glowThreshold = v('threshold'); u.glowIntensity = v('intensity'); u.glowRadius = v('radius'); break
      case 'aura': u.auraThreshold = v('threshold'); u.auraIntensity = v('intensity'); u.auraHue = v('hue'); u.auraPulse = v('pulse'); break
      case 'lens_flare': u.flareX = v('x'); u.flareY = v('y'); u.flareIntensity = v('intensity'); u.flareStreak = v('streak'); break
      case 'light_leak': u.leakIntensity = v('intensity'); u.leakHue = v('hue'); u.leakAngle = v('angle'); break
      case 'vignette': u.vigAmount = v('amount'); u.vigSoft = v('softness'); break
      case 'rgb_split': {
        const a = v('amount'), ang = (v('angle') * Math.PI) / 180
        u.rgbSplit = [Math.cos(ang) * a, Math.sin(ang) * a]
        break
      }
      case 'chromatic_aberration': {
        // approximate as radial split — small fixed-direction split scaled by uv distance handled in shader via rgbSplit
        const a = v('amount') * 14
        u.rgbSplit = [Math.max(u.rgbSplit[0], a * 0.6), Math.max(u.rgbSplit[1], a * 0.6)]
        break
      }
      case 'glitch': u.glitch = v('amount'); u.glitchSpeed = v('speed'); u.glitchBlock = v('blockSize'); break
      case 'wave_distortion': u.waveAmount = v('amount'); u.waveFreq = v('frequency'); u.waveSpeed = v('speed'); break
      case 'screen_distortion': u.crtCurve = v('curve'); u.crtScan = v('scanlines'); break
      case 'exposure': u.exposure += v('stops'); break
      case 'contrast': u.contrast += v('amount'); break
      case 'saturation': u.saturation += v('amount'); break
      case 'temperature': u.temperature += v('value'); break
      case 'tint': u.tint += v('value'); break
      case 'lift_gamma_gain': u.lift += v('lift'); u.gamma *= v('gamma'); u.gain *= v('gain'); break
      case 'vibrance': u.vibrance += v('amount'); break
      case 'speed_lines': u.slIntensity = v('intensity'); u.slCount = v('count'); u.slSpeed = v('speed'); u.slCX = v('centerX'); u.slCY = v('centerY'); break
      case 'impact_flash': u.flashAmount = v('amount'); u.flashMode = v('mode'); break
      case 'energy_burst': u.burstProgress = v('progress'); u.burstIntensity = v('intensity'); u.burstHue = v('hue'); break
      case 'lightning': u.boltIntensity = v('intensity'); u.boltCount = v('boltCount'); u.boltSpeed = v('speed'); break
      case 'particles': u.partDensity = v('density'); u.partSize = v('size'); u.partSpeed = v('speed'); u.partHue = v('hue'); break
      case 'halftone': u.halfMix = v('amount'); u.halfScale = v('scale'); u.halfAngle = v('angle'); break
      // ---- perspective
      case 'bulge': u.bulgeAmount = v('amount'); u.bulgeRadius = v('radius'); u.bulgeCX = v('centerX'); u.bulgeCY = v('centerY'); break
      case 'twirl': u.twirlAngle = v('angle'); u.twirlRadius = v('radius'); u.twirlCX = v('centerX'); u.twirlCY = v('centerY'); break
      case 'ripple': u.ripAmount = v('amount'); u.ripWave = v('wavelength'); u.ripSpeed = v('speed'); break
      case 'fisheye': u.fisheyeAmount = v('amount'); break
      case 'kaleido': u.kaleidoSeg = v('segments'); u.kaleidoRot = v('rotation'); break
      case 'mirror': u.mirrorMode = Math.round(v('mode')); u.mirrorPos = v('position'); break
      case 'tile': u.tileN = Math.round(v('count')); break
      case 'beat_zoom': u.bzAmt = v('amount'); u.bzRate = v('rate'); break
      case 'chroma_key': u.keyTol = v('tolerance'); u.keySoft = v('softness'); u.keyHue = v('hue'); break
      case 'tilt_shift': u.tsAmt = v('amount'); u.tsPos = v('position'); u.tsWidth = v('width'); break
      case 'tilt_2d': u.tiltX = v('shearX'); u.tiltY = v('shearY'); break
      case 'drop_shadow': u.dsX = v('offsetX'); u.dsY = v('offsetY'); u.dsOpacity = v('opacity'); u.dsSoft = v('softness'); break
      // ---- stylize
      case 'posterize': u.posterLevels = v('levels'); break
      case 'pixelate': u.pixSize = v('size'); break
      case 'sketch': u.sketchAmount = v('amount'); u.sketchThresh = v('threshold'); break
      case 'neon_edges': u.neonIntensity = v('intensity'); u.neonHue = v('hue'); u.neonThresh = v('threshold'); break
      case 'oil_paint': u.oilRadius = v('radius'); u.oilMix = v('mix'); break
      case 'duotone': u.duoHueA = v('hueA'); u.duoHueB = v('hueB'); u.duoMix = v('mix'); break
      // ---- generate
      case 'film_grain': u.grainAmount = v('amount'); u.grainSize = v('size'); u.grainSpeed = v('speed'); break
      case 'starfield': u.starDensity = v('density'); u.starSpeed = v('speed'); u.starTwinkle = v('twinkle'); break
      case 'rain_overlay': u.rainIntensity = v('intensity'); u.rainAngle = v('angle'); u.rainSpeed = v('speed'); break
      case 'sakura_petals': u.sakuraDensity = v('density'); u.sakuraSpeed = v('speed'); u.sakuraSway = v('sway'); u.sakuraSize = v('size'); break
      case 'aurora_waves': u.auroraIntensity = v('intensity'); u.auroraHue = v('hue'); u.auroraSpeed = v('speed'); break
      case 'grid_overlay': u.gridSpacing = v('spacing'); u.gridOpacity = v('opacity'); u.gridGlow = v('glow'); break
      // ---- time
      case 'motion_echo': u.echoDecay = v('decay'); u.echoX = v('offsetX'); u.echoY = v('offsetY'); break
      case 'camera_shake': u.shakeIntensity = v('intensity'); u.shakeFreq = v('frequency'); u.shakeRot = v('rotation'); break
      // ---- lighting extra
      case 'soft_bloom': u.bloomThresh = v('threshold'); u.bloomIntensity = v('intensity'); break
      case 'godrays': u.godIntensity = v('intensity'); u.godX = v('x'); u.godY = v('y'); u.godRays = v('rays'); break
      case 'rim_light': u.rimIntensity = v('intensity'); u.rimHue = v('hue'); break
      // ---- color extra
      case 'hue_shift': u.hueDegrees = v('degrees'); break
      case 'color_balance': u.cbR = v('red'); u.cbG = v('green'); u.cbB = v('blue'); break
      case 's_curve': u.scAmount = v('amount'); u.scPivot = v('pivot'); break
      // ---- stylize extra
      case 'sharpen': u.sharpenAmount = v('amount'); u.sharpenRadius = v('radius'); break
      case 'cartoon': u.cartoonMix = v('mix'); u.cartoonLevels = v('levels'); u.cartoonEdge = v('edge'); break
      // ---- distortion extra
      case 'turbulent_displace': u.turbAmount = v('amount'); u.turbScale = v('scale'); u.turbSpeed = v('speed'); break
      // ---- time extra (posterize_time is applied CPU-side in the render loop)
      case 'posterize_time': break
      // ---- plugin effects (AE-style third-party)
      default: {
        const def = EFFECT_MAP[e.type]
        if (def?.pluginId) {
          const sel = pluginSelectionIndex(def.pluginId, e.type)
          if (sel > 0) {
            u.pluginSel = sel
            for (const p of def.params) {
              u.pluginParams[`u_pl${sel - 1}_${sanitizeParamKey(p.key)}`] = v(p.key)
            }
          }
        }
        break
      }
    }
  }
  /**
   * FIXED: mask uniforms are now actually populated from clip.mask.
   * (Previously the UI and the shader existed but this bridge was missing,
   * so masks never rendered.) Pen-mask vertices are filled per-layer in
   * render() where the layer matrix is known.
   */
  if (clip.mask) {
    u.maskEnabled = 1
    u.maskType = clip.mask.shape === 'ellipse' ? 1 : clip.mask.shape === 'pen' ? 2 : 0
    u.maskX = clip.mask.x; u.maskY = clip.mask.y
    u.maskW = clip.mask.width; u.maskH = clip.mask.height
    u.maskFeather = Math.max(0.001, clip.mask.feather)
    u.maskInvert = clip.mask.invert ? 1 : 0
  } else {
    u.maskEnabled = 0; u.maskType = 0; u.maskPtsN = 0
  }
  return u
}

// ---------------------------------------------------------------------------
// Pen-mask CPU helpers
// ---------------------------------------------------------------------------

/** Flatten a closed bezier path into a polyline (≤ maxPts vertices). */
function flattenPenPath(points: MaskPoint[], segsPerCurve = 5, maxPts = 24): { x: number; y: number }[] {
  const src = points
  const n = src.length
  if (n < 3) return points.map(p => ({ x: p.x, y: p.y }))
  const per = Math.max(1, Math.min(segsPerCurve, Math.floor(maxPts / n)))
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const p0 = src[i]
    const p1 = src[(i + 1) % n]
    const c1x = p0.x + (p0.hOut?.x ?? 0), c1y = p0.y + (p0.hOut?.y ?? 0)
    const c2x = p1.x + (p1.hIn?.x ?? 0), c2y = p1.y + (p1.hIn?.y ?? 0)
    for (let s = 0; s < per; s++) {
      const t = s / per
      const mt = 1 - t
      out.push({
        x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * p1.x,
        y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * p1.y,
      })
    }
  }
  return out.slice(0, maxPts)
}

function mat3Inverse(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const invDet = 1 / det
  return [
    A * invDet,
    -(b * i - c * h) * invDet,
    (b * f - c * e) * invDet,
    B * invDet,
    (a * i - c * g) * invDet,
    -(a * f - c * d) * invDet,
    C * invDet,
    -(a * h - b * g) * invDet,
    (a * e - b * d) * invDet,
  ]
}

function sourceSize(src: TextureSource): [number, number] {
  const s = src as HTMLVideoElement & HTMLImageElement & ImageBitmap & HTMLCanvasElement
  return [s.videoWidth || s.naturalWidth || s.width || 16, s.videoHeight || s.naturalHeight || s.height || 16]
}

export class Compositor {
  gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
  private canvas: HTMLCanvasElement | null = null
  private prog!: WebGLProgram
  private blitProg!: WebGLProgram
  private quadVBO: WebGLBuffer | null = null
  private penMaskTex: WebGLTexture | null = null
  private penMasks = new Map<string, { canvas: HTMLCanvasElement; tex: WebGLTexture; sig: string }>()
  /** Pen mask → alpha texture: exact bezier curves, any number of points, real feather. */
  private renderPenMask(clipId: string, pts: { x: number; y: number; hIn?: { x: number; y: number }; hOut?: { x: number; y: number } }[], toUv: (x: number, y: number) => number[], srcW: number, srcH: number, feather: number): WebGLTexture | null {
    const gl = this.gl!
    const k = Math.min(1, 1024 / Math.max(srcW, srcH))
    const W = Math.max(16, Math.round(srcW * k)), H = Math.max(16, Math.round(srcH * k))
    const uvPts = pts.map(p => ({ p: toUv(p.x, p.y), i: toUv(p.x + (p.hIn?.x ?? 0), p.y + (p.hIn?.y ?? 0)), o: toUv(p.x + (p.hOut?.x ?? 0), p.y + (p.hOut?.y ?? 0)) }))
    const sig = `${W}x${H}|${feather.toFixed(4)}|` + uvPts.map(q => q.p.concat(q.i, q.o).map(v => v.toFixed(4)).join(',')).join(';')
    let e = this.penMasks.get(clipId)
    if (e && e.sig === sig) return e.tex
    if (!e) { const c = document.createElement('canvas'); e = { canvas: c, tex: gl.createTexture()!, sig: '' }; this.penMasks.set(clipId, e) }
    const c = e.canvas
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H }
    const g = c.getContext('2d')!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.filter = 'none'
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H)
    const blur = Math.max(0, feather) * H * 0.5
    g.filter = blur > 0.3 ? `blur(${blur.toFixed(2)}px)` : 'none'
    g.fillStyle = '#fff'
    g.beginPath()
    const X = (v: number[]) => v[0] * W, Y = (v: number[]) => v[1] * H
    g.moveTo(X(uvPts[0].p), Y(uvPts[0].p))
    for (let i = 0; i < uvPts.length; i++) {
      const a = uvPts[i], b = uvPts[(i + 1) % uvPts.length]
      g.bezierCurveTo(X(a.o), Y(a.o), X(b.i), Y(b.i), X(b.p), Y(b.p))
    }
    g.closePath(); g.fill()
    gl.bindTexture(gl.TEXTURE_2D, e.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    e.sig = sig
    return e.tex
  }
  private uniformLocs: Record<string, WebGLUniformLocation | null> = {}
  private blitLocs: Record<string, WebGLUniformLocation | null> = {}
  private pp: PingPong[] = []
  private ppIndex = 0
  private prevTex: WebGLTexture | null = null
  private prevSize = ''
  private prevSizeTex: WebGLTexture | null = null
  private texCache = new Map<string, { tex: WebGLTexture; src: TextureSource; w: number; h: number }>()
  private bridgeChecked = new WeakSet<HTMLVideoElement>()
  private bridgeElements = new WeakSet<HTMLVideoElement>()
  private bridgeCanvases = new WeakMap<HTMLVideoElement, HTMLCanvasElement>()
  private lutTex: WebGLTexture | null = null
  private dummyTex: WebGLTexture | null = null
  lutSize = 0
  compLutEnabled = false
  renderScale = 1

  attach(canvas: HTMLCanvasElement, captureSafe = false) {
    this.canvas = canvas
    // export contexts: never skip a video upload (every frame must be exact)
    this.alwaysUploadVideo = captureSafe
    const opts: WebGLContextAttributes = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false,
      // captureSafe: the export engines read the canvas back (VideoFrame /
      // captureStream). With preserveDrawingBuffer=false Safari intermittently
      // hands out a stale or cleared buffer on those reads → single-frame
      // flicker / blank frames in exported files. Preview stays false for
      // iOS performance.
      preserveDrawingBuffer: captureSafe,
      powerPreference: 'high-performance',
    }
    this.gl = (canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts)) as WebGLRenderingContext
    if (!this.gl) throw new Error('WebGL not supported on this device')
    const gl = this.gl
    this.buildMainProgram()
    this.blitProg = this.buildProgram(VERT_SRC, BLIT_FRAG)
    // rebuild when plugin set changes (AE-style plugin hot-load)
    onPluginsChanged(() => this.refreshProgram())
    // quad
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    // a_pos (2) + a_uv (2) interleaved
    const data = new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0,
    ])
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    this.quadVBO = vbo
    // 1×1 dummy texture: keeps sampler-only units (u_lutTex) VALID. An active
    // sampler pointing at a stale/unbound texture triggers INVALID_OPERATION
    // on drawArrays (hit when two+ layers render — the second layer went black).
    const dummy = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, dummy)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.dummyTex = dummy
    this.resize()
  }

  private buildProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl!
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh)
        throw new Error(`Shader compile error: ${log}`)
      }
      return sh
    }
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(p)}`)
    }
    return p
  }

  /** Compile the mega shader with the currently installed plugin chunk. */
  private buildMainProgram() {
    this.prog = this.buildProgram(VERT_SRC, buildFragSrc(getPluginShaderChunk()))
    this.uniformLocs = {}
  }

  /** Hot-reload the program after plugins install/uninstall. */
  refreshProgram() {
    if (!this.gl) return
    try {
      const old = this.prog
      this.buildMainProgram()
      if (old) this.gl.deleteProgram(old)
    } catch (e) {
      // a broken plugin must never take the editor down — rebuild clean
      try {
        const old = this.prog
        this.prog = this.buildProgram(VERT_SRC, buildFragSrc(''))
        this.uniformLocs = {}
        if (old) this.gl.deleteProgram(old)
        void e
      } catch { /* keep previous program */ }
    }
  }

  resize() {
    const gl = this.gl
    const canvas = this.canvas
    if (!gl || !canvas) return
    // already sized by caller; create ping-pong buffers at canvas size
    const w = canvas.width, h = canvas.height
    for (const p of this.pp) {
      gl.deleteFramebuffer(p.fbo)
      gl.deleteTexture(p.tex)
    }
    this.pp = []
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this.pp.push({ fbo, tex })
    }
    this.ppIndex = 0
    if (this.prevTex) { gl.deleteTexture(this.prevTex); this.prevTex = null }
  }

  /** Load a .cube LUT string (3D size N). Returns true on success. */
  loadLUT(cube: string): boolean {
    const gl = this.gl
    if (!gl) return false
    const lines = cube.split('\n')
    let size = 0
    const data: number[] = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('LUT_3D_SIZE')) {
        size = parseInt(line.split(/\s+/)[1], 10)
        continue
      }
      if (line.startsWith('LUT_') || line.startsWith('DOMAIN_') || line.startsWith('TITLE')) continue
      const parts = line.split(/\s+/).map(parseFloat)
      if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
        data.push(parts[0], parts[1], parts[2])
      }
    }
    if (size < 2 || data.length < size * size * size * 3) return false
    // Build tiled atlas: width n*n, height n, RGBA
    const w = size * size, h = size
    const pixels = new Uint8Array(w * h * 4)
    // .cube order: r fastest, then g, then b — map b→tile
    for (let b = 0; b < size; b++) {
      for (let g = 0; g < size; g++) {
        for (let r = 0; r < size; r++) {
          const si = (b * size * size + g * size + r) * 3
          const tileX = b % size, tileY = Math.floor(b / size)
          const dx = tileX * size + r
          const dy = tileY * size + g
          const di = (dy * w + dx) * 4
          pixels[di] = Math.round(data[si] * 255)
          pixels[di + 1] = Math.round(data[si + 1] * 255)
          pixels[di + 2] = Math.round(data[si + 2] * 255)
          pixels[di + 3] = 255
        }
      }
    }
    if (this.lutTex) gl.deleteTexture(this.lutTex)
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.lutTex = tex
    this.lutSize = size
    this.compLutEnabled = true
    return true
  }

  clearLUT() {
    this.compLutEnabled = false
    if (this.lutTex && this.gl) this.gl.deleteTexture(this.lutTex)
    this.lutTex = null
    this.lutSize = 0
  }

  private getOrCreateTexture(key: string, src: TextureSource): { tex: WebGLTexture; w: number; h: number } | null {
    const gl = this.gl!
    let entry = this.texCache.get(key) as { tex: WebGLTexture; src: TextureSource; w: number; h: number } | null | undefined
    const srcW = (src as HTMLVideoElement).videoWidth ?? (src as HTMLImageElement).naturalWidth ?? (src as ImageBitmap).width ?? (src as HTMLCanvasElement).width
    const srcH = (src as HTMLVideoElement).videoHeight ?? (src as HTMLImageElement).naturalHeight ?? (src as ImageBitmap).height ?? (src as HTMLCanvasElement).height
    const isVideo = src instanceof HTMLVideoElement
    // Some environments (headless SwiftShader) silently upload black for video
    // elements — detect once per element and bridge through a 2D canvas.
    // Defer probing until the element actually has frame data, otherwise the
    // probe would permanently misreport.
    if (isVideo && !this.bridgeChecked.has(src) && (src as HTMLVideoElement).readyState >= 2 && (src as HTMLVideoElement).videoWidth > 0) {
      this.bridgeChecked.add(src)
      if (probeVideoNeedsBridge(src)) this.bridgeElements.add(src)
    }
    const useBridge = isVideo && this.bridgeElements.has(src)
    if (useBridge) {
      try {
        let bc = this.bridgeCanvases.get(src)
        if (!bc || bc.width !== srcW || bc.height !== srcH) {
          bc = document.createElement('canvas')
          bc.width = Math.max(2, srcW)
          bc.height = Math.max(2, srcH)
          this.bridgeCanvases.set(src, bc)
        }
        const bctx = bc.getContext('2d')!
        bctx.drawImage(src as HTMLVideoElement, 0, 0)
        if (!entry || entry.src !== bc || entry.w !== srcW || entry.h !== srcH) {
          entry = this.uploadTexture(key, bc, srcW, srcH, entry)
          if (!entry) return null
          this.texCache.set(key, entry)
        } else {
          gl.bindTexture(gl.TEXTURE_2D, entry.tex)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bc)
        }
        return entry
      } catch {
        return null
      }
    }
    if (!entry || entry.src !== src || entry.w !== srcW || entry.h !== srcH) {
      entry = this.uploadTexture(key, src, srcW, srcH, entry)
      if (!entry) return null
      this.texCache.set(key, entry)
      if (isVideo) this.markUploaded(key, src as HTMLVideoElement)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      // PERF: a 1080p/4K texImage2D per layer per rAF was the single biggest
      // preview cost. Only re-upload a video texture when the element really
      // presented a new frame (requestVideoFrameCallback serial) or, while
      // paused, when its currentTime moved (seek / scrub). Still images and
      // canvases (text, procedural) are uploaded as before.
      if (isVideo && !this.videoNeedsUpload(key, src as HTMLVideoElement)) return entry
      // versioned canvases (text): re-upload only when the drawing changed
      const ver = (src as { __asVer?: number }).__asVer
      if (ver !== undefined) {
        const e2 = entry as { ver?: number }
        if (e2.ver === ver) return entry
        e2.ver = ver
      }
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)
        if (isVideo) this.markUploaded(key, src as HTMLVideoElement)
      } catch { /* frame not ready */ }
    }
    return entry
  }

  private uploadTexture(
    key: string, src: TextureSource, srcW: number, srcH: number,
    old: { tex: WebGLTexture; src: TextureSource; w: number; h: number } | null | undefined
  ): { tex: WebGLTexture; src: TextureSource; w: number; h: number } | null {
    const gl = this.gl!
    if (old) gl.deleteTexture(old.tex)
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)
    } catch {
      gl.deleteTexture(tex)
      return null
    }
    return { tex, src, w: srcW, h: srcH }
  }

  // ---- video frame change detection (requestVideoFrameCallback) ----
  private frameSerial = new WeakMap<HTMLVideoElement, number>()
  private rvfcArmed = new WeakSet<HTMLVideoElement>()
  private uploadedAt = new Map<string, { serial: number; t: number; el: HTMLVideoElement }>()
  /** Disable the skip optimisation (export contexts want every upload). */
  alwaysUploadVideo = false

  private armFrameCallback(el: HTMLVideoElement) {
    const anyEl = el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    if (typeof anyEl.requestVideoFrameCallback !== 'function' || this.rvfcArmed.has(el)) return
    this.rvfcArmed.add(el)
    if (!this.frameSerial.has(el)) this.frameSerial.set(el, 1)
    const onFrame = () => {
      this.frameSerial.set(el, (this.frameSerial.get(el) ?? 0) + 1)
      try { anyEl.requestVideoFrameCallback!(onFrame) } catch { this.rvfcArmed.delete(el) }
    }
    try { anyEl.requestVideoFrameCallback(onFrame) } catch { this.rvfcArmed.delete(el) }
  }

  private videoNeedsUpload(key: string, el: HTMLVideoElement): boolean {
    if (this.alwaysUploadVideo) return true
    this.armFrameCallback(el)
    const serial = this.frameSerial.get(el)
    const prev = this.uploadedAt.get(key)
    if (serial === undefined || !prev || prev.el !== el) return true // no rVFC support → always upload
    if (el.seeking) return false // mid-seek frame is stale anyway
    if (serial !== prev.serial) return true
    // paused: rVFC is not guaranteed to fire after a seek on every engine
    if (el.paused && Math.abs(el.currentTime - prev.t) > 1e-4) return true
    return false
  }

  private markUploaded(key: string, el: HTMLVideoElement) {
    this.armFrameCallback(el)
    this.uploadedAt.set(key, { serial: this.frameSerial.get(el) ?? 0, t: el.currentTime, el })
  }

  disposeTexture(key: string) {
    this.uploadedAt.delete(key)
    const e = this.texCache.get(key)
    if (e && this.gl) {
      this.gl.deleteTexture(e.tex)
      this.texCache.delete(key)
    }
  }

  disposeAllTextures() {
    if (!this.gl) return
    for (const [k] of this.texCache) this.disposeTexture(k)
    if (this.prevTex) { this.gl.deleteTexture(this.prevTex); this.prevTex = null }
  }

  /**
   * Mobile memory guard: free GPU textures of clips that are not near the
   * playhead anymore. They are transparently re-uploaded when needed.
   */
  trimUnusedTextures(activeClipIds: Set<string>) {
    if (!this.gl) return
    for (const key of [...this.texCache.keys()]) {
      if (!activeClipIds.has(key)) this.disposeTexture(key)
    }
  }

  /** Capture the current composite into the prev (trails) texture. */
  private snapshotPrev() {
    const gl = this.gl!
    const src = this.pp[this.ppIndex]
    if (!this.prevTex) {
      this.prevTex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, this.prevTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex)
    // copyTexImage2D re-allocates the texture storage every call (slow on mobile);
    // allocate once per size, then only copy into it.
    const w = this.canvas!.width, h = this.canvas!.height
    if (this.prevSize === `${w}x${h}` && this.prevSizeTex === this.prevTex) {
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h)
    } else {
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 0, 0, w, h, 0)
      this.prevSize = `${w}x${h}`
      this.prevSizeTex = this.prevTex
    }
    void src
  }

  /**
   * Render the full composition at `opts.time`.
   * Draws into an FBO then blits to the visible canvas.
   */
  lastRenderStats = { layers: 0, drew: 0, texOk: 0 }

  render(doc: ProjectDoc, provider: SourceProvider, opts: RenderOptions) {
    const gl = this.gl
    const canvas = this.canvas
    if (!gl || !canvas) return
    let drewCount = 0, texOkCount = 0
    const { time } = opts
    const efOn = opts.bypassEffects ? 0 : 1
    const W = canvas.width, H = canvas.height
    const comp = doc.composition
    const rw = W, rh = H // render resolution equals canvas size set by caller

    // Visual draw order: tracks array is top→bottom; render bottom→top.
    const drawTracks = [...doc.tracks].reverse().filter(t => t.kind !== 'audio' && t.visible)
    const drawClips: { clip: Clip; order: number }[] = []
    // AE solo switch: when any visual layer is soloed only soloed layers draw
    // (cameras keep driving the 3D view, like AE).
    const anySolo = doc.clips.some(c => c.solo && !c.hidden && c.kind !== 'audio')
    for (let ti = 0; ti < drawTracks.length; ti++) {
      const t = drawTracks[ti]
      for (const c of doc.clips) {
        if (c.hidden) continue
        if (anySolo && !c.solo && c.kind !== 'camera') continue
        if (c.trackId === t.id && time >= c.start - 1e-6 && time < c.start + c.duration - 1e-6) {
          drawClips.push({ clip: c, order: ti })
        }
      }
    }
    drawClips.sort((a, b) => a.order - b.order)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pp[this.ppIndex].fbo)
    const bg = hexToRgb(comp.background)
    gl.clearColor(bg[0], bg[1], bg[2], opts.mattePass ? 0 : 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.viewport(0, 0, rw, rh)

    gl.useProgram(this.prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO)
    const aPos = gl.getAttribLocation(this.prog, 'a_pos')
    const aUv = gl.getAttribLocation(this.prog, 'a_uv')
    gl.enableVertexAttribArray(aPos)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)

    // unit-1 textures
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.pp[this.ppIndex].tex)
    gl.uniform1i(this.loc('u_back'), 1)
    gl.activeTexture(gl.TEXTURE2)
    if (this.prevTex) gl.bindTexture(gl.TEXTURE_2D, this.prevTex)
    else gl.bindTexture(gl.TEXTURE_2D, this.pp[this.ppIndex].tex)
    gl.uniform1i(this.loc('u_prev'), 2)
    gl.activeTexture(gl.TEXTURE3)
    // u_lutTex must ALWAYS have a valid texture bound — bind the dummy when no LUT
    gl.bindTexture(gl.TEXTURE_2D, (this.lutTex && this.compLutEnabled) ? this.lutTex : this.dummyTex)
    gl.uniform1i(this.loc('u_lutTex'), 3)
    gl.uniform1f(this.loc('u_lutEnabled'), this.compLutEnabled && this.lutSize > 1 ? 1 : 0)
    gl.uniform1f(this.loc('u_lutSize'), this.lutSize)
    // track matte sampler — dummy by default, real matte texture bound per layer
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex)
    gl.uniform1i(this.loc('u_matte'), 4)
    gl.uniform1f(this.loc('u_matteMode'), 0)
    gl.uniform1f(this.loc('u_matteRender'), opts.mattePass ? 1 : 0)

    // ---- active 3D camera: topmost camera layer at the current time ----
    let activeCam: CamState | null = null
    let activeCamSettings: CameraSettings | null = null
    if (!opts.mattePass) {
      for (const { clip } of drawClips) {
        if (clip.kind !== 'camera') continue
        const cc = clip as CameraClip
        const lt = time - clip.start
        activeCamSettings = cc.camera
        activeCam = {
          px: evalProperty(clip, 'x', lt) + cc.camera.positionX,
          py: evalProperty(clip, 'y', lt) + cc.camera.positionY,
          pz: evalProperty(clip, 'z', lt) + cc.camera.positionZ,
          rx: cc.camera.rotationX,
          ry: cc.camera.rotationY,
          rz: cc.camera.rotationZ + evalProperty(clip, 'rotation', lt),
          focalLength: cc.camera.focalLength,
          zoom: cc.camera.zoom * Math.max(0.05, evalProperty(clip, 'scale', lt)),
        }
      }
    }

    // ---- track matte bookkeeping: matte sources are rendered separately, not
    // as regular layers this frame ----
    const matteSkip = new Set<string>()
    const matteModeById = new Map<string, number>()
    const MATTE_MODE: Record<TrackMatte['mode'], number> = { alpha: 1, alphaInv: 2, luma: 3, lumaInv: 4 }
    if (!opts.mattePass) {
      for (const { clip } of drawClips) {
        if (!clip.trackMatte) continue
        const srcClip = doc.clips.find(c => c.id === clip.trackMatte!.sourceClipId)
        if (!srcClip) continue
        matteSkip.add(srcClip.id)
        matteModeById.set(clip.id, MATTE_MODE[clip.trackMatte.mode])
      }
    }

    for (const { clip } of drawClips) {
      const localTime = time - clip.start
      if (clip.kind === 'adjustment') {
        // Re-process composite of all layers below through this layer's effect chain
        this.renderAdjustment(clip as AdjustmentClip, localTime, time, efOn, rw, rh)
        continue
      }
      if (clip.kind === 'audio') continue
      if (clip.kind === 'null' || clip.kind === 'camera') continue // controller layers — never rendered
      if (matteSkip.has(clip.id)) continue

      let src: TextureSource | null = null
      let held: { tex: WebGLTexture; w: number; h: number } | null = null
      let srcW = 0, srcH = 0
      if (clip.kind === 'video') {
        const vc = clip as VideoClip
        // Posterize Time: quantize the layer's local time to a lower frame rate
        // (steppy anime motion) before the speed/remap lookup.
        const pt = clip.effects.find(e => e.type === 'posterize_time' && e.enabled)
        const effLocal = pt ? Math.floor(localTime * Math.max(1, pt.params.fps ?? 12)) / Math.max(1, pt.params.fps ?? 12) : localTime
        const st = clipSourceTime(vc, effLocal)
        src = provider.get(vc, st)
        // OpenFX plug-ins (desktop): the processed frame replaces the layer source
        if (src && !opts.bypassEffects && clipHasOfx(clip)) src = ofxLayerSource(clip, src as CanvasImageSource, localTime, st) as TextureSource
        if (src) [srcW, srcH] = sourceSize(src)
        else {
          // FIX (flicker): while an element re-buffers / seeks (readyState < 2)
          // keep showing its last uploaded frame instead of dropping the layer
          // (that was the black frame alternating with real frames).
          const last = this.texCache.get(clip.id)
          if (last && last.w > 0 && last.h > 0) { held = last; src = last.src; srcW = last.w; srcH = last.h }
        }
      } else if (clip.kind === 'image') {
        // Real image layers: full transform/opacity/blend/keyframes/mask/effects pipeline
        src = provider.get(clip as ImageClip, 0)
        if (src && !opts.bypassEffects && clipHasOfx(clip)) src = ofxLayerSource(clip, src as CanvasImageSource, localTime, 0) as TextureSource
        if (src) [srcW, srcH] = sourceSize(src)
      } else if (clip.kind === 'text') {
        src = provider.getTextCanvas(clip as TextClip, localTime, comp.fps)
        if (src) { srcW = (src as HTMLCanvasElement).width; srcH = (src as HTMLCanvasElement).height }
      } else if (clip.kind === 'solid') {
        // AE Solid layer — procedural comp-resolution canvas
        const sc = clip as SolidClip
        src = getSolidCanvas(sc.id, sc.color, comp.width, comp.height)
        if (src) { srcW = comp.width; srcH = comp.height }
      } else if (clip.kind === 'shape') {
        // AE Shape layer — procedural vector canvas at comp resolution (1:1 px)
        const shc = clip as ShapeClip
        src = getShapeCanvas(shc.id, shc.shape, comp.width, comp.height)
        if (src) { srcW = comp.width; srcH = comp.height }
      } else if (clip.kind === 'precomp') {
        // AE pre-comp: render the nested comp with its own compositor, use it as the layer source
        const pc = (doc.precomps ?? []).find(p => p.id === (clip as PrecompClip).precompId)
        if (pc) {
          src = this.renderPrecomp(doc, pc, localTime * (clip.speed || 1), provider, !!opts.bypassEffects, rw / Math.max(1, comp.width))
          if (src) { srcW = pc.composition.width; srcH = pc.composition.height }
        }
      }

      const u = computeLayerUniforms(clip, localTime)
      u.opacity = evalProperty(clip, 'opacity', localTime)
      u.blend = BLEND_INDEX[clip.blendMode]
      u.lutEnabled = 0; u.lutSize = 0
      u.hasTex = src ? 1 : 0

      // AE motion blur: layer switch + comp "Enable Motion Blur". Shutter-based
      // blur from the real transform velocity (position → directional,
      // scale → zoom, rotation → spin), sized like a 180° shutter.
      u.motionVec = [0, 0]
      if (efOn && clip.motionBlur && comp.motionBlur !== false && !opts.mattePass) {
        const shutter = (comp.shutterAngle ?? 180) / 360 / Math.max(1, comp.fps)
        const vx = this.propertyVelocityComp(clip, 'x', localTime)
        const vy = this.propertyVelocityComp(clip, 'y', localTime)
        const vs = this.propertyVelocityComp(clip, 'scale', localTime)
        const vr = this.propertyVelocityComp(clip, 'rotation', localTime)
        const sc = Math.max(0.01, Math.abs(evalProperty(clip, 'scale', localTime)))
        const rot0 = (evalProperty(clip, 'rotation', localTime) * Math.PI) / 180
        const fw = srcW > 0 ? Math.min(comp.width / srcW, comp.height / srcH) * srcW : comp.width
        const fh = srcH > 0 ? Math.min(comp.width / srcW, comp.height / srcH) * srcH : comp.height
        // half of the shutter displacement, rotated into layer space, as a fraction of the texture
        const hx = vx * shutter * 0.5, hy = vy * shutter * 0.5
        const lx = hx * Math.cos(-rot0) - hy * Math.sin(-rot0)
        const ly = hx * Math.sin(-rot0) + hy * Math.cos(-rot0)
        const mvx = (lx / (fw * sc)) * rw, mvy = (ly / (fh * sc)) * rh
        const ml = Math.hypot(mvx, mvy)
        const cap = 90
        const mcap = 220
        if (ml > 0.6) u.motionVec = [mvx * Math.min(1, mcap / ml), mvy * Math.min(1, mcap / ml)]
        void cap
        const zr = Math.abs(vs) * shutter / sc
        if (zr > 0.002) u.zoomBlur = Math.max(u.zoomBlur, Math.min(0.6, zr / 1.5))
        const dth = Math.abs(vr) * shutter * Math.PI / 180
        if (dth > 0.002) u.radialBlur = Math.max(u.radialBlur, Math.min(2, dth / 0.72))
      }

      // transform matrix
      const x = evalProperty(clip, 'x', localTime)
      const y = evalProperty(clip, 'y', localTime)
      const scale = evalProperty(clip, 'scale', localTime)
      const rot = (evalProperty(clip, 'rotation', localTime) * Math.PI) / 180
      const ax = evalProperty(clip, 'anchorX', localTime)
      const ay = evalProperty(clip, 'anchorY', localTime)

      // transform matrix — maps quad q∈[-1,1]² through:
      // C (center→[0,1]) → S_src (fit into comp px) → T(-pivot) → R → S(scale) → T(pos) → S_base (comp px→clip)
      // comp px space is y-up here (matches clip space).
      let m = mat3Identity()
      const C = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
      let fitScale = 1
      if (src && srcW > 0) fitScale = Math.min(comp.width / srcW, comp.height / srcH)
      const pivotX = (srcW / 2 - ax) * fitScale
      const pivotY = (srcH / 2 - ay) * fitScale
      m = mat3Mul(mat3Scale(2 / comp.width, 2 / comp.height), m)          // comp px → clip
      m = mat3Mul(mat3Translate(x, y), m)                                 // position (y up)
      m = mat3Mul(mat3Scale(scale, scale), m)
      m = mat3Mul(mat3Rotate(rot), m)
      m = mat3Mul(mat3Translate(-pivotX, -pivotY), m)                     // pivot at anchor
      m = mat3Mul(mat3Scale(fitScale * srcW, fitScale * srcH), m)         // [0,1] → fitted comp px
      m = mat3Mul(C, m)

      // ---- parenting (AE Parent & Link): compose ancestor transforms so the
      // child inherits position/scale/rotation of its parent chain.
      // Row-vector convention: m = m·parentM applies the child FIRST, the
      // parent SECOND (verified with scripts/test_parenting_math.mjs).
      // NOTE: applied AFTER the 3D projection below, so 3D layers are parented
      // too (2D parent transform on the projected result).
      const parentM = this.parentChainMatrix(doc, clip, time, comp)

      // ---- 3D: project the layer quad through the active camera as a
      // homography (perspective-correct UVs via gl_Position.w) ----
      if (clip.threeD) {
        const z = evalProperty(clip, 'z', localTime)
        const fittedW = fitScale * (srcW || comp.width)
        const fittedH = fitScale * (srcH || comp.height)
        // anchor offset, rotated into world axes (matches the 2D pivot semantics)
        const adx = (srcW / 2 - ax) * fitScale
        const ady = (srcH / 2 - ay) * fitScale
        const shX = -(adx * Math.cos(rot) - ady * Math.sin(rot))
        const shY = -(adx * Math.sin(rot) + ady * Math.cos(rot))
        const H = layerHomography({
          cx: x + shX, cy: y + shY, cz: z,
          w: fittedW, h: fittedH,
          rotationDeg: (rot * 180) / Math.PI,
          cam: activeCam,
          compW: comp.width, compH: comp.height,
        })
        if (H) {
          m = H
          // depth of field: approximate defocus by distance from the focal plane
          if (activeCam && activeCamSettings && activeCamSettings.depthOfField > 0) {
            const planeDist = Math.abs(Math.abs(z - activeCam.pz) - activeCamSettings.focusDistance)
            const defocus = Math.min(24, planeDist * activeCamSettings.aperture * 0.02 * activeCamSettings.depthOfField)
            if (defocus > 0.3) u.blurRadius = Math.max(u.blurRadius, defocus)
          }
        } else if (activeCam) {
          continue // fully behind the camera — skip the layer
        }
      }

      // parent chain applies to 2D layers and to the 3D-projected homography alike
      if (parentM) m = mat3Mul(m, parentM)

      // pen mask: map comp-space vertices through the inverse layer matrix into
      // layer-uv aspect space so the mask sticks to the layer (AE layer-mask semantics)
      if (clip.mask?.shape === 'pen' && src && srcW > 0) {
        const pts = evalMaskPoints(clip.mask, localTime)
        if (pts.length >= 3) {
          // map comp-space vertices + handles into layer uv (0..1, y-down)
          const inv = mat3Inverse(m)
          const toUv = (x: number, y: number) => {
            const cx = (x / comp.width) * 2, cy = (y / comp.height) * 2
            const wx = inv[0] * cx + inv[3] * cy + inv[6]
            const wy = inv[1] * cx + inv[4] * cy + inv[7]
            return [wx * 0.5 + 0.5, 0.5 - wy * 0.5]
          }
          this.penMaskTex = this.renderPenMask(clip.id, pts, toUv, srcW, srcH, clip.mask.feather)
          u.maskType = 3
          u.maskPtsN = 0
        } else {
          u.maskPtsN = 0
        }
      } else {
        u.maskPtsN = 0
        this.penMaskTex = null
      }

      // NOTE (orientation): layer matrices are intentionally NOT flipped here.
      // All FBO textures are stored NDC-y-up (v=0 at NDC bottom) while the quad
      // uv has y=0 at NDC top; every FBO READ (blit, backdrop, trails,
      // adjustment source, track matte) compensates with 1.0 - v. That keeps the
      // fix rotation-safe (a flip on the quad input would mirror-then-rotate
      // rotated layers) and keeps backdrop/trails position-consistent.

      // nothing to draw yet (video not ready, no frames) — skip layer
      if (!src || srcW === 0 || srcH === 0) continue
      drewCount++

      // track matte source → dedicated pass, then bind as u_matte
      const matteMode = matteModeById.get(clip.id) ?? 0
      if (matteMode > 0 && clip.trackMatte) {
        const matteTex = this.renderMatteSource(doc, provider, clip.trackMatte.sourceClipId, time)
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, matteTex ?? this.dummyTex)
        gl.uniform1i(this.loc('u_matte'), 4)
        gl.uniform1f(this.loc('u_matteMode'), matteTex ? matteMode : 0)
      }

      // draw into the other buffer, sampling current as backdrop
      // Studio FX pack: multi-pass effects processed on the layer texture first
      let fxTex: WebGLTexture | null = null
      if (src && efOn && FxChain.wants(clip.effects)) {
        const t0 = held ?? this.getOrCreateTexture(clip.id, src)
        if (t0) {
          this.fx ??= new FxChain(gl as WebGLRenderingContext)
          let matte: WebGLTexture | null = null
          if (clip.effects.some(e => e.type === 'sx_cutout' && e.enabled)) {
            const st = clip.kind === 'video' ? clipSourceTime(clip as VideoClip, localTime) : 0
            const cut = clip.effects.find(e => e.type === 'sx_cutout' && e.enabled)
            const m = matteAt(clip.id, st, cut ? (evalEffectParam(cut, 'temporal', localTime) ?? 0.35) : 0)
            if (m) matte = this.uploadMatte(clip.id, m)
          }
          fxTex = this.fx.apply(t0.tex, t0.w || srcW, t0.h || srcH, Math.max(rw, rh) * 1.25, clip.effects, localTime, time, { matte })
          // restore the main program state the pack passes changed
          gl.useProgram(this.prog)
          gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO)
          const ap = gl.getAttribLocation(this.prog, 'a_pos'), au = gl.getAttribLocation(this.prog, 'a_uv')
          gl.enableVertexAttribArray(ap); gl.enableVertexAttribArray(au)
          gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 16, 0)
          gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 16, 8)
        }
      }

      const srcPP = this.pp[this.ppIndex]
      const dstPP = this.pp[1 - this.ppIndex]
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstPP.fbo)
      gl.viewport(0, 0, rw, rh)
      // FIX (compositing): pre-fill the destination with the current composite.
      // The old flow drew each layer into a buffer that was either STALE (last
      // frame) or freshly cleared to BLACK depending on the layer-count parity:
      // everything outside the last layer's quad flickered between the previous
      // composite and black (text/null layers exposed it constantly).
      this.copyCompositeInto(srcPP, dstPP, rw, rh)

      gl.activeTexture(gl.TEXTURE0)
      if (fxTex) {
        gl.bindTexture(gl.TEXTURE_2D, fxTex)
      } else if (src) {
        const t = held ?? this.getOrCreateTexture(clip.id, src)
        if (t) gl.bindTexture(gl.TEXTURE_2D, t.tex)
        else u.hasTex = 0
      } else {
        gl.bindTexture(gl.TEXTURE_2D, srcPP.tex)
      }
      gl.uniform1i(this.loc('u_tex'), 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, srcPP.tex)
      gl.uniform1i(this.loc('u_back'), 1)
      // FIX: u_prev must never sample the CURRENT draw target — that is a
      // feedback loop (WebGL INVALID_OPERATION → black layer, hit with 2+ layers).
      // Bind the last-frame snapshot when it exists, otherwise the backdrop.
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.prevTex ?? srcPP.tex)
      gl.uniform1i(this.loc('u_prev'), 2)
      if (u.hasTex > 0.5) texOkCount++

      this.setUniforms(u, time, localTime, rw, rh, efOn)
      gl.uniform1f(this.loc('u_srcFlip'), 0) // reset — adjustment pass sets it to 1
      gl.uniformMatrix3fv(this.loc('u_matrix'), false, new Float32Array(m))
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, (u.maskType === 3 && this.penMaskTex) ? this.penMaskTex : this.dummyTex)
      gl.uniform1i(this.loc('u_maskTex'), 5)
      const mvLen = Math.hypot(u.motionVec[0], u.motionVec[1])
      const ex = mvLen > 0.5 ? [Math.min(0.5, Math.abs(u.motionVec[0]) / rw + 0.002), Math.min(0.5, Math.abs(u.motionVec[1]) / rh + 0.002)] : [0, 0]
      gl.uniform2f(this.loc('u_expand'), ex[0], ex[1])
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (ex[0] || ex[1]) gl.uniform2f(this.loc('u_expand'), 0, 0)
      this.ppIndex = 1 - this.ppIndex
      // restore matte sampler to dummy so later layers don't reuse it
      if (matteMode > 0) {
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_2D, this.dummyTex)
        gl.uniform1f(this.loc('u_matteMode'), 0)
      }
    }
    this.lastRenderStats = { layers: drawClips.length, drew: drewCount, texOk: texOkCount }

    // Trails/echo snapshot after full composite
    if (efOn && !opts.mattePass && drawClips.some(({ clip }) => clip.effects.some(e => e.enabled && (e.type === 'motion_trails' || e.type === 'motion_echo')))) {
      this.snapshotPrev()
    }

    // matte passes leave the composite in the ping-pong target — no blit
    if (opts.mattePass) return

    // Blit composite → canvas (with comp LUT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, rw, rh)
    gl.useProgram(this.blitProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO)
    const bPos = gl.getAttribLocation(this.blitProg, 'a_pos')
    const bUv = gl.getAttribLocation(this.blitProg, 'a_uv')
    gl.enableVertexAttribArray(bPos)
    gl.enableVertexAttribArray(bUv)
    gl.vertexAttribPointer(bPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(bUv, 2, gl.FLOAT, false, 16, 8)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pp[this.ppIndex].tex)
    gl.uniform1i(this.blitLoc('u_tex'), 0)
    gl.activeTexture(gl.TEXTURE1)
    if (this.lutTex && this.compLutEnabled) gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    else gl.bindTexture(gl.TEXTURE_2D, this.dummyTex)
    gl.uniform1i(this.blitLoc('u_lutTex'), 1)
    gl.uniform1f(this.blitLoc('u_lutEnabled'), this.compLutEnabled && this.lutSize > 1 ? 1 : 0)
    gl.uniform1f(this.blitLoc('u_lutSize'), this.lutSize)
    const ident = mat3Identity()
    gl.uniformMatrix3fv(this.blitLoc('u_matrix'), false, new Float32Array(ident))
    gl.uniform1f(this.blitLoc('u_flipY'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /**
   * Identity copy of the current composite (src) into the destination buffer.
   * Uses the blit program with the LUT disabled — cheap full-screen pass that
   * guarantees every layer composites over the REAL previous composite.
   */
  private copyCompositeInto(
    src: { fbo: WebGLFramebuffer; tex: WebGLTexture },
    dst: { fbo: WebGLFramebuffer; tex: WebGLTexture },
    rw: number, rh: number,
  ) {
    const gl = this.gl!
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
    gl.viewport(0, 0, rw, rh)
    gl.useProgram(this.blitProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO)
    const bPos = gl.getAttribLocation(this.blitProg, 'a_pos')
    const bUv = gl.getAttribLocation(this.blitProg, 'a_uv')
    gl.enableVertexAttribArray(bPos)
    gl.enableVertexAttribArray(bUv)
    gl.vertexAttribPointer(bPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(bUv, 2, gl.FLOAT, false, 16, 8)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.uniform1i(this.blitLoc('u_tex'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex)
    gl.uniform1i(this.blitLoc('u_lutTex'), 1)
    gl.uniform1f(this.blitLoc('u_lutEnabled'), 0)
    gl.uniform1f(this.blitLoc('u_lutSize'), 0)
    gl.uniformMatrix3fv(this.blitLoc('u_matrix'), false, new Float32Array(mat3Identity()))
    gl.uniform1f(this.blitLoc('u_flipY'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    // restore the main program + its attribute layout for the layer draw
    gl.useProgram(this.prog)
    const aPos = gl.getAttribLocation(this.prog, 'a_pos')
    const aUv = gl.getAttribLocation(this.prog, 'a_uv')
    gl.enableVertexAttribArray(aPos)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)
  }

  /**
   * AE Parent & Link: composed pre-flip transform of the whole ancestor chain.
   * Each ancestor is evaluated at its OWN local time (keyframes on a parent
   * animate the children). Cycle-safe, max 8 levels.
   */
  private parentChainMatrix(doc: ProjectDoc, clip: Clip, compTime: number, comp: Composition): number[] | null {
    let result: number[] | null = null
    let cur = clip
    const seen = new Set<string>([clip.id])
    for (let i = 0; i < 8; i++) {
      if (!cur.parentId || seen.has(cur.parentId)) break
      const parent = doc.clips.find(c => c.id === cur.parentId)
      if (!parent || parent.kind === 'audio') break
      seen.add(parent.id)
      const pLocal = compTime - parent.start
      const x = evalProperty(parent, 'x', pLocal)
      const y = evalProperty(parent, 'y', pLocal)
      const scale = evalProperty(parent, 'scale', pLocal)
      const rot = (evalProperty(parent, 'rotation', pLocal) * Math.PI) / 180
      const pax = evalProperty(parent, 'anchorX', pLocal)
      const pay = evalProperty(parent, 'anchorY', pLocal)
      const C0 = mat3Mul(mat3Translate(1, 1), mat3Scale(0.5, 0.5))
      let pm = mat3Identity()
      pm = mat3Mul(mat3Scale(2 / comp.width, 2 / comp.height), pm)
      pm = mat3Mul(mat3Translate(x, y), pm)
      pm = mat3Mul(mat3Scale(scale, scale), pm)
      pm = mat3Mul(mat3Rotate(rot), pm)
      pm = mat3Mul(mat3Translate(-(comp.width / 2 - pax), -(comp.height / 2 - pay)), pm)
      // the parent acts on comp-px coords: quad → [0,1] → comp px (same as the
      // child's S(fitScale·srcW) step — without it every child collapses to an
      // off-screen point)
      pm = mat3Mul(mat3Scale(comp.width, comp.height), pm)
      pm = mat3Mul(C0, pm)
      result = result ? mat3Mul(result, pm) : pm  // accumulate: child-first order
      cur = parent
    }
    return result
  }

  /**
   * Render a single matte source clip through the full pipeline into the
   * ping-pong target (no blit) and return its texture. The main chain's
   * ping-pong index is restored afterwards.
   */
  private renderMatteSource(doc: ProjectDoc, provider: SourceProvider, sourceClipId: string, time: number): WebGLTexture | null {
    const srcClip = doc.clips.find(c => c.id === sourceClipId)
    if (!srcClip) return null
    const savedPpIndex = this.ppIndex
    const savedStats = this.lastRenderStats
    const scratch: ProjectDoc = {
      ...doc,
      tracks: doc.tracks.filter(t => t.id === srcClip.trackId),
      clips: [srcClip],
    }
    this.render(scratch, provider, { time, mattePass: true })
    const tex = this.pp[this.ppIndex].tex
    this.ppIndex = savedPpIndex
    this.lastRenderStats = savedStats
    return tex
  }

  private renderAdjustment(clip: AdjustmentClip, localTime: number, time: number, efOn: number, rw: number, rh: number) {
    const gl = this.gl!
    const srcPP = this.pp[this.ppIndex]
    const dstPP = this.pp[1 - this.ppIndex]
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstPP.fbo)
    gl.viewport(0, 0, rw, rh)
    gl.useProgram(this.prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO)
    const aPos = gl.getAttribLocation(this.prog, 'a_pos')
    const aUv = gl.getAttribLocation(this.prog, 'a_uv')
    gl.enableVertexAttribArray(aPos)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcPP.tex)
    gl.uniform1i(this.loc('u_tex'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, srcPP.tex)
    gl.uniform1i(this.loc('u_back'), 1)
    // same feedback-loop guard for adjustment layers
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex ?? srcPP.tex)
    gl.uniform1i(this.loc('u_prev'), 2)
    const u = computeLayerUniforms(clip, localTime)
    u.opacity = evalProperty(clip, 'opacity', localTime)
    u.blend = BLEND_INDEX[clip.blendMode]
    u.hasTex = 1
    u.lutEnabled = 0; u.lutSize = 0
    // layerSize = comp for adjustment
    u.layerSize = [rw, rh]
    this.setUniforms(u, time, localTime, rw, rh, efOn)
    // fullscreen quad — identity: this pass re-processes the composite FBO and
    // u_srcFlip (set below) mirrors the texture reads into screen orientation
    const m = mat3Identity()
    gl.uniformMatrix3fv(this.loc('u_matrix'), false, new Float32Array(m))
    gl.uniform1f(this.loc('u_srcFlip'), 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    this.ppIndex = 1 - this.ppIndex
  }

  private fx: FxChain | null = null
  private matteTex = new Map<string, { tex: WebGLTexture; key: string }>()
  private uploadMatte(clipId: string, m: { data: Uint8Array; w: number; h: number; key: string }): WebGLTexture {
    const gl = this.gl!
    let e = this.matteTex.get(clipId)
    if (!e) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      e = { tex, key: '' }
      this.matteTex.set(clipId, e)
    }
    if (e.key !== m.key) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, e.tex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, m.w, m.h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, m.data)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      e.key = m.key
    }
    return e.tex
  }

  // ---- nested compositions ----
  depth = 0
  private subs = new Map<string, Compositor>()
  private renderPrecomp(doc: ProjectDoc, pc: Precomp, localTime: number, provider: SourceProvider, bypass: boolean, scale: number): HTMLCanvasElement | null {
    if (this.depth >= 4) return null // runaway nesting guard
    let sub = this.subs.get(pc.id)
    if (!sub) {
      sub = new Compositor()
      sub.depth = this.depth + 1
      const cv = document.createElement('canvas')
      cv.width = Math.max(2, Math.round(pc.composition.width * scale))
      cv.height = Math.max(2, Math.round(pc.composition.height * scale))
      try { sub.attach(cv, this.alwaysUploadVideo) } catch { return null }
      this.subs.set(pc.id, sub)
    }
    const cv = sub.canvas!
    const w = Math.max(2, Math.round(pc.composition.width * scale)), h = Math.max(2, Math.round(pc.composition.height * scale))
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; sub.resize() }
    const subDoc: ProjectDoc = { ...doc, composition: pc.composition, tracks: pc.tracks, clips: pc.clips }
    sub.render(subDoc, provider, { time: localTime, bypassEffects: bypass })
    return cv
  }

  private propertyVelocityComp(clip: Clip, prop: 'x' | 'y' | 'scale' | 'rotation', localTime: number): number {
    const dt = 1 / compFpsGlobal
    const track = clip.keyframes.find(k => k.property === prop)
    const hasExpr = !!clip.expressions && Object.keys(clip.expressions).length > 0
    if (!hasExpr && (!track || track.keyframes.length === 0)) return 0
    const a = evalProperty(clip, prop, Math.max(0, localTime - dt))
    const b = evalProperty(clip, prop, localTime + dt)
    return (b - a) / (2 * dt)
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!(name in this.uniformLocs)) {
      this.uniformLocs[name] = this.gl!.getUniformLocation(this.prog, name)
    }
    return this.uniformLocs[name]
  }
  private blitLoc(name: string): WebGLUniformLocation | null {
    if (!(name in this.blitLocs)) {
      this.blitLocs[name] = this.gl!.getUniformLocation(this.blitProg, name)
    }
    return this.blitLocs[name]
  }

  private setUniforms(u: LayerUniforms, time: number, localTime: number, rw: number, rh: number, efOn: number) {
    const gl = this.gl!
    const L = (n: string) => this.loc(n)
    const f = (n: string, v: number) => { const l = L(n); if (l) gl.uniform1f(l, v) }
    const f2 = (n: string, v: [number, number]) => { const l = L(n); if (l) gl.uniform2f(l, v[0], v[1]) }
    f('u_hasTex', u.hasTex)
    gl.uniform2f(L('u_layerSize')!, u.layerSize[0], u.layerSize[1])
    gl.uniform2f(L('u_compRes')!, rw, rh)
    f('u_time', time)
    f('u_localTime', localTime)
    f('u_opacity', u.opacity)
    f('u_blend', u.blend)
    f('u_efEnabled', efOn)
    f('u_exposure', u.exposure); f('u_contrast', u.contrast); f('u_saturation', u.saturation)
    f('u_temperature', u.temperature); f('u_tint', u.tint)
    f('u_lift', u.lift); f('u_gamma', u.gamma); f('u_gain', u.gain); f('u_vibrance', u.vibrance)
    f('u_vigAmount', u.vigAmount); f('u_vigSoft', u.vigSoft)
    f('u_blurRadius', u.blurRadius); f2('u_blurDir', u.blurDir); f2('u_motionVec', u.motionVec)
    f('u_zoomBlur', u.zoomBlur); f('u_radialBlur', u.radialBlur)
    f2('u_rgbSplit', u.rgbSplit)
    f('u_waveAmount', u.waveAmount); f('u_waveFreq', u.waveFreq); f('u_waveSpeed', u.waveSpeed)
    f('u_glitch', u.glitch); f('u_glitchSpeed', u.glitchSpeed); f('u_glitchBlock', u.glitchBlock)
    f('u_crtCurve', u.crtCurve); f('u_crtScan', u.crtScan)
    f('u_glowThreshold', u.glowThreshold); f('u_glowIntensity', u.glowIntensity); f('u_glowRadius', u.glowRadius)
    f('u_auraThreshold', u.auraThreshold); f('u_auraIntensity', u.auraIntensity); f('u_auraHue', u.auraHue); f('u_auraPulse', u.auraPulse)
    f('u_flareX', u.flareX); f('u_flareY', u.flareY); f('u_flareIntensity', u.flareIntensity); f('u_flareStreak', u.flareStreak)
    f('u_leakIntensity', u.leakIntensity); f('u_leakHue', u.leakHue); f('u_leakAngle', u.leakAngle)
    f('u_slIntensity', u.slIntensity); f('u_slCount', u.slCount); f('u_slSpeed', u.slSpeed); f('u_slCX', u.slCX); f('u_slCY', u.slCY)
    f('u_flashAmount', u.flashAmount); f('u_flashMode', u.flashMode)
    f('u_burstProgress', u.burstProgress); f('u_burstIntensity', u.burstIntensity); f('u_burstHue', u.burstHue)
    f('u_boltIntensity', u.boltIntensity); f('u_boltCount', u.boltCount); f('u_boltSpeed', u.boltSpeed)
    f('u_partDensity', u.partDensity); f('u_partSize', u.partSize); f('u_partSpeed', u.partSpeed); f('u_partHue', u.partHue)
    f('u_halfMix', u.halfMix); f('u_halfScale', u.halfScale); f('u_halfAngle', u.halfAngle)
    f('u_trailsDecay', u.trailsDecay)
    f('u_maskEnabled', u.maskEnabled); f('u_maskType', u.maskType)
    f('u_maskX', u.maskX); f('u_maskY', u.maskY); f('u_maskW', u.maskW); f('u_maskH', u.maskH)
    f('u_maskFeather', u.maskFeather); f('u_maskInvert', u.maskInvert)
    // pen mask polygon upload
    if (u.maskPtsN >= 3 && u.maskPts.length >= 6) {
      const pl = L('u_maskPts[0]') ?? L('u_maskPts')
      if (pl) gl.uniform2fv(pl, u.maskPts.slice(0, Math.min(24, Math.floor(u.maskPtsN)) * 2))
      f('u_maskPtsN', Math.min(24, Math.floor(u.maskPtsN)))
    } else {
      f('u_maskPtsN', 0)
    }
    f('u_maskAspect', u.maskAspect)
    f('u_lutEnabled', 0); f('u_lutSize', 0)
    f('u_flipY', 0)
    // perspective
    f('u_bulgeAmount', u.bulgeAmount); f('u_bulgeRadius', u.bulgeRadius); f('u_bulgeCX', u.bulgeCX); f('u_bulgeCY', u.bulgeCY)
    f('u_twirlAngle', u.twirlAngle); f('u_twirlRadius', u.twirlRadius); f('u_twirlCX', u.twirlCX); f('u_twirlCY', u.twirlCY)
    f('u_ripAmount', u.ripAmount); f('u_ripWave', u.ripWave); f('u_ripSpeed', u.ripSpeed)
    f('u_fisheyeAmount', u.fisheyeAmount)
    f('u_kaleidoSeg', u.kaleidoSeg); f('u_kaleidoRot', u.kaleidoRot)
    f('u_mirrorMode', u.mirrorMode); f('u_mirrorPos', u.mirrorPos); f('u_tileN', u.tileN)
    f('u_bzAmt', u.bzAmt); f('u_bzRate', u.bzRate)
    f('u_keyTol', u.keyTol); f('u_keySoft', u.keySoft); f('u_keyHue', u.keyHue)
    f('u_tsAmt', u.tsAmt); f('u_tsPos', u.tsPos); f('u_tsWidth', u.tsWidth)
    f('u_tiltX', u.tiltX); f('u_tiltY', u.tiltY)
    f('u_dsX', u.dsX); f('u_dsY', u.dsY); f('u_dsOpacity', u.dsOpacity); f('u_dsSoft', u.dsSoft)
    // stylize
    f('u_posterLevels', u.posterLevels)
    f('u_pixSize', u.pixSize)
    f('u_sketchAmount', u.sketchAmount); f('u_sketchThresh', u.sketchThresh)
    f('u_neonIntensity', u.neonIntensity); f('u_neonHue', u.neonHue); f('u_neonThresh', u.neonThresh)
    f('u_oilRadius', u.oilRadius); f('u_oilMix', u.oilMix)
    f('u_duoHueA', u.duoHueA); f('u_duoHueB', u.duoHueB); f('u_duoMix', u.duoMix)
    // generate
    f('u_grainAmount', u.grainAmount); f('u_grainSize', u.grainSize); f('u_grainSpeed', u.grainSpeed)
    f('u_starDensity', u.starDensity); f('u_starSpeed', u.starSpeed); f('u_starTwinkle', u.starTwinkle)
    f('u_rainIntensity', u.rainIntensity); f('u_rainAngle', u.rainAngle); f('u_rainSpeed', u.rainSpeed)
    f('u_sakuraDensity', u.sakuraDensity); f('u_sakuraSpeed', u.sakuraSpeed); f('u_sakuraSway', u.sakuraSway); f('u_sakuraSize', u.sakuraSize)
    f('u_auroraIntensity', u.auroraIntensity); f('u_auroraHue', u.auroraHue); f('u_auroraSpeed', u.auroraSpeed)
    f('u_gridSpacing', u.gridSpacing); f('u_gridOpacity', u.gridOpacity); f('u_gridGlow', u.gridGlow)
    // time
    f('u_echoDecay', u.echoDecay); f('u_echoX', u.echoX); f('u_echoY', u.echoY)
    f('u_shakeIntensity', u.shakeIntensity); f('u_shakeFreq', u.shakeFreq); f('u_shakeRot', u.shakeRot)
    // lighting extra
    f('u_bloomThresh', u.bloomThresh); f('u_bloomIntensity', u.bloomIntensity)
    f('u_godIntensity', u.godIntensity); f('u_godX', u.godX); f('u_godY', u.godY); f('u_godRays', u.godRays)
    f('u_rimIntensity', u.rimIntensity); f('u_rimHue', u.rimHue)
    // color extra
    f('u_hueDegrees', u.hueDegrees)
    f('u_cbR', u.cbR); f('u_cbG', u.cbG); f('u_cbB', u.cbB)
    f('u_scAmount', u.scAmount); f('u_scPivot', u.scPivot)
    f('u_sharpenAmount', u.sharpenAmount); f('u_sharpenRadius', u.sharpenRadius)
    f('u_cartoonMix', u.cartoonMix); f('u_cartoonLevels', u.cartoonLevels); f('u_cartoonEdge', u.cartoonEdge)
    f('u_turbAmount', u.turbAmount); f('u_turbScale', u.turbScale); f('u_turbSpeed', u.turbSpeed)
    // plugin dispatch + params
    f('u_pluginSel', u.pluginSel)
    for (const [name, val] of Object.entries(u.pluginParams)) {
      const l = L(name)
      if (l) gl.uniform1f(l, val)
    }
  }
}

let compFpsGlobal = 30
export function setCompositorFps(fps: number) { compFpsGlobal = fps; setExpressionFps(fps) }

/**
 * One-time probe: does direct video→WebGL upload produce real pixels in this
 * environment? Headless SwiftShader is known to yield black. Compares a tiny
 * GL readback against the guaranteed 2D-canvas path.
 */
function probeVideoNeedsBridge(el: HTMLVideoElement): boolean {
  try {
    if (el.readyState < 2 || el.videoWidth === 0) return false
    const PTS: [number, number][] = [[8, 4], [16, 9], [24, 13], [12, 14], [20, 5]]
    // 2D reference — always reliable
    const c2 = document.createElement('canvas')
    c2.width = 32; c2.height = 18
    const ctx2 = c2.getContext('2d')!
    ctx2.drawImage(el, 0, 0, 32, 18)
    let refMax = 0
    for (const [x, y] of PTS) {
      const d = ctx2.getImageData(x, y, 1, 1).data
      refMax = Math.max(refMax, d[0], d[1], d[2])
    }
    // GL test
    const cv = document.createElement('canvas')
    cv.width = 32; cv.height = 18
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl')
    if (!gl) return false
    const glc = gl as WebGLRenderingContext
    const tex = glc.createTexture()
    glc.bindTexture(glc.TEXTURE_2D, tex)
    glc.texImage2D(glc.TEXTURE_2D, 0, glc.RGBA, glc.RGBA, glc.UNSIGNED_BYTE, el)
    const vs = 'attribute vec2 p; varying vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0,1); }'
    const fs = 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }'
    const compile = (type: number, src: string) => { const s = glc.createShader(type)!; glc.shaderSource(s, src); glc.compileShader(s); return s }
    const prog = glc.createProgram()!
    glc.attachShader(prog, compile(glc.VERTEX_SHADER, vs))
    glc.attachShader(prog, compile(glc.FRAGMENT_SHADER, fs))
    glc.linkProgram(prog)
    glc.useProgram(prog)
    const buf = glc.createBuffer()
    glc.bindBuffer(glc.ARRAY_BUFFER, buf)
    glc.bufferData(glc.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), glc.STATIC_DRAW)
    const loc = glc.getAttribLocation(prog, 'p')
    glc.enableVertexAttribArray(loc)
    glc.vertexAttribPointer(loc, 2, glc.FLOAT, false, 0, 0)
    glc.viewport(0, 0, 32, 18)
    glc.drawArrays(glc.TRIANGLE_STRIP, 0, 4)
    let glMax = 0
    for (const [x, y] of PTS) {
      const px = new Uint8Array(4)
      glc.readPixels(x, y, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, px)
      glMax = Math.max(glMax, px[0], px[1], px[2])
    }
    // GL much darker than the guaranteed 2D path → bridge required
    return glMax < 6 && refMax > 12
  } catch {
    return false
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}
