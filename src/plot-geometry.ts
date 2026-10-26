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
  const box = fitGrid(Math.max(1, width - 34), Math.max(1, height - 50), 1, 1);
  return { ...box, x: box.x + 22, y: box.y + 26 };
}

export interface WaveLayout {
  columns: number;
  tileStride: number;
  rowStride: number;
  waveWidth: number;
  waveHeight: number;
  inset: number;
}
