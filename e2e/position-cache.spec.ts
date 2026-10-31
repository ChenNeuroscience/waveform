import { settingsSection, ready } from "./controls";
import { test, expect } from "@playwright/test";

test("tetrode switches preserve position canvases without redrawing the speed histogram", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: string[] = [];
    Object.assign(window, { positionRequests: requests });
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width")!;
    Object.defineProperty(HTMLCanvasElement.prototype, "width", {
      ...width,
      set(value: number) {
        if (this === (window as any).originalSpeedCanvas) (window as any).speedDraws++;
        width.set!.call(this, value);
      },
    });
    const Base = window.Worker;
    window.Worker = class extends Base {
      override postMessage(message: any) {
        requests.push(message.type);
        super.postMessage(message);
      }
    };
  });
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const path = page.locator(".position-path canvas");
  const speed = page.locator(".position-speed canvas");
  await expect(path).toBeVisible();
  await expect(speed).toBeVisible();
  // Settle the initial ResizeObserver draw before counting actual repaints.
  const originalSpeed = await speed.evaluate(async (canvas) => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    Object.assign(window, { originalSpeedCanvas: canvas, speedDraws: 0 });
    return (canvas as HTMLCanvasElement).toDataURL();
  });
  const original = await path.evaluate((canvas) => {
    Object.assign(window, { originalPathCanvas: canvas });
    return (canvas as HTMLCanvasElement).toDataURL();
  });
  const requests = () =>
    page.evaluate(
      () => (window as any).positionRequests.filter((t: string) => t === "trajectory").length,
    );
  await expect.poll(requests).toBe(1);

  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  await expect(page.getByRole("button", { name: "02", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Wait for the new tetrode's cell analysis, then another cell's analysis.
  for (const cell of [1, 2]) {
    await page.locator(`.cell-tile[data-cell="${cell}"]`).hover();
    await expect(page.locator(".position-path")).toHaveAttribute("data-cell", String(cell));
    expect(await speed.evaluate((c) => c === (window as any).originalSpeedCanvas)).toBe(true);
    expect(await speed.evaluate((c) => (c as HTMLCanvasElement).toDataURL())).toBe(originalSpeed);
    expect(await page.evaluate(() => (window as any).speedDraws)).toBe(0);
  }
  await page.locator(".desktop-toolbar").hover();
  expect(await path.evaluate((canvas) => canvas === (window as any).originalPathCanvas)).toBe(true);
  expect(await requests()).toBe(1);
  await expect
    .poll(() => path.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL()))
    .toBe(original);

  // A different trial must still fetch and draw its own path.
  await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
  await ready(page);
  await expect.poll(requests).toBe(2);
  await expect(path).toBeVisible();
  await expect
    .poll(() => path.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL()))
    .not.toBe(original);

  await expect(speed).toBeVisible();
  expect(await speed.evaluate((c) => c === (window as any).originalSpeedCanvas)).toBe(false);
  const trialSpeed = await speed.evaluate((c) => (c as HTMLCanvasElement).toDataURL());

  // A speed-binning change must invalidate the histogram even within one trial.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Speed tuning");
  await page.getByRole("slider", { name: "Speed bin width", exact: true }).fill("8");
  await expect(speed).toBeVisible();
  await expect
    .poll(() => speed.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL()))
    .not.toBe(trialSpeed);
});
