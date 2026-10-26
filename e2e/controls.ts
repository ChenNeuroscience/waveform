import { expect, type Page } from "@playwright/test";

export async function ready(page: Page, timeout = 30000) {
  await expect(page.locator(".desktop-app")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout },
  );
}

export async function exportCut(page: Page) {
  await ready(page);
  // Move focus out of edit fields without opening a tool window.
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+s");
}

export async function exportCutFromHistory(page: Page) {
  await ready(page);
  const panel = page.getByRole("dialog", { name: "Edit history", exact: true });
  const opened = !(await panel.isVisible());
  if (opened)
    await page
      .getByRole("button", { name: "Edit history", exact: true })
      .click();
  await panel.getByRole("button", { name: "Export .cut", exact: true }).click();
  if (opened)
    await panel
      .getByRole("button", { name: "Close panel", exact: true })
      .click();
}

export async function setDensity(page: Page, enabled: boolean) {
  const panel = page.getByRole("dialog", { name: "Settings", exact: true });
  const opened = !(await panel.isVisible());
  if (opened)
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await panel
    .getByRole("checkbox", { name: "Density rendering", exact: true })
    .setChecked(enabled);
  if (opened)
    await panel
      .getByRole("button", { name: "Close panel", exact: true })
      .click();
}
