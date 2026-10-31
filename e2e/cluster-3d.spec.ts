import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { destination, source, ready, exportCut } from "./controls";
import { pcaRecording } from "../tests/pca-fixture";
import { decodeCut } from "../tests/wasm";

async function watch(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { clusterEdits: [], clusterLabels: [], clusterPCs: [] });
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (event) => {
          const data = event.data.data;
          if (data?.labels) Object.assign(window, { clusterLabels: [...data.labels] });
          if (data?.values && "samples" in data)
            Object.assign(window, { clusterPCs: [...data.values] });
        });
      }
      override postMessage(message: any) {
        if (message.type === "edit") (window as any).clusterEdits.push(message);
        super.postMessage(message);
      }
    };
  });
}

async function load(page: Page, fixture: ReturnType<typeof pcaRecording>) {
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "clusters.1",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([Buffer.from(fixture.header), Buffer.from(fixture.raw)]),
    },
    {
      name: "clusters_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from(
        `Exact_cut_for: clusters spikes: ${fixture.spikes}\n${fixture.labels.join(" ")}\n`,
      ),
    },
  ]);
  await ready(page);
  await page.getByRole("button", { name: "3D clusters", exact: true }).click();
  await expect(page.locator(".cluster-3d")).toBeVisible();
}

async function labels(page: Page, count: number) {
  const [download] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
  return [
    ...(await decodeCut(
      new File([await readFile((await download.path())!)], "clusters_1.cut"),
      count,
    )),
  ];
}

async function screenPoints(page: Page, values: number[]) {
  const root = page.locator(".cluster-3d");
  const box = (await root.boundingBox())!;
  const m = (await root.getAttribute("data-projection"))!.split(",").map(Number);
  const points = Array.from({ length: values.length / 4 }, (_, i) => {
    const [x, y, z] = values.slice(i * 4, i * 4 + 3);
    return [
      (m[0] * x + m[1] * y + m[2] * z + m[3]) * box.width,
      (1 - (m[4] * x + m[5] * y + m[6] * z + m[7])) * box.height,
    ];
  });
  return { box, points, matrix: m };
}

test("3D is optional, navigates without edits, preserves colour modes and restores the six 2D pairings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await watch(page);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const toggle = page.getByRole("button", { name: "3D clusters", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(
    await toggle.evaluate((button) => button.previousElementSibling?.getAttribute("aria-label")),
  ).toBe("Fixed cluster colours");
  expect(await toggle.evaluate((button) => button.nextElementSibling?.className)).toBe(
    "tool-separator",
  );
  await toggle.click();
  const root = page.locator(".cluster-3d");
  await expect(root).toBeVisible();
  await expect(page.getByRole("button", { name: "Rotate 3D view", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".projection-labels")).toHaveCount(0);
  expect(await root.locator("text[data-axis]").allTextContents()).toEqual(["A1", "A2", "A3"]);
  await expect(page.locator(".plot-error")).toHaveCount(0);
  const canvas = root.locator("canvas");
  await expect
    .poll(() =>
      canvas.evaluate((c) => {
        const gl = (c as HTMLCanvasElement).getContext("webgl2")!;
        const bytes = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        let points = 0;
        for (let i = 0; i < bytes.length; i += 4)
          if (bytes[i] < 250 || bytes[i + 1] < 250 || bytes[i + 2] < 250) points++;
        return points;
      }),
    )
    .toBeGreaterThan(100);
  const before = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const initial = await root.getAttribute("data-projection");
  const box = (await root.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await expect(root).not.toHaveAttribute("data-projection", initial!);
  await expect
    .poll(() => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()))
    .not.toBe(before);
  const rotated = await root.getAttribute("data-projection");
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(root).not.toHaveAttribute("data-projection", rotated!);
  const panned = await root.getAttribute("data-projection");
  await page.mouse.wheel(0, -160);
  await expect(root).not.toHaveAttribute("data-projection", panned!);
  expect(await page.evaluate(() => (window as any).clusterEdits)).toHaveLength(0);
  await page.getByRole("button", { name: "Reset 3D view", exact: true }).click();
  await expect(root).toHaveAttribute("data-projection", initial!);
  await page.keyboard.press("p");
  await expect(root).toHaveAttribute("data-colour-mode", "drift");
  const palette = page.getByRole("button", { name: "Fixed cluster colours", exact: true });
  await palette.click();
  await expect(root).toHaveAttribute("data-colour-mode", "fixed");
  await page.screenshot({ path: "test-results/cluster-3d-amplitudes.png" });
  await page.getByRole("button", { name: "Principal components", exact: true }).click();
  await expect(root).toHaveAttribute("data-features", "pca");
  expect(await root.locator("text[data-axis]").allTextContents()).toEqual(["PC1", "PC2", "PC3"]);
  await root.screenshot({ path: "test-results/cluster-3d-pca.png" });
  const axisBounds = await root.locator("text[data-axis]").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = (node as SVGGraphicsElement).getBBox();
      return { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height };
    }),
  );
  const plotBox = (await root.boundingBox())!;
  for (const bounds of axisBounds) {
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(plotBox.width);
    expect(bounds.bottom).toBeLessThanOrEqual(plotBox.height);
  }
  const beforeRestore = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await canvas.evaluate((c) => {
    const extension = (c as HTMLCanvasElement)
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context")!;
    extension.loseContext();
    setTimeout(() => extension.restoreContext(), 100);
  });
  await expect
    .poll(() => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()))
    .toBe(beforeRestore);
  await page.keyboard.down("Space");
  await root.click({ position: { x: 50, y: 50 } });
  await page.keyboard.up("Space");
  const copy = page.locator(".floating-window").filter({ has: page.locator(".plot-copy") });
  await expect(copy).toBeVisible();
  const copied = await copy.locator(".plot-copy").getAttribute("src");
  expect(copied).not.toBe(beforeRestore); // The frozen capture includes cube edges and axis labels.
  await copy.getByRole("button", { name: "Close panel", exact: true }).click();
  await palette.click();
  await expect(root).toHaveAttribute("data-colour-mode", "drift");
  await toggle.click();
  await expect(page.locator('.clusters[data-dimension="2"]')).toBeVisible();
  await expect(page.locator(".projection-labels > div")).toHaveCount(6);
  await expect(
    page.getByRole("button", { name: "Paint source spikes", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("waveform-ui:cluster-3d")))
    .toBe("true");
  await page.reload();
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await expect(root).toBeVisible();
  await expect(page.getByRole("button", { name: "Rotate 3D view", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const splitter = (await page.locator(".desktop-splitter").boundingBox())!;
  await page.mouse.move(splitter.x + 3, splitter.y + 80);
  await page.mouse.down();
  await page.mouse.move(240, splitter.y + 80);
  await page.mouse.up();
  const controlsFit = await page.locator(".feature-pane").evaluate((pane) => {
    const bounds = pane.getBoundingClientRect();
    return [...pane.querySelectorAll(".feature-tools button, .painting-set button")].every(
      (button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right;
      },
    );
  });
  expect(controlsFit).toBe(true);
  await expect(page.locator(".plot-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("rotated, panned and zoomed amplitude lassos cut the displayed population and undo exactly", async ({
  page,
}) => {
  await watch(page);
  const fixture = pcaRecording();
  const values: number[] = [];
  for (let i = 0; i < fixture.spikes; i++) {
    for (let ch = 0; ch < 4; ch++) {
      const amplitude = ch < 3 ? [25, 89, 166, 230][(i >> (ch * 2)) & 3] : (i * 7) % 256;
      const start = i * 216 + ch * 54 + 4;
      fixture.raw.fill(128, start, start + 50);
      fixture.raw[start + 17] = (amplitude - 128) & 255;
      values.push(amplitude / 255);
    }
  }
  await load(page, fixture);
  await destination(page, 3);
  await source(page, 1);
  const root = page.locator(".cluster-3d");
  const originalBox = (await root.boundingBox())!;
  await page.mouse.move(
    originalBox.x + originalBox.width / 2,
    originalBox.y + originalBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    originalBox.x + originalBox.width / 2 + 30,
    originalBox.y + originalBox.height / 2 - 15,
    { steps: 4 },
  );
  await page.mouse.up();
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(
    originalBox.x + originalBox.width / 2 + 40,
    originalBox.y + originalBox.height / 2 - 5,
    { steps: 3 },
  );
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const beforeZoom = await root.getAttribute("data-projection");
  await page.mouse.wheel(0, -100);
  await expect(root).not.toHaveAttribute("data-projection", beforeZoom!);
  const { box, points, matrix } = await screenPoints(page, values);
  const left = 5,
    right = box.width / 2,
    top = 5,
    bottom = box.height - 32;
  const expected = fixture.labels.map((label, i) =>
    label === 1 &&
    points[i][0] > left &&
    points[i][0] < right &&
    points[i][1] > top &&
    points[i][1] < bottom
      ? 3
      : label,
  );
  expect(expected.filter((label) => label === 3).length).toBeGreaterThan(0);
  expect(expected.filter((label) => label === 1).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Lasso cut", exact: true }).click();
  await page.mouse.move(box.x + left, box.y + top);
  await page.mouse.down();
  for (const [x, y] of [
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ])
    await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).clusterLabels)).toEqual(expected);
  expect(await labels(page, fixture.spikes)).toEqual(expected);
  const edit = await page.evaluate(() => (window as any).clusterEdits.at(-1));
  expect(edit.projection.matrix).toEqual(matrix);
  expect(edit.featureKey).toBeUndefined();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).clusterLabels))
    .toEqual(fixture.labels);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).clusterLabels)).toEqual(expected);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Rotate 3D view", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".plot-error")).toHaveCount(0);
});

test("PCA supports projected picking, brush cuts, cancellation and undo", async ({ page }) => {
  await watch(page);
  const fixture = pcaRecording();
  await load(page, fixture);
  await page.getByRole("button", { name: "Principal components", exact: true }).click();
  await expect(page.locator(".cluster-3d")).toHaveAttribute("data-features", "pca");
  const values = await page.evaluate(() => (window as any).clusterPCs as number[]);
  expect(values).toHaveLength(fixture.spikes * 4);
  const { box, points } = await screenPoints(page, values);
  const [px, py] = points[0];
  await source(page, 2);
  await page.mouse.move(box.x + px, box.y + py);
  await page.keyboard.press("f");
  await expect(page.locator('.painting-sources button[data-group="1"]')).toBeVisible();
  await destination(page, 3);
  await source(page, 1);
  const expected = fixture.labels.map((label, i) =>
    label === 1 && (points[i][0] - px) ** 2 + (points[i][1] - py) ** 2 < 81 ? 3 : label,
  );
  expect(expected.filter((label) => label === 3).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Paint source spikes", exact: true }).click();
  await page.mouse.click(box.x + px, box.y + py);
  await expect.poll(() => page.evaluate(() => (window as any).clusterLabels)).toEqual(expected);
  expect(await labels(page, fixture.spikes)).toEqual(expected);
  const edit = await page.evaluate(() => (window as any).clusterEdits.at(-1));
  expect(edit.featureKey).toContain("|pca:");
  expect(edit.projection).toBeDefined();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).clusterLabels))
    .toEqual(fixture.labels);
  const count = await page.evaluate(() => (window as any).clusterEdits.length);
  await page.mouse.move(box.x + px, box.y + py);
  await page.mouse.down();
  await page.mouse.move(box.x + px + 10, box.y + py + 5);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Rotate 3D view", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => (window as any).clusterEdits.length)).toBe(count);
  await expect(page.locator(".plot-error")).toHaveCount(0);
});
