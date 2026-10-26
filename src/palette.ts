// Byte-for-byte group colours and text contrast from waveform-v1 palettes.html.
// Unassigned entries in the original 256-entry palette are intentionally black.
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
  0, 2, 3, 4, 5, 6, 7, 10, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 25, 26,
  27, 28, 30,
]);
export const groupRgb8 = (cell: number): readonly number[] =>
  groupPalette[cell] || [0, 0, 0];
export const groupTextColor = (cell: number) =>
  blackText.has(cell) ? "#000" : "#fff";
