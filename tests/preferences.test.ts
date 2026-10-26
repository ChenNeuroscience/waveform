import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  fitPaneLayout,
  fitWindowLayout,
  defaultLayout,
} from "../src/preferences";
import { experimentTiming } from "../src/position-info";
import { groupRgb8, groupTextColor } from "../src/palette";
it("matches every original palette byte and every badge contrast colour", async () => {
  const html = await readFile(
    new URL("../palettes.html", import.meta.url),
    "utf8",
  );
  const original = new Function(
    html.replace(/<\/?script>/g, "") + "; return Palettes;",
  )();
  for (let i = 0; i < 256; i++) {
    expect(groupRgb8(i)).toEqual([...original.flag.slice(i * 4, i * 4 + 3)]);
    expect(groupTextColor(i).toLowerCase()).toBe(
      original.flag_css_text[i]
        .toLowerCase()
        .replace("#fff", "#fff")
        .replace("#000", "#000"),
    );
  }
});
it("clamps saved dividers and tool windows to a smaller screen", () => {
  const layout = fitPaneLayout(
    { left: 1500, files: 900, features: 800 },
    800,
    500,
  );
  expect(layout.left).toBeLessThanOrEqual(463);
  expect(layout.left).toBeGreaterThanOrEqual(240);
  expect(layout.files + layout.features + 102).toBeLessThanOrEqual(500);
  const window = fitWindowLayout(
    { x: 1800, y: 900, width: 1200, height: 800 },
    800,
    600,
  );
  expect(window.x + window.width).toBeLessThanOrEqual(800);
  expect(window.y + window.height).toBeLessThanOrEqual(600);
  expect(fitPaneLayout(defaultLayout, 1440, 995)).toEqual(defaultLayout);
});
it("shows acquisition clock time and duration, including midnight rollover", () => {
  expect(
    experimentTiming(
      {
        set: {
          trial_time: "16:07",
          duration: "1265",
          lasttrialdatetime: "1749827224",
        },
      },
      1,
    ),
  ).toMatchObject({ text: "16:07–16:28", minutes: "21.1 min" });
  expect(
    experimentTiming({ set: { trial_time: "23:59", duration: "125" } }, 0),
  ).toMatchObject({ text: "23:59–00:01 (+1 day)", minutes: "2.1 min" });
  expect(experimentTiming({}, 600)).toMatchObject({
    text: "Start time unavailable",
    minutes: "10 min",
  });
});
