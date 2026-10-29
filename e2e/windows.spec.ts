import { ready } from "./controls";
import { test, expect, type Page } from "@playwright/test";

/** The clipboard's HTML and plain text. */
async function readClipboard(page: Page) {
  return page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const html = await (await item.getType("text/html")).text();
    const text = await (await item.getType("text/plain")).text();
    return { html, text, types: item.types };
  });
}

test("Space closes windows; copied tiles have one title and frozen stats only on hover", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const source = page.locator('.cell-tile[data-cell="1"]');
  await source.hover();
  await expect(page.locator(".position-path")).toHaveAttribute("data-cell", "1");
  const rect = (await source.boundingBox())!;
  await page.keyboard.down("Space");
  await source.locator(".tile-waves").click();
  await page.keyboard.up("Space");
  const copy = page.getByRole("dialog").filter({ has: page.locator(".tile-copy") });
  await expect(copy).toHaveCount(1);
  const title = (await copy.locator(".floating-titlebar > span").textContent())!;
  await expect(copy.getByText(title, { exact: true })).toHaveCount(1);
  await expect(copy.locator(".floating-content").getByText(title, { exact: true })).toHaveCount(0);
  const image = copy.locator(".plot-copy"),
    stats = copy.getByLabel("Copied cell statistics"),
    src = await image.getAttribute("src");
  const dimensions = await image.evaluate((el) => ({
    w: (el as HTMLImageElement).naturalWidth,
    h: (el as HTMLImageElement).naturalHeight,
    dpr: Math.min(2, devicePixelRatio || 1),
  }));
  // A title strip or baked hover panel must not add another row to the plot image.
  expect(dimensions.h).toBe(rect.height * dimensions.dpr);
  expect(dimensions.w).toBe(rect.width * dimensions.dpr);
  await page.locator(".desktop-toolbar").hover();
  await expect(stats).toBeHidden();
  await page.screenshot({ path: "test-results/copied-tile.png" });
  await image.hover();
  await expect(stats).toBeVisible();
  await expect(stats).toContainText("spikes");
  expect(await copy.evaluate((el) => getComputedStyle(el).resize)).toBe("none");
  const beforeDrag = (await copy.boundingBox())!,
    content = (await image.boundingBox())!;
  await page.mouse.move(content.x + 70, content.y + 40);
  await page.mouse.down();
  await page.mouse.move(content.x - 40, content.y + 90, { steps: 4 });
  await page.mouse.up();
  const afterDrag = (await copy.boundingBox())!;
  expect(afterDrag.x - beforeDrag.x).toBe(-110);
  expect(afterDrag.y - beforeDrag.y).toBe(50);
  expect(afterDrag.width).toBe(beforeDrag.width);
  expect(afterDrag.height).toBe(beforeDrag.height);
  const frozen = await stats.textContent();
  expect(await image.getAttribute("src")).toBe(src);
  await page.screenshot({ path: "test-results/copied-tile-hover.png" });
  await copy.locator(".floating-titlebar").hover();
  await expect(stats).toBeHidden();
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  expect(await stats.textContent()).toBe(frozen);
  expect(await image.getAttribute("src")).toBe(src);
  await page.keyboard.down("Space");
  await image.click();
  await page.keyboard.up("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".plot-copy")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  // The same Space gesture closes tools without changing the controls underneath.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "File headers", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true }),
    headers = page.getByRole("dialog", { name: "File headers", exact: true });
  await page.keyboard.down("Space");
  await settings.getByText("Rendering", { exact: true }).click();
  await page.keyboard.up("Space");
  await expect(settings).toHaveCount(0);
  await expect(headers).toBeVisible();
  await page.keyboard.down("Space");
  await headers.locator(".floating-titlebar").click();
  await page.keyboard.up("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const selector of [".position-path", ".feature-stage"]) {
    await page.keyboard.down("Space");
    await page.locator(selector).click();
    await page.keyboard.up("Space");
    const plot = page.getByRole("dialog").filter({ has: page.locator(".plot-copy") });
    await expect(plot).toHaveCount(1);
    await page.keyboard.down("Space");
    await plot.locator(".plot-copy").click();
    await page.keyboard.up("Space");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("Copying a cell puts its text and each plot separately on the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await page.locator('.cell-tile[data-cell="1"] .tile-badge button').click();
  await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(async () => (await readClipboard(page).catch(() => ({ text: "" }))).text)
    .toMatch(/t1 c1 · /);
  const clipboard = await readClipboard(page);
  expect(clipboard.types).not.toContain("image/png");
  expect(clipboard.text).toMatch(/t\d+ c1 · [\d,]+ spikes/);
  expect(clipboard.html).toContain("<b>demo_box-a · t1 c1</b>");
  expect(clipboard.html).not.toContain("<table");
  expect(clipboard.html).not.toContain("Waveforms from");
  expect(clipboard.html).not.toContain("Trials and cuts:");
  expect(clipboard.text.split("\n")).toHaveLength(1);
  const alts = [...clipboard.html.matchAll(/<img[^>]*alt="([^"]+)"/g)].map(
    (m) => m[1].split(" · ")[0],
  );
  expect(alts).toEqual([
    "Waveforms",
    "Spatial rate map",
    "Head direction",
    "Speed",
    "Autocorrelation",
  ]);
  const preview = await context.newPage();
  await preview.setContent(
    `<div style="display:inline-block;font:11px Arial;">${clipboard.html}</div>`,
  );
  const plots = preview.locator("p").filter({ has: preview.locator("img") });
  await expect(plots).toHaveCount(1);
  await expect(plots.locator("img")).toHaveCount(5);
  await preview
    .locator("img")
    .evaluateAll((images) =>
      Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
    );
  await preview.locator("div").screenshot({ path: "test-results/single-trial-clipboard.png" });
  await preview.close();
});

test("holding Cmd/Ctrl C opens copy mode, which keeps the clipboard in step", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const tile = (n: number) => page.locator(`.cell-tile[data-cell="${n}"]`);
  // A read can race a write still landing; poll again.
  const lines = async () =>
    (await readClipboard(page).catch(() => ({ text: "" }))).text
      .split("\n")
      .filter((line) => /· t\d+ c\d+ ·/.test(line));
  await tile(2).hover();
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.down("c");
  await page.waitForTimeout(1100);
  await page.keyboard.down("c"); // A key repeat while held.
  await page.keyboard.up("c");
  await page.keyboard.up("ControlOrMeta");
  const prompt = page.getByRole("region", { name: "Copy cells", exact: true });
  await expect(prompt).toContainText("(1 cell on the clipboard)");
  await expect(tile(2)).toHaveClass(/tile-marked/);
  await expect(tile(3)).toHaveClass(/tile-muted/);
  await expect.poll(lines).toEqual([expect.stringMatching(/t1 c2 · /)]);
  await tile(3).click();
  await expect(prompt).toContainText("(2 cells on the clipboard)");
  await expect
    .poll(lines)
    .toEqual([expect.stringMatching(/t1 c2 · /), expect.stringMatching(/t1 c3 · /)]);
  await tile(2).click();
  await expect.poll(lines).toEqual([expect.stringMatching(/t1 c3 · /)]);
  // Select all includes tiles scrolled out of view, each with its own plots.
  await prompt.getByRole("button", { name: /Select all/ }).click();
  await expect.poll(async () => (await lines()).length).toBeGreaterThan(3);
  const { html, text } = await readClipboard(page);
  const count = text.split("\n").filter((line) => /· t\d+ c\d+ ·/.test(line)).length;
  expect(html.match(/alt="Waveforms"/g)).toHaveLength(count);
  expect(html.match(/alt="Autocorrelation"/g)).toHaveLength(count);
  // Leaving the window ends copy mode and vignettes the window until it returns.
  const app = page.locator(".desktop-app");
  await expect(app).not.toHaveClass(/unfocused/);
  await page.evaluate(() => dispatchEvent(new Event("blur")));
  await expect(prompt).toHaveCount(0);
  await expect(app).toHaveClass(/unfocused/);
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect(app).not.toHaveClass(/unfocused/);
  await tile(2).hover();
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.down("c");
  await page.waitForTimeout(1100);
  await page.keyboard.down("c");
  await page.keyboard.up("c");
  await page.keyboard.up("ControlOrMeta");
  await expect(prompt).toBeVisible();
  // Escape ends copy mode first; then it hides and shows the toolbar.
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await expect(page.locator(".tile-muted")).toHaveCount(0);
  await expect(page.locator(".desktop-toolbar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".desktop-toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Show toolbar", exact: true }).click();
  await expect(page.locator(".desktop-toolbar")).toBeVisible();
});
