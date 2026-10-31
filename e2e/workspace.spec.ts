import { ready } from "./controls";
import { test, expect } from "@playwright/test";
test("Production subpath, Wasm loading and mobile welcome", async ({ page, context }) => {
  await test.step("Load the deployed app and Wasm", async () => {
    await page.goto("http://127.0.0.1:4174/waveform/?demo=quick");
    await page.getByText("Try it now with simulated data").click();
    await ready(page, 30000);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/^1[78],\d{3}$/)).toBeVisible();
  });
  await test.step("Mobile welcome", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?demo=quick");
    await expect(page.getByRole("button", { name: "Browse files", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});
