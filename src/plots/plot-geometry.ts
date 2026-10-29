/** Fit data units uniformly on both axes, leaving unused canvas space around them. */
export function fitGrid(width: number, height: number, columns: number, rows: number) {
  const unit = Math.max(0, Math.min(width / Math.max(1, columns), height / Math.max(1, rows)));
  return {
    x: (width - columns * unit) / 2,
    y: (height - rows * unit) / 2,
    width: columns * unit,
    height: rows * unit,
    unit,
  };
}
export function projectionFrame(width: number, height: number) {
  const box = fitGrid(Math.max(1, width - 4), Math.max(1, height - 4), 1, 1);
  return { ...box, x: box.x + 2, y: box.y + 2 };
}

/**
 * Waveform frame geometry, shared by the GPU shader, the split marker, split
 * gestures and tests. Each of the four channels fills a quarter of the frame
 * width, with its 50 samples spanning the middle WAVE_SPAN of that quarter
 * (WAVE_MARGIN either side); ±128 ADC units span WAVE_GAIN of the frame height.
 * Coordinates are fractions of the frame: x from the left, y from the top.
 */
export const WAVE_SAMPLES = 50;
export const WAVE_MARGIN = 0.01;
export const WAVE_SPAN = 1 - 2 * WAVE_MARGIN;
export const WAVE_GAIN = 1;
export const waveX = (channel: number, sample: number) =>
  (channel + WAVE_MARGIN + (WAVE_SPAN * sample) / (WAVE_SAMPLES - 1)) / 4;
export const waveY = (value: number) => 0.5 - ((value / 128) * WAVE_GAIN) / 2;
/** The channel, nearest sample and threshold value under a point in the frame. */
export function wavePoint(x: number, y: number) {
  const wx = Math.min(0.99999, Math.max(0, x)) * 4;
  const channel = Math.min(3, Math.floor(wx));
  const sample = Math.round(((wx - channel - WAVE_MARGIN) / WAVE_SPAN) * (WAVE_SAMPLES - 1));
  const threshold = Math.round(((0.5 - y) * 2 * 128) / WAVE_GAIN);
  return {
    channel,
    sample: Math.max(0, Math.min(WAVE_SAMPLES - 1, sample)),
    threshold: Math.max(-128, Math.min(127, threshold)),
  };
}
export interface WaveLayout {
  columns: number;
  tileStride: number;
  rowStride: number;
  waveWidth: number;
  waveHeight: number;
  inset: number;
  top?: number;
}

export const FEATURE_PLOT = 128;
export const FEATURE_GAP = 4;
export const FEATURE_STRIDE = FEATURE_PLOT + FEATURE_GAP;
export function featureGridSize(columns: number, plots = 6) {
  const rows = Math.ceil(plots / columns);
  return {
    width: columns * FEATURE_STRIDE - FEATURE_GAP,
    height: rows * FEATURE_STRIDE - FEATURE_GAP,
  };
}
export function featurePlotOrigin(index: number, columns: number) {
  return {
    x: (index % columns) * FEATURE_STRIDE,
    y: Math.floor(index / columns) * FEATURE_STRIDE,
  };
}
