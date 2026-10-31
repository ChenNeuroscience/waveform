import { settingsSection, ready } from "./controls";
import { test, expect } from "@playwright/test";

test("position bases survive tetrode changes and invalidate for trials and speed binning", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { positionRequests: [], speedBinningRequests: [], speedDraws: 0 });
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width")!;
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
      ...width,
      set(value: number) {
        if (this === (window as any).watchedSpeedCanvas) (window as any).speedDraws++;
        width.set!.call(this, value);
        if (this.matches(".position-speed canvas"))
          Object.assign(window, { drawnSpeedCanvas: this });
      },
    });
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      source: CanvasImageSource,
      ...args: number[]
    ) {
      const result = Reflect.apply(draw, this, [source, ...args]);
      if (
        this.canvas instanceof HTMLCanvasElement &&
        this.canvas.matches(".position-path canvas")
      ) {
        Object.assign(window, { drawnPathBase: source });
      }
      return result;
    };
    const Base = Worker;
    window.Worker = class extends Base {
      override postMessage(message: any) {
        (window as any).positionRequests.push(message.type);
        if (message.type === "analysis")
          (window as any).speedBinningRequests.push(message.settings.speedBin);
        super.postMessage(message);
      }
    };
  });
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const path = page.locator(".position-path canvas");
  const speed = page.locator(".position-speed canvas");
  await expect.poll(() => page.evaluate(() => !!(window as any).drawnPathBase)).toBe(true);
  await speed.evaluate(async (canvas) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    Object.assign(window, {
      originalSpeedCanvas: canvas,
      watchedSpeedCanvas: canvas,
      speedDraws: 0,
      originalPathBase: (window as any).drawnPathBase,
    });
  });
  const requests = () =>
    page.evaluate(
      () => (window as any).positionRequests.filter((t: string) => t === "trajectory").length,
    );
  await expect.poll(requests).toBe(1);
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  for (const cell of [1, 2]) {
    await page.locator(`.cell-tile[data-cell="${cell}"]`).hover();
    await expect(page.locator(".position-path")).toHaveAttribute("data-cell", String(cell));
    expect(await speed.evaluate((c) => c === (window as any).originalSpeedCanvas)).toBe(true);
    expect(await page.evaluate(() => (window as any).speedDraws)).toBe(0);
    expect(
      await page.evaluate(() => (window as any).drawnPathBase === (window as any).originalPathBase),
    ).toBe(true);
  }
  expect(await requests()).toBe(1);
  await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
  await ready(page);
  await expect.poll(requests).toBe(2);
  // The rendered base must change identity even when two trajectories happen
  // to rasterise identically. PNG inequality is not an invalidation guarantee.
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).drawnPathBase !== (window as any).originalPathBase),
    )
    .toBe(true);
  await expect(path).toBeVisible();
  expect(await speed.evaluate((c) => c === (window as any).originalSpeedCanvas)).toBe(false);
  await speed.evaluate(async (canvas) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    Object.assign(window, { watchedSpeedCanvas: canvas, speedDraws: 0 });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Speed tuning");
  await page.getByRole("slider", { name: "Speed bin width", exact: true }).fill("8");
  await expect
    .poll(() => page.evaluate(() => (window as any).speedBinningRequests.includes(8)))
    .toBe(true);
  await expect
    .poll(() => speed.evaluate((c) => c !== (window as any).watchedSpeedCanvas))
    .toBe(true);
  await expect.poll(() => speed.evaluate((c) => c === (window as any).drawnSpeedCanvas)).toBe(true);
});
