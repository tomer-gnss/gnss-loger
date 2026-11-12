import type { Sys } from './logParser'

// Validated categorical palette (light = marks on white, dark = sky plot on the dark panel).
// Fixed order = SYS_ORDER: colour follows the constellation, never its rank in a given log.
export const SYS_COLOR: Record<Sys, { light: string; dark: string }> = {
  GPS: { light: '#2a78d6', dark: '#3987e5' },
  Galileo: { light: '#eb6834', dark: '#d95926' },
  GLONASS: { light: '#1baf7a', dark: '#199e70' },
  BeiDou: { light: '#eda100', dark: '#c98500' },
  QZSS: { light: '#e87ba4', dark: '#d55181' },
  SBAS: { light: '#008300', dark: '#008300' },
  NavIC: { light: '#6250d6', dark: '#9085e9' },
  Unknown: { light: '#898781', dark: '#898781' },
}

// Sequential single-hue ramp (blue, light → dark) for magnitude: the C/N0 heatmap.
export const SEQ_BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b']

// Cellular network generation (cellular chart). Drawn from the same validated palette.
export const TECH_COLOR: Record<'2G' | '3G' | '4G' | '5G', string> = { '5G': '#6250d6', '4G': '#1c5cab', '3G': '#c98500', '2G': '#898781' }
