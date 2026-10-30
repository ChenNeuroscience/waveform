import { test, expect } from "@playwright/test";
import { ready } from "./controls";

test("directional plots follow v1's zero-left and quarter-turn-up convention", async ({ page }) => {
  const n = 200;
  const position = Buffer.alloc(n * 20);
  const spots = [
    [48, 50, 52, 50],
    [50, 48, 50, 52],
    [52, 50, 48, 50],
    [50, 52, 50, 48],
  ];
  for (let i = 0; i < n; i++) {
    position.writeUInt32BE((i % 3) * 99999, i * 20);
    spots[Math.floor(i / 50)].forEach((v, j) => position.writeUInt16BE(v, i * 20 + 4 + j * 2));
    position.writeUInt16BE(30, i * 20 + 12);
    position.writeUInt16BE(10, i * 20 + 14);
  }
  const spikes = Buffer.alloc(20 * 216);
  for (let cell = 0; cell < 4; cell++) {
    for (let k = 0; k < 5; k++) {
      const tick = Math.round((cell + 0.2 + k * 0.15) * 1000);
      for (let channel = 0; channel < 4; channel++) {
        spikes.writeUInt32BE(tick, (cell * 5 + k) * 216 + channel * 54);
      }
    }
  }
  await page.goto("/");
  await page.getByLabel("Import recording files", { exact: true }).setInputFiles([
    {
      name: "rotation.1",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          "num_spikes 20\nnum_chans 4\nsamples_per_spike 50\ntimebase 1000 hz\nduration 4\nspike_format t,ch1,t,ch2,t,ch3,t,ch4\ndata_start",
        ),
        spikes,
      ]),
    },
    {
      name: "rotation_1.cut",
      mimeType: "text/plain",
      buffer: Buffer.from(
        `Exact_cut_for: rotation spikes: 20\n${Array.from({ length: 20 }, (_, i) => Math.floor(i / 5) + 1).join(" ")}\n`,
      ),
    },
    {
      name: "rotation.pos",
      mimeType: "application/octet-stream",
      buffer: Buffer.concat([
        Buffer.from(
          "pos_format t,x1,y1,x2,y2,numpix1,numpix2\nnum_pos_samples 200\npixels_per_metre 100\nsample_rate 50 hz\ntimebase 50 hz\nwindow_max_x 100\nwindow_max_y 100\ndata_start",
        ),
        position,
      ]),
    },
  ]);
  await ready(page);
  const ink = (cell: number) =>
    page.locator(`.cell-tile[data-cell="${cell}"] .tile-direction canvas`).evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const { width, height } = canvas;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
      const counts = [0, 0, 0, 0]; // left, up, right, down
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (pixels[i + 3] < 200 || pixels[i] > 100 || pixels[i + 1] > 100 || pixels[i + 2] > 100)
            continue;
          if (x < width / 2 - 5) counts[0]++;
          if (y < height / 2 - 5) counts[1]++;
          if (x > width / 2 + 5) counts[2]++;
          if (y > height / 2 + 5) counts[3]++;
        }
      }
      return counts;
    });
  for (let direction = 0; direction < 4; direction++) {
    await expect.poll(async () => (await ink(direction + 1))[direction]).toBeGreaterThan(8);
    expect((await ink(direction + 1))[(direction + 2) % 4]).toBe(0);
  }
});
