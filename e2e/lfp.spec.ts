import { test, expect } from "@playwright/test";
import { ready } from "./controls";

const egf = (header: string, n: number) => ({
  name: header,
  mimeType: "application/octet-stream",
  buffer: Buffer.concat([
    Buffer.from(`num_chans 1\r\nsample_rate 5000 hz\r\nnum_EEG_samples ${n}\r\ndata_start`),
    Buffer.from(Int8Array.from({ length: n }, (_, i) => Math.round(40 * Math.sin(i / 90))).buffer),
  ]),
});

test(".egf files: the selected number is kept across trials, shown missing where absent, and its frequency distribution drawn", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=quick");
  await page.getByRole("button", { name: "Try it now with simulated data" }).click();
  await ready(page, 60000);
  const chip = (trial: string, name: string) =>
    page.getByRole("button", { name: `${trial} ${name}`, exact: true });

  // Each simulated trial has two; the first is selected, the second collapsed.
  await expect(chip("demo_box-a", "~.egf")).toHaveClass(/expanded/);
  await expect(chip("demo_box-a", "~.egf")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("demo_box-a", "~.egf2")).not.toHaveClass(/expanded/);
  const plot = page.locator(".lfp-frequency");
  const theta = page.getByRole("button", { name: "LFP phase", exact: true });
  await expect(theta).toHaveText("θ");
  // Off by default: the LFP frequency shows with the tiles' phase plots.
  await expect(plot).toHaveCount(0);
  await theta.click({ modifiers: ["Shift"] });
  await expect(plot).toBeVisible({ timeout: 30000 });
  // The phase tile: simulated cells are locked to theta, so each has a histogram.
  await expect(page.locator(".tile-phase canvas").first()).toBeVisible({ timeout: 30000 });
  // Hovered, each plot shows its axis ends: the band's edges, and the recording's mean (the
  // simulated theta is 7.3 ± 0.4 Hz).
  await page.mouse.move(600, 10);
  await expect(page.locator(".axis-label")).toHaveCount(0);
  await plot.hover();
  await expect(page.locator(".lfp-label")).toHaveText(["6 Hz", "12 Hz", /^mean 7\.\d Hz$/]);
  await page.locator(".position-speed").hover();
  await expect(page.locator(".speed-label")).toHaveText(["0", "45 cm/s"]);
  await expect(page.locator(".lfp-label")).toHaveCount(0);
  await page.mouse.move(600, 10);
  await expect(page.locator(".axis-label")).toHaveCount(0);

  // The selected .egf file's header is in the headers panel.
  await page.getByRole("button", { name: "File headers", exact: true }).click();
  const headers = page.getByRole("dialog", { name: "File headers", exact: true });
  await expect(headers.locator(".headers-section", { hasText: "lfp" })).toBeVisible();
  // Read-only: only the position's headers can be edited.
  const channel = headers.locator(".headers-list > div", {
    has: page.locator("dt", { hasText: /^chan_name$/ }),
  });
  await expect(channel.locator("dd")).toHaveText("CH1");
  const section = headers.locator("[data-text-selectable]", {
    has: page.locator(".headers-section", { hasText: /^lfp$/ }),
  });
  await expect(section.locator("input")).toHaveCount(0);
  await headers.getByRole("button", { name: "Close panel" }).click();

  // The speed dwell goes with the tiles' speed plots.
  const speed = page.getByRole("button", { name: "Speed", exact: true });
  await speed.click({ modifiers: ["Shift"] });
  await expect(page.locator(".position-speed canvas")).toHaveCount(0);
  await speed.click({ modifiers: ["Shift"] });
  await expect(page.locator(".position-speed canvas")).toBeVisible();
  // B shows only the phase plots (and so the LFP frequency, but not the speed dwell).
  await page.mouse.move(600, 10);
  await page.keyboard.press("b");
  await expect(page.locator(".tile-spatial")).toHaveCount(0);
  await expect(page.locator(".position-speed canvas")).toHaveCount(0);
  await expect(page.locator(".tile-phase canvas").first()).toBeVisible();
  await expect(plot).toBeVisible();

  // Choosing ~.egf2 keeps it across trials.
  await chip("demo_box-a", "~.egf2").click();
  await expect(chip("demo_box-a", "~.egf2")).toHaveAttribute("aria-pressed", "true");
  await expect(plot).toBeVisible();
  await page.getByRole("button", { name: /^demo_box-b \d+$/ }).click();
  await ready(page);
  await expect(chip("demo_box-b", "~.egf2")).toHaveAttribute("aria-pressed", "true");
  await expect(plot).toBeVisible();
  // The headers follow it: ~.egf2 is channel 2.
  await page.getByRole("button", { name: "File headers", exact: true }).click();
  await expect(channel.locator("dd")).toHaveText("CH2");
  await headers.getByRole("button", { name: "Close panel" }).click();

  // A trial with only ~.egf shows ~.egf2 as missing rather than falling back.
  const tetrode = Buffer.concat([
    Buffer.from(
      "num_spikes 1\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
    ),
    Buffer.alloc(216),
  ]);
  await page
    .getByLabel("Import recording files", { exact: true })
    .setInputFiles([
      { name: "zz.1", mimeType: "application/octet-stream", buffer: tetrode },
      egf("zz.egf", 50000),
      ...[2, 3, 4, 5, 6, 7].map((n) => egf(`yy.egf${n}`, 10)),
      egf("yy.egf", 10),
      { name: "yy.1", mimeType: "application/octet-stream", buffer: tetrode },
    ]);
  await page.getByRole("button", { name: /^zz \d+$/ }).click();
  await ready(page);
  await expect(page.locator(".trial-block.selected .egf-file.missing")).toHaveText("~.egf2");
  await expect(plot).toHaveCount(0);
  // Choosing its own uses it.
  await chip("zz", "~.egf").click();
  // Without a .pos, the frequency plot still shows.
  await expect(plot).toBeVisible();

  // Beyond five, the rest are named but not used.
  const yy = page.locator(".trial-block", { has: page.getByText("Trial 'yy'") });
  await expect(yy.locator(".egf-file:not(.missing)")).toHaveCount(5);
  await expect(yy.locator(".egf-truncated")).toHaveText("+2 .egf");
  await expect(yy.locator(".egf-truncated")).toHaveAttribute("title", /yy\.egf6\nyy\.egf7/);
  expect(errors).toEqual([]);
});
