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

test("P and Shift+P cycle colour choices, D is unused, and Q switches waveform features", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const modes = page.getByRole("group", { name: "Colour mode", exact: true });
  const density = modes.getByRole("button", { name: "Density rendering", exact: true });
  const drift = modes.getByRole("button", {
    name: "Drift (colour by recording time)",
    exact: true,
  });
  const fixed = modes.getByRole("button", { name: "Fixed colours", exact: true });
  await expect(density).toHaveAttribute("aria-pressed", "true");
  const image = () =>
    page.locator(".clusters canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const original = await image();
  await page.keyboard.press("p");
  await expect(drift).toHaveAttribute("aria-pressed", "true");
  await expect.poll(image).not.toBe(original);
  await page.keyboard.press("d");
  await expect(drift).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("p");
  await expect(fixed).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("p");
  await expect(density).toHaveAttribute("aria-pressed", "true");
  await expect.poll(image).toBe(original);
  for (const previous of [fixed, drift, density]) {
    await page.keyboard.press("Shift+p");
    await expect(previous).toHaveAttribute("aria-pressed", "true");
  }
  await expect.poll(image).toBe(original);
  await expect(modes.locator('[aria-pressed="true"]')).toHaveCount(1);
  await page.keyboard.press("q");
  await expect(
    page.locator('.clusters[data-features="pca"][data-colour-mode="density"]'),
  ).toBeVisible();
  await page
    .locator(".feature-group-heading")
    .screenshot({ path: "test-results/aligned-feature-controls.png" });
  await page.screenshot({ path: "test-results/cluster-density-pca.png" });
  await page.keyboard.press("q");
  await expect(page.locator('.clusters[data-features="amplitudes"]')).toBeVisible();
});

test("cluster palette lock holds fixed colours while the main palette changes", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const lock = page.getByRole("button", { name: "Fixed cluster colours", exact: true });
  const clusters = page.locator(".clusters");
  const waves = page.locator(".tile-wave-canvas");
  const image = () =>
    clusters.locator("canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await expect(clusters).toHaveAttribute("data-colour-mode", "density");
  const densityImage = await image();
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await expect(clusters).toHaveAttribute("data-colour-mode", "fixed");
  await expect(waves).toHaveAttribute("data-colour-mode", "density");
  await expect.poll(image).not.toBe(densityImage);
  const fixedImage = await image();
  await page.keyboard.press("p");
  await expect(waves).toHaveAttribute("data-colour-mode", "drift");
  await expect(clusters).toHaveAttribute("data-colour-mode", "fixed");
  await expect.poll(image).toBe(fixedImage);
  await page.keyboard.press("q");
  await expect(clusters).toHaveAttribute("data-features", "pca");
  await expect(clusters).toHaveAttribute("data-colour-mode", "fixed");
  await page.keyboard.press("q");
  await expect(clusters).toHaveAttribute("data-features", "amplitudes");
  await expect.poll(image).toBe(fixedImage);
  await page.keyboard.press("Shift+p");
  await expect(waves).toHaveAttribute("data-colour-mode", "density");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("waveform-ui:cluster-fixed-colours")))
    .toBe("true");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await expect(clusters).toHaveAttribute("data-colour-mode", "density");
  await expect.poll(image).toBe(densityImage);
});

test("trial and tetrode choices use joined neutral controls; header text retains native copying", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const tets = page.getByRole("group", { name: "Tetrodes", exact: true });
  await tets.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  await expect(tets.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(tets.getByRole("button", { name: "02", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const trial = page.getByRole("button", { name: "demo_box-b 8", exact: true });
  await trial.click();
  await ready(page);
  await expect(trial).toHaveAttribute("aria-current", "true");
  expect(await trial.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("0px");
  const controls = await page.locator(".feature-group-heading").evaluate((el) => {
    const centre = (selector: string) => {
      const b = el.querySelector(selector)!.getBoundingClientRect();
      return b.y + b.height / 2;
    };
    return [
      centre(".feature-tools button"),
      centre(".painting-destination button"),
      centre(".source-chips button"),
      centre(".set-symbol"),
    ];
  });
  for (const value of controls) expect(Math.abs(value - controls[0])).toBeLessThanOrEqual(0.5);
  expect(
    await page.locator(".desktop-toolbar").evaluate((el) => getComputedStyle(el).userSelect),
  ).toBe("none");
  await page.getByRole("button", { name: "File headers", exact: true }).click();
  const entry = page
    .locator(".headers-list > div")
    .filter({ has: page.getByText("num_spikes", { exact: true }) })
    .locator("dd");
  await entry.dblclick({ position: { x: 8, y: 6 } });
  const text = await entry.textContent();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
});
