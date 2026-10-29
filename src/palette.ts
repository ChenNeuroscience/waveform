// Cell group colours, and which groups need black badge text for contrast.
// Groups beyond the listed colours are black.
export const groupPalette = [
  [190, 190, 190],
  [0, 0, 200],
  [80, 255, 0],
  [255, 0, 0],
  [245, 0, 255],
  [0, 200, 255],
  [0, 185, 0],
  [255, 185, 50],
  [0, 150, 175],
  [150, 0, 175],
  [170, 170, 0],
  [200, 0, 0],
  [255, 255, 0],
  [140, 140, 140],
  [0, 255, 235],
  [255, 0, 160],
  [175, 75, 75],
  [255, 155, 175],
  [190, 190, 160],
  [255, 255, 75],
  [154, 205, 50],
  [255, 99, 71],
  [0, 255, 127],
  [255, 140, 0],
  [32, 178, 170],
  [255, 69, 0],
  [240, 230, 140],
  [100, 149, 237],
  [255, 218, 185],
  [153, 50, 204],
  [250, 128, 114],
] as const;
const blackText = new Set([
  0, 2, 3, 4, 5, 6, 7, 10, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 30,
]);
export const groupRgb8 = (cell: number): readonly number[] => groupPalette[cell] || [0, 0, 0];
export const groupTextColor = (cell: number) => (blackText.has(cell) ? "#000" : "#fff");

// The five spatial rate-map colours from waveform-v1's rm-plots.html.
const rateMapColours = [
  [0, 0, 198],
  [0, 162, 255],
  [56, 235, 32],
  [248, 221, 0],
  [255, 32, 0],
] as const;

/** Other step counts sample the same colours with linear RGB interpolation. */
export function rateMapPalette(steps = 5): string[] {
  const count = Number.isFinite(steps) ? Math.max(2, Math.min(32, Math.round(steps))) : 5;
  return Array.from({ length: count }, (_, i) => {
    const position = (i * (rateMapColours.length - 1)) / (count - 1);
    const low = Math.floor(position);
    const high = Math.min(low + 1, rateMapColours.length - 1);
    const rgb = rateMapColours[low].map((v, channel) =>
      Math.round(v + (rateMapColours[high][channel] - v) * (position - low)),
    );
    return `rgb(${rgb.join(",")})`;
  });
}

export function rateMapColour(rate: number, maximum: number, palette: readonly string[]): string {
  if (!Number.isFinite(rate)) {
    return "#ffffff";
  }
  // Match v1's equal-width bins, including its epsilon at exact boundaries.
  const index = maximum > 0 ? Math.floor((rate / (maximum * (1 + 1e-7))) * palette.length) : 0;
  return palette[Math.max(0, Math.min(palette.length - 1, index))];
}
