import { test, expect } from "@playwright/test";
import { ready } from "./controls";

test("tetrode switches preserve the path canvas and reuse the trial's trajectory", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: string[] = [];
    Object.assign(window, { positionRequests: requests });
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
  await expect(path).toBeVisible();
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
});
