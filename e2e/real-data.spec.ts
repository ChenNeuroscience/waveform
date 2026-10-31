import { destination } from "./controls";
import { ready, exportCut } from "./controls";
import { test, expect } from "@playwright/test";
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeCut as readCut } from "../tests/wasm";
test("user sample: three trials and sixteen tetrodes load without cuts", async ({ page }) => {
  const dir = process.env.WAVEFORM_SAMPLE_DIR;
  test.skip(!dir, "Set WAVEFORM_SAMPLE_DIR for private local sample validation.");
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=quick");
  const files = readdirSync(dir!)
    .filter((f) => /\.(set|pos|\d+)$/.test(f))
    .map((f) => resolve(dir!, f));
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles(files);
  await ready(page, 60000);
  await expect(
    page
      .getByRole("group", { name: "Recording details", exact: true })
      .getByText("289,129", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "16", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "Recording details", exact: true })
      .getByText("164,385", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "13062025b 16", exact: true }).click();
  await ready(page);
  await expect(
    page
      .getByRole("group", { name: "Recording details", exact: true })
      .getByText("382,880", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "01", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "Recording details", exact: true })
      .getByText("704,080", { exact: true }),
  ).toBeVisible();
  await destination(page, 1);
  await page.getByRole("button", { name: "Lasso cut", exact: true }).click();
  const plot = page.locator(".clusters"),
    box = (await plot.boundingBox())!;
  // Select a broad rectangle inside the first channel projection. All-population mask is independent of display LOD.
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 10, { steps: 5 });
  await page.mouse.move(box.x + 120, box.y + 120, { steps: 5 });
  await page.mouse.move(box.x + 10, box.y + 120, { steps: 5 });
  await page.mouse.move(box.x + 10, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Select cell 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select cell 1", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("nine million spikes and 100 cells: import, merge, undo and export", async ({ page }) => {
  const dir = process.env.WAVEFORM_STRESS_DIR;
  test.skip(
    !dir || !existsSync(resolve(dir, "stress.1")),
    "Generate fixtures with scripts/make-stress.mjs and set WAVEFORM_STRESS_DIR.",
  );
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=quick");
  const start = Date.now();
  await page
    .getByLabel("Import recording files", { exact: true })
    .setInputFiles([resolve(dir!, "stress.1"), resolve(dir!, "stress_1.cut")]);
  await ready(page, 120000);
  await expect(
    page
      .getByRole("group", { name: "Recording details", exact: true })
      .getByText("9,000,000", { exact: true }),
  ).toBeVisible();
  console.log(`9M browser first load: ${Date.now() - start}ms`);
  await page
    .locator('.cell-tile[data-cell="1"] .tile-waves')
    .dragTo(page.locator('.cell-tile[data-cell="2"] .tile-waves'));
  await expect(page.getByRole("button", { name: "Select cell 2", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select cell 1", exact: true })).toBeVisible();
  const [d] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
  expect(d.suggestedFilename()).toBe("stress_1.cut");
  const exported = await readCut(
    new File([await readFile((await d.path())!)], "stress_1.cut"),
    9_000_000,
  );
  const expected = new Uint16Array(9_000_000);
  for (let i = 0; i < expected.length; i++) expected[i] = i % 101;
  const hash = (a: Uint16Array) =>
    createHash("sha256").update(new Uint8Array(a.buffer)).digest("hex");
  expect(hash(exported)).toBe(hash(expected));
  expect(errors).toEqual([]);
});
