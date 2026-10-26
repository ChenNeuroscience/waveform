import { test, expect, type Page } from "@playwright/test";
import { ready } from "./controls";

async function demo(page: Page) {
  await page.goto("/");
  await page.getByText("Explore a synthetic demo").click();
  await ready(page);
}

test("hover preserves waveform pixels, aligns the badge and displays the sampling warning above the toolbar", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Waveform");
  await page.getByText("Explore a synthetic demo").click();
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
    warning = tile.locator(".sampling-warning"),
    badge = tile.locator(".tile-badge button"),
    bounds = (await tile.boundingBox())!;
  await page.locator(".desktop-toolbar").hover();
  await expect(warning).toBeHidden();
  const beforeBadge = await badge.boundingBox();
  const clip = { x: bounds.x + 25, y: bounds.y + 20, width: 400, height: 65 };
  const before = await page.screenshot({ clip });
  await tile.hover({ position: { x: 45, y: 45 } });
  await expect(warning).toHaveText("WARNING: using sampled rendering");
  await expect(warning).toBeVisible();
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
  await expect(copy.locator(".sampling-warning")).toBeVisible();
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
  await page
    .getByRole("button", { name: "demo_open-field 3", exact: true })
    .click();
  await ready(page);
  expect(await page.locator(".plot-copy").getAttribute("src")).toBe(png);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByLabel("isolate", { exact: true }).check();
  await page.getByRole("button", { name: "Waveforms", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
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
  await page.getByText("Explore a synthetic demo").click();
  await ready(page);
  const left = (await page.locator(".left-workspace").boundingBox())!;
  expect(left.width).toBe(563);
  await expect(page.getByLabel("isolate", { exact: true })).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Waveforms", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("slider", { name: "Maximum speed shown", exact: true }),
  ).toHaveValue("60");
  const restored = (await settings.boundingBox())!;
  expect(restored.x + restored.width).toBeLessThanOrEqual(900);
  expect(restored.y + restored.height).toBeLessThanOrEqual(650);
});

test("external file readiness uses the original 800 ms pivot animation; internal cut drags do not", async ({
  page,
}) => {
  await page.goto("/");
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
