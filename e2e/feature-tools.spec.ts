import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeCut } from "../tests/wasm";
import { ready, exportCut } from "./controls";
async function fixture(page: Page) {
  const bytes = Buffer.alloc(3 * 216);
  for (let i = 0; i < 3; i++)
    for (let c = 0; c < 4; c++) {
      const p = i * 216 + c * 54;
      bytes.writeUInt32BE((i + 1) * 96000, p);
      bytes[p + 18] = [
        [20, 40, 30, 50],
        [60, 70, 90, 80],
        [100, 110, 120, 100],
      ][i][c];
    }
  await page.goto("/");
  await page
    .getByLabel("Import recording files", { exact: true })
    .setInputFiles([
      {
        name: "paint.1",
        mimeType: "application/octet-stream",
        buffer: Buffer.concat([
          Buffer.from(
            "num_spikes 3\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
          ),
          bytes,
        ]),
      },
      {
        name: "paint_1.cut",
        mimeType: "text/plain",
        buffer: Buffer.from("Exact_cut_for: paint spikes: 3\n1 1 2\n"),
      },
    ]);
  await ready(page);
}
async function labels(page: Page) {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    exportCut(page),
  ]);
  return [
    ...(await decodeCut(
      new File([await readFile((await file.path())!)], "paint_1.cut"),
      3,
    )),
  ];
}
test("paint is the default; spaced projections paint/lasso the right axes and ignore gaps", async ({
  page,
}) => {
  await fixture(page);
  const paint = page.getByRole("button", {
    name: "Paint source spikes",
    exact: true,
  });
  await expect(paint).toHaveClass(/active/);
  await expect(
    page.getByRole("button", { name: "Select", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "Lasso cut", exact: true })
      .locator(".lucide-lasso"),
  ).toHaveCount(1);
  const plots = page.locator(".projection-labels > div"),
    first = (await plots.nth(0).boundingBox())!,
    second = (await plots.nth(1).boundingBox())!;
  expect(second.x - first.x - first.width).toBe(4);
  expect(first.width).toBe(128);
  expect(first.height).toBe(128);
  for (const p of await plots.all()) {
    expect(
      await p.evaluate((el) =>
        ["Top", "Right", "Bottom", "Left"].map((side) =>
          getComputedStyle(el).getPropertyValue(
            `border-${side.toLowerCase()}-width`,
          ),
        ),
      ),
    ).toEqual(["1px", "1px", "1px", "1px"]);
  }
  await page.getByLabel("Destination cell", { exact: true }).fill("3");
  await page.mouse.click(first.x + first.width + 2, first.y + 60);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  // Known amplitudes (A1=20, A3=30) in the second projection; one brush dab.
  await page.mouse.click(
    second.x + 2 + (0.035 + (0.93 * 20) / 255) * 124,
    second.y + 2 + (0.965 - (0.93 * 30) / 255) * 124,
  );
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  expect(await labels(page)).toEqual([3, 1, 2]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await ready(page);
  await page.getByRole("button", { name: "Lasso cut", exact: true }).click();
  await page.mouse.move(second.x + 8, second.y + 8);
  await page.mouse.down();
  for (const [x, y] of [
    [120, 8],
    [120, 120],
    [8, 120],
    [8, 8],
  ])
    await page.mouse.move(second.x + x, second.y + y, { steps: 3 });
  await page.mouse.up();
  await ready(page);
  expect(await labels(page)).toEqual([3, 3, 2]);
  await page.keyboard.press("Escape");
  await expect(paint).toHaveClass(/active/);
  await page.keyboard.down("Space");
  await page.locator(".feature-stage").click({ position: { x: 10, y: 10 } });
  await page.keyboard.up("Space");
  expect(
    await page.locator(".plot-copy").evaluate(async (el) => {
      const img = el as HTMLImageElement;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(60, 0, 1, 1).data];
    }),
  ).toEqual([187, 187, 187, 255]);
});
test("all group chips wrap inside the feature pane", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page);
  const strip = page.locator(".feature-group-strip");
  const layout = await strip.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    rows: new Set(
      [...el.querySelectorAll("button")].map(
        (button) => button.getBoundingClientRect().top,
      ),
    ).size,
  }));
  expect(layout.rows).toBeGreaterThan(1);
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  expect(await strip.evaluate((el) => getComputedStyle(el).overflowX)).toBe(
    "visible",
  );
  await page.screenshot({ path: "test-results/feature-tools-and-gaps.png" });
});
