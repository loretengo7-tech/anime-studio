/**
 * ANIME STUDIO — "Studio FX" pack: multi-pass GPU effects in the spirit of the
 * big third-party AE suites (glows, light rays, flares, glitch, shockwaves…).
 *
 * Each effect is a small chain of fragment passes run on the LAYER texture
 * before the main compositor program draws it, so effects can sample freely
 * (multi-pass blurs, ring samples, displacement). Passes render into pooled
 * FBOs at a fraction of the source resolution where quality allows.
 */
import type { EffectDef, EffectInstance } from './types'
import { evalEffectParam } from './keyframes'

type Src = 'orig' | 'prev' | 'matte' | number // number = output of pass N; 'matte' = AI cut-out matte
interface Pass { fs: string; scale?: number; input?: Src; aux?: Src; dir?: [number, number]; radius?: (p: Record<string, number>) => number }
interface PackEffect { def: EffectDef; passes: Pass[] }

const P = (key: string, label: string, min: number, max: number, step: number, def: number) => ({ key, label, min, max, step, default: def, uniform: key })

const HEAD = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_orig;
uniform sampler2D u_aux;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_dir;
uniform float u_radius;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hsv2rgb(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 T(sampler2D s, vec2 uv) { return texture2D(s, clamp(uv, vec2(0.0005), vec2(0.9995))); }
`
const BLUR = HEAD + `
void main() {
  vec2 px = 1.0 / u_res;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -7; i <= 7; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    acc += T(u_tex, v_uv + u_dir * fi * (u_radius / 7.0) * px) * w;
    ws += w;
  }
  gl_FragColor = acc / ws;
}`
const blurPair = (scale: number, radius: (p: Record<string, number>) => number): Pass[] => [
  { fs: BLUR, scale, dir: [1, 0], radius },
  { fs: BLUR, scale, dir: [0, 1], radius },
]

const EFFECTS: PackEffect[] = [
  // ------------------------------------------------------------- glows
  {
    def: {
      type: 'sx_deep_glow', name: 'Deep Glow', category: 'lighting', heavy: true,
      description: 'Physically-inspired multi-radius glow. Bright parts bloom far beyond the layer — the classic anime highlight.',
      params: [P('threshold', 'Threshold', 0, 1, 0.01, 0.55), P('radius', 'Radius', 1, 80, 1, 30), P('intensity', 'Exposure', 0, 6, 0.05, 1.6),
        P('hue', 'Tint Hue', 0, 360, 1, 275), P('tint', 'Tint Amount', 0, 1, 0.01, 0.35), P('chroma', 'Aberration', 0, 1, 0.01, 0.2)],
    },
    passes: [
      { input: 'orig', scale: 0.5, fs: HEAD + `uniform float u_p_threshold; void main(){ vec4 c=T(u_orig,v_uv); float l=luma(c.rgb); float b=smoothstep(u_p_threshold, u_p_threshold+0.25, l); gl_FragColor=vec4(c.rgb*b*c.a, b*c.a); }` },
      ...blurPair(0.5, p => p.radius * 0.5),
      ...blurPair(0.25, p => p.radius),
      { input: 2, aux: 4, fs: HEAD + `uniform float u_p_intensity, u_p_hue, u_p_tint, u_p_chroma;
        void main(){ vec4 o=T(u_orig,v_uv); vec2 d=(v_uv-0.5)*0.01*u_p_chroma;
        vec3 a=vec3(T(u_tex,v_uv+d).r, T(u_tex,v_uv).g, T(u_tex,v_uv-d).b);
        vec3 b=vec3(T(u_aux,v_uv+d*2.0).r, T(u_aux,v_uv).g, T(u_aux,v_uv-d*2.0).b);
        vec3 g=(a*0.6+b*1.4)*u_p_intensity; vec3 tint=hsv2rgb(vec3(u_p_hue/360.0,1.0,1.0));
        g=mix(g, g*tint*1.6, u_p_tint);
        vec3 col=o.rgb + g*(1.0-o.rgb*0.35);
        gl_FragColor=vec4(col, max(o.a, clamp(luma(g),0.0,1.0))); }` },
    ],
  },
  {
    def: {
      type: 'sx_edge_glow', name: 'Neon Edge Glow', category: 'lighting', heavy: true,
      description: 'Finds edges and lights them like neon tubes (great on line art and text).',
      params: [P('width', 'Edge Width', 0.5, 6, 0.1, 1.5), P('radius', 'Glow Radius', 1, 60, 1, 18), P('intensity', 'Intensity', 0, 5, 0.05, 1.8), P('hue', 'Hue', 0, 360, 1, 285), P('cycle', 'Hue Cycle (°/s)', 0, 360, 1, 0), P('keep', 'Keep Source', 0, 1, 0.01, 1)],
    },
    passes: [
      { input: 'orig', fs: HEAD + `uniform float u_p_width, u_p_hue, u_p_cycle;
        void main(){ vec2 px=u_p_width/u_res; float a=0.0;
        float c=luma(T(u_orig,v_uv).rgb)+T(u_orig,v_uv).a;
        for(int i=0;i<8;i++){ float ang=float(i)*0.785398; vec2 o=vec2(cos(ang),sin(ang))*px; vec4 s=T(u_orig,v_uv+o); a=max(a, abs(luma(s.rgb)+s.a-c)); }
        float e=smoothstep(0.08,0.45,a); vec3 col=hsv2rgb(vec3(fract((u_p_hue+u_time*u_p_cycle)/360.0),0.85,1.0));
        gl_FragColor=vec4(col*e, e); }` },
      ...blurPair(0.5, p => p.radius),
      { input: 2, aux: 0, fs: HEAD + `uniform float u_p_intensity, u_p_keep;
        void main(){ vec4 o=T(u_orig,v_uv); vec4 g=T(u_tex,v_uv)*u_p_intensity; vec4 e=T(u_aux,v_uv);
        vec3 col=o.rgb*u_p_keep + g.rgb + e.rgb; gl_FragColor=vec4(col, clamp(max(o.a*u_p_keep, max(g.a,e.a)),0.0,1.0)); }` },
    ],
  },
  {
    def: {
      type: 'sx_outer_glow', name: 'Glow Stroke', category: 'lighting',
      description: 'Solid stroke + soft outer glow around the layer alpha — text and cut-out characters.',
      params: [P('stroke', 'Stroke Width', 0, 30, 0.5, 6), P('glow', 'Glow Radius', 0, 60, 1, 20), P('intensity', 'Glow Intensity', 0, 4, 0.05, 1.4), P('hue', 'Hue', 0, 360, 1, 280), P('sat', 'Saturation', 0, 1, 0.01, 0.8), P('light', 'Brightness', 0, 1, 0.01, 1)],
    },
    passes: [
      { input: 'orig', fs: HEAD + `uniform float u_p_stroke;
        void main(){ float m=T(u_orig,v_uv).a; for(int i=0;i<16;i++){ float ang=float(i)*0.3927; for(int r=1;r<=3;r++){ vec2 o=vec2(cos(ang),sin(ang))*u_p_stroke*float(r)/3.0/u_res; m=max(m,T(u_orig,v_uv+o).a);} }
        gl_FragColor=vec4(m); }` },
      ...blurPair(0.5, p => p.glow),
      { input: 2, aux: 0, fs: HEAD + `uniform float u_p_intensity, u_p_hue, u_p_sat, u_p_light;
        void main(){ vec4 o=T(u_orig,v_uv); float s=T(u_aux,v_uv).a; float g=T(u_tex,v_uv).a*u_p_intensity;
        vec3 c=hsv2rgb(vec3(u_p_hue/360.0,u_p_sat,u_p_light));
        vec3 under=c*clamp(max(s,g),0.0,1.0); float ua=clamp(max(s,g),0.0,1.0);
        gl_FragColor=vec4(mix(under, o.rgb, o.a), max(ua, o.a)); }` },
    ],
  },
  // ------------------------------------------------------------- light
  {
    def: {
      type: 'sx_light_rays', name: 'Light Rays', category: 'lighting', heavy: true,
      description: 'Volumetric god rays streaming from a point — bright pixels cast rays.',
      params: [P('cx', 'Center X', 0, 1, 0.01, 0.5), P('cy', 'Center Y', 0, 1, 0.01, 0.35), P('length', 'Ray Length', 0, 1, 0.01, 0.45), P('intensity', 'Intensity', 0, 4, 0.05, 1.2), P('threshold', 'Threshold', 0, 1, 0.01, 0.5), P('hue', 'Tint Hue', 0, 360, 1, 40)],
    },
    passes: [
      { input: 'orig', scale: 0.5, fs: HEAD + `uniform float u_p_cx, u_p_cy, u_p_length, u_p_threshold;
        void main(){ vec2 c=vec2(u_p_cx,u_p_cy); vec2 d=(c-v_uv)*u_p_length/40.0; vec2 uv=v_uv; vec3 acc=vec3(0.0); float w=1.0;
        for(int i=0;i<40;i++){ vec4 s=T(u_orig,uv); float b=smoothstep(u_p_threshold,u_p_threshold+0.3,luma(s.rgb))*s.a; acc+=s.rgb*b*w; w*=0.965; uv+=d; }
        gl_FragColor=vec4(acc/22.0,1.0); }` },
      { input: 'prev', aux: 0, fs: HEAD + `uniform float u_p_intensity, u_p_hue;
        void main(){ vec4 o=T(u_orig,v_uv); vec3 r=T(u_tex,v_uv).rgb*u_p_intensity*mix(vec3(1.0),hsv2rgb(vec3(u_p_hue/360.0,0.45,1.0)),0.8);
        gl_FragColor=vec4(o.rgb+r, max(o.a, clamp(luma(r),0.0,1.0))); }` },
    ],
  },
  {
    def: {
      type: 'sx_lens_flare', name: 'Lens Flare', category: 'lighting',
      description: 'Procedural anamorphic flare with ghosts and streak. Animate the position for camera moves.',
      params: [P('x', 'Position X', -0.2, 1.2, 0.005, 0.75), P('y', 'Position Y', -0.2, 1.2, 0.005, 0.25), P('intensity', 'Brightness', 0, 3, 0.05, 1), P('hue', 'Hue', 0, 360, 1, 205), P('streak', 'Anamorphic Streak', 0, 2, 0.05, 1), P('ghosts', 'Ghosts', 0, 2, 0.05, 1)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_x, u_p_y, u_p_intensity, u_p_hue, u_p_streak, u_p_ghosts;
      void main(){ vec4 o=T(u_orig,v_uv); float ar=u_res.x/u_res.y; vec2 p=vec2(u_p_x,u_p_y); vec2 d=(v_uv-p)*vec2(ar,1.0);
      float r=length(d); vec3 tint=hsv2rgb(vec3(u_p_hue/360.0,0.6,1.0));
      vec3 f=vec3(1.0,0.95,0.85)*exp(-r*18.0)*1.6 + tint*exp(-r*5.0)*0.35;
      f+=tint*exp(-abs(d.y)*90.0)*exp(-abs(d.x)*1.6)*u_p_streak*0.9;
      vec2 axis=vec2(0.5)-p;
      for(int i=1;i<=5;i++){ float k=float(i)*0.38; vec2 g=(v_uv-(p+axis*k*1.4))*vec2(ar,1.0); float gr=length(g); float sz=0.02+0.03*fract(k*3.7);
        f+=hsv2rgb(vec3(fract(u_p_hue/360.0+k*0.15),0.7,1.0))*smoothstep(sz,sz*0.6,gr)*0.25*u_p_ghosts; }
      f+=tint*smoothstep(0.012,0.0,abs(r-0.28))*0.25*u_p_ghosts;
      f*=u_p_intensity; gl_FragColor=vec4(o.rgb+f*(1.0-o.rgb*0.4), max(o.a,clamp(luma(f),0.0,1.0))); }` }],
  },
  {
    def: {
      type: 'sx_light_leak', name: 'Light Leak', category: 'lighting',
      description: 'Warm film light leaks drifting across the frame.',
      params: [P('intensity', 'Intensity', 0, 2, 0.05, 0.8), P('speed', 'Speed', 0, 3, 0.05, 0.6), P('hue', 'Hue', 0, 360, 1, 20), P('seed', 'Seed', 0, 100, 1, 7)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_intensity, u_p_speed, u_p_hue, u_p_seed;
      void main(){ vec4 o=T(u_orig,v_uv); float t=u_time*u_p_speed+u_p_seed; vec3 acc=vec3(0.0);
      for(int i=0;i<4;i++){ float fi=float(i); vec2 c=vec2(0.5+0.6*sin(t*0.7+fi*2.1), 0.5+0.5*cos(t*0.5+fi*1.7)); float d=length((v_uv-c)*vec2(1.3,1.0));
        acc+=hsv2rgb(vec3(fract(u_p_hue/360.0+fi*0.06),0.8,1.0))*exp(-d*d*5.0); }
      vec3 l=acc*u_p_intensity*0.6; gl_FragColor=vec4(1.0-(1.0-o.rgb)*(1.0-l), o.a); }` }],
  },
  // ------------------------------------------------------------- distort
  {
    def: {
      type: 'sx_shockwave', name: 'Shockwave', category: 'distortion',
      description: 'Expanding impact ring that refracts the image. Keyframe Progress 0→1 on the hit.',
      params: [P('cx', 'Center X', 0, 1, 0.01, 0.5), P('cy', 'Center Y', 0, 1, 0.01, 0.5), P('progress', 'Progress', 0, 1, 0.01, 0.4), P('strength', 'Strength', 0, 0.2, 0.002, 0.06), P('width', 'Ring Width', 0.01, 0.4, 0.005, 0.09), P('chroma', 'Chromatic', 0, 1, 0.01, 0.5)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_cx, u_p_cy, u_p_progress, u_p_strength, u_p_width, u_p_chroma;
      void main(){ float ar=u_res.x/u_res.y; vec2 c=vec2(u_p_cx,u_p_cy); vec2 d=(v_uv-c)*vec2(ar,1.0); float r=length(d); float R=u_p_progress*1.2;
      float x=(r-R)/u_p_width; float ring=exp(-x*x*4.0)*(1.0-u_p_progress*0.7); vec2 n=normalize(d+1e-5)/vec2(ar,1.0);
      vec2 off=n*ring*u_p_strength*sign(x+1e-4)*-1.0;
      vec4 g=T(u_orig,v_uv+off); float rr=T(u_orig,v_uv+off*(1.0+u_p_chroma)).r; float bb=T(u_orig,v_uv+off*(1.0-u_p_chroma)).b;
      gl_FragColor=vec4(rr,g.g,bb,g.a)+vec4(vec3(ring*0.25),0.0); }` }],
  },
  {
    def: {
      type: 'sx_twirl', name: 'Twirl', category: 'distortion',
      description: 'Spiral distortion around a center — transitions and dream sequences.',
      params: [P('angle', 'Angle (°)', -1440, 1440, 1, 180), P('radius', 'Radius', 0.05, 1.5, 0.01, 0.5), P('cx', 'Center X', 0, 1, 0.01, 0.5), P('cy', 'Center Y', 0, 1, 0.01, 0.5)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_angle, u_p_radius, u_p_cx, u_p_cy;
      void main(){ float ar=u_res.x/u_res.y; vec2 c=vec2(u_p_cx,u_p_cy); vec2 d=(v_uv-c)*vec2(ar,1.0); float r=length(d);
      float k=clamp(1.0-r/u_p_radius,0.0,1.0); float a=radians(u_p_angle)*k*k; float s=sin(a), co=cos(a);
      d=vec2(d.x*co-d.y*s, d.x*s+d.y*co); gl_FragColor=T(u_orig, c+d/vec2(ar,1.0)); }` }],
  },
  {
    def: {
      type: 'sx_lens_distort', name: 'Lens Distortion', category: 'distortion',
      description: 'Barrel / fisheye (positive) or pincushion (negative) lens curvature with edge fringing.',
      params: [P('amount', 'Curvature', -1, 1, 0.01, 0.35), P('zoom', 'Zoom', 0.5, 2, 0.01, 1), P('fringe', 'Edge Fringe', 0, 1, 0.01, 0.3)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_amount, u_p_zoom, u_p_fringe;
      vec2 dist(vec2 uv, float k){ vec2 d=uv-0.5; float r2=dot(d,d); return 0.5+d*(1.0+k*r2)/u_p_zoom; }
      void main(){ vec2 a=dist(v_uv,u_p_amount); vec2 b=dist(v_uv,u_p_amount*(1.0+0.08*u_p_fringe)); vec2 c=dist(v_uv,u_p_amount*(1.0-0.08*u_p_fringe));
      vec4 g=T(u_orig,a); float out_=step(0.0,a.x)*step(a.x,1.0)*step(0.0,a.y)*step(a.y,1.0);
      gl_FragColor=vec4(T(u_orig,b).r,g.g,T(u_orig,c).b,g.a)*out_; }` }],
  },
  {
    def: {
      type: 'sx_kaleido', name: 'Kaleidoscope', category: 'distortion',
      description: 'Mirrored radial segments — psychedelic openings and transitions.',
      params: [P('segments', 'Segments', 2, 16, 1, 6), P('rotation', 'Rotation (°)', -360, 360, 1, 0), P('zoom', 'Zoom', 0.3, 3, 0.01, 1)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_segments, u_p_rotation, u_p_zoom;
      void main(){ float ar=u_res.x/u_res.y; vec2 d=(v_uv-0.5)*vec2(ar,1.0)/u_p_zoom; float r=length(d); float a=atan(d.y,d.x)+radians(u_p_rotation);
      float seg=6.28318/u_p_segments; a=mod(a,seg); a=abs(a-seg*0.5); vec2 p=vec2(cos(a),sin(a))*r; gl_FragColor=T(u_orig,0.5+p/vec2(ar,1.0)); }` }],
  },
  // ------------------------------------------------------------- stylize
  {
    def: {
      type: 'sx_chroma', name: 'Prism / Chromatic Aberration', category: 'stylize',
      description: 'Radial RGB separation that grows toward the edges, like cheap glass or an impact frame.',
      params: [P('amount', 'Amount', 0, 0.08, 0.001, 0.012), P('radial', 'Radial (0 = linear)', 0, 1, 0.01, 1), P('angle', 'Angle (°)', 0, 360, 1, 0)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_amount, u_p_radial, u_p_angle;
      void main(){ vec2 lin=vec2(cos(radians(u_p_angle)),sin(radians(u_p_angle))); vec2 dir=mix(lin,(v_uv-0.5)*2.0,u_p_radial)*u_p_amount;
      vec4 g=T(u_orig,v_uv); vec4 r=T(u_orig,v_uv+dir); vec4 b=T(u_orig,v_uv-dir);
      gl_FragColor=vec4(r.r,g.g,b.b,max(g.a,max(r.a,b.a))); }` }],
  },
  {
    def: {
      type: 'sx_glitch', name: 'Digital Damage', category: 'stylize',
      description: 'Datamosh-style block glitches, RGB tears and scan displacement.',
      params: [P('amount', 'Amount', 0, 1, 0.01, 0.4), P('blocks', 'Block Count', 2, 60, 1, 18), P('speed', 'Speed', 0, 30, 0.5, 12), P('shift', 'RGB Shift', 0, 0.1, 0.001, 0.02)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_amount, u_p_blocks, u_p_speed, u_p_shift;
      void main(){ float t=floor(u_time*u_p_speed); vec2 b=floor(v_uv*vec2(u_p_blocks,u_p_blocks*0.6)); float n=hash(b+t);
      vec2 uv=v_uv; if(n<u_p_amount*0.5){ uv.x+=(hash(b*1.7+t)-0.5)*0.15*u_p_amount; }
      float line=hash(vec2(floor(v_uv.y*120.0),t)); if(line<u_p_amount*0.12) uv.x+=(line-0.05)*0.4;
      float s=u_p_shift*(n<u_p_amount?1.0:0.25);
      vec4 g=T(u_orig,uv); gl_FragColor=vec4(T(u_orig,uv+vec2(s,0.0)).r,g.g,T(u_orig,uv-vec2(s,0.0)).b,g.a); }` }],
  },
  {
    def: {
      type: 'sx_vhs', name: 'VHS / Analog', category: 'stylize',
      description: 'Tape look: chroma bleed, tracking noise band, scanlines and soft jitter.',
      params: [P('amount', 'Amount', 0, 1, 0.01, 0.7), P('noise', 'Noise', 0, 1, 0.01, 0.35), P('scan', 'Scanlines', 0, 1, 0.01, 0.4), P('bleed', 'Chroma Bleed', 0, 0.03, 0.0005, 0.006)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_amount, u_p_noise, u_p_scan, u_p_bleed;
      void main(){ vec2 uv=v_uv; float band=smoothstep(0.0,0.03,abs(fract(uv.y-u_time*0.15)-0.5)-0.02);
      uv.x+=(1.0-band)*0.012*u_p_amount+(hash(vec2(floor(uv.y*240.0),floor(u_time*24.0)))-0.5)*0.002*u_p_amount;
      vec4 c=T(u_orig,uv); float r=T(u_orig,uv+vec2(u_p_bleed,0.0)).r; float b=T(u_orig,uv-vec2(u_p_bleed,0.0)).b;
      vec3 col=vec3(r,c.g,b); col*=1.0-u_p_scan*0.25*(0.5+0.5*sin(uv.y*u_res.y*3.14159));
      col+=(hash(uv*u_res+u_time*60.0)-0.5)*u_p_noise*0.25; col+=(1.0-band)*0.08*u_p_amount;
      gl_FragColor=vec4(mix(c.rgb,col,u_p_amount),c.a); }` }],
  },
  {
    def: {
      type: 'sx_film', name: 'Film Look', category: 'color',
      description: 'Grain, halation, vignette and a filmic tone curve in one.',
      params: [P('grain', 'Grain', 0, 1, 0.01, 0.25), P('size', 'Grain Size', 0.5, 4, 0.1, 1.4), P('vignette', 'Vignette', 0, 1, 0.01, 0.35), P('warmth', 'Warmth', -1, 1, 0.01, 0.15), P('contrast', 'Contrast', 0, 1, 0.01, 0.3)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_grain, u_p_size, u_p_vignette, u_p_warmth, u_p_contrast;
      void main(){ vec4 c=T(u_orig,v_uv); vec3 col=c.rgb; col=mix(col, col*col*(3.0-2.0*col), u_p_contrast);
      col*=vec3(1.0+0.08*u_p_warmth,1.0,1.0-0.08*u_p_warmth);
      vec2 g=floor(v_uv*u_res/u_p_size); col+=(hash(g+fract(u_time*7.0)*100.0)-0.5)*u_p_grain*0.35;
      float v=smoothstep(0.95,0.35,length(v_uv-0.5)*1.25); col*=mix(1.0,v,u_p_vignette);
      gl_FragColor=vec4(col,c.a); }` }],
  },
  {
    def: {
      type: 'sx_duotone', name: 'Duotone / Gradient Map', category: 'color',
      description: 'Maps shadows and highlights to two colors — poster and manga cover looks.',
      params: [P('hue1', 'Shadow Hue', 0, 360, 1, 260), P('hue2', 'Highlight Hue', 0, 360, 1, 30), P('sat', 'Saturation', 0, 1, 0.01, 0.8), P('mix', 'Mix', 0, 1, 0.01, 1)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_hue1, u_p_hue2, u_p_sat, u_p_mix;
      void main(){ vec4 c=T(u_orig,v_uv); float l=luma(c.rgb); vec3 a=hsv2rgb(vec3(u_p_hue1/360.0,u_p_sat,0.25)); vec3 b=hsv2rgb(vec3(u_p_hue2/360.0,u_p_sat*0.6,1.0));
      gl_FragColor=vec4(mix(c.rgb,mix(a,b,smoothstep(0.0,1.0,l)),u_p_mix),c.a); }` }],
  },
  {
    def: {
      type: 'sx_hue_cycle', name: 'Rainbow Cycle', category: 'color',
      description: 'Animated hue rotation — RGB edit flashes and neon loops.',
      params: [P('speed', 'Speed (°/s)', -720, 720, 1, 180), P('offset', 'Offset (°)', 0, 360, 1, 0), P('mix', 'Mix', 0, 1, 0.01, 1)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_speed, u_p_offset, u_p_mix;
      vec3 hueRot(vec3 c, float a){ const vec3 k=vec3(0.57735); float co=cos(a); return c*co+cross(k,c)*sin(a)+k*dot(k,c)*(1.0-co); }
      void main(){ vec4 c=T(u_orig,v_uv); gl_FragColor=vec4(mix(c.rgb,hueRot(c.rgb,radians(u_p_offset+u_time*u_p_speed)),u_p_mix),c.a); }` }],
  },
  {
    def: {
      type: 'sx_sharpen', name: 'Detail Sharpen', category: 'color',
      description: 'Unsharp-mask sharpening for soft or upscaled anime sources.',
      params: [P('amount', 'Amount', 0, 3, 0.05, 0.8), P('radius', 'Radius', 0.5, 4, 0.1, 1)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_amount, u_p_radius;
      void main(){ vec2 px=u_p_radius/u_res; vec4 c=T(u_orig,v_uv);
      vec3 b=(T(u_orig,v_uv+vec2(px.x,0.0)).rgb+T(u_orig,v_uv-vec2(px.x,0.0)).rgb+T(u_orig,v_uv+vec2(0.0,px.y)).rgb+T(u_orig,v_uv-vec2(0.0,px.y)).rgb)*0.25;
      gl_FragColor=vec4(clamp(c.rgb+(c.rgb-b)*u_p_amount,0.0,1.0),c.a); }` }],
  },
  {
    def: {
      type: 'sx_enhance', name: 'Detail Restore (Enhance)', category: 'color',
      description: 'Live Topaz-style restore: edge-aware denoise + deblock, then line-directed sharpen and detail reinjection.',
      params: [P('denoise', 'Denoise', 0, 1, 0.01, 0.35), P('deblock', 'Deblock', 0, 1, 0.01, 0.3), P('sharpen', 'Line sharpen', 0, 1, 0.01, 0.5), P('detail', 'Detail recon', 0, 1, 0.01, 0.3), P('linePreserve', 'Line protect', 0, 1, 0.01, 0.6)],
    },
    passes: [
      { input: 'prev', fs: HEAD + `uniform float u_p_denoise, u_p_deblock;
      void main(){ vec2 px=1.0/u_res; vec4 c0=T(u_tex,v_uv); vec3 c=c0.rgb; float cl=luma(c);
        vec3 acc=vec3(0.0); float ws=0.0;
        for(int i=0;i<8;i++){ float a=float(i)*0.7853981; vec3 s=T(u_tex,v_uv+vec2(cos(a),sin(a))*px*(1.0+u_p_denoise*2.0)).rgb;
          float w=exp(-abs(luma(s)-cl)*(6.0+18.0*(1.0-u_p_denoise))); acc+=s*w; ws+=w; }
        vec3 dn=acc/max(ws,1e-4);
        vec3 ba=(T(u_tex,v_uv+vec2(2.0*px.x,0.0)).rgb+T(u_tex,v_uv-vec2(2.0*px.x,0.0)).rgb+T(u_tex,v_uv+vec2(0.0,2.0*px.y)).rgb+T(u_tex,v_uv-vec2(0.0,2.0*px.y)).rgb)*0.25;
        float v=abs(luma(ba)-cl); float flatM=1.0-smoothstep(0.02,0.12,v);
        vec3 o=mix(c,dn,u_p_denoise); o=mix(o,ba,u_p_deblock*flatM*0.8);
        gl_FragColor=vec4(o,c0.a); }` },
      { input: 'prev', fs: HEAD + `uniform float u_p_sharpen, u_p_detail, u_p_linePreserve;
      void main(){ vec2 px=1.0/u_res; vec4 c0=T(u_tex,v_uv); vec3 c=c0.rgb; float lum=luma(c);
        float tl=luma(T(u_tex,v_uv+vec2(-px.x,-px.y)).rgb), tt=luma(T(u_tex,v_uv+vec2(0.0,-px.y)).rgb), tr=luma(T(u_tex,v_uv+vec2(px.x,-px.y)).rgb);
        float l=luma(T(u_tex,v_uv+vec2(-px.x,0.0)).rgb), r=luma(T(u_tex,v_uv+vec2(px.x,0.0)).rgb);
        float bl=luma(T(u_tex,v_uv+vec2(-px.x,px.y)).rgb), bb=luma(T(u_tex,v_uv+vec2(0.0,px.y)).rgb), br=luma(T(u_tex,v_uv+vec2(px.x,px.y)).rgb);
        float gx=-tl-2.0*l-bl+tr+2.0*r+br, gy=-tl-2.0*tt-tr+bl+2.0*bb+br; float gm=length(vec2(gx,gy));
        float edge=clamp(gm*1.4,0.0,1.0); vec2 g=gm>0.0001?vec2(gx,gy)/gm:vec2(0.0);
        vec3 al=(T(u_tex,v_uv+g*px*1.25).rgb+T(u_tex,v_uv-g*px*1.25).rgb)*0.5;
        float mask=mix(edge,max(edge,0.22),1.0-u_p_linePreserve);
        vec3 o=c+(c-al)*u_p_sharpen*2.6*mask;
        vec3 fine=(T(u_tex,v_uv+vec2(px.x,0.0)).rgb+T(u_tex,v_uv-vec2(px.x,0.0)).rgb+T(u_tex,v_uv+vec2(0.0,px.y)).rgb+T(u_tex,v_uv-vec2(0.0,px.y)).rgb)*0.25;
        vec3 wide=(T(u_tex,v_uv+vec2(px.x*3.0,0.0)).rgb+T(u_tex,v_uv-vec2(px.x*3.0,0.0)).rgb+T(u_tex,v_uv+vec2(0.0,px.y*3.0)).rgb+T(u_tex,v_uv-vec2(0.0,px.y*3.0)).rgb)*0.25;
        float e2=clamp(abs(lum-luma(wide))*3.0,0.0,1.0); float lm=mix(0.45,clamp(e2*1.2,0.0,1.0),u_p_linePreserve);
        o+= (c-fine)*u_p_detail*1.6*lm + (fine-wide)*u_p_detail*0.9;
        gl_FragColor=vec4(clamp(o,0.0,1.0),c0.a); }` },
    ],
  },
  {
    def: {
      type: 'sx_ink', name: 'Ink Sketch', category: 'anime',
      description: 'Turns footage into inked line art over paper, or adds ink lines on top.',
      params: [P('lines', 'Line Strength', 0, 3, 0.05, 1.2), P('paper', 'Paper Mix', 0, 1, 0.01, 0.6), P('width', 'Line Width', 0.5, 4, 0.1, 1.2)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_lines, u_p_paper, u_p_width;
      void main(){ vec2 px=u_p_width/u_res; vec4 c=T(u_orig,v_uv);
      float gx=luma(T(u_orig,v_uv+vec2(px.x,0.0)).rgb)-luma(T(u_orig,v_uv-vec2(px.x,0.0)).rgb);
      float gy=luma(T(u_orig,v_uv+vec2(0.0,px.y)).rgb)-luma(T(u_orig,v_uv-vec2(0.0,px.y)).rgb);
      float e=clamp(length(vec2(gx,gy))*u_p_lines*3.0,0.0,1.0); vec3 paper=mix(c.rgb,vec3(0.96,0.94,0.9),u_p_paper);
      gl_FragColor=vec4(mix(paper,vec3(0.05),e),c.a); }` }],
  },
  {
    def: {
      type: 'sx_speed_burst', name: 'Impact Frame', category: 'anime',
      description: 'High-contrast inverted impact frame with radial streaks — the 1-2 frame hit flash of fight scenes.',
      params: [P('amount', 'Amount', 0, 1, 0.01, 1), P('cx', 'Center X', 0, 1, 0.01, 0.5), P('cy', 'Center Y', 0, 1, 0.01, 0.5), P('lines', 'Streaks', 0, 1, 0.01, 0.7), P('invert', 'Invert', 0, 1, 1, 1)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_amount, u_p_cx, u_p_cy, u_p_lines, u_p_invert;
      void main(){ vec4 c=T(u_orig,v_uv); float l=luma(c.rgb); float bw=smoothstep(0.35,0.6,l); if(u_p_invert>0.5) bw=1.0-bw;
      vec2 d=v_uv-vec2(u_p_cx,u_p_cy); float a=atan(d.y,d.x); float s=step(0.82,hash(vec2(floor(a*60.0),floor(u_time*24.0))))*smoothstep(0.15,0.6,length(d));
      vec3 im=vec3(bw); im=mix(im, vec3(1.0-bw), s*u_p_lines); im=mix(im, im*vec3(1.0,0.15,0.2)+vec3(0.15,0.0,0.0), 0.25);
      gl_FragColor=vec4(mix(c.rgb,im,u_p_amount),c.a); }` }],
  },
  {
    def: {
      type: 'sx_cutout', name: 'AI Cut-out', category: 'anime',
      description: 'Character cut-out from the AI matte. Bake it in the Cut-out panel (tap the character), then refine here.',
      params: [P('choke', 'Choke', 0.05, 0.95, 0.01, 0.5), P('feather', 'Feather', 0.01, 0.5, 0.01, 0.12), P('invert', 'Invert (keep background)', 0, 1, 1, 0), P('view', 'Show Matte', 0, 1, 1, 0)],
    },
    passes: [{ input: 'orig', aux: 'matte', fs: HEAD + `uniform float u_p_choke, u_p_feather, u_p_invert, u_p_view;
      void main(){ vec4 c=T(u_orig,v_uv); float m=T(u_aux,v_uv).r; float a=smoothstep(u_p_choke-u_p_feather,u_p_choke+u_p_feather,m);
      if(u_p_invert>0.5) a=1.0-a; if(u_p_view>0.5){ gl_FragColor=vec4(vec3(a),1.0); return; } gl_FragColor=vec4(c.rgb,c.a*a); }` }],
  },
  {
    def: {
      type: 'sx_posterize', name: 'Cel Posterize', category: 'anime',
      description: 'Flat cel-shaded color bands with soft edges — makes footage read as anime.',
      params: [P('levels', 'Levels', 2, 12, 1, 5), P('smooth', 'Edge Softness', 0, 1, 0.01, 0.2), P('sat', 'Saturation Boost', 0, 2, 0.01, 1.2)],
    },
    passes: [{ input: 'orig', fs: HEAD + `uniform float u_p_levels, u_p_smooth, u_p_sat;
      void main(){ vec4 c=T(u_orig,v_uv); vec3 q=c.rgb*u_p_levels; vec3 f=fract(q); vec3 st=floor(q)+smoothstep(0.5-u_p_smooth*0.5,0.5+u_p_smooth*0.5,f);
      vec3 col=st/u_p_levels; float l=luma(col); col=mix(vec3(l),col,u_p_sat); gl_FragColor=vec4(col,c.a); }` }],
  },
]

export const FX_PACK_DEFS: EffectDef[] = EFFECTS.map(e => ({ ...e.def, pack: 'Studio FX' }))
const BY_TYPE = new Map(EFFECTS.map(e => [e.def.type, e]))
export function isPackEffect(type: string) { return BY_TYPE.has(type) }

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`

interface Target { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

/** Runs pack effect chains on layer textures. One per WebGL context. */
export class FxChain {
  private progs = new Map<string, { p: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> } | null>()
  private pool: Target[] = []
  private inUse = new Set<Target>()
  private vbo: WebGLBuffer
  constructor(private gl: WebGLRenderingContext) {
    this.vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  }

  private prog(fs: string) {
    if (this.progs.has(fs)) return this.progs.get(fs)!
    const gl = this.gl
    const mk = (t: number, s: string) => { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('[fxpack]', gl.getShaderInfoLog(sh)); return null } return sh }
    const v = mk(gl.VERTEX_SHADER, VS), f = mk(gl.FRAGMENT_SHADER, fs)
    if (!v || !f) { this.progs.set(fs, null); return null }
    const p = gl.createProgram()!
    gl.attachShader(p, v); gl.attachShader(p, f)
    gl.bindAttribLocation(p, 0, 'a_pos')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { this.progs.set(fs, null); return null }
    const e = { p, loc: new Map<string, WebGLUniformLocation | null>() }
    this.progs.set(fs, e)
    return e
  }

  private target(w: number, h: number): Target {
    let t = this.pool.find(x => !this.inUse.has(x) && x.w === w && x.h === h)
    if (!t) {
      const gl = this.gl
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      t = { fbo, tex, w, h }
      this.pool.push(t)
      if (this.pool.length > 48) { const old = this.pool.shift()!; gl.deleteTexture(old.tex); gl.deleteFramebuffer(old.fbo) }
    }
    this.inUse.add(t)
    return t
  }

  /** True when the layer has at least one enabled pack effect. */
  static wants(effects: EffectInstance[]) { return effects.some(e => e.enabled && BY_TYPE.has(e.type)) }

  /**
   * Run all enabled pack effects of the layer, in stack order, on `src`.
   * Returns the processed texture (valid until the next apply()).
   */
  apply(src: WebGLTexture, srcW: number, srcH: number, maxW: number, effects: EffectInstance[], localTime: number, compTime: number, extra: { matte?: WebGLTexture | null } = {}): WebGLTexture {
    const gl = this.gl
    this.inUse.clear()
    const k = Math.min(1, maxW / Math.max(1, srcW))
    const W = Math.max(2, Math.round(srcW * k)), H = Math.max(2, Math.round(srcH * k))
    let cur = src
    gl.disable(gl.BLEND)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    for (const inst of effects) {
      if (!inst.enabled) continue
      const fx = BY_TYPE.get(inst.type)
      if (!fx) continue
      if (inst.type === 'sx_cutout' && !extra.matte) continue // not baked yet → pass-through
      const params: Record<string, number> = {}
      for (const pd of fx.def.params) params[pd.key] = evalEffectParam(inst, pd.key, localTime)
      const orig = cur
      const outs: WebGLTexture[] = []
      let prev = cur
      fx.passes.forEach((pass, i) => {
        const pr = this.prog(pass.fs)
        if (!pr) return
        const s = pass.scale ?? 1
        const t = this.target(Math.max(2, Math.round(W * s)), Math.max(2, Math.round(H * s)))
        const pick = (x: Src | undefined): WebGLTexture => x === undefined || x === 'prev' ? prev : x === 'orig' ? orig : x === 'matte' ? (extra.matte ?? orig) : outs[x] ?? prev
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
        gl.viewport(0, 0, t.w, t.h)
        gl.useProgram(pr.p)
        const L = (n: string) => { if (!pr.loc.has(n)) pr.loc.set(n, gl.getUniformLocation(pr.p, n)); return pr.loc.get(n)! }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pick(pass.input)); gl.uniform1i(L('u_tex'), 0)
        gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, orig); gl.uniform1i(L('u_orig'), 6)
        gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, pass.aux !== undefined ? pick(pass.aux) : orig); gl.uniform1i(L('u_aux'), 7)
        gl.uniform2f(L('u_res'), t.w, t.h)
        gl.uniform1f(L('u_time'), compTime)
        gl.uniform2f(L('u_dir'), pass.dir?.[0] ?? 0, pass.dir?.[1] ?? 0)
        gl.uniform1f(L('u_radius'), (pass.radius?.(params) ?? 0) * s * k)
        for (const [key, v] of Object.entries(params)) gl.uniform1f(L(`u_p_${key}`), v)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        outs.push(t.tex)
        prev = t.tex
      })
      cur = prev
    }
    gl.activeTexture(gl.TEXTURE0)
    return cur
  }
}
