import { test, expect } from "@playwright/test";
import { ready, settingsSection } from "./controls";

test("temporal and directional controls reach Rust without coupling spatial settings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const replies: any[] = [];
    Object.assign(window, { analysisSettingsReplies: replies });
    const Base = Worker;
    window.Worker = class extends Base {
      requests = new Map<number, any>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }) => {
          const settings = this.requests.get(data.id);
          if (settings && data.data?.ac) {
            replies.push({
              window: settings.acWindow,
              bin: settings.acBinMs,
              bins: data.data.ac.length,
              dirBin: settings.dirBin,
              dirSmooth: settings.dirSmooth,
              spatialBin: settings.binCm,
              spatialSmooth: settings.smooth,
              direction: [...data.data.direction],
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
  const latest = () => page.evaluate(() => (window as any).analysisSettingsReplies.at(-1));
  await expect
    .poll(latest)
    .toMatchObject({ window: 1000, bin: 5, bins: 200, dirBin: 6, dirSmooth: 1 });
  const direction = (await latest()).direction;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Temporal autocorrelogram");
  await page.getByRole("slider", { name: "Temporal bin width", exact: true }).fill("10");
  await expect.poll(latest).toMatchObject({ window: 1000, bin: 10, bins: 100 });
  await page.getByRole("slider", { name: "Autocorrelation window", exact: true }).fill("20");
  await page.getByRole("slider", { name: "Temporal bin width", exact: true }).fill("50");
  await expect.poll(latest).toMatchObject({ window: 20, bin: 50, bins: 1 });
  await expect(page.locator('.cell-tile[data-cell="1"] .tile-ac canvas')).toBeVisible();

  await settingsSection(page, "Spatial rate map");
  await page.getByRole("slider", { name: "Boxcar radius", exact: true }).fill("3");
  await expect.poll(latest).toMatchObject({ spatialSmooth: 3, dirSmooth: 1 });
  expect((await latest()).direction).toEqual(direction);
  await settingsSection(page, "Directional rate map");
  await page.getByRole("slider", { name: "Directional boxcar radius", exact: true }).fill("0");
  await expect.poll(latest).toMatchObject({ dirBin: 6, dirSmooth: 0, spatialSmooth: 3 });
  expect((await latest()).direction).not.toEqual(direction);
  await page.getByRole("slider", { name: "Direction bin width", exact: true }).fill("10");
  await expect.poll(latest).toMatchObject({ dirBin: 10, dirSmooth: 0, spatialSmooth: 3 });
  expect((await latest()).direction).toHaveLength(36);
});
