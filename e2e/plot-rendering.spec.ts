import { test, expect } from "@playwright/test";
import { ready, setDensity } from "./controls";
import { rateMapPalette } from "../src/palette";

test("waveforms use the tile's full height with and without analysis plots", async ({ page }) => {
  const record = Buffer.alloc(216);
  for (let channel = 0; channel < 4; channel++) {
    record.writeUInt32BE(96000, channel * 54);
    for (let sample = 0; sample < 50; sample++) {
      record.writeInt8(sample < 25 ? 126 : -126, channel * 54 + 4 + sample);
    }
  }
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles({
    name: "height.1",
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([
      Buffer.from(
        "num_spikes 1\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
      ),
      record,
    ]),
  });
  await ready(page);
  await setDensity(page, false);
  for (const wavesOnly of [false, true]) {
    if (wavesOnly) {
      await page.getByRole("button", { name: "Waveforms", exact: true }).click();
    }
    const canvas = page.locator(".tile-wave-canvas");
    await expect(canvas).toHaveAttribute("data-waves", "ready");
    const rows = await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2")!;
      const wave = document.querySelector<HTMLElement>(".tile-waves")!;
      const rect = canvas.getBoundingClientRect();
      const tile = wave.closest(".cell-tile")!.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      const width = Math.floor(Number(wave.dataset.plotWidth) * sx);
      const pixels = new Uint8Array(width * 4);
      const ink: number[] = [];
      for (let row = 0; row < tile.height; row++) {
        const y = canvas.height - 1 - Math.floor((tile.top - rect.top + row) * sy);
        gl.readPixels(
          Math.round((tile.left - rect.left) * sx),
          y,
          width,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        if (pixels.some((value, i) => i % 4 !== 3 && value < 240)) ink.push(row);
      }
      return {
        first: ink[0],
        last: ink[ink.length - 1],
        height: tile.height,
        top: wave.dataset.plotTop,
      };
    });
    expect(rows.top).toBe("0");
    expect(rows.first).toBeLessThanOrEqual(2);
    expect(rows.last).toBeGreaterThanOrEqual(rows.height - 3);
  }
  await page.screenshot({ path: "test-results/full-height-waveforms.png" });
});

test("spatial maps default to v1 colours and save, restore and reset custom steps", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const spatial = page.locator('.cell-tile[data-cell="1"] .tile-spatial canvas');
  await expect(spatial).toBeVisible();
  const colours = () =>
    spatial.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      const colours = new Set<string>();
      for (let i = 0; i < pixels.length; i += 4) {
        colours.add(`rgb(${pixels[i]},${pixels[i + 1]},${pixels[i + 2]})`);
      }
      return [...colours];
    });
  const checkPalette = async (steps: number) => {
    const palette = rateMapPalette(steps);
    await expect
      .poll(async () =>
        (await colours()).every(
          (colour) => colour === "rgb(255,255,255)" || palette.includes(colour),
        ),
      )
      .toBe(true);
    // A particular recording need not contain rates in every available colour bin.
    await expect
      .poll(async () => (await colours()).filter((colour) => palette.includes(colour)).length)
      .toBeGreaterThan(2);
  };
  await expect.poll(colours).toEqual(expect.arrayContaining(rateMapPalette()));
  await checkPalette(5);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const steps = page.getByRole("slider", { name: "Rate-map colour steps", exact: true });
  await expect(steps).toHaveValue("5");
  await steps.fill("9");
  await checkPalette(9);
  await expect
    .poll(async () =>
      (await colours()).some(
        (colour) => rateMapPalette(9).includes(colour) && !rateMapPalette().includes(colour),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("waveform-desktop-settings") || "{}").rateMapSteps,
      ),
    )
    .toBe(9);
  await page.reload();
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(steps).toHaveValue("9");
  await checkPalette(9);
  await page.getByRole("button", { name: "Reset settings", exact: true }).click();
  await expect(steps).toHaveValue("5");
  await expect.poll(colours).toEqual(expect.arrayContaining(rateMapPalette()));
  await checkPalette(5);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.screenshot({ path: "test-results/v1-rate-map-palette.png" });
});
