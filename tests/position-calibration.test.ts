import { describe, expect, it } from "vitest";
import { parsePosition, trajectory } from "../src/worker/position";
import { defaultSettings } from "../src/types";
import { editHeader, headerRows, headersChanged, resetHeaders } from "../src/shell/header-edits";
import { corePromise } from "./wasm";

/** A .pos with `samples` as [x, y] for the first LED, or null if it wasn't seen. */
function pos(ppm: string, samples: ([number, number] | null)[]) {
  const header = `pos_format t,x1,y1,x2,y2,numpix1,numpix2\nnum_pos_samples ${samples.length}\npixels_per_metre ${ppm}\nsample_rate 50 hz\nwindow_min_x 0\nwindow_max_x 800\nwindow_min_y 0\nwindow_max_y 600\r\ndata_start`;
  const raw = new Uint8Array(samples.length * 20);
  const view = new DataView(raw.buffer);
  samples.forEach((sample, i) => {
    const [x, y] = sample ?? [1023, 1023];
    view.setUint16(i * 20 + 4, x);
    view.setUint16(i * 20 + 6, y);
    view.setUint16(i * 20 + 8, 1023);
    view.setUint16(i * 20 + 10, 1023);
    view.setUint16(i * 20 + 12, sample ? 10 : 0);
  });
  return new File([header, raw], "trial.pos");
}

async function calibration(file: File, edited?: number) {
  const w = await corePromise;
  const position = await parsePosition(file, defaultSettings, w, "key", undefined, edited);
  try {
    const { ppm, ppmEstimated, arenaWidth } = trajectory(w, position);
    return { ppm, ppmEstimated, arenaWidth };
  } finally {
    w.position_free(position.handle);
  }
}

describe("position calibration", () => {
  const moved: [number, number][] = [
    [100, 100],
    [150, 120],
    [300, 150],
  ];
  it("uses the file's, when it has one", async () => {
    expect(await calibration(pos("400", moved))).toEqual({
      ppm: 400,
      ppmEstimated: false,
      arenaWidth: 200,
    });
  });
  it("takes the largest dimension used to be a metre when it's not set", async () => {
    expect(await calibration(pos("NaN", moved))).toEqual({
      ppm: 200,
      ppmEstimated: true,
      arenaWidth: 400,
    });
  });
  it("falls back on the window if the LEDs were never seen", async () => {
    const { ppm, ppmEstimated } = await calibration(pos("NaN", [null, null]));
    expect([ppm, ppmEstimated]).toEqual([800, true]);
  });
  it("prefers an edit to the file or a guess", async () => {
    for (const file of [pos("NaN", moved), pos("400", moved)]) {
      expect(await calibration(file, 500)).toMatchObject({ ppm: 500, ppmEstimated: false });
    }
  });
});

describe("header edits", () => {
  const row = (rows: ReturnType<typeof headerRows>) =>
    rows.find((r) => r.key === "pixels_per_metre");
  it("show edits and estimates over the file's value, or as new rows", () => {
    const file = { pixels_per_metre: "NaN", duration: "4" };
    expect(row(headerRows("position", file))).toMatchObject({
      value: "NaN",
      note: "",
      editable: true,
    });
    expect(
      row(headerRows("position", file, undefined, { pixels_per_metre: "812.0" })),
    ).toMatchObject({ value: "812.0", note: "estimated, file says NaN" });
    expect(
      row(headerRows("position", file, { pixels_per_metre: "500" }, { pixels_per_metre: "812.0" })),
    ).toMatchObject({ value: "500", note: "edited, file says NaN" });
    expect(row(headerRows("position", {}, { pixels_per_metre: "500" }))).toMatchObject({
      note: "edited, not in the file",
    });
    expect(headerRows("position", file).find((r) => r.key === "duration")?.editable).toBe(false);
    expect(row(headerRows("set", file))?.editable).toBe(false);
  });
  it("count only for the active files, and reset a file at a time", () => {
    const edits = editHeader(editHeader({}, "a", "k", "1"), "b", "k", "2");
    expect(headersChanged({ position: "c" }, edits, {})).toBe(false);
    expect(headersChanged({ position: "a", set: undefined }, edits, {})).toBe(true);
    expect(headersChanged({ position: "c" }, edits, { position: { k: "3" } })).toBe(true);
    expect(resetHeaders(edits, "a")).toEqual({ b: { k: "2" } });
  });
});
