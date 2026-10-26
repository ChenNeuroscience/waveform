import { ready, exportCut } from "./controls";
import { test, expect } from "@playwright/test";
test("demo imports, exact cut edits survive switching, undo/redo and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByText("Explore a synthetic demo").click();
  await ready(page, 30000);
  await expect(page.getByText("18,000", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/workspace.png", fullPage: true });
  const count = await page
    .getByRole("button", { name: "Select cell 1", exact: true })
    .textContent();
  await page.getByLabel("Destination cell", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".tile-wall").evaluate((el) => (el.scrollTop = 0));
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveText(count!);
  await page.getByLabel("Destination cell", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await ready(page);
  await page.locator(".tile-wall").evaluate((el) => (el.scrollTop = 0));
  await expect(
    page.getByRole("button", { name: "Select cell 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".tile-wall").evaluate((el) => (el.scrollTop = 0));
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveText(count!);
  await expect(page.locator(".tile-wave-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "01", exact: true }).click();
  await ready(page);
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".tile-wall").evaluate((el) => (el.scrollTop = 0));
  await expect(
    page.getByRole("button", { name: "Select cell 1", exact: true }),
  ).toHaveText(count!);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportCut(page),
  ]);
  expect(download.suggestedFilename()).toBe("demo_linear-track_1.cut");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Spatial bin width", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page
    .getByRole("button", { name: "Head direction", exact: true })
    .click();
  await expect(page.locator(".tile-wave-canvas")).toBeVisible();
  await page.keyboard.down("Space");
  await page.locator('.cell-tile[data-cell="1"] .tile-waves').click();
  await page.keyboard.up("Space");
  await expect(page.locator(".plot-copy")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit history", exact: true }).click();
  await page
    .getByRole("button", { name: "Duplicate cut", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Edit history", exact: true })
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "~_1 edited 2.cut", exact: true }),
  ).toBeVisible();
  await ready(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("production assets and Wasm load under the GitHub Pages subpath", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/waveform/");
  await page.getByText("Explore a synthetic demo").click();
  await ready(page, 30000);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("18,000", { exact: true })).toBeVisible();
});
test("mobile welcome stays within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Browse files", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
});
