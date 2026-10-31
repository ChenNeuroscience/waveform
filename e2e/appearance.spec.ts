import { settingsSection, ready } from "./controls";
import { test, expect, type Page } from "@playwright/test";

async function demo(page: Page) {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
}

test("feature corner labels survive Space copies; settings and divider positions restore and fit smaller screens", async ({
  page,
}) => {
  await demo(page);
  // The density composite uses a full-grid viewport; inspect the point pass here.
  await page.getByRole("button", { name: "Fixed colours", exact: true }).click();
  const labels = page.locator(".projection-labels > div");
  await expect(labels).toHaveCount(6);
  await expect(labels.first().locator(".axis-y")).toHaveText("A2");
  await expect(labels.first().locator(".axis-x")).toHaveText("A1");
  const grip = (await page.locator(".desktop-splitter").boundingBox())!;
  await page.mouse.move(grip.x + 3, grip.y + 60);
  await page.mouse.down();
  await page.mouse.move(600, grip.y + 60);
  await page.mouse.up();
  await expect(page.locator(".clusters")).toHaveAttribute("data-columns", "4");
  const frame = await page.locator(".clusters canvas").evaluate((el) => {
    const gl = (el as HTMLCanvasElement).getContext("webgl2")!;
    return Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array);
  });
  expect(frame[2]).toBe(frame[3]);
  await page.keyboard.down("Space");
  await page.locator(".feature-stage").click({ position: { x: 50, y: 50 } });
  await page.keyboard.up("Space");
  // Both corner labels must be drawn into the PNG, even where the raw GPU canvas is blank.
  const labelInk = await page.locator(".plot-copy").evaluate(async (el) => {
    const image = el as HTMLImageElement;
    await image.decode();
    const c = document.createElement("canvas");
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const ink = (x: number, y: number) => {
      const a = ctx.getImageData(x, y, 20, 13).data;
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] < 150 && a[i + 1] < 150 && a[i + 2] < 150) n++;
      return n;
    };
    return [ink(2, 2), ink(106, 113)];
  });
  for (const ink of labelInk) expect(ink).toBeGreaterThan(5);
  const png = await page.locator(".plot-copy").getAttribute("src");
  await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
  await ready(page);
  expect(await page.locator(".plot-copy").getAttribute("src")).toBe(png);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page
    .getByRole("button", { name: "Waveforms", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Speed tuning");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await page.getByRole("slider", { name: "Maximum speed shown", exact: true }).fill("60");
  const window = (await settings.boundingBox())!;
  await page.mouse.move(window.x + 50, window.y + 12);
  await page.mouse.down();
  await page.mouse.move(1100, 140, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("waveform-ui:panes") || "{}").left),
    )
    .toBe(600);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("waveform-ui:window:settings") || "{}").x,
      ),
    )
    .toBeGreaterThan(800);
  await page.setViewportSize({ width: 900, height: 650 });
  await page.reload();
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const left = (await page.locator(".left-workspace").boundingBox())!;
  expect(left.width).toBe(563);
  await expect(page.getByRole("button", { name: "Waveforms", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Speed tuning");
  await expect(page.getByRole("slider", { name: "Maximum speed shown", exact: true })).toHaveValue(
    "60",
  );
  const restored = (await settings.boundingBox())!;
  expect(restored.x + restored.width).toBeLessThanOrEqual(900);
  expect(restored.y + restored.height).toBeLessThanOrEqual(650);
});
