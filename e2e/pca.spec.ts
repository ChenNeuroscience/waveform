import { settingsSection, destination, ready, exportCut, source } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { pcaRecording } from "../tests/pca-fixture";
import { decodeCut } from "../tests/wasm";

async function watchFeatures(page: Page) {
  await page.addInitScript(() => {
    const requests: any[] = [];
    const replies: any[] = [];
    Object.assign(window, { featureRequests: requests, featureReplies: replies, lastPCs: [] });
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => {
          const data = event.data.data;
          if (data?.key && "samples" in data) {
            replies.push({ key: data.key, samples: data.samples, length: data.values?.length });
            if (data.values) Object.assign(window, { lastPCs: [...data.values] });
          }
        });
      }
      override postMessage(message: any) {
        requests.push({
          type: message.type,
          mode: message.mode,
          samples: message.samples,
          featureKey: message.featureKey,
          ax: message.ax,
          ay: message.ay,
        });
        super.postMessage(message);
      }
    };
  });
}

async function fixture(page: Page, data = pcaRecording()) {
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "pca.1",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([Buffer.from(data.header), Buffer.from(data.raw)]),
    },
    {
      name: "pca_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from(`Exact_cut_for: pca spikes: ${data.spikes}\n${data.labels.join(" ")}\n`),
    },
  ]);
  await ready(page);
  return data;
}

async function labels(page: Page, n: number) {
  const [download] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
  return [
    ...(await decodeCut(new File([await readFile((await download.path())!)], "pca_1.cut"), n)),
  ];
}

test("PCA picking, cuts, undo and configurable sampling project the full population", async ({
  page,
  context,
}) => {
  const data = pcaRecording(2048);
  data.header = data.header.replace("duration 10", "duration 30");
  await test.step("Pick, paint, lasso and undo", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await watchFeatures(page);
    await fixture(page, data);
    const toggle = page.getByRole("button", { name: "Principal components", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    const clusters = page.locator('.clusters[data-features="pca"]');
    await expect(clusters).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const plots = page.locator(".projection-labels > div");
    expect(
      await plots.evaluateAll((nodes) =>
        nodes.map((el) => [(el as HTMLElement).dataset.xAxis, (el as HTMLElement).dataset.yAxis]),
      ),
    ).toEqual([
      ["PC1", "PC2"],
      ["PC1", "PC3"],
      ["PC1", "PC4"],
      ["PC2", "PC3"],
      ["PC2", "PC4"],
      ["PC3", "PC4"],
    ]);
    const pcs: number[] = await page.evaluate(() => (window as any).lastPCs);
    expect(pcs).toHaveLength(data.spikes * 4);
    const corner = (await plots.first().boundingBox())!;
    const x = corner.x + 2 + 0.965 * 124;
    const y = corner.y + 2 + 0.965 * 124;
    await page.mouse.move(x, y);
    await page.keyboard.press("f");
    await expect(page.locator('.painting-sources button[data-group="1"]')).toBeVisible();
    await destination(page, 3);
    await source(page, 1);
    await page.mouse.click(x, y);
    await ready(page);
    const painted = data.labels.map((label, i) =>
      label === 1 && pcs[i * 4] > 0.9 && pcs[i * 4 + 1] < 0.1 ? 3 : label,
    );
    expect(painted.filter((v) => v === 3)).toHaveLength(data.spikes / 4);
    expect(await labels(page, data.spikes)).toEqual(painted);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await ready(page);
    expect(await labels(page, data.spikes)).toEqual(data.labels);
    await expect(clusters).toBeVisible();
    await page.getByRole("button", { name: "Lasso cut", exact: true }).click();
    // Enclose the upper endpoint as well as the lower: the visible plot margin
    // must allow lassoing points whose normalised PC coordinates are exactly 1.
    await page.mouse.move(corner.x + 64, corner.y + 1);
    await page.mouse.down();
    for (const [dx, dy] of [
      [127, 1],
      [127, 127],
      [64, 127],
      [64, 1],
    ]) {
      await page.mouse.move(corner.x + dx, corner.y + dy, { steps: 2 });
    }
    await page.mouse.up();
    await ready(page);
    const cut = data.labels.map((label, i) => (label === 1 && pcs[i * 4] > 0.5 ? 3 : label));
    expect(cut.filter((v) => v === 3)).toHaveLength(data.spikes / 2);
    expect(await labels(page, data.spikes)).toEqual(cut);
    const requests = await page.evaluate(() => (window as any).featureRequests);
    expect(
      requests.filter((r: any) => r.type === "edit" && r.featureKey?.includes("|pca:")).length,
    ).toBe(2);
    await page.getByRole("button", { name: "Amplitudes", exact: true }).click();
    await expect(page.locator('.clusters[data-features="amplitudes"]')).toBeVisible();
    await expect(plots.first()).toHaveAttribute("data-x-axis", "A1");
    await toggle.click();
    await expect(clusters).toBeVisible();
    await expect
      .poll(async () => (await page.evaluate(() => (window as any).featureReplies)).at(-1)?.length)
      .toBeUndefined();
    expect(errors).toEqual([]);
  });
  await test.step("Refit and retain sample preferences", async () => {
    const toggle = page.getByRole("button", { name: "Principal components", exact: true });

    const clusters = page.locator('.clusters[data-features="pca"]');
    await expect(clusters).toBeVisible();
    const first = await page.evaluate(() =>
      (window as any).featureReplies.findLast((r: any) => r.length),
    );
    expect(first.samples).toBe(Math.min(5000, data.spikes));
    expect(first.length).toBe(data.spikes * 4);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await settingsSection(page, "Cluster plots");
    const samples = page.getByRole("slider", { name: "PCA fit sample size", exact: true });
    await samples.fill("1000");
    await expect(clusters).toHaveAttribute("data-feature-key", /\|pca:1000$/);
    const second = await page.evaluate(() => (window as any).featureReplies.at(-1));
    expect(second.samples).toBe(1000);
    expect(second.length).toBe(first.length);
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("waveform-desktop-settings") || "{}").pcaSamples,
        ),
      )
      .toBe(1000);
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await page.reload();
    await fixture(page, data);
    await ready(page);
    await expect(clusters).toHaveAttribute("data-feature-key", /\|pca:1000$/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});
