import { test, expect } from "@playwright/test";

test("Space closes windows; copied tiles have one title and frozen stats only on hover", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByText("Explore a synthetic demo").click();
  await expect(
    page.getByRole("button", { name: "Export cut", exact: true }),
  ).toBeEnabled();
  const source = page.locator('.cell-tile[data-cell="1"]');
  await source.hover();
  await expect(page.locator(".position-path")).toHaveAttribute(
    "data-cell",
    "1",
  );
  const rect = (await source.boundingBox())!;
  await page.keyboard.down("Space");
  await source.locator(".tile-waves").click();
  await page.keyboard.up("Space");
  const copy = page
    .getByRole("dialog")
    .filter({ has: page.locator(".tile-copy") });
  await expect(copy).toHaveCount(1);
  const title = (await copy
    .locator(".floating-titlebar > span")
    .textContent())!;
  await expect(copy.getByText(title, { exact: true })).toHaveCount(1);
  await expect(
    copy.locator(".floating-content").getByText(title, { exact: true }),
  ).toHaveCount(0);
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
  await page.screenshot({ path: "test-results/copied-tile.png" });
  await image.hover();
  await expect(stats).toBeVisible();
  await expect(stats).toContainText("spikes");
  const frozen = await stats.textContent();
  expect(await image.getAttribute("src")).toBe(src);
  await page.screenshot({ path: "test-results/copied-tile-hover.png" });
  await copy.locator(".floating-titlebar").hover();
  await expect(stats).toBeHidden();
  await page.getByRole("button", { name: "02", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export cut", exact: true }),
  ).toBeEnabled();
  expect(await stats.textContent()).toBe(frozen);
  expect(await image.getAttribute("src")).toBe(src);
  await page.keyboard.down("Space");
  await image.click();
  await page.keyboard.up("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".plot-copy")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  // The same Space gesture closes tools without changing the controls underneath.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "File headers", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true }),
    headers = page.getByRole("dialog", { name: "File headers", exact: true });
  await page.keyboard.down("Space");
  await settings.getByText("Rendering", { exact: true }).click();
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
    const plot = page
      .getByRole("dialog")
      .filter({ has: page.locator(".plot-copy") });
    await expect(plot).toHaveCount(1);
    await page.keyboard.down("Space");
    await plot.locator(".plot-copy").click();
    await page.keyboard.up("Space");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
