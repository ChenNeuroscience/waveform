import { afterEach, expect, it, vi } from "vitest";
import { drawAnalysis } from "../src/plots/AnalysisPlot";
import type { AnalysisData } from "../src/types";

afterEach(() => vi.unstubAllGlobals());
function render(ac: number[], mode: "ac" | "spatial" = "ac", steps = 5, maxRate = 0) {
  vi.stubGlobal("devicePixelRatio", 1);
  const lines: number[][] = [];
  const fills: { colour: string; rect: number[] }[] = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    scale() {},
    translate() {},
    beginPath() {},
    stroke: vi.fn(),
    moveTo(...p: number[]) {
      lines.push(p);
    },
    lineTo(...p: number[]) {
      lines.push(p);
    },
    fillRect(...rect: number[]) {
      fills.push({ colour: this.fillStyle, rect });
    },
  };
  const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
  const data = {
    ac: Float32Array.from(ac),
    spatial: Float32Array.from([0, 3, 8]),
    width: 3,
    height: 1,
    peak: 8,
  } as AnalysisData;
  drawAnalysis(canvas, 128, 32, { data, mode, compact: true, maxRate, rateMapSteps: steps });
  return { lines, fills: fills.slice(1), context };
}
it("draws finite, visible segments for a single temporal bin, including an empty bin", () => {
  for (const [count, y] of [
    [5, 2],
    [0, 30],
  ]) {
    const result = render([count]);
    expect(result.lines).toEqual([
      [1, y],
      [127, y],
    ]);
    expect(result.lines.flat().every(Number.isFinite)).toBe(true);
    expect(result.context.stroke).toHaveBeenCalledOnce();
  }
});
it("preserves the temporal shape across zero and peak bins", () => {
  expect(render([0, 2, 0]).lines).toEqual([
    [1, 30],
    [64, 2],
    [127, 30],
  ]);
});
it("applies spatial colour steps and rate limits in the actual plot renderer", () => {
  const five = render([], "spatial").fills;
  const nine = render([], "spatial", 9).fills;
  const limited = render([], "spatial", 5, 4).fills;
  expect(five).toHaveLength(3);
  expect(five[0].colour).toBe(nine[0].colour);
  expect(five[2].colour).toBe(nine[2].colour);
  expect(five[1].colour).not.toBe(nine[1].colour);
  expect(limited[1].colour).not.toBe(five[1].colour);
  for (const { rect } of five) expect(rect.every(Number.isFinite)).toBe(true);
});
