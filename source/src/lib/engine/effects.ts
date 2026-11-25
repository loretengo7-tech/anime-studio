/**
 * ANIME STUDIO — Effects registry
 *
 * The catalog of real, adjustable effects. Every effect maps to actual
 * processing in the WebGL compositor (visual) or the WebAudio engine (audio).
 * Params are clamped, keyframable and exposed to the AI tool system.
 */
import type { EffectDef } from './types'

export const EFFECT_DEFS: EffectDef[] = [
  // ------------------------------------------------ New (CapCut-style) — mirror / tile / key / tilt-shift / beat zoom
  {
    type: 'mirror', name: 'Mirror', category: 'perspective',
    description: 'Mirror one half onto the other. Mode 1 = horizontal, 2 = vertical, 3 = both.',
    params: [
      { key: 'mode', label: 'Mode (1 H · 2 V · 3 both)', min: 1, max: 3, step: 1, default: 1, uniform: 'mode' },
      { key: 'position', label: 'Axis Position', min: 0.1, max: 0.9, step: 0.01, default: 0.5, uniform: 'position' },
    ],
  },
  {
    type: 'tile', name: 'Split Screen / Tile', category: 'perspective',
    description: 'Repeat the picture in an N×N grid (2 = 4-up split screen).',
    params: [
      { key: 'count', label: 'Grid (N×N)', min: 1, max: 4, step: 1, default: 2, uniform: 'count' },
    ],
  },
  {
    type: 'beat_zoom', name: 'Beat Zoom', category: 'motion',
    description: 'Punch-in zoom pulse repeating at a steady rate.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 0.5, step: 0.01, default: 0.15, uniform: 'amount' },
      { key: 'rate', label: 'Rate (Hz)', min: 0.5, max: 8, step: 0.1, default: 2, uniform: 'rate' },
    ],
  },
  {
    type: 'chroma_key', name: 'Chroma Key', category: 'stylize',
    description: 'Remove a key color (default green) to make it transparent.',
    params: [
      { key: 'tolerance', label: 'Tolerance', min: 0, max: 0.5, step: 0.005, default: 0.2, uniform: 'tolerance' },
      { key: 'softness', label: 'Edge Softness', min: 0, max: 0.3, step: 0.005, default: 0.08, uniform: 'softness' },
      { key: 'hue', label: 'Key Hue (deg)', min: 0, max: 360, step: 1, default: 120, uniform: 'hue' },
    ],
  },
  {
    type: 'tilt_shift', name: 'Tilt-Shift', category: 'perspective', heavy: true,
    description: 'Miniature look: sharp focus band, blur toward top and bottom.',
    params: [
      { key: 'amount', label: 'Blur', min: 0, max: 24, step: 0.5, default: 10, uniform: 'amount' },
      { key: 'position', label: 'Focus Position', min: 0, max: 1, step: 0.01, default: 0.5, uniform: 'position' },
      { key: 'width', label: 'Focus Width', min: 0, max: 0.4, step: 0.01, default: 0.12, uniform: 'width' },
    ],
  },

  // ------------------------------------------------ Motion
  {
    type: 'directional_blur', name: 'Directional Blur', category: 'motion', heavy: true,
    description: 'Multi-tap blur along an angle — motion streaks.',
    params: [
      { key: 'amount', label: 'Amount (px)', min: 0, max: 60, step: 1, default: 12, uniform: 'amount' },
      { key: 'angle', label: 'Angle (deg)', min: 0, max: 360, step: 1, default: 0, uniform: 'angle' },
    ],
  },
  {
    type: 'zoom_blur', name: 'Zoom Blur', category: 'motion', heavy: true,
    description: 'Radial burst blur from center — speed & impact.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.35, uniform: 'amount' },
      { key: 'centerX', label: 'Center X', min: -1, max: 1, step: 0.01, default: 0, uniform: 'centerX' },
      { key: 'centerY', label: 'Center Y', min: -1, max: 1, step: 0.01, default: 0, uniform: 'centerY' },
    ],
  },
  {
    type: 'radial_blur', name: 'Radial Blur', category: 'motion', heavy: true,
    description: 'Rotational blur around center — spin emphasis.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.3, uniform: 'amount' },
    ],
  },
  {
    type: 'gaussian_blur', name: 'Gaussian Blur', category: 'motion',
    description: 'Soft uniform blur.',
    params: [
      { key: 'amount', label: 'Radius (px)', min: 0, max: 40, step: 0.5, default: 6, uniform: 'amount' },
    ],
  },
  {
    type: 'motion_trails', name: 'Motion Trails', category: 'motion', heavy: true,
    description: 'Frame-echo trails via feedback buffer.',
    params: [
      { key: 'decay', label: 'Trail Persistence', min: 0, max: 0.95, step: 0.01, default: 0.6, uniform: 'decay' },
    ],
  },

  // ------------------------------------------------ Lighting
  {
    type: 'glow', name: 'Glow', category: 'lighting', heavy: true,
    description: 'Bright-pass glow around highlights — the classic anime bloom.',
    params: [
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01, default: 0.55, uniform: 'threshold' },
      { key: 'intensity', label: 'Intensity', min: 0, max: 3, step: 0.01, default: 0.8, uniform: 'intensity' },
      { key: 'radius', label: 'Radius (px)', min: 2, max: 40, step: 1, default: 12, uniform: 'radius' },
    ],
  },
  {
    type: 'aura', name: 'Anime Aura', category: 'lighting', heavy: true,
    description: 'Colored energy aura traced around bright subject edges.',
    params: [
      { key: 'threshold', label: 'Edge Threshold', min: 0, max: 1, step: 0.01, default: 0.4, uniform: 'threshold' },
      { key: 'intensity', label: 'Intensity', min: 0, max: 3, step: 0.01, default: 1.0, uniform: 'intensity' },
      { key: 'hue', label: 'Aura Hue (deg)', min: 0, max: 360, step: 1, default: 210, uniform: 'hue' },
      { key: 'pulse', label: 'Pulse Speed', min: 0, max: 8, step: 0.1, default: 2, uniform: 'pulse' },
    ],
  },
  {
    type: 'lens_flare', name: 'Lens Flare', category: 'lighting',
    description: 'Procedural anamorphic streak + ghosting.',
    params: [
      { key: 'x', label: 'Source X', min: -1, max: 1, step: 0.01, default: 0, uniform: 'x' },
      { key: 'y', label: 'Source Y', min: -1, max: 1, step: 0.01, default: 0, uniform: 'y' },
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0.7, uniform: 'intensity' },
      { key: 'streak', label: 'Streak Length', min: 0, max: 1, step: 0.01, default: 0.6, uniform: 'streak' },
    ],
  },
  {
    type: 'light_leak', name: 'Light Leak', category: 'lighting',
    description: 'Warm analog light bleed from an edge.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0.6, uniform: 'intensity' },
      { key: 'hue', label: 'Hue (deg)', min: 0, max: 360, step: 1, default: 30, uniform: 'hue' },
      { key: 'angle', label: 'Direction (deg)', min: 0, max: 360, step: 1, default: 45, uniform: 'angle' },
    ],
  },
  {
    type: 'vignette', name: 'Vignette', category: 'lighting',
    description: 'Darkened edges for cinematic focus.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.45, uniform: 'amount' },
      { key: 'softness', label: 'Softness', min: 0.01, max: 1, step: 0.01, default: 0.5, uniform: 'softness' },
    ],
  },

  // ------------------------------------------------ Distortion
  {
    type: 'rgb_split', name: 'RGB Split', category: 'distortion',
    description: 'Channel separation — classic AMV glitch accent.',
    params: [
      { key: 'amount', label: 'Amount (px)', min: 0, max: 40, step: 0.5, default: 6, uniform: 'amount' },
      { key: 'angle', label: 'Angle (deg)', min: 0, max: 360, step: 1, default: 0, uniform: 'angle' },
    ],
  },
  {
    type: 'chromatic_aberration', name: 'Chromatic Aberration', category: 'distortion',
    description: 'Lens-style radial color fringing.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.15, uniform: 'amount' },
    ],
  },
  {
    type: 'glitch', name: 'Glitch', category: 'distortion',
    description: 'Block displacement, scanline tearing and noise.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.35, uniform: 'amount' },
      { key: 'speed', label: 'Speed', min: 0.1, max: 20, step: 0.1, default: 6, uniform: 'speed' },
      { key: 'blockSize', label: 'Block Size (px)', min: 4, max: 120, step: 2, default: 24, uniform: 'blockSize' },
    ],
  },
  {
    type: 'wave_distortion', name: 'Wave Distortion', category: 'distortion',
    description: 'Sine warp of the image.',
    params: [
      { key: 'amount', label: 'Amount (px)', min: 0, max: 60, step: 0.5, default: 12, uniform: 'amount' },
      { key: 'frequency', label: 'Frequency', min: 0.5, max: 40, step: 0.5, default: 8, uniform: 'frequency' },
      { key: 'speed', label: 'Speed', min: 0, max: 10, step: 0.1, default: 2, uniform: 'speed' },
    ],
  },
  {
    type: 'screen_distortion', name: 'CRT Screen Distortion', category: 'distortion',
    description: 'Barrel curve + scanlines — old-screen feel.',
    params: [
      { key: 'curve', label: 'Curve', min: 0, max: 1, step: 0.01, default: 0.3, uniform: 'curve' },
      { key: 'scanlines', label: 'Scanlines', min: 0, max: 1, step: 0.01, default: 0.35, uniform: 'scanlines' },
    ],
  },

  // ------------------------------------------------ Color
  {
    type: 'exposure', name: 'Exposure', category: 'color',
    description: 'Photographic exposure in stops.',
    params: [{ key: 'stops', label: 'Stops', min: -3, max: 3, step: 0.05, default: 0, uniform: 'stops' }],
  },
  {
    type: 'contrast', name: 'Contrast', category: 'color',
    description: 'Tonal contrast around mid grey.',
    params: [{ key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0, uniform: 'amount' }],
  },
  {
    type: 'saturation', name: 'Saturation', category: 'color',
    description: 'Color intensity; negative = desaturate.',
    params: [{ key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0, uniform: 'amount' }],
  },
  {
    type: 'temperature', name: 'Temperature', category: 'color',
    description: 'Warm ↔ cool white balance shift.',
    params: [{ key: 'value', label: 'Temp (warm +)', min: -1, max: 1, step: 0.01, default: 0, uniform: 'value' }],
  },
  {
    type: 'tint', name: 'Tint', category: 'color',
    description: 'Green ↔ magenta balance shift.',
    params: [{ key: 'value', label: 'Tint (magenta +)', min: -1, max: 1, step: 0.01, default: 0, uniform: 'value' }],
  },
  {
    type: 'lift_gamma_gain', name: 'Lift / Gamma / Gain', category: 'color',
    description: 'Professional three-way color balance.',
    params: [
      { key: 'lift', label: 'Lift (shadows)', min: -0.5, max: 0.5, step: 0.01, default: 0, uniform: 'lift' },
      { key: 'gamma', label: 'Gamma', min: 0.5, max: 2, step: 0.01, default: 1, uniform: 'gamma' },
      { key: 'gain', label: 'Gain (highlights)', min: 0.5, max: 2, step: 0.01, default: 1, uniform: 'gain' },
    ],
  },
  {
    type: 'vibrance', name: 'Vibrance', category: 'color',
    description: 'Smart saturation that protects skin/already-saturated tones.',
    params: [{ key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0, uniform: 'amount' }],
  },

  // ------------------------------------------------ Anime
  {
    type: 'speed_lines', name: 'Speed Lines', category: 'anime',
    description: 'Procedural manga speed lines converging to focus point.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.5, uniform: 'intensity' },
      { key: 'count', label: 'Density', min: 10, max: 240, step: 1, default: 80, uniform: 'count' },
      { key: 'speed', label: 'Flow Speed', min: 0, max: 10, step: 0.1, default: 3, uniform: 'speed' },
      { key: 'centerX', label: 'Focus X', min: -1, max: 1, step: 0.01, default: 0, uniform: 'centerX' },
      { key: 'centerY', label: 'Focus Y', min: -1, max: 1, step: 0.01, default: 0, uniform: 'centerY' },
    ],
  },
  {
    type: 'impact_flash', name: 'Impact Flash', category: 'anime',
    description: 'Invert/white flash — impact frames. Keyframe amount for punch.',
    params: [
      { key: 'amount', label: 'Flash Amount', min: 0, max: 1, step: 0.01, default: 0.8, uniform: 'amount' },
      { key: 'mode', label: '0=white 1=invert', min: 0, max: 1, step: 1, default: 1, uniform: 'mode' },
    ],
  },
  {
    type: 'energy_burst', name: 'Energy Burst', category: 'anime',
    description: 'Radiating energy shockwave rings.',
    params: [
      { key: 'progress', label: 'Progress', min: 0, max: 1, step: 0.01, default: 0.5, uniform: 'progress' },
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 1, uniform: 'intensity' },
      { key: 'hue', label: 'Hue (deg)', min: 0, max: 360, step: 1, default: 190, uniform: 'hue' },
    ],
  },
  {
    type: 'lightning', name: 'Lightning Arcs', category: 'anime',
    description: 'Procedural lightning bolt overlays.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.6, uniform: 'intensity' },
      { key: 'boltCount', label: 'Bolt Count', min: 1, max: 8, step: 1, default: 3, uniform: 'boltCount' },
      { key: 'speed', label: 'Flicker Speed', min: 0.5, max: 20, step: 0.5, default: 8, uniform: 'speed' },
    ],
  },
  {
    type: 'particles', name: 'Particles', category: 'anime',
    description: 'Floating ember/dust particles (procedural, GPU).',
    params: [
      { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, default: 0.4, uniform: 'density' },
      { key: 'size', label: 'Size', min: 0.5, max: 8, step: 0.1, default: 2, uniform: 'size' },
      { key: 'speed', label: 'Rise Speed', min: 0, max: 4, step: 0.05, default: 0.6, uniform: 'speed' },
      { key: 'hue', label: 'Hue (deg)', min: 0, max: 360, step: 1, default: 35, uniform: 'hue' },
    ],
  },
  {
    type: 'halftone', name: 'Manga Halftone', category: 'anime',
    description: 'Comic print dots + ink lines overlay.',
    params: [
      { key: 'amount', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.3, uniform: 'amount' },
      { key: 'scale', label: 'Dot Scale', min: 2, max: 30, step: 0.5, default: 8, uniform: 'scale' },
      { key: 'angle', label: 'Screen Angle (deg)', min: 0, max: 90, step: 1, default: 45, uniform: 'angle' },
    ],
  },

  // ------------------------------------------------ Audio (WebAudio chain)
  {
    type: 'bass_boost', name: 'Bass Boost', category: 'audio',
    description: 'Low-shelf boost for punchy music.',
    params: [{ key: 'gainDB', label: 'Gain (dB)', min: 0, max: 18, step: 0.5, default: 6, uniform: 'gain' }],
  },
  {
    type: 'treble_boost', name: 'Treble Boost', category: 'audio',
    description: 'High-shelf boost for crisp edits.',
    params: [{ key: 'gainDB', label: 'Gain (dB)', min: 0, max: 18, step: 0.5, default: 4, uniform: 'gain' }],
  },
  {
    type: 'reverb', name: 'Reverb', category: 'audio',
    description: 'Algorithmic room reverb (generated impulse).',
    params: [
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.25, uniform: 'mix' },
      { key: 'decay', label: 'Decay (s)', min: 0.2, max: 6, step: 0.1, default: 1.8, uniform: 'decay' },
    ],
  },
  {
    type: 'compressor', name: 'Compressor', category: 'audio',
    description: 'Dynamics compressor for loud, controlled mixes.',
    params: [
      { key: 'threshold', label: 'Threshold (dB)', min: -60, max: 0, step: 1, default: -18, uniform: 'threshold' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, default: 6, uniform: 'ratio' },
    ],
  },
  // ------------------------------------------------ Perspective
  {
    type: 'bulge', name: 'Bulge / Pinch', category: 'perspective', heavy: true,
    description: 'Lens-style bulge (positive) or pinch (negative) warp.',
    params: [
      { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.4, uniform: 'bulgeAmount' },
      { key: 'radius', label: 'Radius', min: 0.1, max: 1.5, step: 0.01, default: 0.7, uniform: 'bulgeRadius' },
      { key: 'centerX', label: 'Center X', min: -1, max: 1, step: 0.01, default: 0, uniform: 'bulgeCX' },
      { key: 'centerY', label: 'Center Y', min: -1, max: 1, step: 0.01, default: 0, uniform: 'bulgeCY' },
    ],
  },
  {
    type: 'twirl', name: 'Twirl', category: 'perspective', heavy: true,
    description: 'Spiral rotation warp around a center point.',
    params: [
      { key: 'angle', label: 'Angle (deg)', min: -720, max: 720, step: 5, default: 120, uniform: 'twirlAngle' },
      { key: 'radius', label: 'Radius', min: 0.1, max: 1.5, step: 0.01, default: 0.6, uniform: 'twirlRadius' },
      { key: 'centerX', label: 'Center X', min: -1, max: 1, step: 0.01, default: 0, uniform: 'twirlCX' },
      { key: 'centerY', label: 'Center Y', min: -1, max: 1, step: 0.01, default: 0, uniform: 'twirlCY' },
    ],
  },
  {
    type: 'ripple', name: 'Ripple', category: 'perspective', heavy: true,
    description: 'Concentric water ripple emanating from center.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.35, uniform: 'ripAmount' },
      { key: 'wavelength', label: 'Wavelength (px)', min: 8, max: 200, step: 1, default: 60, uniform: 'ripWave' },
      { key: 'speed', label: 'Speed', min: 0, max: 8, step: 0.1, default: 1.5, uniform: 'ripSpeed' },
    ],
  },
  {
    type: 'fisheye', name: 'Fisheye', category: 'perspective', heavy: true,
    description: 'Full-frame spherical lens distortion.',
    params: [
      { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.01, default: 0.4, uniform: 'fisheyeAmount' },
    ],
  },
  {
    type: 'kaleido', name: 'Kaleidoscope', category: 'perspective', heavy: true,
    description: 'Mirrored segments — psychedelic symmetry.',
    params: [
      { key: 'segments', label: 'Segments', min: 2, max: 16, step: 1, default: 6, uniform: 'kaleidoSeg' },
      { key: 'rotation', label: 'Phase (deg)', min: 0, max: 360, step: 1, default: 0, uniform: 'kaleidoRot' },
    ],
  },
  {
    type: 'tilt_2d', name: '2D Tilt (Fake 3D)', category: 'perspective',
    description: 'Horizontal/vertical shear — parallax tilt feel.',
    params: [
      { key: 'shearX', label: 'Shear X', min: -1, max: 1, step: 0.01, default: 0.2, uniform: 'tiltX' },
      { key: 'shearY', label: 'Shear Y', min: -1, max: 1, step: 0.01, default: 0, uniform: 'tiltY' },
    ],
  },
  {
    type: 'drop_shadow', name: 'Drop Shadow', category: 'perspective',
    description: 'Offset darkened copy behind the layer.',
    params: [
      { key: 'offsetX', label: 'Offset X (px)', min: -80, max: 80, step: 1, default: 10, uniform: 'dsX' },
      { key: 'offsetY', label: 'Offset Y (px)', min: -80, max: 80, step: 1, default: 10, uniform: 'dsY' },
      { key: 'opacity', label: 'Shadow Opacity', min: 0, max: 1, step: 0.01, default: 0.5, uniform: 'dsOpacity' },
      { key: 'softness', label: 'Softness (px)', min: 0, max: 40, step: 1, default: 8, uniform: 'dsSoft' },
    ],
  },

  // ------------------------------------------------ Stylize
  {
    type: 'posterize', name: 'Posterize', category: 'stylize',
    description: 'Quantize colors to N levels — flat cel look.',
    params: [{ key: 'levels', label: 'Levels', min: 2, max: 16, step: 1, default: 5, uniform: 'posterLevels' }],
  },
  {
    type: 'pixelate', name: 'Pixelate / Mosaic', category: 'stylize',
    description: 'Block mosaic — retro or censorship.',
    params: [
      { key: 'size', label: 'Block Size (px)', min: 2, max: 80, step: 1, default: 12, uniform: 'pixSize' },
    ],
  },
  {
    type: 'sketch', name: 'Pencil Sketch', category: 'stylize', heavy: true,
    description: 'Edge-outline drawing over paper white.',
    params: [
      { key: 'amount', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.8, uniform: 'sketchAmount' },
      { key: 'threshold', label: 'Line Threshold', min: 0.05, max: 0.9, step: 0.01, default: 0.35, uniform: 'sketchThresh' },
    ],
  },
  {
    type: 'neon_edges', name: 'Neon Edges', category: 'stylize', heavy: true,
    description: 'Glowing outline traced on edges — cyber look.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 3, step: 0.01, default: 1.2, uniform: 'neonIntensity' },
      { key: 'hue', label: 'Hue (deg)', min: 0, max: 360, step: 1, default: 320, uniform: 'neonHue' },
      { key: 'threshold', label: 'Edge Threshold', min: 0.05, max: 0.9, step: 0.01, default: 0.3, uniform: 'neonThresh' },
    ],
  },
  {
    type: 'oil_paint', name: 'Oil Paint', category: 'stylize', heavy: true,
    description: 'Kuwahara-style painterly smoothing.',
    params: [
      { key: 'radius', label: 'Brush Radius', min: 1, max: 6, step: 1, default: 3, uniform: 'oilRadius' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.7, uniform: 'oilMix' },
    ],
  },
  {
    type: 'duotone', name: 'Duotone', category: 'stylize',
    description: 'Map luminance between two hues — poster grade.',
    params: [
      { key: 'hueA', label: 'Shadow Hue (deg)', min: 0, max: 360, step: 1, default: 230, uniform: 'duoHueA' },
      { key: 'hueB', label: 'Highlight Hue (deg)', min: 0, max: 360, step: 1, default: 45, uniform: 'duoHueB' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 0.8, uniform: 'duoMix' },
    ],
  },

  // ------------------------------------------------ Generate
  {
    type: 'film_grain', name: 'Film Grain', category: 'generate',
    description: 'Animated photographic grain.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.25, uniform: 'grainAmount' },
      { key: 'size', label: 'Grain Size', min: 0.5, max: 4, step: 0.1, default: 1.2, uniform: 'grainSize' },
      { key: 'speed', label: 'Flicker', min: 0, max: 10, step: 0.1, default: 2, uniform: 'grainSpeed' },
    ],
  },
  {
    type: 'starfield', name: 'Starfield', category: 'generate',
    description: 'Drifting star specks — night sky feel.',
    params: [
      { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, default: 0.3, uniform: 'starDensity' },
      { key: 'speed', label: 'Drift Speed', min: 0, max: 4, step: 0.05, default: 0.3, uniform: 'starSpeed' },
      { key: 'twinkle', label: 'Twinkle', min: 0, max: 3, step: 0.05, default: 1, uniform: 'starTwinkle' },
    ],
  },
  {
    type: 'rain_overlay', name: 'Rain', category: 'generate',
    description: 'Procedural rain streaks + mist.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.45, uniform: 'rainIntensity' },
      { key: 'angle', label: 'Angle (deg)', min: -45, max: 45, step: 1, default: 12, uniform: 'rainAngle' },
      { key: 'speed', label: 'Fall Speed', min: 0.2, max: 6, step: 0.1, default: 2.5, uniform: 'rainSpeed' },
    ],
  },
  {
    type: 'sakura_petals', name: 'Sakura Petals', category: 'generate',
    description: 'Falling cherry blossom petals.',
    params: [
      { key: 'density', label: 'Density', min: 0, max: 1, step: 0.01, default: 0.4, uniform: 'sakuraDensity' },
      { key: 'speed', label: 'Fall Speed', min: 0.1, max: 3, step: 0.05, default: 0.5, uniform: 'sakuraSpeed' },
      { key: 'sway', label: 'Sway', min: 0, max: 3, step: 0.05, default: 1, uniform: 'sakuraSway' },
      { key: 'size', label: 'Size', min: 0.5, max: 4, step: 0.1, default: 1.4, uniform: 'sakuraSize' },
    ],
  },
  {
    type: 'aurora_waves', name: 'Aurora', category: 'generate',
    description: 'Flowing aurora curtains of light.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0.8, uniform: 'auroraIntensity' },
      { key: 'hue', label: 'Hue (deg)', min: 0, max: 360, step: 1, default: 150, uniform: 'auroraHue' },
      { key: 'speed', label: 'Flow Speed', min: 0.1, max: 4, step: 0.05, default: 0.8, uniform: 'auroraSpeed' },
    ],
  },
  {
    type: 'grid_overlay', name: 'Grid / HUD', category: 'generate',
    description: 'Tech grid overlay with scanning glow.',
    params: [
      { key: 'spacing', label: 'Spacing (px)', min: 8, max: 120, step: 1, default: 32, uniform: 'gridSpacing' },
      { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 0.3, uniform: 'gridOpacity' },
      { key: 'glow', label: 'Scan Glow', min: 0, max: 1, step: 0.01, default: 0.4, uniform: 'gridGlow' },
    ],
  },

  // ------------------------------------------------ Time
  {
    type: 'motion_echo', name: 'Motion Echo', category: 'time', heavy: true,
    description: 'Directional frame echo — streaking after-images.',
    params: [
      { key: 'decay', label: 'Echo Persistence', min: 0.1, max: 0.95, step: 0.01, default: 0.65, uniform: 'echoDecay' },
      { key: 'offsetX', label: 'Echo Offset X (px)', min: -60, max: 60, step: 1, default: -14, uniform: 'echoX' },
      { key: 'offsetY', label: 'Echo Offset Y (px)', min: -60, max: 60, step: 1, default: 0, uniform: 'echoY' },
    ],
  },
  {
    type: 'camera_shake', name: 'Camera Shake', category: 'time',
    description: 'Procedural handheld/impact camera jitter.',
    params: [
      { key: 'intensity', label: 'Intensity (px)', min: 0, max: 40, step: 0.5, default: 8, uniform: 'shakeIntensity' },
      { key: 'frequency', label: 'Frequency', min: 1, max: 40, step: 0.5, default: 12, uniform: 'shakeFreq' },
      { key: 'rotation', label: 'Rotation Jitter (deg)', min: 0, max: 8, step: 0.1, default: 0.8, uniform: 'shakeRot' },
    ],
  },

  // ------------------------------------------------ extra lighting / color
  {
    type: 'soft_bloom', name: 'Soft Bloom', category: 'lighting', heavy: true,
    description: 'Wide, gentle bloom — dreamy highlight wash.',
    params: [
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, step: 0.01, default: 0.5, uniform: 'bloomThresh' },
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0.6, uniform: 'bloomIntensity' },
    ],
  },
  {
    type: 'godrays', name: 'God Rays', category: 'lighting', heavy: true,
    description: 'Radial light shafts from a point.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0.7, uniform: 'godIntensity' },
      { key: 'x', label: 'Source X', min: -1, max: 1, step: 0.01, default: -0.3, uniform: 'godX' },
      { key: 'y', label: 'Source Y', min: -1, max: 1, step: 0.01, default: 0.4, uniform: 'godY' },
      { key: 'rays', label: 'Ray Count', min: 4, max: 24, step: 1, default: 10, uniform: 'godRays' },
    ],
  },
  {
    type: 'rim_light', name: 'Rim Light', category: 'lighting', heavy: true,
    description: 'Edge-based highlight — separates subject from bg.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 3, step: 0.01, default: 1, uniform: 'rimIntensity' },
      { key: 'hue', label: 'Tint Hue (deg)', min: 0, max: 360, step: 1, default: 40, uniform: 'rimHue' },
    ],
  },
  {
    type: 'hue_shift', name: 'Hue Rotate', category: 'color',
    description: 'Rotate all hues by degrees.',
    params: [{ key: 'degrees', label: 'Degrees', min: -180, max: 180, step: 1, default: 0, uniform: 'hueDegrees' }],
  },
  {
    type: 'color_balance', name: 'Color Balance', category: 'color',
    description: 'Per-channel offset — broadcast-style balance.',
    params: [
      { key: 'red', label: 'Red', min: -0.5, max: 0.5, step: 0.01, default: 0, uniform: 'cbR' },
      { key: 'green', label: 'Green', min: -0.5, max: 0.5, step: 0.01, default: 0, uniform: 'cbG' },
      { key: 'blue', label: 'Blue', min: -0.5, max: 0.5, step: 0.01, default: 0, uniform: 'cbB' },
    ],
  },
  {
    type: 's_curve', name: 'S-Curve Contrast', category: 'color',
    description: 'Filmic S-curve with pivot control.',
    params: [
      { key: 'amount', label: 'Strength', min: 0, max: 1, step: 0.01, default: 0.4, uniform: 'scAmount' },
      { key: 'pivot', label: 'Pivot', min: 0.2, max: 0.8, step: 0.01, default: 0.5, uniform: 'scPivot' },
    ],
  },
  {
    type: 'sharpen', name: 'Sharpen', category: 'stylize',
    description: 'Unsharp-mask style edge crispening.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 2, step: 0.01, default: 0.5, uniform: 'sharpenAmount' },
      { key: 'radius', label: 'Radius (px)', min: 0.5, max: 4, step: 0.5, default: 1, uniform: 'sharpenRadius' },
    ],
  },
  {
    type: 'cartoon', name: 'Cartoon / Cel Shade', category: 'stylize',
    description: 'Posterized colors + dark ink edges — anime cel look.',
    params: [
      { key: 'mix', label: 'Strength', min: 0, max: 1, step: 0.01, default: 0.7, uniform: 'cartoonMix' },
      { key: 'levels', label: 'Color Levels', min: 2, max: 12, step: 1, default: 5, uniform: 'cartoonLevels' },
      { key: 'edge', label: 'Edge Ink', min: 0, max: 1, step: 0.01, default: 0.5, uniform: 'cartoonEdge' },
    ],
  },
  {
    type: 'turbulent_displace', name: 'Turbulent Displace', category: 'distortion',
    description: 'Fractal-noise UV warping — heat haze, water, energy.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 60, step: 0.5, default: 12, uniform: 'turbAmount' },
      { key: 'scale', label: 'Scale', min: 1, max: 20, step: 0.1, default: 6, uniform: 'turbScale' },
      { key: 'speed', label: 'Evolution Speed', min: 0, max: 3, step: 0.01, default: 0.6, uniform: 'turbSpeed' },
    ],
  },
  {
    type: 'posterize_time', name: 'Posterize Time', category: 'time',
    description: 'Lock layer motion to a lower frame rate — steppy anime feel.',
    params: [
      { key: 'fps', label: 'Frame Rate', min: 1, max: 60, step: 1, default: 12, uniform: 'posterizeFps' },
    ],
  },
]

export const EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(EFFECT_DEFS.map(e => [e.type, e]))

export const EFFECT_CATEGORIES = ['motion', 'lighting', 'distortion', 'color', 'anime', 'stylize', 'generate', 'perspective', 'time', 'audio'] as const

export const COLOR_PRESETS: Record<string, { label: string; grade: Record<string, number> }> = {
  cinematic_teal_orange: { label: 'Cinematic Teal & Orange', grade: { contrast: 0.15, saturation: 0.1, temperature: 0.15, tint: -0.05, lift: -0.03, gamma: 0.96, gain: 1.06 } },
  anime_punch: { label: 'Anime Punch', grade: { contrast: 0.25, saturation: 0.28, vibrance: 0.2, gamma: 0.95 } },
  soft_pastel: { label: 'Soft Pastel', grade: { contrast: -0.05, saturation: -0.1, temperature: 0.06, lift: 0.04, gamma: 1.06 } },
  dramatic_dark: { label: 'Dramatic Dark', grade: { contrast: 0.3, exposure: -0.25, saturation: -0.12, lift: -0.06, vignette: 0.5 } },
  retro_vhs: { label: 'Retro VHS', grade: { contrast: 0.12, saturation: 0.15, temperature: -0.08, tint: 0.08, gamma: 1.05 } },
  mono_noir: { label: 'Mono Noir', grade: { saturation: -1, contrast: 0.25, lift: -0.02, gain: 1.1 } },
  sunset_glow: { label: 'Sunset Glow', grade: { temperature: 0.3, saturation: 0.15, exposure: 0.08, lift: 0.02 } },
  cold_horror: { label: 'Cold Horror', grade: { temperature: -0.25, saturation: -0.25, contrast: 0.2, gamma: 0.92 } },
}

/** Fixed effect defaults → params record. */
export function defaultParams(type: string): Record<string, number> {
  const def = EFFECT_MAP[type]
  if (!def) return {}
  return Object.fromEntries(def.params.map(p => [p.key, p.default]))
}

export function clampParam(type: string, key: string, value: number): number {
  const def = EFFECT_MAP[type]
  const p = def?.params.find(pp => pp.key === key)
  if (!p) return value
  return Math.min(p.max, Math.max(p.min, value))
}

export const BLEND_MODES = ['normal', 'add', 'screen', 'multiply', 'overlay', 'lighten', 'difference'] as const
