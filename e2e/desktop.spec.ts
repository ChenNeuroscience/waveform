import { ready, exportCut, setDensity } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeCut } from "../tests/wasm";
import { waveX, waveY } from "../src/plot-geometry";
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
test("original desktop dimensions, nested cuts and independent floating tools", async ({
  page,
}) => {
  await fixture(page);
  const left = page.locator(".left-workspace");
  expect((await left.boundingBox())!.width).toBe(350);
  const block = page.locator(".tetrode-file-block");
  await expect(block.getByRole("button", { name: "~_1.cut", exact: true })).toBeVisible();
  await expect(block.getByRole("button", { name: "~.clu.1", exact: true })).toBeVisible();
  const grip = (await page.locator(".desktop-splitter").boundingBox())!;
  await page.mouse.move(grip.x + 3, grip.y + 50);
  await page.mouse.down();
  await page.mouse.move(30, grip.y + 50);
  await page.mouse.up();
  expect((await left.boundingBox())!.width).toBe(240);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "File headers", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const headers = page.getByRole("dialog", {
    name: "File headers",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect(headers).toBeVisible();
  await expect(settings).toHaveAttribute("aria-modal", "false");
  const before = (await headers.boundingBox())!;
  await page.mouse.move(before.x + 70, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + 300, before.y + 150, { steps: 8 });
  await page.mouse.up();
  const after = (await headers.boundingBox())!;
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(30);
  const b = (await settings.boundingBox())!;
  await page.mouse.move(b.x + b.width - 3, b.y + b.height - 3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 80, b.y + b.height + 40);
  await page.mouse.up();
  expect((await settings.boundingBox())!.width).toBeGreaterThan(b.width + 30);
  await page.screenshot({ path: "test-results/floating-tools.png" });
});
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
  await expect(page.locator(".split-pair")).toHaveCount(2);
  await expect(page.locator(".split-muted")).toHaveCount(1);
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
  await expect(page.locator(".split-pair")).toHaveCount(2);
  await expect(page.locator(".tile-wall")).toHaveAttribute("data-splitting", "1");
  await expect(
    page.locator('.cell-tile[data-cell="2"] .tile-caption .stat-value').last(),
  ).toHaveText("1");
  await page.screenshot({ path: "test-results/split-mode.png" });
  await page.mouse.click(1050, 15); // Any left click completes; this click is consumed.
  await expect(page.locator(".split-pair")).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 1, 2, 3]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 2]);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 2, 3]);
  await wave(1).click({ button: "right" });
  await expect(page.locator(".split-pair")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator(".split-pair")).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 1, 2, 3]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 2]);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});
test("hover overlays and Space copies retain plots while navigating", async ({ page }) => {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const wave = page.locator('.cell-tile[data-cell="2"] .tile-waves');
  await wave.hover();
  await expect(page.locator(".position-path")).toHaveAttribute("data-cell", "2");
  await expect
    .poll(async () => +(await page.locator(".position-path").getAttribute("data-spikes"))!)
    .toBeGreaterThan(0);
  await page.keyboard.down("Space");
  await wave.click();
  await page.keyboard.up("Space");
  const copy = page.getByRole("dialog").filter({ has: page.locator(".plot-copy") });
  await expect(copy).toHaveCount(1);
  const src = await copy.locator("img").getAttribute("src");
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  expect(await copy.locator("img").getAttribute("src")).toBe(src);
  await expect(page.locator(".position-path")).toHaveAttribute("data-spikes", "0");
  await copy.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await page.keyboard.down("Space");
  await page.locator(".position-path").click();
  await page.keyboard.up("Space");
  const floating = (await page.getByRole("dialog").boundingBox())!;
  await page.mouse.move(floating.x + 70, floating.y + 12);
  await page.mouse.down();
  await page.mouse.move(1000, 120, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.down("Space");
  await page.locator(".feature-stage").click();
  await page.keyboard.up("Space");
  await expect(page.locator(".plot-copy")).toHaveCount(2);
  for (const c of await page.locator(".plot-copy").all())
    expect((await c.getAttribute("src"))!.length).toBeGreaterThan(1000);
  for (let i = 0; i < 2; i++)
    await page.getByRole("button", { name: "Close panel", exact: true }).first().click();
  await page.screenshot({ path: "test-results/desktop-wall.png" });
});

test("plot data keeps its proportions when panes and the window resize", async ({ page }) => {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const viewport = async () =>
    page
      .locator(".clusters canvas")
      .evaluate((c) =>
        Array.from(
          (c as HTMLCanvasElement).getContext("webgl2")!.getParameter(0x0ba2) as Int32Array,
        ),
      );
  const waves = page.locator('.cell-tile[data-cell="1"] .tile-waves');
  const before = (await waves.boundingBox())!;
  expect(before.width / 124).toBe(4);
  const a = await viewport();
  expect(a[2]).toBe(a[3]);
  const grip = (await page.locator(".desktop-splitter").boundingBox())!;
  await page.mouse.move(grip.x + 3, grip.y + 80);
  await page.mouse.down();
  await page.mouse.move(600, grip.y + 80);
  await page.mouse.up();
  await expect
    .poll(async () => (await page.locator(".left-workspace").boundingBox())!.width)
    .toBe(600);
  await expect
    .poll(async () => {
      const v = await viewport();
      return v[2] - v[3];
    })
    .toBe(0);
  expect((await waves.boundingBox())!.width).toBe(before.width);
  await setDensity(page, false);
  expect((await waves.boundingBox())!.width).toBe(before.width);
  await page.setViewportSize({ width: 1100, height: 760 });
  const b = await viewport();
  expect(b[2]).toBe(b[3]);
  await page.screenshot({ path: "test-results/plot-proportions.png" });
});

test("tiles wrap at their plot width, with details only on hover and no selection checkboxes", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const tile = (cell: number) => page.locator(`.cell-tile[data-cell="${cell}"]`);
  const initial = (await tile(0).boundingBox())!;
  await page
    .getByRole("button", { name: "Waveforms", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await tile(0).boundingBox())!.width).toBeLessThan(initial.width);
  const a = (await tile(0).boundingBox())!,
    b = (await tile(1).boundingBox())!;
  expect(a.y).toBe(b.y);
  expect(b.x).toBeGreaterThan(a.x + a.width);
  expect(b.width).toBe(a.width);
  await expect(page.locator(".cell-tile input[type=checkbox]")).toHaveCount(0);
  await page.locator(".desktop-toolbar").hover();
  await expect(tile(0).locator(".tile-caption")).toBeHidden();
  await tile(0).hover();
  await expect(tile(0).locator(".tile-caption")).toBeVisible();
  expect(
    await tile(0)
      .locator(".tile-caption")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(14);
  await expect(tile(1).locator(".tile-caption")).toBeHidden();
  await page.screenshot({ path: "test-results/wrapped-tiles.png" });
  await page
    .getByRole("button", { name: "Spatial rate", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await tile(0).boundingBox())!.width).toBeLessThan(a.width);
  for (const name of ["Head direction", "Speed", "Autocorrelation"])
    await page.getByRole("button", { name, exact: true }).click({ modifiers: ["Shift"] });
  await page
    .getByRole("button", { name: "Waveforms", exact: true })
    .click({ modifiers: ["Shift"] });
  const size = (await tile(0).boundingBox())!;
  expect(size.width).toBeLessThan(initial.width);
  expect((await tile(1).boundingBox())!.y).toBe(size.y);
  await expect(page.locator(".tile-wave-canvas")).toHaveAttribute("data-density", "ready");
  await page.screenshot({ path: "test-results/wrapped-waveforms.png" });
});

test("flag waveforms retain their exact pixels through repeated density switches", async ({
  page,
}) => {
  await fixture(page);
  await setDensity(page, false);
  const image = () =>
    page.locator(".tile-wave-canvas").evaluate((el) => {
      const c = el as HTMLCanvasElement,
        gl = c.getContext("webgl2")!;
      const pixels = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let raised = 0;
      for (let y = 10; y < 45; y++)
        for (let x = 2; x < 120; x++) {
          const i = ((c.height - 1 - y) * c.width + x) * 4;
          if (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240) raised++;
        }
      return { png: c.toDataURL(), raised, error: gl.getError() };
    });
  await expect.poll(async () => (await image()).raised).toBeGreaterThan(5);
  const original = await image();
  expect(original.error).toBe(0);
  for (let i = 0; i < 3; i++) {
    await setDensity(page, true);
    await expect(page.locator(".tile-wave-canvas")).toHaveAttribute("data-density", "ready");
    await expect.poll(async () => (await image()).png).not.toBe(original.png);
    await setDensity(page, false);
    await expect.poll(async () => (await image()).png).toBe(original.png);
    expect((await image()).error).toBe(0);
  }
});
