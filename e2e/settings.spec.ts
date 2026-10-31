import { test, expect } from "@playwright/test";
import { ready, settingsSection } from "./controls";
import { defaultSettings } from "../src/types";

test("settings sections fit their content and clipboard settings restore together", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Settings", exact: true });
  const position = panel.getByRole("button", { name: "Position processing", exact: true });
  await expect(position).toHaveAttribute("aria-expanded", "true");
  await settingsSection(page, "Spatial rate map");
  await expect(position).toHaveAttribute("aria-expanded", "false");
  const steps = panel.getByRole("slider", { name: "Rate-map colour steps", exact: true });
  await steps.fill("9");
  await panel.getByRole("slider", { name: "Spatial bin width", exact: true }).fill("4.5");
  await expect
    .poll(() =>
      panel.locator(".floating-content").evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBeLessThanOrEqual(1);
  await panel.screenshot({ path: "test-results/settings-spatial.png" });
  const expandedHeight = (await panel.boundingBox())!.height;
  await panel.getByRole("button", { name: "Spatial rate map", exact: true }).click();
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeLessThan(expandedHeight - 100);
  await settingsSection(page, "Cluster plots");
  await panel.getByRole("slider", { name: "PCA fit sample size", exact: true }).fill("1000");
  await panel.getByRole("button", { name: "Copy settings", exact: true }).click();
  const toast = page.locator(".desktop-notice");
  await expect(toast).toHaveText("Settings copied.");
  const saved = await page.evaluate(() => navigator.clipboard.readText());
  expect(saved).toContain("waveform-settings: 1\npcaSamples: 1000\nrenderMode: density\n");
  expect(saved).toContain("binCm: 4.5\n");
  expect(saved).toContain("rateMapSteps: 9\n");
  await panel.getByRole("button", { name: "Reset settings", exact: true }).click();
  const settings = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("waveform-desktop-settings") || "{}"));
  await expect.poll(settings).toEqual(defaultSettings);
  await panel.getByRole("button", { name: "Restore settings", exact: true }).click();
  await expect(toast).toHaveText("Settings restored.");
  await expect
    .poll(settings)
    .toEqual({ ...defaultSettings, pcaSamples: 1000, binCm: 4.5, rateMapSteps: 9 });
  await expect(toast).toBeHidden({ timeout: 6500 });

  await page.evaluate(() => navigator.clipboard.writeText("not settings"));
  await panel.getByRole("button", { name: "Restore settings", exact: true }).click();
  await expect(toast).toHaveAttribute("role", "alert");
  await expect(toast).toContainText("Could not restore settings");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(
    (value) => navigator.clipboard.writeText(value),
    saved.replace("binCm: 4.5", "binCm: -1"),
  );
  await panel.getByRole("button", { name: "Restore settings", exact: true }).click();
  await expect(toast).toContainText("Invalid value for binCm");
  await expect
    .poll(settings)
    .toEqual({ ...defaultSettings, pcaSamples: 1000, binCm: 4.5, rateMapSteps: 9 });
  await expect(toast).toBeHidden({ timeout: 6500 });
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "readText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Denied", "NotAllowedError")),
    });
  });
  await panel.getByRole("button", { name: "Restore settings", exact: true }).click();
  await expect(toast).toContainText("Could not read the clipboard");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(() => {
    delete (navigator.clipboard as any).readText;
  });
  await page.evaluate((value) => navigator.clipboard.writeText(value), saved);
  await panel.getByRole("button", { name: "Restore settings", exact: true }).click();
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toHaveText("Settings restored.");
  await panel.screenshot({ path: "test-results/settings-cluster.png" });
  await page.setViewportSize({ width: 800, height: 500 });
  await settingsSection(page, "Spatial rate map");
  await expect
    .poll(async () => {
      const box = (await panel.boundingBox())!;
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(500);
  await panel.getByRole("slider", { name: "Rate-map colour steps", exact: true }).fill("7");
});
