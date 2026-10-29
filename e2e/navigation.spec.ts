import { destination, paintSources } from "./controls";
import { test, expect, type Page } from "@playwright/test";
import { ready } from "./controls";
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
  await page.getByRole("slider", { name: "Point size", exact: true }).fill("2");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  expect(await length(page)).toBe(navigations);
  expect(page.url()).toBe(url);
  await page.goBack();
  await ready(page);
  expect(await selection(page)).toEqual(other);
  await page.goForward();
  await ready(page);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
});
test("browser back cancels a split preview before restoring the recording", async ({ page }) => {
  await demo(page);
  const first = await selection(page);
  await page.getByRole("button", { name: "02", exact: true }).click();
  await ready(page);
  await page
    .locator('.cell-tile[data-cell="1"] .tile-waves')
    .click({ button: "right", position: { x: 30, y: 60 } });
  await expect(page.locator(".tile-marked")).toHaveCount(2);
  await page.goBack();
  await ready(page);
  expect(await selection(page)).toEqual(first);
  await expect(page.locator(".tile-marked")).toHaveCount(0);
  await page.goForward();
  await ready(page);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
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
test("opening files adds a history entry after the start screen; the file menu clears directly", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  const start = await length(page);
  const tryDemo = page.getByRole("button", { name: "Try it now with simulated data", exact: true });
  await tryDemo.click();
  await ready(page);
  expect(await length(page)).toBe(start + 1);
  await page.goBack();
  await expect(tryDemo).toBeVisible();
  await expect(page.locator(".desktop-toolbar")).toHaveCount(0);
  await tryDemo.click();
  await ready(page);
  const home = page.getByRole("button", { name: "Waveform menu", exact: true });
  await home.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "File actions", exact: true })).toHaveCount(0);
  await expect(page.locator(".desktop-toolbar")).toBeVisible();
  await home.click();
  await page.getByRole("menuitem", { name: "Clear files", exact: true }).click();
  await expect(tryDemo).toBeVisible();
  // The start screen is a new entry, so Back is still available.
  expect(await page.evaluate(() => history.state.waveform.selection)).toBeNull();
});
