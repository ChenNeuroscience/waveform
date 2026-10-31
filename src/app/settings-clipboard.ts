import { defaultSettings, RENDERING_MODES, type Settings } from "../types";

const limits: Record<Exclude<keyof Settings, "renderMode">, [number, number]> = {
  pcaSamples: [500, 20000],
  binCm: [0.5, 10],
  smooth: [0, 5],
  maxRate: [0, 50],
  rateMapSteps: [2, 32],
  acWindow: [20, 1000],
  scMinOverlap: [2, 200],
  leds: [1, 2],
  maxSpeed: [0, 10],
  posSmooth: [0, 2],
  dirBin: [2, 30],
  speedBin: [1, 10],
  speedMax: [10, 200],
};

/** A flat YAML mapping, deliberately readable in notes and editable by hand. */
export function encodeSettings(settings: Settings): string {
  return [
    "waveform-settings: 1",
    ...Object.keys(defaultSettings).map((key) => `${key}: ${settings[key as keyof Settings]}`),
    "",
  ].join("\n");
}

export function decodeSettings(text: string): Settings {
  const fields = new Map<string, string>();
  for (const line of text.trim().split(/\r?\n/)) {
    const content = line.replace(/\s+#.*$/, "").trim();
    if (!content || content.startsWith("#")) {
      continue;
    }
    const match = /^([\w-]+):\s*(\S.*?)\s*$/.exec(content);
    if (!match || fields.has(match[1])) {
      throw new Error("Paste a complete Waveform settings mapping.");
    }
    fields.set(match[1], match[2]);
  }
  if (fields.get("waveform-settings") !== "1") {
    throw new Error("These are not supported Waveform settings.");
  }
  fields.delete("waveform-settings");
  if (fields.size !== Object.keys(defaultSettings).length) {
    throw new Error("Paste a complete Waveform settings mapping.");
  }
  const result = { ...defaultSettings };
  for (const [key, raw] of fields) {
    if (key === "renderMode") {
      const mode = raw.replace(/^(["'])(.*)\1$/, "$2");
      if (!RENDERING_MODES.includes(mode as Settings["renderMode"])) {
        throw new Error("Unknown rendering mode.");
      }
      result.renderMode = mode as Settings["renderMode"];
    } else {
      if (!Object.hasOwn(limits, key)) {
        throw new Error(`Unknown setting: ${key}.`);
      }
      const setting = key as keyof typeof limits;
      const value = Number(raw);
      const [min, max] = limits[setting];
      if (
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (setting === "leds" && !Number.isInteger(value))
      ) {
        throw new Error(`Invalid value for ${key} (expected ${min}–${max}).`);
      }
      result[setting] = value;
    }
  }
  return result;
}
