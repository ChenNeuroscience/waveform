import { test, expect, type Page } from "@playwright/test";
import { destination, paintSources, ready, source } from "./controls";

async function clipboard(page: Page) {
  return page.evaluate(async () => {
    try {
      const [item] = await navigator.clipboard.read();
      return {
        html: await (await item.getType("text/html")).text(),
        text: await (await item.getType("text/plain")).text(),
      };
    } catch (error) {
      // Selection changes can replace the clipboard between reading its two types.
      if (error instanceof DOMException && error.name === "InvalidStateError") {
        return { html: "", text: "" };
      }
      throw error;
    }
  });
}
async function copyMode(page: Page, cell: number) {
  await page.locator(`.cell-tile[data-cell="${cell}"]`).hover();
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.down("c");
  await page.waitForTimeout(1100);
  await page.keyboard.down("c");
  await page.keyboard.up("c");
  await page.keyboard.up("ControlOrMeta");
  await expect(page.getByRole("region", { name: "Copy cells", exact: true })).toBeVisible();
}
async function watchWorker(page: Page) {
  await page.addInitScript(() => {
    const requests: {
      type: string;
      file?: string;
      asset?: string;
      cells?: number[];
      files?: string[];
    }[] = [];
    Object.assign(window, { recordingRequests: requests });
    const Base = window.Worker;
    window.Worker = class extends Base {
      override postMessage(message: any) {
        requests.push({
          type: message.type,
          file: message.file?.name,
          asset: message.asset,
          cells: message.cells,
          files: message.recordings?.map((r: any) => r.file.name),
        });
        super.postMessage(message);
      }
    };
  });
}

test("copy mode compares trials without loading their waveform views, and produces aligned chart subrows", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await watchWorker(page);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await expect(page.locator(".tile-wave-canvas")).toHaveAttribute("data-waves", "ready");
  const original = await page
    .locator(".tile-wave-canvas")
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await copyMode(page, 2);
  const primary = page.getByRole("button", { name: "demo_box-a 8", exact: true });
  await expect(primary).toHaveAttribute("aria-pressed", "true");
  await primary.click();
  await expect(primary).toHaveAttribute("aria-pressed", "true");
  const secondary = page.getByRole("button", { name: "demo_box-b 8", exact: true });
  await secondary.click();
  await expect(secondary).toHaveClass(/copy-included/);
  const excluded = page.getByRole("button", { name: "demo_box-c 8", exact: true });
  await expect(excluded).toHaveCSS("opacity", "0.45");
  await expect(excluded).toHaveCSS("filter", "grayscale(1)");
  await expect(secondary).toHaveCSS("opacity", "1");
  await expect(primary).toHaveCSS("opacity", "1");
  await expect(page.locator('.trial-block input[type="checkbox"]')).toHaveCount(0);
  await page.locator('.cell-tile[data-cell="3"]').click();
  await expect.poll(async () => (await clipboard(page)).text).toContain("demo_box-b · t1 c3");
  await expect(page).toHaveTitle("demo_box-a [Waveform]");
  await expect(page.locator(".tile-wave-canvas")).toHaveAttribute("data-waves", "ready");
  expect(
    await page.locator(".tile-wave-canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
  ).toBe(original);
  const requests = await page.evaluate(() => (window as any).recordingRequests);
  expect(requests.filter((r: any) => r.type === "load")).toHaveLength(1);
  expect(
    requests
      .filter((r: any) => r.type === "wave_batch")
      .every((r: any) => r.asset.includes("demo_box-a")),
  ).toBe(true);
  expect(
    requests.some((r: any) => r.type === "copy_analysis" && r.files.includes("demo_box-b.1")),
  ).toBe(true);
  const content = await clipboard(page);
  expect(content.html).toContain("<table");
  expect(content.html).not.toContain("&nbsp;");
  expect(content.html).not.toContain("Courier New");
  expect(content.html.match(/alt="Waveforms"/g)).toHaveLength(2);
  for (const plot of ["Spatial rate map", "Head direction", "Speed", "Autocorrelation"]) {
    expect(content.html.match(new RegExp(`alt="${plot} ·`, "g"))).toHaveLength(4);
  }
  expect(content.text).toContain("Waveforms from demo_box-a only (T1).");
  expect(content.text).not.toContain("spikes");
  expect(content.text).toContain(
    "Values above spatial rate maps and directional maps are peak firing rates (Hz).",
  );

  // Plot toggles also update an existing multi-trial selection.
  await page.getByRole("button", { name: "Spatial rate", exact: true }).click();
  await expect
    .poll(async () => {
      const current = await clipboard(page);
      return (
        current.html.includes('alt="Spatial rate map ·') &&
        !current.html.includes('alt="Waveforms"') &&
        !current.html.includes('alt="Head direction ·')
      );
    })
    .toBe(true);
  expect((await clipboard(page)).text).not.toContain("Waveforms from");
  const compactContent = await clipboard(page);
  const compact = await context.newPage();
  await compact.setContent(`<div style="display:inline-block">${compactContent.html}</div>`);
  await compact
    .locator("img")
    .evaluateAll((images) =>
      Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
    );
  const titleWidths = await compact
    .locator('th[scope="rowgroup"]')
    .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().width));
  expect(titleWidths).toHaveLength(2);
  for (const width of titleWidths) expect(width).toBeLessThanOrEqual(60);
  expect(compactContent.text).toContain(
    "Values above spatial rate maps are peak firing rates (Hz).",
  );
  expect(compactContent.text).not.toContain("directional maps");
  expect(compactContent.text).not.toContain("Head direction:");
  await compact.close();
  await page
    .getByRole("button", { name: "Waveforms", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect
    .poll(async () => (await clipboard(page)).html.match(/alt="Waveforms"/g)?.length)
    .toBe(2);

  // The clipboard contains a real table with editable text and separate plot images.
  const preview = await context.newPage();
  await preview.setContent(
    `<div contenteditable="true" style="font:12px Arial;display:inline-block;max-width:600px">${content.html}</div>`,
  );
  await preview
    .locator("img")
    .evaluateAll((images) =>
      Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
    );
  await expect(preview.locator("table")).toHaveCount(1);
  await expect(preview.locator("table")).toHaveAttribute("border", "0");
  await expect(preview.locator("tbody")).toHaveCount(2);
  expect(await preview.locator('th[scope="rowgroup"]').allTextContents()).toEqual([
    "t1 c2",
    "t1 c3",
  ]);
  const chartRows = () =>
    preview.locator("tbody tr").evaluateAll((rows) =>
      rows
        .filter((row) => row.querySelector("img"))
        .map((row) =>
          [...(row as HTMLTableRowElement).cells].map((cell) => {
            const rect = cell.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        ),
    );
  const rows = await chartRows();
  expect(rows).toHaveLength(8); // Four chart subrows per cell; empty waveform cells keep their space.
  for (const row of rows) {
    expect(row).toHaveLength(3);
    expect(row.map((image) => image.x)).toEqual(rows[0].map((image) => image.x));
    expect(new Set(row.map((image) => image.y)).size).toBe(1);
    expect(new Set(row.map((image) => image.height)).size).toBe(1);
  }
  expect(rows[0][2].x + rows[0][2].width - rows[0][0].x).toBeLessThanOrEqual(600);
  expect(content.html).not.toContain('alt="Trial ');
  const editableText = await preview.locator("div[contenteditable]").textContent();
  expect(editableText).toContain("demo_box-a");
  expect(editableText).toContain("demo_box-b");
  expect(editableText).not.toContain("Spatial rate map");
  expect(editableText).not.toContain("Head direction");
  expect(await preview.locator("thead th").allTextContents()).toEqual(["", "a", "b"]);
  expect(editableText).toContain("Trials and cuts:");
  expect(editableText).toContain("demo_box-a_1.cut");
  expect(editableText).not.toContain("Spikes");
  expect(editableText).not.toContain("Spatial max");
  expect(editableText).not.toContain("Direction max");
  await expect(preview.locator('th[scope="row"]')).toHaveCount(0);
  const captions = await preview
    .locator('td:has(> img[alt^="Spatial rate map ·"]), td:has(> img[alt^="Head direction ·"])')
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const caption = cell.querySelector("p")!;
        const plot = cell.querySelector("img")!;
        return {
          text: caption.textContent,
          bottom: caption.getBoundingClientRect().bottom,
          plotTop: plot.getBoundingClientRect().top,
        };
      }),
    );
  expect(captions).toHaveLength(8);
  for (const caption of captions) {
    expect(caption.text).toMatch(/^\d+\.\d Hz$/);
    expect(caption.bottom).toBeLessThanOrEqual(caption.plotTop);
  }
  // Editors may discard CSS or substitute fonts; column alignment is structural.
  await preview.locator("table").evaluate((table) => {
    for (const element of [table, ...table.querySelectorAll("[style]")])
      element.removeAttribute("style");
    (table as HTMLElement).style.font = "15px 'Times New Roman', serif";
  });
  const unstyledRows = await chartRows();
  for (const row of unstyledRows) {
    expect(row.map((cell) => cell.x)).toEqual(unstyledRows[0].map((cell) => cell.x));
    expect(row.map((cell) => cell.width)).toEqual(unstyledRows[0].map((cell) => cell.width));
  }
  await preview.close();
});

test("missing cells and missing tetrodes occupy complete chart slots, and trial toggles restore a single-trial clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await watchWorker(page);
  await page.goto("/");
  const files = [
    { name: "alpha", tetrode: 1, labels: [1, 1, 2, 2] },
    { name: "beta", tetrode: 1, labels: [1, 1, 1, 1] },
    { name: "gamma", tetrode: 2, labels: [1, 1, 2, 2] },
  ].flatMap(({ name, tetrode, labels }) => {
    const bytes = Buffer.alloc(labels.length * 216);
    labels.forEach((_, i) => {
      for (let c = 0; c < 4; c++) {
        bytes.writeUInt32BE((i + 1) * 96000, i * 216 + c * 54);
        bytes[i * 216 + c * 54 + 18] = 100;
      }
    });
    return [
      {
        name: `${name}.${tetrode}`,
        mimeType: "application/octet-stream",
        buffer: Buffer.concat([
          Buffer.from(
            `num_spikes ${labels.length}\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start`,
          ),
          bytes,
        ]),
      },
      {
        name: `${name}_${tetrode}.cut`,
        mimeType: "text/plain",
        buffer: Buffer.from(
          `Exact_cut_for: ${name} spikes: ${labels.length}\n${labels.join(" ")}\n`,
        ),
      },
    ];
  });
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles(files);
  await ready(page);
  await copyMode(page, 2);
  await page.getByRole("button", { name: "beta 1", exact: true }).click();
  await page.getByRole("button", { name: "gamma 1", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).text).toContain("gamma · t1 c2 · No data");
  const content = await clipboard(page);
  expect(content.html.match(/alt="Waveforms"/g)).toHaveLength(1);
  expect(content.html.match(/t1 c2 — No data/g)).toHaveLength(4);
  expect(content.html.match(/t1 c2 — No tetrode 1/g)).toHaveLength(4);
  expect(content.html.match(/t1 c2 — No position data/g)).toHaveLength(3);
  expect(
    (await page.evaluate(() => (window as any).recordingRequests)).filter(
      (r: any) => r.type === "load",
    ),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "beta 1", exact: true }).click();
  await page.getByRole("button", { name: "gamma 1", exact: true }).click();
  await expect.poll(async () => (await clipboard(page)).text).toContain("alpha · t1 c2 · 2 spikes");
  const single = await clipboard(page);
  expect(single.html).not.toContain("<table");
  expect(single.html).not.toContain("Waveforms from");
  expect(single.html).not.toContain("Trials and cuts:");
  expect(single.html).toContain("<b>alpha · t1 c2</b>");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Copy cells", exact: true })).toHaveCount(0);
  await expect(page.locator(".trial-block.copy-included")).toHaveCount(0);
  await page.getByRole("button", { name: "beta 1", exact: true }).click();
  await ready(page);
  await expect(page).toHaveTitle("beta [Waveform]");
});

test("secondary trials use their remembered edited cut without changing the primary session", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
  await ready(page);
  await destination(page, 2);
  await source(page, 1);
  await paintSources(page);
  await expect(page.getByRole("button", { name: "Select cell 1", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "demo_box-a 8", exact: true }).click();
  await ready(page);
  await copyMode(page, 1);
  const second = page.getByRole("button", { name: "demo_box-b 8", exact: true });
  await second.click();
  await expect
    .poll(async () => (await clipboard(page)).text)
    .toContain("demo_box-b · t1 c1 · No data");
  await expect(page).toHaveTitle("demo_box-a [Waveform]");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  // Choosing a different cut includes its trial and leaves the displayed recording alone.
  await second.getByRole("button", { name: "~_1.cut", exact: true }).click();
  await expect
    .poll(async () =>
      (await clipboard(page)).text
        .split("\n")
        .find((line) => line.startsWith("demo_box-b · t1 c1")),
    )
    .toMatch(/^demo_box-b · t1 c1(?: · (?!No data).+)?$/);
  await expect(second.getByRole("button", { name: "~_1.cut", exact: true })).toHaveClass(/active/);
  await expect(page).toHaveTitle("demo_box-a [Waveform]");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
