import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { ready } from "./controls";

async function demo(page: Page) {
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
}

test("Waveform menu offers both additive pickers and clear files; keyboard focus stays within the menu", async ({
  page,
}, testInfo) => {
  await demo(page);
  const trigger = page.getByRole("button", { name: "Waveform menu", exact: true });
  const menu = page.getByRole("menu", { name: "File actions", exact: true });
  await trigger.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Add folder…", "Add files…", "Clear files"]);
  await expect(menu.getByRole("menuitem", { name: "Add folder…", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Add files…", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("button", { name: "Browse files", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open a folder", exact: true })).toHaveCount(0);

  // A closed menu trigger must not swallow the normal tool shortcut.
  const brush = page.getByRole("button", { name: "Paint source spikes", exact: true });
  const lasso = page.getByRole("button", { name: "Lasso cut", exact: true });
  await page.keyboard.press("l");
  await expect(lasso).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("l");
  await expect(brush).toHaveAttribute("aria-pressed", "true");

  await trigger.click();
  const [files] = await Promise.all([
    page.waitForEvent("filechooser"),
    menu.getByRole("menuitem", { name: "Add files…", exact: true }).click(),
  ]);
  expect(await files.element().getAttribute("aria-label")).toBe("Import recording files");
  await files.setFiles({
    name: "demo_box-a.eeg",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("auxiliary"),
  });
  await expect(page.getByRole("button", { name: "demo_box-a 8", exact: true })).toContainText(
    "1 other file",
  );
  await expect(page).toHaveTitle("demo_box-a [Waveform]");
  await expect(page.locator(".trial-block")).toHaveCount(5);
  await trigger.click();
  const [folder] = await Promise.all([
    page.waitForEvent("filechooser"),
    menu.getByRole("menuitem", { name: "Add folder…", exact: true }).click(),
  ]);
  expect(await folder.element().getAttribute("aria-label")).toBe("Import recording folder");
  const directory = testInfo.outputPath("recording-folder");
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/folder-added.set`, "duration 20\n");
  await folder.setFiles(directory);
  await expect(page.getByRole("button", { name: "folder-added 0", exact: true })).toBeVisible();
  await expect(page.locator(".trial-block")).toHaveCount(6);
  await expect(page).toHaveTitle("demo_box-a [Waveform]");
  await trigger.click();
});
