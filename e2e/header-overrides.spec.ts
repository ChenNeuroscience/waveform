import { test, expect } from "@playwright/test";
import { ready } from "./controls";

function pos() {
  const samples = 200;
  const raw = Buffer.alloc(samples * 20);
  for (let i = 0; i < samples; i++) {
    raw.writeUInt16BE(100 + i, i * 20 + 4);
    raw.writeUInt16BE(100 + (i % 20), i * 20 + 6);
    raw.writeUInt16BE(1023, i * 20 + 8);
    raw.writeUInt16BE(1023, i * 20 + 10);
    raw.writeUInt16BE(10, i * 20 + 12);
  }
  return Buffer.concat([
    Buffer.from(
      `pos_format t,x1,y1,x2,y2,numpix1,numpix2\nnum_pos_samples ${samples}\npixels_per_metre NaN\nsample_rate 50 hz\ntimebase 50 hz\nwindow_min_x 0\nwindow_max_x 800\nwindow_min_y 0\nwindow_max_y 600\r\ndata_start`,
    ),
    raw,
  ]);
}

test("an uncalibrated position is guessed at, and its header can be edited and reset", async ({
  page,
}) => {
  await page.goto("/?demo=quick");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "trial.1",
      mimeType: "application/octet-stream",
      // A tetrode with no spikes has no markers.
      buffer: Buffer.from(
        "num_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 4\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\nnum_spikes 0             ",
      ),
    },
    { name: "trial.pos", mimeType: "application/octet-stream", buffer: pos() },
  ]);
  await ready(page);

  const warning = page.locator(".position-warning");
  const dot = page.locator(".headers-changed");
  await expect(warning).toContainText("pixels_per_metre isn't set");
  await expect(dot).toBeVisible();

  await warning.getByRole("button", { name: "Set it in File headers" }).click();
  const row = page.locator(".headers-list > div", { hasText: "pixels_per_metre" }).first();
  await expect(row).toContainText("199.0");
  await expect(row).toContainText("estimated, file says NaN");
  await expect(page.getByRole("button", { name: "Reset position headers" })).toHaveCount(0);

  await page.getByRole("button", { name: "Change pixels_per_metre" }).click();
  const input = page.getByLabel("New pixels_per_metre");
  await input.fill("nonsense");
  await input.press("Enter");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.fill("500");
  await input.press("Enter");
  await expect(row).toContainText("edited, file says NaN");
  await expect(warning).toHaveCount(0);
  await expect(dot).toBeVisible();

  await page.getByRole("button", { name: "Reset position headers" }).click();
  await expect(row).toContainText("estimated, file says NaN");
  await expect(warning).toBeVisible();
});
