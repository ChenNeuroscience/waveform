import { expect, it } from "vitest";
import { decodeSettings, encodeSettings } from "../src/app/settings-clipboard";
import { defaultSettings } from "../src/types";

it("round-trips all settings as readable YAML, including rendering and PCA", () => {
  const settings = {
    ...defaultSettings,
    renderMode: "drift" as const,
    pcaSamples: 1000,
    posSmooth: 0.7,
  };
  const text = encodeSettings(settings);
  expect(text).toContain("waveform-settings: 1\npcaSamples: 1000\nrenderMode: drift\n");
  expect(decodeSettings(text)).toEqual(settings);
  expect(decodeSettings(`# From my notes\n${text.replace("drift", "'drift' # colours")}`)).toEqual(
    settings,
  );
});

it("rejects incomplete, unsupported or unsafe settings instead of partially restoring", () => {
  const text = encodeSettings(defaultSettings);
  for (const bad of [
    "hello",
    text.replace("waveform-settings: 1", "waveform-settings: 2"),
    text.replace("binCm: 3\n", ""),
    text + "binCm: 4\n",
    text.replace("binCm: 3", "unknown: 3"),
    text.replace("binCm: 3", "binCm: .nan"),
    text.replace("binCm: 3", "binCm: -1"),
    text.replace("leds: 2", "leds: 1.5"),
    text.replace("density", "rainbow"),
  ])
    expect(() => decodeSettings(bad)).toThrow();
});

it("restores settings saved before temporal bin width was configurable", () => {
  const legacy = encodeSettings({ ...defaultSettings, smooth: 3 }).replace(
    /^(?:acBinMs|dirSmooth):.*\n/gm,
    "",
  );
  expect(decodeSettings(legacy).acBinMs).toBe(defaultSettings.acBinMs);
  expect(decodeSettings(legacy).dirSmooth).toBe(3);
});
