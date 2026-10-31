import { ready, exportCut, setDensity } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeCut } from "../tests/wasm";
import { waveX, waveY } from "../src/plots/plot-geometry";
async function assignments(page: Page) {
  const [d] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
  return [...(await decodeCut(new File([await readFile((await d.path())!)], "trial_1.cut"), 5))];
}
async function fixture(page: Page) {
  const raw = Buffer.alloc(5 * 216);
  [20, 30, 90, 100, 50].forEach((v, i) => {
    for (let c = 0; c < 4; c++) raw.writeUInt32BE(96000 * (i + 1), i * 216 + c * 54);
    raw[i * 216 + 4 + 14] = v;
    raw[i * 216 + 54 + 4 + 20] = [10, 25, 40, 100, 0][i];
  });
  await page.goto("/?demo=quick");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "trial.1",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          "num_spikes 5\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
        ),
        raw,
      ]),
    },
    {
      name: "trial_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from("Exact_cut_for: trial spikes: 5\n1 1 1 1 2\n"),
    },
    {
      name: "trial.clu.1",
      mimeType: "text/plain",
      buffer: Buffer.from("3\n2\n2\n2\n2\n3\n"),
    },
  ]);
  await ready(page);
}
test("tile drag merge and right-button waveform split preserve exact undo labels", async ({
  page,
}) => {
  await fixture(page);
  const wave = (cell: number) => page.locator(`.cell-tile[data-cell="${cell}"] .tile-waves`);
  await setDensity(page, true);
  await expect
    .poll(() =>
      page.locator(".tile-wave-canvas").evaluate((c) => {
        const gl = (c as HTMLCanvasElement).getContext("webgl2")!;
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240) ink++;
        return ink;
      }),
    )
    .toBeGreaterThan(100);
  await wave(1).dragTo(wave(2));
  await expect(page.getByRole("button", { name: "Select cell 2", exact: true })).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 1]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 2]);
  const b = (await wave(1).boundingBox())!;
  const x = b.x + b.width * waveX(0, 14),
    y = b.y + b.height * waveY(60);
  await page.mouse.move(x, y + 3);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x, y, { steps: 4 });
  await expect(page.locator(".wave-split-marker")).toBeVisible();
  await page.mouse.up({ button: "right" });
  await expect(page.getByRole("button", { name: "Select cell 3", exact: true })).toBeVisible();
  await expect(page.locator(".tile-wall")).toHaveAttribute("data-splitting", "1");
  await expect(page.locator(".tile-marked")).toHaveCount(2);
  await expect(page.locator(".tile-muted")).toHaveCount(1);
  await expect(page.locator(".wave-split-marker")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await ready(page);
  // Adjust from the spawned tile, using a different channel/sample. Membership
  // must always be recomputed from the original cell, never just one half.
  const second = (await wave(2).boundingBox())!;
  const xx = second.x + second.width * waveX(1, 20),
    yy = second.y + second.height * waveY(60);
  await page.mouse.move(xx, yy + 3);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(xx, yy, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect(
    page.locator('.cell-tile[data-cell="1"] .tile-caption .stat-value').last(),
  ).toHaveText("3");
  await expect(
    page.locator('.cell-tile[data-cell="2"] .tile-caption .stat-value').last(),
  ).toHaveText("1");
  // A left press on a split tile's waveforms adjusts rather than finishing.
  await ready(page);
  await page.mouse.move(xx, yy + 3);
  await page.mouse.down();
  await page.mouse.move(xx, yy, { steps: 4 });
  await page.mouse.up();
  await ready(page);
  await expect(page.locator(".tile-marked")).toHaveCount(2);
  await expect(page.locator(".tile-wall")).toHaveAttribute("data-splitting", "1");
  await expect(
    page.locator('.cell-tile[data-cell="2"] .tile-caption .stat-value').last(),
  ).toHaveText("1");
  await page.mouse.click(1050, 15); // Any left click completes; this click is consumed.
  await expect(page.locator(".tile-marked")).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 1, 2, 3]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 2]);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 2, 3]);
  await wave(1).click({ button: "right" });
  await expect(page.locator(".tile-marked")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".tile-marked")).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 1, 2, 3]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 2]);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});
