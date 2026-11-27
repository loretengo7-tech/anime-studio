/** After Effects effect matchNames → AnimeStudio effect types (scripts, .ffx presets, .aep import). */
export const MATCH_TO_TYPE: Record<string, string> = {
  'ADBE Slider Control': 'slider_control', 'ADBE Checkbox Control': 'checkbox_control', 'ADBE Angle Control': 'angle_control',
  'ADBE Gaussian Blur 2': 'gaussian_blur', 'ADBE Gaussian Blur': 'gaussian_blur', 'ADBE Box Blur2': 'gaussian_blur', 'ADBE Camera Lens Blur': 'gaussian_blur',
  'ADBE Glo2': 'glow', 'ADBE Glow': 'glow', 'ADBE Fill': 'fill', 'ADBE Tint': 'tint',
  'ADBE Motion Blur': 'directional_blur', 'ADBE Radial Blur': 'radial_blur', 'ADBE Drop Shadow': 'drop_shadow',
  'ADBE Exposure2': 'exposure', 'ADBE Brightness & Contrast 2': 'contrast', 'ADBE HUE SATURATION': 'saturation', 'ADBE Color Balance (HLS)': 'hue_shift',
  'ADBE Vibrance': 'vibrance', 'ADBE CurvesCustom': 's_curve', 'ADBE Lumetri': 'color_balance', 'ADBE Pro Levels2': 'lift_gamma_gain',
  'ADBE Sharpen': 'sharpen', 'ADBE Unsharp Mask2': 'sharpen', 'ADBE Posterize': 'posterize', 'ADBE Mosaic': 'pixelate',
  'ADBE Noise': 'film_grain', 'ADBE Add Grain': 'film_grain', 'ADBE Turbulent Displace': 'turbulent_displace', 'ADBE Twirl': 'twirl',
  'ADBE Bulge': 'bulge', 'ADBE Ripple': 'ripple', 'ADBE Wave Warp': 'wave_distortion', 'ADBE Optics Compensation': 'fisheye',
  'ADBE Tile': 'tile', 'ADBE Mirror': 'mirror', 'ADBE Lens Flare': 'lens_flare', 'ADBE Echo': 'motion_echo', 'ADBE Posterize Time': 'posterize_time',
  'ADBE Find Edges': 'neon_edges', 'ADBE Cartoonify': 'cartoon', 'ADBE Color Key': 'chroma_key', 'ADBE KeyLight': 'chroma_key', 'Keylight 906': 'chroma_key',
  'ADBE Geometry2': 'tilt_2d', 'ADBE Vignette': 'vignette', 'ADBE Channel Mixer': 'color_balance', 'ADBE Tritone': 'duotone',
  'CC Radial Fast Blur': 'zoom_blur', 'CC Lens': 'fisheye', 'CC Kaleida': 'kaleido', 'CC Light Rays': 'godrays', 'CC Rainfall': 'rain_overlay',
  'CC Star Burst': 'starfield', 'CC Particle World': 'particles', 'CC Particle Systems II': 'particles', 'CC Vignette': 'vignette',
  'S_Glow': 'glow', 'S_Shake': 'camera_shake', 'S_BlurMoCurves': 'directional_blur', 'Deep Glow': 'glow', 'PEDG': 'glow',
  'RSMB': 'directional_blur', 'RSMB Pro': 'directional_blur',
}
