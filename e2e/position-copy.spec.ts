import { test, expect, type Page } from "@playwright/test";
import { ready } from "./controls";

async function clipboard(page: Page) {
  try {
    return await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return {
        html: await (await item.getType("text/html")).text(),
        text: await (await item.getType("text/plain")).text(),
      };
    });
  } catch {
    return { html: "", text: "" };
  }
}

test("Position and spatial-autocorrelation plots, multi-trial path clipboard and legends", async ({
  page,
  context,
}) => {
  await test.step("Copy paths across trials", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?demo=quick");
    await page.getByText("Try it now with simulated data").click();
    await ready(page);
    await expect(page.locator(".position-path canvas")).toBeVisible();
    await page.locator(".position-path canvas").hover();
    await page.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(async () => (await clipboard(page)).html)
      .toContain('alt="Position path · demo_box-a"');
    let content = await clipboard(page);
    expect(content.text).toContain("demo_box-a · t1 · 10 min 0 sec");
    expect(content.html).toContain('width="160"');
    expect(content.html).not.toContain("<table");
    expect(content.html).not.toContain("Waveforms");
    expect(content.html).not.toContain("■");

    await page.keyboard.down("ControlOrMeta");
    await page.keyboard.down("c");
    await page.waitForTimeout(600);
    await page.keyboard.down("c");
    await page.keyboard.up("c");
    await page.keyboard.up("ControlOrMeta");
    await expect(
      page.getByRole("region", { name: "Copy position paths", exact: true }),
    ).toBeVisible();
    await expect(page.locator('.cell-tile[data-cell="2"]')).toHaveClass(/tile-muted/);
    await page.locator('.cell-tile[data-cell="2"]').click();
    await page.locator('.cell-tile[data-cell="3"]').click();
    await expect(page.locator(".position-path")).toHaveAttribute("data-cells", "2,3");
    await expect(page.locator('.cell-tile[data-cell="2"]')).not.toHaveClass(
      /tile-muted|tile-marked/,
    );
    await expect(page.locator('.cell-tile[data-cell="1"]')).toHaveClass(/tile-muted/);
    await page.getByRole("button", { name: "demo_box-b 8", exact: true }).click();
    await expect.poll(async () => (await clipboard(page)).text).toContain("demo_box-b · t1");
    content = await clipboard(page);
    expect(content.html.match(/alt="Position path ·/g)).toHaveLength(2);
    expect(content.html.match(/alt="Speed dwell ·/g)).toHaveLength(2);
    expect(content.html.match(/t1 c2/g)).toHaveLength(1);
    expect(content.html.match(/t1 c3/g)).toHaveLength(1);
    expect(content.html.match(/■/g)).toHaveLength(2);
    expect(content.html).not.toMatch(/<table|Waveforms|Spatial rate map/);
    expect(content.html.indexOf("t1 c2")).toBeGreaterThan(content.html.lastIndexOf("<img"));
    await expect(page).toHaveTitle("demo_box-a [Waveform]");

    expect(errors).toEqual([]);
  });
  await test.step("Spatial autocorrelograms and plot toggles", async () => {
    await page.keyboard.press("Escape");

    const toggle = page.getByRole("button", { name: "Spatial autocorrelation", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".tile-sc")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("title", /\[A\]/);
    await page.keyboard.press("a");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Waveforms", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.keyboard.press("Shift+a");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // C retains its existing head-direction shortcut.
    await page.keyboard.press("c");
    await expect(page.getByRole("button", { name: "Head direction", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("r");
    await page.keyboard.press("Shift+a");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Spatial rate", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.locator(".cell-tile").first().locator(".tile-spatial + .tile-sc"),
    ).toBeVisible();
    await expect(
      page.locator(".cell-tile").first().getByLabel("Spatial autocorrelogram"),
    ).toBeVisible();
    await page.getByRole("button", { name: "demo_box-a tetrode 5", exact: true }).click();
    await ready(page);
    await page
      .locator('.trial-block.selected .tetrode-file-block[data-tetrode="5"] .cut-file')
      .click();
    await ready(page);
    await page.getByRole("button", { name: "Spatial rate", exact: true }).click();
    await toggle.click({ modifiers: ["Shift"] });
    await expect(page.locator(".cell-tile").nth(5)).toBeVisible();
    await expect(page.locator(".tile-sc canvas").first()).toBeVisible();
    await page.waitForTimeout(250);
  });
});
