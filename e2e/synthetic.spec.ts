import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ready, exportCut } from "./controls";

test("mock recording files can be dragged into the app", async ({ page }) => {
  await page.goto("/?demo=quick");
  await expect(page.locator(".demo-file-card")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Explore a synthetic demo", exact: true })
    .dragTo(page.locator(".start-drop h1"));
  await ready(page);
  await expect(
    page.getByRole("group", { name: "Recording details", exact: true }),
  ).toContainText("18,000");
  await expect(page.locator(".toolbar-status")).not.toContainText(
    "Local files",
  );
});

test("the default demo generates nine million spikes and 100 cells; merge/undo preserves every exported assignment", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Explore a synthetic demo", exact: true }),
  ).toContainText("9 million spikes");
  const start = Date.now();
  await page
    .getByRole("button", { name: "Explore a synthetic demo", exact: true })
    .click();
  await ready(page, 120000);
  console.log(`Generated 9M demo ready: ${Date.now() - start}ms`);
  await expect(page.locator(".toolbar-status")).toContainText("9,000,000");
  await expect(page.locator(".trial-block")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Focus cell 100", exact: true }),
  ).toHaveCount(1);
  const hashExport = async () => {
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      exportCut(page),
    ]);
    return createHash("sha256")
      .update(await readFile((await file.path())!))
      .digest("hex");
  };
  const before = await hashExport();
  await page.getByLabel("Destination cell", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  await ready(page);
  await expect(
    page.getByRole("button", { name: "Focus cell 1", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await ready(page);
  expect(await hashExport()).toBe(before);
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  await page.getByRole("button", { name: "01", exact: true }).click();
  await ready(page);
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
