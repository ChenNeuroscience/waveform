import { test, expect } from "@playwright/test";
import { ready } from "./controls";

test("drift colours rate maps by mean spike time and path spikes by their time", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const replies: {
      parts: string[];
      bins: number;
      drift: number;
      spikes: number;
      times: number;
    }[] = [];
    // Every analysis request, with the colour mode it was made in.
    const requests: { parts: string[]; mode: string }[] = [];
    Object.assign(window, { driftReplies: replies, driftRequests: requests });
    const Base = Worker;
    window.Worker = class extends Base {
      parts = new Map<number, string[]>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }) => {
          const parts = this.parts.get(data.id);
          if (parts && data.data) {
            const a = data.data;
            replies.push({
              parts,
              bins: a.spatial.length,
              drift: a.spatialDrift?.length ?? -1,
              spikes: a.spikes.length / 2,
              times: a.spikeDrift?.length ?? -1,
            });
            this.parts.delete(data.id);
          }
        });
      }
      override postMessage(message: any) {
        if (message.type === "analysis") {
          this.parts.set(message.id, message.parts);
          requests.push({ parts: message.parts, mode: message.settings.renderMode });
        }
        super.postMessage(message);
      }
    };
  });
  await page.goto("/?demo=quick");
  await page.getByText("Try it now with simulated data").click();
  await ready(page);
  const replies = () => page.evaluate(() => (window as any).driftReplies.splice(0));
  await replies();
  await page.getByRole("button", { name: "Drift (colour by recording time)", exact: true }).click();
  await page.locator('.cell-tile[data-cell="1"]').hover();
  // Tiles ask for each bin's mean spike time; the hovered cell for each path spike's time.
  await expect
    .poll(async () => {
      const r = await replies();
      return [
        r.some((a) => a.parts.includes("spatialDrift") && a.drift === a.bins && a.bins > 0),
        r.some((a) => a.parts.includes("spikeDrift") && a.times === a.spikes && a.spikes > 0),
      ];
    })
    .toEqual([true, true]);
  await expect(page.locator('.cell-tile[data-cell="1"] .tile-spatial canvas')).toBeVisible();
  // Leaving drift stops asking for them: every request made in another mode leaves them out.
  await page.getByRole("button", { name: "Fixed colours", exact: true }).click();
  await page.locator('.cell-tile[data-cell="2"]').hover();
  const fixed = () =>
    page.evaluate(() =>
      (window as any).driftRequests.filter((r: { mode: string }) => r.mode === "fixed"),
    );
  await expect
    .poll(async () => {
      const r: { parts: string[] }[] = await fixed();
      return [
        r.some((a) => a.parts.includes("spatial")),
        r.some((a) => a.parts.includes("spikes")),
      ];
    })
    .toEqual([true, true]);
  for (const r of await fixed()) {
    expect(r.parts).not.toContain("spatialDrift");
    expect(r.parts).not.toContain("spikeDrift");
  }
});
