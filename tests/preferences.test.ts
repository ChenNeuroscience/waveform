import { it, expect } from "vitest";
import { fitPaneLayout, fitWindowLayout, defaultLayout, restoreSettings } from "../src/preferences";
import { experimentTiming } from "../src/shell/position-info";
import { groupRgb8, groupTextColor } from "../src/palette";
it("restores one colour mode from the previous competing switches", () => {
  expect(restoreSettings({ drift: true, density: true }).renderMode).toBe("drift");
  expect(restoreSettings({ drift: false, density: true }).renderMode).toBe("density");
  expect(restoreSettings({ drift: false, density: false }).renderMode).toBe("fixed");
  expect(restoreSettings({ renderMode: "fixed", drift: true }).renderMode).toBe("fixed");
  expect(restoreSettings({ renderMode: "unknown" }).renderMode).toBe("density");
  expect(restoreSettings(null).renderMode).toBe("density");
});
it("has a colour and a black or white badge text colour for every group", () => {
  for (let i = 0; i < 256; i++) {
    expect(groupRgb8(i)).toHaveLength(3);
    expect(groupRgb8(i).every((v) => v >= 0 && v <= 255)).toBe(true);
    expect(["#000", "#fff"]).toContain(groupTextColor(i));
  }
});
it("clamps saved dividers and tool windows to a smaller screen", () => {
  const layout = fitPaneLayout({ left: 1500, files: 900, features: 800 }, 800, 500);
  expect(layout.left).toBeLessThanOrEqual(463);
  expect(layout.left).toBeGreaterThanOrEqual(240);
  expect(layout.files + layout.features + 102).toBeLessThanOrEqual(500);
  const window = fitWindowLayout({ x: 1800, y: 900, width: 1200, height: 800 }, 800, 600);
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
  ).toMatchObject({ text: "16:07–16:28", durationText: "21 min 5 sec" });
  expect(experimentTiming({ set: { trial_time: "23:59", duration: "125" } }, 0)).toMatchObject({
    text: "23:59–00:01 (+1 day)",
    durationText: "2 min 5 sec",
  });
  expect(experimentTiming({}, 600)).toMatchObject({
    text: "Start time unavailable",
    durationText: "10 min 0 sec",
  });
});
