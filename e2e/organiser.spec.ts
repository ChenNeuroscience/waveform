import { destination, paintSources } from "./controls";
import { ready, exportCut } from "./controls";
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
  await page.goto("/?demo=quick");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
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
const cut = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
async function assignments(page: Page) {
  const [d] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
  return [...(await decodeCut(new File([await readFile((await d.path())!)], "trial_1.cut"), 6))];
}
test("cut files remain inline when collapsed; edits create independently navigable local cuts with their histories", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  const group = (n: number) => page.locator(`.tetrode-file-block[data-tetrode="${n}"]`);
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
  await destination(page, 2);
  await paintSources(page);
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
  await destination(page, 3);
  await paintSources(page);
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
  await destination(page, 1);
  await paintSources(page);
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
  expect(dragged.url).toMatch(/^application\/octet-stream:trial_1 edited.cut:blob:/);
  const url = dragged.url.slice("application/octet-stream:trial_1 edited.cut:".length);
  const exported = await page.evaluate(async (url) => await (await fetch(url)).text(), url);
  expect([...(await decodeCut(new File([exported], "trial_1.cut"), 6))]).toEqual([
    1, 1, 2, 2, 3, 3,
  ]);
  await expect(created).toHaveClass(/active/);
  await expect(cut(page, "Undo")).toBeDisabled();
  expect(await assignments(page)).toEqual([0, 0, 0, 0, 0, 0]);
  await first.click();
  await expect(cut(page, "Redo")).toBeEnabled();
  await cut(page, "Redo").click();
  expect(await assignments(page)).toEqual([2, 2, 2, 2, 3, 3]);
  await cut(page, "Undo").click();
  await first.click();
  expect(await assignments(page)).toEqual([1, 1, 2, 2, 3, 3]);
  await expect(cut(page, "Undo")).toBeDisabled();
  await expect(cut(page, "Redo")).toBeEnabled();
  expect(errors).toEqual([]);
});
