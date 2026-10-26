import { ready, exportCut } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeCut } from "../tests/wasm";

async function fixture(page: Page) {
  const spikes = Buffer.alloc(6 * 216),
    pos = Buffer.alloc(10 * 20);
  for (let i = 0; i < 6; i++)
    for (let c = 0; c < 4; c++) {
      spikes.writeUInt32BE((i + 1) * 96000, i * 216 + c * 54);
      spikes[i * 216 + c * 54 + 4 + 14] = 20 + i * 10;
    }
  for (let i = 0; i < 10; i++) {
    pos.writeUInt32BE(i * 96000, i * 20);
    pos.writeUInt16BE(10 + i * 8, i * 20 + 4);
    pos.writeUInt16BE(20 + i * 3, i * 20 + 6);
    pos.writeUInt16BE(12, i * 20 + 12);
  }
  await page.goto("/");
  await page
    .getByLabel("Import recording files", { exact: true })
    .setInputFiles([
      {
        name: "compare.1",
        mimeType: "application/octet-stream",
        buffer: Buffer.concat([
          Buffer.from(
            "num_spikes 6\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
          ),
          spikes,
        ]),
      },
      {
        name: "compare_1.cut",
        mimeType: "text/plain",
        buffer: Buffer.from("Exact_cut_for: compare spikes: 6\n1 1 2 2 3 3\n"),
      },
      {
        name: "compare.pos",
        mimeType: "application/octet-stream",
        buffer: Buffer.concat([
          Buffer.from(
            "pos_format t,x1,y1,x2,y2,numpix1,numpix2\nnum_pos_samples 10\npixels_per_metre 100\nsample_rate 1 hz\ntimestamp_timebase 96000 hz\nwindow_max_x 100\nwindow_max_y 100\ndata_start",
          ),
          pos,
        ]),
      },
    ]);
  await ready(page);
}
async function assignments(page: Page) {
  const [d] = await Promise.all([
    page.waitForEvent("download"),
    exportCut(page),
  ]);
  return [
    ...(await decodeCut(
      new File([await readFile((await d.path())!)], "compare_1.cut"),
      6,
    )),
  ];
}
const tile = (page: Page, cell: number) =>
  page.locator(`.cell-tile[data-cell="${cell}"]`);
async function start(page: Page, cell: number) {
  const b = (await tile(page, cell).locator(".tile-waves").boundingBox())!;
  await page.mouse.move(b.x + 65, b.y + 45);
  await page.mouse.down();
  await page.mouse.move(b.x + 85, b.y + 45, { steps: 3 });
}
async function snap(page: Page, cell: number) {
  const b = (await tile(page, cell).boundingBox())!;
  await page.mouse.move(b.x + 80, b.y + 37, { steps: 4 });
  const ghost = page.locator(".tile-drag-ghost.snapped");
  await expect(ghost).toHaveAttribute("data-target", String(cell));
  const g = (await ghost.boundingBox())!;
  expect(g.x).toBe(b.x);
  expect(g.y).toBe(b.y);
  expect(g.width).toBe(b.width);
  expect(g.height).toBe(b.height);
  const primary = (await tile(page, cell)
      .locator(".tile-badge button")
      .boundingBox())!,
    secondary = (await ghost.locator(".tile-drag-badge").boundingBox())!;
  expect(secondary.y).toBe(primary.y);
  expect(secondary.width).toBe(primary.width);
  expect(secondary.height).toBe(primary.height);
  expect(primary.x - secondary.x - secondary.width).toBe(3);
  const speedPlot = tile(page, cell).locator(".tile-speed canvas");
  if (await speedPlot.count()) {
    const speed = (await speedPlot.boundingBox())!;
    expect(speed.y - primary.y - primary.height).toBe(5);
  }
  const halo = page.locator("body > .tile-hover-glow");
  expect(await halo.boundingBox()).toEqual(b);
  expect(
    await halo.evaluate((el) => +getComputedStyle(el).zIndex),
  ).toBeGreaterThan(await ghost.evaluate((el) => +getComputedStyle(el).zIndex));
  return ghost;
}

test("drag comparison leaves a placeholder, fades at exact alignment, overlays both spike sets and only merges on snapped release", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  const original = (await tile(page, 1).boundingBox())!;
  await start(page, 1);
  await expect(
    tile(page, 1).getByLabel("Original location of cell 1"),
  ).toHaveText("[group 1]");
  expect((await tile(page, 1).boundingBox())!.y).toBe(original.y);
  const ghost = await snap(page, 2);
  await expect(tile(page, 1).locator(".tile-caption")).toBeHidden();
  await expect(tile(page, 2).locator(".tile-caption")).toBeHidden();
  const path = page.locator(".position-path");
  await expect(path).toHaveAttribute("data-cells", "1,2");
  await expect(path).toHaveAttribute("data-source-spikes", "2");
  await expect(path).toHaveAttribute("data-target-spikes", "2");
  await expect(path).toHaveAttribute("data-spikes", "4");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  const image = ghost.locator(".tile-drag-image");
  expect(
    await image.evaluate((el) => {
      const a = el.getAnimations()[0];
      a.pause();
      a.currentTime = 0;
      return {
        opacity: getComputedStyle(el).opacity,
        duration: a.effect!.getTiming().duration,
      };
    }),
  ).toEqual({ opacity: "1", duration: 1500 });
  await page.screenshot({ path: "test-results/drag-snap-source.png" });
  expect(
    await image.evaluate((el) => {
      el.getAnimations()[0].currentTime = 900;
      return getComputedStyle(el).opacity;
    }),
  ).toBe("0");
  await page.screenshot({ path: "test-results/drag-snap-target.png" });
  expect(
    await page.locator("body > .tile-hover-glow").evaluate((el) => ({
      opacity: getComputedStyle(el).opacity,
      animations: el.getAnimations().length,
    })),
  ).toEqual({ opacity: "1", animations: 0 });
  await snap(page, 3);
  await expect(path).toHaveAttribute("data-cells", "1,3");
  // Moving out of a snap must invalidate it before mouse-up.
  await page.mouse.move(1420, 300, { steps: 4 });
  await expect(page.locator(".tile-drag-ghost.snapped")).toHaveCount(0);
  await expect(path).toHaveAttribute("data-cells", "1");
  await page.mouse.up();
  const returning = page.getByLabel("Returning cell 1", { exact: true });
  await expect(returning).toBeVisible();
  expect(
    await returning.evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("tile-settle");
  await expect(returning).toHaveCount(0);
  await expect(page.locator(".tile-drag-placeholder")).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  // Wrap into two columns and compare/merge across columns on the shared canvas.
  for (const name of [
    "Spatial rate",
    "Head direction",
    "Speed",
    "Autocorrelation",
  ])
    await page.getByRole("button", { name, exact: true }).click();
  await start(page, 1);
  await snap(page, 2);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Select cell 2", exact: true }),
  ).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 3, 3]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await start(page, 1);
  await snap(page, 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".tile-drag-ghost.snapped")).toHaveCount(0);
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("cancelling after the source scrolls out of the virtual wall restores its slot", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByText("Explore a synthetic demo").click();
  await ready(page);
  await start(page, 1);
  await page
    .locator(".tile-wall")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(tile(page, 1)).toHaveCount(0);
  await page.mouse.move(20, 20, { steps: 3 });
  await page.mouse.up();
  await expect(tile(page, 1)).toBeVisible();
  await expect(page.locator(".tile-drag-placeholder")).toHaveCount(0);
  await expect(page.locator(".tile-drag-ghost")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("18,000", { exact: true })).toBeVisible();
});
