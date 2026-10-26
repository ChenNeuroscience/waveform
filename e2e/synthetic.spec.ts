import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ready, exportCut } from "./controls";

test("the simulated-files card starts the demo on click", async ({ page }) => {
  await page.goto("/?demo=quick");
  await expect(page.locator(".demo-file-card")).toHaveCount(3);
  await expect(page.locator(".demo-files")).toHaveAttribute(
    "draggable",
    "false",
  );
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page);
  await expect(
    page.getByRole("group", { name: "Recording details", exact: true }),
  ).toContainText("18,000");
  await expect(page.locator(".toolbar-status")).not.toContainText(
    "Local files",
  );
});

test("the stress demo generates nine million spikes and 100 cells; merge/undo preserves every exported assignment", async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?demo=stress");
  await expect(
    page.getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    }),
  ).toContainText("9 million spikes");
  const start = Date.now();
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page, 120000);
  console.log(`Generated 9M demo ready: ${Date.now() - start}ms`);
  await expect(page.locator(".toolbar-status")).toContainText("9,000,000");
  await expect(page.locator(".trial-block")).toHaveCount(5);
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

test("the normal demo is a twenty-minute box experiment with typical spike and cell counts", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".demo-files")).toContainText(
    "~50k spikes/tetrode",
  );
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page);
  await expect(page.locator(".toolbar-status")).toContainText("50,000");
  await expect(page.locator(".position-time")).toContainText("20 min 0 sec");
  await expect(page.locator(".trial-block")).toHaveCount(5);
  for (const trial of await page.locator(".trial-block").all())
    await expect(trial.locator(".tetrode-file-block")).toHaveCount(8);
  await expect(
    page.getByRole("button", { name: "Focus cell 24", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Focus cell 25", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/simulated-box-experiment.png" });
});
