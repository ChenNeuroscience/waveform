import { test, expect, type Page } from "@playwright/test";
import { ready } from "./controls";

async function fixture(page: Page) {
  const n = 10000;
  const raw = Buffer.alloc(n * 216);
  for (let i = 0; i < n; i++) {
    const amplitude = i < 1 ? 20 : i < 5 ? 40 : i < 21 ? 60 : 120;
    for (let ch = 0; ch < 4; ch++) {
      raw.writeUInt32BE((i + 1) * 1000, i * 216 + ch * 54);
      raw[i * 216 + ch * 54 + 24] = amplitude;
    }
  }
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "density.1",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          `num_spikes ${n}\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 20\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
        ),
        raw,
      ]),
    },
    {
      name: "density_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from(`Exact_cut_for: density spikes: ${n}\n${Array(n).fill(1).join(" ")}\n`),
    },
  ]);
  await ready(page);
}

for (const fallback of [false, true]) {
  test(`cluster density counts overlaps with the waveform palette${fallback ? " without float extensions" : ""}`, async ({
    page,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        const get = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function (name: string) {
          return ["EXT_color_buffer_float", "EXT_float_blend"].includes(name)
            ? null
            : get.call(this, name);
        };
      });
    await fixture(page);
    const colours = () =>
      page.locator(".clusters canvas").evaluate((el) => {
        const source = el as HTMLCanvasElement;
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = source.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(source, 0, 0);
        const ratio = source.width / source.clientWidth;
        return [20, 40, 60].map((a) => {
          const x = Math.floor((2 + (0.035 + (0.93 * a) / 255) * 124) * ratio);
          const y = Math.floor((2 + (0.965 - (0.93 * a) / 255) * 124) * ratio);
          return [...ctx.getImageData(x - 1, y - 1, 3, 3).data];
        });
      });
    const matches = (pixels: number[], rgb: number[]) =>
      pixels.some((_, i) => i % 4 === 0 && rgb.every((v, ch) => Math.abs(pixels[i + ch] - v) <= 1));
    for (const [i, expected] of [
      [187, 161, 81],
      [135, 187, 161],
      [0, 0, 255],
    ].entries()) {
      await expect.poll(async () => matches((await colours())[i], expected)).toBe(true);
    }
    await page.getByRole("button", { name: "Fixed colours", exact: true }).click();
    await expect
      .poll(async () => (await colours()).every((p) => matches(p, [0, 0, 200])))
      .toBe(true);
    await page.getByRole("button", { name: "Density rendering", exact: true }).click();
    await expect.poll(async () => matches((await colours())[0], [187, 161, 81])).toBe(true);
    expect(
      await page
        .locator(".clusters canvas")
        .evaluate((c) => (c as HTMLCanvasElement).getContext("webgl2")!.getError()),
    ).toBe(0);
  });
}
