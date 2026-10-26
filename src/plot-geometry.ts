/** Fit data units uniformly on both axes, leaving unused canvas space around them. */
export function fitGrid(
  width: number,
  height: number,
  columns: number,
  rows: number,
) {
  const unit = Math.max(
    0,
    Math.min(width / Math.max(1, columns), height / Math.max(1, rows)),
  );
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
