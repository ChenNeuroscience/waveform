import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ready, exportCut } from "./controls";

test("the simulated-files card starts the demo on click", async ({ page }) => {
  await page.goto("/?demo=quick");
  await expect(page.locator(".demo-file-card")).toHaveCount(3);
  await expect(page.locator(".demo-files")).toHaveAttribute("draggable", "false");
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page);
  await expect(page.getByRole("group", { name: "Recording details", exact: true })).toContainText(
    /\b1[78],\d{3}\b/,
  );
  await expect(page.locator(".toolbar-status")).not.toContainText("Local files");
});

for (const millions of [1, 9]) {
  test(`the ${millions}M stress demo preserves every exported assignment through merge/undo`, async ({
    page,
  }) => {
    test.skip(
      millions === 9 && process.env.WAVEFORM_STRESS_9M !== "1",
      "Opt in with WAVEFORM_STRESS_9M=1.",
    );
    test.setTimeout(180000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(millions === 9 ? "/?demo=stress-9m" : "/?demo=stress");
    await expect(
      page.getByRole("button", {
        name: "Try it now with simulated data",
        exact: true,
      }),
    ).toContainText(`${millions} million spikes`);
    const start = Date.now();
    await page
      .getByRole("button", {
        name: "Try it now with simulated data",
        exact: true,
      })
      .click();
    await ready(page, 120000);
    console.log(`Generated ${millions}M demo ready: ${Date.now() - start}ms`);
    await expect(page.locator(".toolbar-status")).toContainText(
      millions === 9 ? /\b(8,99\d|9,00\d),\d{3}\b/ : /\b(99\d,\d{3}|1,00\d,\d{3})\b/,
    );
    if (millions === 9)
      await expect(page.locator(".toolbar-warning")).toContainText("waveforms sampled");
    await expect(page.locator(".trial-block")).toHaveCount(5);
    await expect(page.locator('.group-selector [data-group="100"]')).toHaveCount(1);
    const hashExport = async () => {
      const [file] = await Promise.all([page.waitForEvent("download"), exportCut(page)]);
      return createHash("sha256")
        .update(await readFile((await file.path())!))
        .digest("hex");
    };
    const before = await hashExport();
    const from = (await page.locator('.cell-tile[data-cell="1"] .tile-waves').boundingBox())!;
    const to = (await page.locator('.cell-tile[data-cell="2"] .tile-waves').boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + 45);
    await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + 45, { steps: 8 });
    await page.mouse.up();
    await ready(page);
    await expect(page.locator('.group-selector [data-group="2"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await ready(page);
    expect(await hashExport()).toBe(before);
    await page.getByRole("button", { name: "02", exact: true }).click();
    await ready(page);
    await page.getByRole("button", { name: "01", exact: true }).click();
    await ready(page);
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test("the normal demo is a twenty-minute box experiment with typical spike and cell counts", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".demo-files")).toContainText("~50k spikes/tetrode");
  await page
    .getByRole("button", {
      name: "Try it now with simulated data",
      exact: true,
    })
    .click();
  await ready(page);
  await expect(page.locator(".toolbar-status")).toContainText(/\b(49|50),\d{3}\b/);
  await expect(page.locator(".position-time")).toContainText("20 min 0 sec");
  await expect(page.locator(".trial-block")).toHaveCount(5);
  for (const trial of await page.locator(".trial-block").all())
    await expect(trial.locator(".tetrode-file-block")).toHaveCount(8);
  await expect(page.locator('.group-selector [data-group="24"]')).toHaveCount(1);
  await expect(page.locator('.cell-tile[data-cell="25"]')).toHaveCount(0);
  await expect(page.locator('.painting-destination [data-group="25"]')).toHaveCount(1);
  await page.screenshot({ path: "test-results/simulated-box-experiment.png" });
});
