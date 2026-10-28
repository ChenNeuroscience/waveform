import { expect, it } from "vitest";
import { rateMapColour, rateMapPalette } from "../src/palette";
import { defaultSettings } from "../src/types";

it("defaults to the exact five spatial colours from waveform-v1", () => {
  expect(rateMapPalette(defaultSettings.rateMapSteps)).toEqual([
    "rgb(0,0,198)",
    "rgb(0,162,255)",
    "rgb(56,235,32)",
    "rgb(248,221,0)",
    "rgb(255,32,0)",
  ]);
});

it("matches v1's equal-width rate bins, automatic zero maps and saturated rates", () => {
  const palette = rateMapPalette();
  expect([0, 1, 3, 5, 7, 9, 10, 20].map((v) => rateMapColour(v, 10, palette))).toEqual([
    palette[0],
    palette[0],
    palette[1],
    palette[2],
    palette[3],
    palette[4],
    palette[4],
    palette[4],
  ]);
  // As in v1, exact boundaries belong to the lower bin.
  for (let i = 1; i < 5; i++) {
    expect(rateMapColour(i * 2, 10, palette)).toBe(palette[i - 1]);
    expect(rateMapColour(i * 2 + 0.00001, 10, palette)).toBe(palette[i]);
  }
  expect(rateMapColour(0, 0, palette)).toBe(palette[0]);
  expect(rateMapColour(-1, 10, palette)).toBe(palette[0]);
  expect(rateMapColour(NaN, 10, palette)).toBe("#ffffff");
});

it("resamples the original colours for custom step counts", () => {
  const palette = rateMapPalette(9);
  expect(palette).toHaveLength(9);
  expect(new Set(palette).size).toBe(9);
  expect(palette.filter((_, i) => i % 2 === 0)).toEqual(rateMapPalette());
  expect(rateMapPalette(2)).toEqual([palette[0], palette[8]]);
  expect(rateMapPalette(NaN)).toEqual(rateMapPalette());
  expect(rateMapPalette(-2)).toHaveLength(2);
  expect(rateMapPalette(100)).toHaveLength(32);
});
