import { expect, type Page } from "@playwright/test";

export async function ready(page: Page, timeout = 30000) {
  await expect(page.locator(".desktop-app")).toHaveAttribute("data-ready", "true", { timeout });
}

export async function destination(page: Page, group: number) {
  await ready(page);
  const active = page.locator(".painting-destination button");
  if ((await active.getAttribute("data-group")) === String(group)) return;
  const chip = page.locator(`.group-selector button[data-group="${group}"]`);
  if (await chip.count()) await chip.click();
  else await page.getByRole("button", { name: "New destination group", exact: true }).click();
  await expect(active).toHaveAttribute("data-group", String(group));
}

/** Make `group` the only painting source (right-click its chip). */
export async function source(page: Page, group: number) {
  await ready(page);
  await page
    .locator(`.group-selector button[data-group="${group}"]`)
    .first()
    .click({ button: "right" });
  await expect(page.locator(".painting-sources button[data-group]")).toHaveAttribute(
    "data-group",
    String(group),
  );
}

// Paint the entire projection to exercise the same multi-source transfer path
// as a region edit, without relying on the removed numeric/merge controls.
export async function paintSources(page: Page) {
  await ready(page);
  await page.getByRole("button", { name: "Lasso cut", exact: true }).click();
  const plot = page.locator(".projection-labels > div").nth(0);
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + 1);
  await page.mouse.down();
  for (const [x, y] of [
    [127, 1],
    [127, 127],
    [1, 127],
    [1, 1],
  ])
    await page.mouse.move(box.x + x, box.y + y, { steps: 2 });
  await page.mouse.up();
  await ready(page);
  await page.getByRole("button", { name: "Paint source spikes", exact: true }).click();
}

export async function adjacentSwap(page: Page, source: number, delta: number) {
  await ready(page);
  await page.locator(`.cell-tile[data-cell="${source}"]`).hover();
  await page.keyboard.press("s");
  await page
    .getByRole("button", {
      name: `Swap ${delta < 0 ? "−1" : "+1"} (empty ${source + delta})`,
      exact: true,
    })
    .click();
  await ready(page);
}

export async function exportCut(page: Page) {
  await ready(page);
  const panel = page.getByRole("dialog", { name: "Edit history", exact: true });
  const opened = !(await panel.isVisible());
  // A real click supplies browser activation for repeated downloads; the
  // application export remains the ordinary Ctrl/Cmd-S keyboard command.
  await page.getByRole("button", { name: "Edit history", exact: true }).click();
  await Promise.all([page.waitForEvent("download"), page.keyboard.press("ControlOrMeta+s")]);
  if (opened) await panel.getByRole("button", { name: "Close panel", exact: true }).click();
}

export async function setDensity(page: Page, enabled: boolean) {
  const toggle = page.getByRole("button", { name: "Density rendering", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== String(enabled)) {
    await page
      .getByRole("button", { name: enabled ? "Density rendering" : "Fixed colours", exact: true })
      .click();
  }
  await expect(toggle).toHaveAttribute("aria-pressed", String(enabled));
}
