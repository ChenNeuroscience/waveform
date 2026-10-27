import { adjacentSwap } from "./controls";
import { ready } from "./controls";
import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("identical basenames in different folders keep separate cuts and histories", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "waveform-folders-"));
  try {
    for (const [folder, cell] of [
      ["a", 1],
      ["b", 2],
    ] as const) {
      const base = join(dir, folder);
      await mkdir(base);
      const record = Buffer.alloc(216);
      for (let c = 0; c < 4; c++) {
        record.writeUInt32BE(96000, c * 54);
        record[c * 54 + 4] = 80;
      }
      await writeFile(
        join(base, "trial.1"),
        Buffer.concat([
          Buffer.from(
            "num_spikes 1\nnum_chans 4\nsamples_per_spike 50\ntimebase 96000 hz\nduration 10\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\r\ndata_start",
          ),
          record,
          Buffer.from("\r\ndata_end"),
        ]),
      );
      await writeFile(
        join(base, "trial_1.cut"),
        `n_clusters: 3\nExact_cut_for: trial spikes: 1\n${cell}\n`,
      );
      await utimes(join(base, "trial.1"), 1, 1);
      await utimes(join(base, "trial_1.cut"), 1, 1);
    }
    await page.goto("/?demo=quick");
    await page.getByLabel("Import recording folder", { exact: true }).setInputFiles(dir);
    await ready(page);
    await expect(page.getByRole("button", { name: "Select cell 1", exact: true })).toBeVisible();
    const trials = page.getByRole("button", { name: "trial 1", exact: true });
    await expect(trials).toHaveCount(2);
    await trials.nth(1).click();
    await expect(page.getByRole("button", { name: "Select cell 2", exact: true })).toBeVisible();
    await adjacentSwap(page, 2, 1);
    await expect(page.getByRole("button", { name: "Select cell 3", exact: true })).toBeVisible();
    await trials.nth(0).click();
    await expect(page.getByRole("button", { name: "Select cell 1", exact: true })).toBeVisible();
    await trials.nth(1).click();
    await expect(page.getByRole("button", { name: "Select cell 3", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Select cell 2", exact: true })).toBeVisible();
    await expect(trials).toHaveCount(2);
    await expect(page.getByRole("button", { name: "~_1 edited.cut", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select cell 2", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
