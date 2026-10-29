import { test, expect, type Page } from "@playwright/test";
import { ready } from "./controls";

async function fixture(page: Page) {
  const n = 100;
  const raw = Buffer.alloc(n * 216);
  for (let i = 0; i < n; i++) {
    for (let channel = 0; channel < 4; channel++) {
      raw.writeUInt32BE((i + 1) * 960, i * 216 + channel * 54);
      raw.fill(i < 5 ? 32 : 224, i * 216 + channel * 54 + 4, i * 216 + channel * 54 + 54);
    }
  }
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "wave-density.1",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          `num_spikes ${n}\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
        ),
        raw,
      ]),
    },
    {
      name: "wave-density_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from(
        `Exact_cut_for: wave-density spikes: ${n}\n${Array.from({ length: n }, (_, i) => (i < 1 ? 1 : i < 5 ? 2 : 3)).join(" ")}\n`,
      ),
    },
  ]);
  await ready(page);
  await expect(page.locator(".tile-wave-canvas")).toHaveAttribute("data-density", "ready");
}

for (const format of ["float", "half-float", "byte"]) {
  test(`wave density uses v1's tetrode scale (${format})`, async ({ page }) => {
    if (format !== "float") {
      await page.addInitScript((format) => {
        const get = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function (name: string) {
          return name === "EXT_float_blend" ||
            (format === "byte" && name === "EXT_color_buffer_float")
            ? null
            : get.call(this, name);
        };
      }, format);
    }
    await fixture(page);
    const pixels = (cell: number) =>
      page.locator(".tile-wave-canvas").evaluate((element, cell) => {
        const canvas = element as HTMLCanvasElement;
        const frame = document.querySelector<HTMLElement>(
          `.cell-tile[data-cell="${cell}"] .tile-waves`,
        )!;
        const box = frame.getBoundingClientRect();
        const area = canvas.getBoundingClientRect();
        const dpr = canvas.width / area.width;
        // A horizontal waveform at +32 ADC units lies 3/8 down the frame.
        const x = Math.round(
          (box.left - area.left + 2 + Number(frame.dataset.plotWidth) / 8) * dpr,
        );
        const y = Math.round(
          (box.top - area.top + (Number(frame.dataset.plotHeight) * 3) / 8) * dpr,
        );
        const pixels = new Uint8Array(3 * 5 * 4);
        canvas
          .getContext("webgl2")!
          .readPixels(
            x - 1,
            canvas.height - y - 3,
            3,
            5,
            WebGL2RenderingContext.RGBA,
            WebGL2RenderingContext.UNSIGNED_BYTE,
            pixels,
          );
        return [...pixels];
      }, cell);
    const contains = (pixels: number[], rgb: number[]) =>
      pixels.some((_, i) => i % 4 === 0 && rgb.every((v, ch) => Math.abs(pixels[i + ch] - v) <= 1));
    // v1's sqrt(10 * overlaps / total tetrode spikes), using its exact ramp:
    // one overlapping spike out of 100, and four overlapping spikes out of 100.
    await expect.poll(async () => contains(await pixels(1), [187, 161, 81])).toBe(true);
    await expect.poll(async () => contains(await pixels(2), [135, 187, 161])).toBe(true);
    expect(
      await page
        .locator(".tile-wave-canvas")
        .evaluate((c) => (c as HTMLCanvasElement).getContext("webgl2")!.getError()),
    ).toBe(0);

    if (format === "float") {
      // Floating copies use the same tetrode scale as the live wall.
      await page.keyboard.down("Space");
      await page.locator('.cell-tile[data-cell="1"] .tile-waves').click();
      await page.keyboard.up("Space");
      const copy = page.locator(".tile-copy .plot-copy");
      await expect(copy).toBeVisible();
      const capture = await copy.evaluate(async (element) => {
        const image = element as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(0, 0, canvas.width, canvas.height).data];
      });
      expect(contains(capture, [187, 161, 81])).toBe(true);
    }
  });
}
