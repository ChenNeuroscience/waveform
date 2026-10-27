import { destination, paintSources } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { ready } from "./controls";

async function demo(page: Page) {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
}

test("hover preserves waveform pixels and aligns the badge; tiles carry no sampling warning", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  await expect(page).toHaveTitle("Waveform");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await expect(page).toHaveTitle(/demo_.* \[Waveform\]/);
  await expect(page.locator(".toolbar-title")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export cut", exact: true }),
  ).toHaveCount(0);
  await page.locator(".tile-wall").evaluate((el) => (el.scrollTop = 0));
  await expect(page.locator(".tile-wave-canvas")).toHaveAttribute(
    "data-density",
    "ready",
  );
  const tile = page.locator('.cell-tile[data-cell="0"]'),
    badge = tile.locator(".tile-badge button"),
    bounds = (await tile.boundingBox())!;
  await page.locator(".desktop-toolbar").hover();
  const beforeBadge = await badge.boundingBox();
  const clip = { x: bounds.x + 25, y: bounds.y + 20, width: 400, height: 65 };
  const before = await page.screenshot({ clip });
  await tile.hover({ position: { x: 45, y: 45 } });
  // Only waveforms of tetrodes over 1M spikes are sampled, and that is flagged
  // once in the toolbar rather than on tiles.
  await expect(tile.locator(".sampling-warning")).toHaveCount(0);
  await expect(page.locator(".toolbar-warning")).toHaveCount(0);
  expect(await page.screenshot({ clip })).toEqual(before);
  expect(await badge.boundingBox()).toEqual(beforeBadge);
  const glow = page.locator("body > .tile-hover-glow");
  expect(await glow.boundingBox()).toEqual(bounds);
  expect(
    await glow.evaluate((el) => +getComputedStyle(el).zIndex),
  ).toBeGreaterThan(
    await page
      .locator(".desktop-toolbar")
      .evaluate((el) => parseInt(getComputedStyle(el).zIndex) || 0),
  );
  expect(
    await tile
      .locator(".tile-waves")
      .evaluate((el) => getComputedStyle(el).borderWidth),
  ).toBe("0px");
  await expect(tile.locator(".tile-speed canvas")).toBeVisible();
  const speed = (await tile.locator(".tile-speed canvas").boundingBox())!,
    square = beforeBadge!;
  expect(speed.y - square.y - square.height).toBe(5);
  await expect(tile.locator(".stat-label").last()).toHaveText("n spikes");
  await expect(tile.locator(".tile-caption")).not.toContainText(
    /ISI|mean rate/i,
  );
  await page.screenshot({ path: "test-results/original-hover-style.png" });
  await page.keyboard.down("Space");
  await tile.click({ position: { x: 45, y: 45 } });
  await page.keyboard.up("Space");
  const copy = page.locator(".tile-copy");
  await copy.hover();
  await expect(copy.locator(".sampling-warning")).toHaveCount(0);
  const cb = (await copy.boundingBox())!,
    sticker = (await copy.locator(".tile-copy-badge").boundingBox())!;
  expect(sticker.y - cb.y).toBe(3);
  expect(cb.x + cb.width - sticker.x - sticker.width).toBe(3);
});

test("feature corner labels survive Space copies; settings and divider positions restore and fit smaller screens", async ({
  page,
}) => {
  await demo(page);
  const labels = page.locator(".projection-labels > div");
  await expect(labels).toHaveCount(6);
  await expect(labels.first().locator(".axis-y")).toHaveText("A2");
  await expect(labels.first().locator(".axis-x")).toHaveText("A1");
  const grip = (await page.locator(".desktop-splitter").boundingBox())!;
  await page.mouse.move(grip.x + 3, grip.y + 60);
  await page.mouse.down();
  await page.mouse.move(600, grip.y + 60);
  await page.mouse.up();
  await expect(page.locator(".clusters")).toHaveAttribute("data-columns", "4");
  const frame = await page.locator(".clusters canvas").evaluate((el) => {
    const gl = (el as HTMLCanvasElement).getContext("webgl2")!;
    return Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array);
  });
  expect(frame[2]).toBe(frame[3]);
  await page.keyboard.down("Space");
  await page.locator(".feature-stage").click({ position: { x: 50, y: 50 } });
  await page.keyboard.up("Space");
  // Both corner labels must be drawn into the PNG, even where the raw GPU canvas is blank.
  const labelInk = await page.locator(".plot-copy").evaluate(async (el) => {
    const image = el as HTMLImageElement;
    await image.decode();
    const c = document.createElement("canvas");
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const ink = (x: number, y: number) => {
      const a = ctx.getImageData(x, y, 20, 13).data;
      let n = 0;
      for (let i = 0; i < a.length; i += 4)
        if (a[i] < 150 && a[i + 1] < 150 && a[i + 2] < 150) n++;
      return n;
    };
    return [ink(2, 2), ink(106, 113)];
  });
  for (const ink of labelInk) expect(ink).toBeGreaterThan(5);
  const png = await page.locator(".plot-copy").getAttribute("src");
  await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
  await ready(page);
  expect(await page.locator(".plot-copy").getAttribute("src")).toBe(png);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByRole("button", { name: "Waveforms", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings
    .getByRole("checkbox", { name: "Isolate selected cell", exact: true })
    .check();
  await page
    .getByRole("slider", { name: "Maximum speed shown", exact: true })
    .fill("60");
  const window = (await settings.boundingBox())!;
  await page.mouse.move(window.x + 50, window.y + 12);
  await page.mouse.down();
  await page.mouse.move(1100, 140, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("waveform-ui:panes") || "{}").left,
      ),
    )
    .toBe(600);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("waveform-ui:window:settings") || "{}",
          ).x,
      ),
    )
    .toBeGreaterThan(800);
  await page.setViewportSize({ width: 900, height: 650 });
  await page.reload();
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const left = (await page.locator(".left-workspace").boundingBox())!;
  expect(left.width).toBe(563);
  await expect(
    page.getByRole("button", { name: "Waveforms", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("slider", { name: "Maximum speed shown", exact: true }),
  ).toHaveValue("60");
  await expect(
    settings.getByRole("checkbox", {
      name: "Isolate selected cell",
      exact: true,
    }),
  ).toBeChecked();
  const restored = (await settings.boundingBox())!;
  expect(restored.x + restored.width).toBeLessThanOrEqual(900);
  expect(restored.y + restored.height).toBeLessThanOrEqual(650);
});

test("external file readiness uses the original 800 ms pivot animation; internal cut drags do not", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  const enter = (internal = false) =>
    page.locator(".desktop-app").evaluate((el, internal) => {
      const data = new DataTransfer();
      data.items.add(new File([""], "trial.1"));
      if (internal) data.setData("application/x-waveform-cut", "1");
      el.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
    }, internal);
  await enter(true);
  await expect(page.locator(".drop-title-wobble")).toHaveCount(0);
  await enter();
  const title = page.locator(".drop-title-wobble").first();
  await expect(title).toContainText(/drag & drop files here/i);
  const animation = await title.evaluate((el) => {
    const effect = el.getAnimations()[0].effect as KeyframeEffect;
    return {
      duration: effect.getTiming().duration,
      frames: effect.getKeyframes().length,
    };
  });
  expect(animation).toEqual({ duration: 800, frames: 11 });
  await page.locator(".desktop-app").dispatchEvent("dragleave");
  await expect(page.locator(".drop-title-wobble")).toHaveCount(0);
});

test("browser reload/close modifiers do not toggle plots before the leave warning; the path fills its pane", async ({
  page,
}) => {
  await demo(page);
  await destination(page, 2);
  await paintSources(page);
  await ready(page);
  const waves = page.getByRole("button", { name: "Waveforms", exact: true }),
    rate = page.getByRole("button", { name: "Spatial rate", exact: true });
  for (const modifiers of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ]) {
    for (const key of ["r", "w"])
      await page.evaluate(
        ({ key, modifiers }) =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }),
          ),
        { key, modifiers },
      );
    await expect(waves).toHaveAttribute("aria-pressed", "true");
    await expect(rate).toHaveAttribute("aria-pressed", "true");
  }
  expect(
    await page.evaluate(() =>
      window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("r");
  await expect(rate).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("r");
  await expect(rate).toHaveAttribute("aria-pressed", "true");
  const pane = (await page.locator(".position-pane").boundingBox())!,
    path = (await page.locator(".position-path canvas").boundingBox())!;
  expect(path.x).toBe(pane.x);
  expect(path.y).toBe(pane.y);
  expect(path.width).toBe(pane.width);
  expect(path.height).toBe(pane.height);
});

test("compact toolbar replaces the footer; feature grid centres without experimental controls or a numeric split form", async ({
  page,
}) => {
  await demo(page);
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  const details = page.getByRole("group", {
    name: "Recording details",
    exact: true,
  });
  await expect(details).toContainText(/\b1[78],\d{3}\b/);
  const toolbar = (await page.locator(".desktop-toolbar").boundingBox())!,
    status = (await details.boundingBox())!;
  expect(status.y).toBeGreaterThanOrEqual(toolbar.y);
  expect(status.y + status.height).toBeLessThanOrEqual(
    toolbar.y + toolbar.height,
  );
  expect(status.x).toBeGreaterThan(1000);
  await expect(page.locator(".feature-pane input[type=checkbox]")).toHaveCount(
    0,
  );
  await expect(page.locator(".wave-gate")).toHaveCount(0);
  await expect(
    page.getByText("Split by waveform sample", { exact: true }),
  ).toHaveCount(0);
  const centred = async () => {
    const stage = (await page.locator(".feature-stage").boundingBox())!,
      grid = (await page.locator(".clusters").boundingBox())!;
    const clientWidth = await page
      .locator(".feature-stage")
      .evaluate((el) => el.clientWidth);
    expect(
      Math.abs(grid.x - stage.x - (clientWidth - grid.width) / 2),
    ).toBeLessThanOrEqual(1);
    if (grid.height <= stage.height)
      expect(
        Math.abs(grid.y - stage.y - (stage.height - grid.height) / 2),
      ).toBeLessThanOrEqual(1);
    else expect(grid.y).toBe(stage.y); // Overflow must remain scrollable from the first row.
  };
  await centred();
  await page.setViewportSize({ width: 1440, height: 1500 });
  await centred();
  await page.screenshot({ path: "test-results/centred-feature-grid.png" });
});
