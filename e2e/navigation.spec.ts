import { settingsSection, destination, paintSources, ready } from "./controls";
import { test, expect, type Page } from "@playwright/test";
const selection = (page: Page) =>
  page.evaluate(
    () =>
      history.state.waveform.selection as {
        trialId: string;
        tetNum: number;
        cutId: string;
      },
  );
const length = (page: Page) => page.evaluate(() => history.length);
async function demo(page: Page) {
  await page.goto("/?demo=quick");
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page);
}
test("browser back/forward restores only trial, tetrode and cut choices", async ({ page }) => {
  await demo(page);
  const url = page.url(),
    initial = await selection(page),
    start = await length(page);
  await page.getByRole("button", { name: "01", exact: true }).click();
  expect(await length(page)).toBe(start);
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  const second = await selection(page);
  expect(second.tetNum).toBe(2);
  await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
  await ready(page);
  const other = await selection(page);
  expect(other.trialId).not.toBe(initial.trialId);
  expect(other.tetNum).toBe(2);
  await page.getByRole("button", { name: "demo_box-b tetrode 2", exact: true }).click();
  await ready(page);
  expect((await selection(page)).cutId).toBe("");
  await page.getByRole("button", { name: "02", exact: true }).click();
  expect((await selection(page)).cutId).toBe("");
  expect(await length(page)).toBe(start + 3);
  for (const target of [other, second, initial]) {
    await page.goBack();
    await ready(page);
    expect(await selection(page)).toEqual(target);
  }
  for (const target of [second, other]) {
    await page.goForward();
    await ready(page);
    expect(await selection(page)).toEqual(target);
  }
  await page.goForward();
  await ready(page);
  expect((await selection(page)).cutId).toBe("");
  const navigations = await length(page);
  await destination(page, 1);
  await paintSources(page);
  await ready(page);
  expect((await selection(page)).cutId).not.toBe(""); // New cut replaces this entry.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await ready(page);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await ready(page);
  await page
    .getByRole("button", { name: "Waveforms", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsSection(page, "Cluster plots");
  await page.getByRole("slider", { name: "PCA fit sample size", exact: true }).fill("1000");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  expect(await length(page)).toBe(navigations);
  expect(page.url()).toBe(url);
  await page.goBack();
  await ready(page);
  expect(await selection(page)).toEqual(other);
  await page.goForward();
  await ready(page);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();

  // The earlier preference check hid waveforms; restore them before splitting.
  const waves = page.getByRole("button", { name: "Waveforms", exact: true });
  if ((await waves.getAttribute("aria-pressed")) !== "true") {
    await waves.click({ modifiers: ["Shift"] });
  }
  const splitFrom = await selection(page);
  await page.getByRole("button", { name: "01", exact: true }).click();
  await ready(page);
  await page
    .locator('.cell-tile[data-cell="1"] .tile-waves')
    .click({ button: "right", position: { x: 30, y: 60 } });
  await expect(page.locator(".tile-marked")).toHaveCount(2);
  await page.goBack();
  await ready(page);
  expect(await selection(page)).toEqual(splitFrom);
  await expect(page.locator(".tile-marked")).toHaveCount(0);
});

test("arrow keys step trials (up/down), tetrodes (left/right) and a tetrode's cuts (shift)", async ({
  page,
}) => {
  await demo(page);
  await page.mouse.move(5, 1000);
  const start = await selection(page);
  expect(start.tetNum).toBe(1);
  expect(start.cutId).not.toBe("");
  const press = async (key: string) => {
    await page.keyboard.press(key);
    await ready(page);
  };
  await press("ArrowRight");
  await expect.poll(async () => (await selection(page)).tetNum).toBe(2);
  expect((await selection(page)).trialId).toBe(start.trialId);
  await press("ArrowLeft");
  await expect.poll(async () => (await selection(page)).tetNum).toBe(1);
  // No tetrode before the first: the selection stays put.
  await press("ArrowLeft");
  expect((await selection(page)).tetNum).toBe(1);
  await press("ArrowDown");
  await expect.poll(async () => (await selection(page)).trialId).not.toBe(start.trialId);
  expect((await selection(page)).tetNum).toBe(1);
  await press("ArrowUp");
  await expect.poll(async () => (await selection(page)).trialId).toBe(start.trialId);
  // Shift steps within the tetrode: no cut comes before the cut files.
  await press("Shift+ArrowLeft");
  await expect.poll(async () => (await selection(page)).cutId).toBe("");
  await press("Shift+ArrowLeft");
  expect((await selection(page)).cutId).toBe("");
  await press("Shift+ArrowRight");
  await expect.poll(async () => (await selection(page)).cutId).toBe(start.cutId);
  expect((await selection(page)).tetNum).toBe(1);
});
