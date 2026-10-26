import { ready, exportCutFromHistory as exportCut } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeCut } from "../tests/wasm";
async function fixture(
  page: Page,
  extras: { name: string; mimeType: string; buffer: Buffer }[] = [],
) {
  const raw = Buffer.alloc(6 * 216);
  for (let i = 0; i < 6; i++)
    for (let c = 0; c < 4; c++) {
      raw.writeUInt32BE((i + 1) * 96000, i * 216 + c * 54);
      raw[i * 216 + c * 54 + 18] = 20 + i * 10;
    }
  const tet = (n: number) => ({
    name: `trial.${n}`,
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([
      Buffer.from(
        "num_spikes 6\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
      ),
      raw,
    ]),
  });
  await page.goto("/");
  await page
    .getByLabel("Import recording files", { exact: true })
    .setInputFiles([
      ...extras,
      tet(1),
      tet(2),
      tet(3),
      {
        name: "trial_1.cut",
        mimeType: "text/plain",
        buffer: Buffer.from("Exact_cut_for: trial spikes: 6\n1 1 2 2 3 3\n"),
      },
      {
        name: "trial.clu.1",
        mimeType: "text/plain",
        buffer: Buffer.from("4\n2\n2\n3\n3\n4\n4\n"),
      },
      {
        name: "trial_2.cut",
        mimeType: "text/plain",
        buffer: Buffer.from("Exact_cut_for: trial spikes: 6\n2 2 2 2 2 2\n"),
      },
    ]);
  await ready(page);
}
const cut = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
async function assignments(page: Page) {
  const [d] = await Promise.all([
    page.waitForEvent("download"),
    exportCut(page),
  ]);
  return [
    ...(await decodeCut(
      new File([await readFile((await d.path())!)], "trial_1.cut"),
      6,
    )),
  ];
}
test("cut files remain inline when collapsed; edits create independently navigable local cuts with their histories", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  const group = (n: number) =>
    page.locator(`.tetrode-file-block[data-tetrode="${n}"]`);
  for (const n of [1, 2]) {
    const buttons = await group(n).getByRole("button").all();
    const boxes = await Promise.all(buttons.map((b) => b.boundingBox()));
    expect(boxes.length).toBe(n === 1 ? 3 : 2);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.y).toBe(boxes[0]!.y);
      expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
    }
  }
  await expect(group(2)).not.toHaveClass(/expanded/);
  await expect(group(2).locator(".cut-file")).toBeVisible();
  await page.getByLabel("Destination cell", { exact: true }).fill("2");
  await cut(page, "Merge").click();
  const first = cut(page, "~_1 edited.cut");
  await expect(first).toHaveAttribute("data-local", "true");
  expect(await assignments(page)).toEqual([2, 2, 2, 2, 3, 3]);
  await cut(page, "02").click();
  await cut(page, "01").click();
  await expect(first).toHaveClass(/active/);
  await cut(page, "Undo").click();
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await cut(page, "Redo").click();
  expect(await assignments(page)).toEqual([2, 2, 2, 2, 3, 3]);
  await cut(page, "~_1.cut").click();
  await expect(cut(page, "Undo")).toBeDisabled();
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await page.getByLabel("Destination cell", { exact: true }).fill("3");
  await cut(page, "Merge").click();
  const second = cut(page, "~_1 edited 2.cut");
  await expect(second).toHaveAttribute("data-local", "true");
  expect(await assignments(page)).toEqual([3, 3, 2, 2, 3, 3]);
  await first.click();
  expect(await assignments(page)).toEqual([2, 2, 2, 2, 3, 3]);
  await cut(page, "Undo").click();
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await second.click();
  expect(await assignments(page)).toEqual([3, 3, 2, 2, 3, 3]);
  await expect(cut(page, "Undo")).toBeEnabled();
  await cut(page, "03").click();
  await page.getByLabel("Destination cell", { exact: true }).fill("1");
  await cut(page, "Merge").click();
  const created = cut(page, "~_3 edited.cut");
  await expect(created).toHaveAttribute("data-local", "true");
  expect(await assignments(page)).toEqual([1, 1, 1, 1, 1, 1]);
  await cut(page, "Undo").click();
  expect(await assignments(page)).toEqual([0, 0, 0, 0, 0, 0]);
  // Preparing/exporting an inactive cut must preserve the current tetrode and history.
  await first.hover();
  await expect(first).toHaveAttribute("data-export-ready", "true");
  const dragged = await first.evaluate((el) => {
    const data = new DataTransfer();
    const event = new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    });
    el.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      url: data.getData("DownloadURL"),
      names: [...data.files].map((f) => f.name),
    };
  });
  expect(dragged.prevented).toBe(false);
  expect(dragged.names).toEqual(["trial_1 edited.cut"]);
  expect(dragged.url).toMatch(
    /^application\/octet-stream:trial_1 edited.cut:blob:/,
  );
  const url = dragged.url.slice(
    "application/octet-stream:trial_1 edited.cut:".length,
  );
  const exported = await page.evaluate(
    async (url) => await (await fetch(url)).text(),
    url,
  );
  expect([
    ...(await decodeCut(new File([exported], "trial_1.cut"), 6)),
  ]).toEqual([1, 1, 2, 2, 3, 3]);
  await expect(created).toHaveClass(/active/);
  await expect(cut(page, "Undo")).toBeDisabled();
  expect(await assignments(page)).toEqual([0, 0, 0, 0, 0, 0]);
  await first.click();
  await page.getByRole("button", { name: "Edit history", exact: true }).click();
  await page
    .getByRole("button", { name: "Duplicate cut", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Edit history", exact: true })
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(cut(page, "~_1 edited 3.cut")).toHaveClass(/active/);
  await expect(cut(page, "Redo")).toBeEnabled();
  await cut(page, "Redo").click();
  expect(await assignments(page)).toEqual([2, 2, 2, 2, 3, 3]);
  await first.click();
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await expect(cut(page, "Undo")).toBeDisabled();
  await expect(cut(page, "Redo")).toBeEnabled();
  await page.screenshot({ path: "test-results/file-organiser.png" });
  expect(errors).toEqual([]);
});
test("original favicon and compact tile corners; extra filter, time controls and channel hover labels are absent", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    page.getByRole("textbox", { name: "Find cell", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "Time window start", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "Time window end", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".wave-channel-names")).toHaveCount(0);
  const icon = await page.locator("link[rel=icon]").getAttribute("href");
  const response = await page.request.get(new URL(icon!, page.url()).href);
  expect(await response.body()).toEqual(await readFile("favicon.ico"));
  const tile = page.locator('.cell-tile[data-cell="1"]'),
    row = (await tile.boundingBox())!,
    waves = (await tile.locator(".tile-waves").boundingBox())!,
    plots = (await tile.locator(".tile-numeric-plots").boundingBox())!,
    badge = (await tile.locator(".tile-badge").boundingBox())!;
  expect(row.width).toBe(waves.width + plots.width + 3);
  expect(badge.x + badge.width).toBeLessThanOrEqual(row.x + row.width);
  expect(badge.x).toBeLessThan(plots.x + plots.width);
  for (const name of [
    "Spatial rate",
    "Head direction",
    "Speed",
    "Autocorrelation",
  ])
    await cut(page, name).click();
  const frame = await tile.locator(".tile-waves").evaluate((el) => ({
    w: Number((el as HTMLElement).dataset.plotWidth),
    h: Number((el as HTMLElement).dataset.plotHeight),
  }));
  expect(frame.w / frame.h).toBe(4);
  await page.screenshot({ path: "test-results/tile-corners.png" });
});

test("trial rows keep the current tetrode and cut history; clock/speed summaries stay visible and auxiliary files stay inline", async ({
  page,
}) => {
  const pos = Buffer.alloc(10 * 20);
  for (let i = 0; i < 10; i++) {
    pos.writeUInt32BE(i * 96000, i * 20);
    pos.writeUInt16BE(10 + i * 8, i * 20 + 4);
    pos.writeUInt16BE(20 + i * 3, i * 20 + 6);
    pos.writeUInt16BE(12 + i * 8, i * 20 + 8);
    pos.writeUInt16BE(20 + i * 3, i * 20 + 10);
    pos.writeUInt16BE(12, i * 20 + 12);
    pos.writeUInt16BE(12, i * 20 + 14);
  }
  await fixture(page, [
    {
      name: "trial.eeg",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("skipped"),
    },
    {
      name: "trial.fet.1",
      mimeType: "text/plain",
      buffer: Buffer.from("skipped"),
    },
    {
      name: "trial.set",
      mimeType: "text/plain",
      buffer: Buffer.from("trial_time 16:07:04\nduration 1265\n"),
    },
    {
      name: "trial.pos",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          "pos_format t,x1,y1,x2,y2,numpix1,numpix2\nnum_pos_samples 10\npixels_per_metre 100\nsample_rate 1 hz\ntimestamp_timebase 96000 hz\nwindow_max_x 100\nwindow_max_y 100\ndata_start",
        ),
        pos,
      ]),
    },
  ]);
  await expect(page.locator(".other-files")).toHaveText("2 other files");
  await expect(page.locator(".other-files")).toHaveAttribute(
    "title",
    /trial.eeg\ntrial.fet.1/,
  );
  await expect(
    page.getByRole("status").filter({ hasText: /skipped/ }),
  ).toHaveCount(0);
  await page.locator(".desktop-toolbar").hover();
  await expect(page.locator(".position-info")).toBeVisible();
  await expect(page.locator(".position-time")).toHaveText(
    "16:07–16:2821 min 5 sec",
  );
  await page.locator(".position-pane").hover();
  await expect(page.locator(".position-info")).toBeVisible();
  const histogram = (await page
      .locator(".position-speed canvas")
      .boundingBox())!,
    axis = (await page.locator(".speed-axis-limit").boundingBox())!,
    pane = (await page.locator(".position-pane").boundingBox())!;
  expect(histogram.x).toBe(pane.x + 4);
  expect(
    await page
      .locator(".speed-axis-limit")
      .evaluate((el) => getComputedStyle(el).borderWidth),
  ).toBe("0px");
  expect(axis.y).toBe(histogram.y + histogram.height);
  const axisPixels = await page
    .locator(".position-speed canvas")
    .evaluate((el) => {
      const c = el as HTMLCanvasElement,
        ctx = c.getContext("2d")!;
      return {
        horizontal: [...ctx.getImageData(10, c.height - 1, 1, 1).data],
        vertical: [...ctx.getImageData(0, Math.floor(c.height / 2), 1, 1).data],
      };
    });
  expect(axisPixels.horizontal[0]).toBe(255);
  expect(axisPixels.horizontal[1]).toBe(0);
  expect(axisPixels.horizontal[2]).toBe(0);
  expect(axisPixels.horizontal[3]).toBeGreaterThan(200);
  expect(axisPixels.vertical[3]).toBe(0);
  await expect(page.locator(".speed-axis-limit")).toHaveText("45 cm/s max");
  await cut(page, "02").click();
  await page.getByLabel("Destination cell", { exact: true }).fill("3");
  await cut(page, "Merge").click();
  await expect(cut(page, "~_2 edited.cut")).toHaveClass(/active/);
  await page
    .getByLabel("Import recording files", { exact: true })
    .setInputFiles([
      {
        name: "other.2",
        mimeType: "application/octet-stream",
        buffer: Buffer.concat([
          Buffer.from(
            "num_spikes 6\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
          ),
          Buffer.alloc(6 * 216),
        ]),
      },
      {
        name: "other.eeg",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("skipped"),
      },
    ]);
  const other = page
      .locator(".trial-block")
      .filter({ has: page.locator('.trial-name[title="other"]') }),
    original = page
      .locator(".trial-block")
      .filter({ has: page.locator('.trial-name[title="trial"]') });
  await expect(other.locator(".other-files")).toHaveText("1 other file");
  await other.locator(".file-tag").last().click();
  await ready(page);
  await expect(page).toHaveTitle("other [Waveform]");
  await expect(cut(page, "02")).toHaveClass(/active/);
  await original.locator(".file-tag").first().click();
  await ready(page);
  await expect(cut(page, "~_2 edited.cut")).toHaveClass(/active/);
  await expect(cut(page, "Undo")).toBeEnabled();
  await expect(page).toHaveTitle("trial [Waveform]");
  await page.screenshot({ path: "test-results/position-and-file-details.png" });
});
