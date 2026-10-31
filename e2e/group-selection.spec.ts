import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ready, exportCut, paintSources } from "./controls";
import { decodeCut } from "../tests/wasm";
import { groupRgb8 } from "../src/palette";

async function fixture(page: Page) {
  const bytes = Buffer.alloc(6 * 216);
  for (let i = 0; i < 6; i++)
    for (let channel = 0; channel < 4; channel++) {
      const offset = i * 216 + channel * 54;
      bytes.writeUInt32BE((i + 1) * 96000, offset);
      bytes[offset + 18] = [10, 40, 40, 80, 100, 120][i];
    }
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    ...[1, 2].map((tet) => ({
      name: `groups.${tet}`,
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          "num_spikes 6\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
        ),
        bytes,
      ]),
    })),
    {
      name: "groups_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from("Exact_cut_for: groups spikes: 6\n0 1 2 4 4 6\n"),
    },
  ]);
  await ready(page);
}
const chip = (page: Page, n: number) => page.locator(`.group-selector button[data-group="${n}"]`);
const tile = (page: Page, n: number) => page.locator(`.cell-tile[data-cell="${n}"]`);
async function sources(page: Page) {
  return page
    .locator(".painting-sources button")
    .evaluateAll((elements) => elements.map((el) => Number(el.getAttribute("data-group"))));
}
async function labels(page: Page) {
  const [download] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
  return [
    ...(await decodeCut(new File([await readFile((await download.path())!)], "groups_1.cut"), 6)),
  ];
}

test("set notation restores mouse/hover shortcuts, multiple sources and new destinations; edits remain exact", async ({
  page,
}) => {
  await fixture(page);
  const historyLength = await page.evaluate(() => history.length);
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Swap", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Destination cell", { exact: true })).toHaveCount(0);
  await expect(page.locator(".painting-set")).toContainText("←");
  await expect(
    page
      .getByRole("button", { name: "Paint source spikes", exact: true })
      .locator(".lucide-paintbrush"),
  ).toHaveCount(1);
  const layout = await page.locator(".group-selector").evaluate((el) => {
    const heading = el.querySelector(".feature-group-heading")!.getBoundingClientRect(),
      rest = el.querySelector(".feature-group-strip")!;
    return {
      headingBottom: heading.bottom,
      restTop: rest.getBoundingClientRect().top,
      plusLast: rest.lastElementChild?.classList.contains("new-group"),
    };
  });
  expect(layout.restTop).toBeGreaterThanOrEqual(layout.headingBottom);
  expect(layout.plusLast).toBe(true);
  await chip(page, 2).click({ button: "right" });
  expect(await sources(page)).toEqual([2]);
  await chip(page, 4).click({ button: "right", modifiers: ["Shift"] });
  expect(await sources(page)).toEqual([2, 4]);
  await chip(page, 2).click({ button: "right", modifiers: ["Shift"] });
  expect(await sources(page)).toEqual([4]);
  await chip(page, 4).click();
  expect(await sources(page)).toEqual([]);
  await expect(page.locator(".painting-destination button")).toHaveText("4");
  await tile(page, 1).hover();
  await page.keyboard.press("f");
  await tile(page, 2).hover();
  await page.keyboard.press("Shift+f");
  expect(await sources(page)).toEqual([1, 2]);
  await tile(page, 4).hover();
  await page.keyboard.press("Shift+f");
  await page.keyboard.press("Shift+f");
  expect(await sources(page)).toEqual([1, 2]);
  await tile(page, 2).click({ position: { x: 30, y: 70 } });
  expect(await sources(page)).toEqual([1, 2]);
  await chip(page, 1).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".painting-destination button")).toHaveText("3");
  await expect(tile(page, 3)).toHaveCount(0);
  await paintSources(page);
  expect(await labels(page)).toEqual([0, 3, 3, 4, 4, 6]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 1, 2, 4, 4, 6]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 3, 3, 4, 4, 6]);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("tile clicks bring coincident points to the front without uploading feature buffers; E/F can pick the plot", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype,
      original = prototype.bufferData;
    (window as any).featureUploads = 0;
    prototype.bufferData = function (...args: any[]) {
      if ((this.canvas as HTMLCanvasElement).closest(".clusters")) (window as any).featureUploads++;
      return (original as any).apply(this, args);
    };
  });
  await fixture(page);
  await page.getByRole("button", { name: "Fixed colours", exact: true }).click();
  const uploads = await page.evaluate(() => (window as any).featureUploads);
  const pixels = () =>
    page.locator(".clusters canvas").evaluate((el) => {
      const source = el as HTMLCanvasElement,
        out = document.createElement("canvas");
      out.width = source.width;
      out.height = source.height;
      const context = out.getContext("2d")!;
      context.drawImage(source, 0, 0);
      const x = Math.floor(2 + (0.035 + (0.93 * 40) / 255) * 124),
        y = Math.floor(2 + (0.965 - (0.93 * 40) / 255) * 124);
      return [...context.getImageData(x - 1, y - 1, 3, 3).data];
    });
  const has = (bytes: number[], rgb: readonly number[]) =>
    bytes.some((_, i) => i % 4 === 0 && rgb.every((v, j) => bytes[i + j] === v));
  await expect.poll(async () => has(await pixels(), groupRgb8(1))).toBe(true);
  const originalSources = await sources(page);
  await tile(page, 2).click({ position: { x: 30, y: 65 } });
  await expect.poll(async () => has(await pixels(), groupRgb8(2))).toBe(true);
  expect(await sources(page)).toEqual(originalSources);
  expect(await page.evaluate(() => (window as any).featureUploads)).toBe(uploads);
  await tile(page, 1).click({ position: { x: 30, y: 65 } });
  await expect.poll(async () => has(await pixels(), groupRgb8(1))).toBe(true);
  const box = (await page.locator(".clusters canvas").boundingBox())!;
  await page.mouse.move(
    box.x + 2 + (0.035 + (0.93 * 40) / 255) * 124,
    box.y + 2 + (0.965 - (0.93 * 40) / 255) * 124,
  );
  await page.keyboard.press("e");
  await expect(page.locator(".painting-destination button")).toHaveText("1");
  await page.keyboard.press("f");
  expect(await sources(page)).toEqual([1]);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("S uses the hovered tile, focuses a centred prompt, accepts clicks or numbers and preserves undo", async ({
  page,
}) => {
  await fixture(page);
  const swap = page.getByRole("region", { name: "Swap groups", exact: true });
  await chip(page, 4).hover();
  await page.keyboard.press("s");
  await expect(swap).toHaveCount(0);
  await tile(page, 4).hover();
  await page.keyboard.press("s");
  await expect(swap).toContainText("Swap group 4: click or type a group");
  await expect(swap.getByRole("textbox", { name: "Group to swap with" })).toBeFocused();
  await swap.getByRole("textbox", { name: "Group to swap with" }).hover();
  await expect(page.locator('.tile-hover-glow[data-cell="4"]')).toBeVisible();
  expect(
    await page
      .locator('.tile-hover-glow[data-cell="4"]')
      .evaluate((el) => getComputedStyle(el).boxShadow),
  ).toContain("255, 204, 0");
  const wall = (await page.locator(".right-workspace").boundingBox())!,
    prompt = (await swap.boundingBox())!;
  expect(Math.abs(prompt.x + prompt.width / 2 - wall.x - wall.width / 2)).toBeLessThan(1);
  await expect(swap.getByRole("button", { name: "Swap −1 (empty 3)", exact: true })).toBeVisible();
  await expect(swap.getByRole("button", { name: "Swap +1 (empty 5)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(swap).toHaveCount(0);
  expect(await labels(page)).toEqual([0, 1, 2, 4, 4, 6]);
  await tile(page, 4).hover();
  await page.keyboard.press("s");
  await swap.getByRole("button", { name: "Swap −1 (empty 3)", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 1, 2, 3, 3, 6]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 1, 2, 4, 4, 6]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 1, 2, 3, 3, 6]);
  await tile(page, 1).hover();
  await page.keyboard.press("s");
  await page.getByRole("button", { name: "Select cell 2", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 2, 1, 3, 3, 6]);
  await expect(swap).toHaveCount(0);
  await expect(page.locator(".tile-wall")).not.toHaveAttribute("data-dragging");
  await tile(page, 3).hover();
  await page.keyboard.press("s");
  const input = swap.getByRole("textbox", { name: "Group to swap with" });
  await input.fill("1024");
  await input.press("Enter");
  await expect(swap.getByRole("alert")).toContainText("0 to 1023");
  await input.fill("10");
  await input.press("Enter");
  await ready(page);
  expect(await labels(page)).toEqual([0, 2, 1, 10, 10, 6]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await ready(page);
  expect(await labels(page)).toEqual([0, 2, 1, 3, 3, 6]);
  await tile(page, 1).hover();
  await page.keyboard.press("s");
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  await expect(swap).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
