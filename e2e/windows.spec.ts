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

test("Pane shortcuts, frozen Space captures, cell clipboard and virtualised drag cancellation", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await test.step("Pane and frozen captures", async () => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?demo=quick");
    await page.getByText("Try it now with simulated data").click();
    await ready(page);
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
    const history = page.getByRole("dialog", { name: "Edit history", exact: true });
    await page.keyboard.press("k");
    await expect(help).toBeVisible();
    await page.keyboard.press("k");
    await expect(help).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(history).toBeVisible();
    await expect(
      history.getByText("Each cut keeps its own undo and redo history", { exact: false }),
    ).toHaveCount(0);
    const actions = history.getByRole("group", { name: "History actions", exact: true });
    await expect(actions.getByRole("button")).toHaveText(["", ""]);
    await expect(actions.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await expect(actions.getByRole("button", { name: "Redo", exact: true })).toBeDisabled();
    await page.keyboard.press("z");
    await expect(history).toHaveCount(0);
    await page.keyboard.press("k");
    await page.keyboard.press("z");
    await expect(help).toBeVisible();
    await expect(history).toBeVisible();
    await page.keyboard.press("k");
    await expect(help).toHaveCount(0);
    await expect(history).toBeVisible();
    await page.keyboard.press("k");
    await page.keyboard.press("z");
    await expect(history).toHaveCount(0);
    await expect(help).toBeVisible();

    await page.keyboard.press("k");
    await expect(help).toHaveCount(0);

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
    expect(title).toBe("demo_box-a · t1 c1");
    await expect(copy.getByText(title, { exact: true })).toHaveCount(1);
    await expect(copy.locator(".floating-content").getByText(title, { exact: true })).toHaveCount(
      0,
    );
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
    await settings.locator(".floating-titlebar").click();
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
  await test.step("Clipboard and virtualised wall", async () => {
    await page.getByRole("button", { name: "01", exact: true }).click();

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
    await preview.close();
    const wave = page.locator('.cell-tile[data-cell="1"] .tile-waves');
    const rect = (await wave.boundingBox())!;
    await page.mouse.move(rect.x + 65, rect.y + 45);
    await page.mouse.down();
    await page.mouse.move(rect.x + 85, rect.y + 45, { steps: 3 });
    await page.locator(".tile-wall").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.locator('.cell-tile[data-cell="1"]')).toHaveCount(0);
    await page.mouse.move(20, 20, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator('.cell-tile[data-cell="1"]')).toBeVisible();
    await expect(page.locator(".tile-drag-placeholder, .tile-drag-ghost")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  });
});
