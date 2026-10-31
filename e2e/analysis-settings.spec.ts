import { test, expect } from "@playwright/test";
import { ready, settingsSection } from "./controls";

test("temporal bins and window update both the worker and displayed correlograms", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const replies: { window: number; bin: number; length: number }[] = [];
    Object.assign(window, { temporalAnalyses: replies });
    const Base = Worker;
    window.Worker = class extends Base {
      requests = new Map<number, { acWindow: number; acBinMs: number }>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }) => {
          const settings = this.requests.get(data.id);
          if (settings && data.data?.ac) {
            replies.push({
              window: settings.acWindow,
              bin: settings.acBinMs,
              length: data.data.ac.length,
            });
            this.requests.delete(data.id);
          }
        });
      }
      override postMessage(message: any) {
        if (message.type === "analysis") this.requests.set(message.id, message.settings);
        super.postMessage(message);
      }
    };
  });
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const analyses = () => page.evaluate(() => (window as any).temporalAnalyses);
  await expect.poll(analyses).toContainEqual({ window: 1000, bin: 5, length: 200 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Temporal autocorrelogram");
  const windowSlider = page.getByRole("slider", { name: "Autocorrelation window", exact: true });
  const binSlider = page.getByRole("slider", { name: "Temporal bin width", exact: true });
  await expect(windowSlider).toHaveValue("1000");
  await expect(binSlider).toHaveValue("5");
  await binSlider.fill("10");
  await expect.poll(analyses).toContainEqual({ window: 1000, bin: 10, length: 100 });
  await windowSlider.fill("20");
  await binSlider.fill("50");
  await expect.poll(analyses).toContainEqual({ window: 20, bin: 50, length: 1 });
  const ac = page.locator('.cell-tile[data-cell="1"] .tile-ac canvas');
  await expect
    .poll(() =>
      ac.evaluate((canvas) => {
        const c = canvas as HTMLCanvasElement;
        const pixels = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] > pixels[i + 1] + 20 && pixels[i] > pixels[i + 2] + 20) red++;
        return red;
      }),
    )
    .toBeGreaterThan(10);
  await page.screenshot({ path: "test-results/temporal-settings.png" });
});

test("directional smoothing and angular bins change independently of spatial settings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const replies: { bin: number; smooth: number; spatialSmooth: number; values: number[] }[] = [];
    Object.assign(window, { directionalAnalyses: replies });
    const Base = Worker;
    window.Worker = class extends Base {
      requests = new Map<number, any>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }) => {
          const settings = this.requests.get(data.id);
          if (settings && data.data?.direction) {
            replies.push({
              bin: settings.dirBin,
              smooth: settings.dirSmooth,
              spatialSmooth: settings.smooth,
              values: [...data.data.direction],
            });
            this.requests.delete(data.id);
          }
        });
      }
      override postMessage(message: any) {
        if (message.type === "analysis" && message.cell === 1)
          this.requests.set(message.id, message.settings);
        super.postMessage(message);
      }
    };
  });
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const latest = () => page.evaluate(() => (window as any).directionalAnalyses.at(-1));
  await expect.poll(latest).toMatchObject({ bin: 6, smooth: 1, spatialSmooth: 1 });
  const before = (await latest()).values;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Spatial rate map");
  await page.getByRole("slider", { name: "Boxcar radius", exact: true }).fill("3");
  await expect.poll(latest).toMatchObject({ bin: 6, smooth: 1, spatialSmooth: 3 });
  expect((await latest()).values).toEqual(before);
  await settingsSection(page, "Directional rate map");
  await page.getByRole("slider", { name: "Directional boxcar radius", exact: true }).fill("0");
  await expect.poll(latest).toMatchObject({ bin: 6, smooth: 0, spatialSmooth: 3 });
  expect((await latest()).values).not.toEqual(before);
  await page.getByRole("slider", { name: "Direction bin width", exact: true }).fill("10");
  await expect.poll(latest).toMatchObject({ bin: 10, smooth: 0, spatialSmooth: 3 });
  expect((await latest()).values).toHaveLength(36);
  await page.screenshot({ path: "test-results/directional-settings.png" });
});
