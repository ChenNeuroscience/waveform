import { useEffect, useState } from "react";
import { defaultSettings, RENDERING_MODES, type Settings, type RenderingMode } from "./types";

/** Restore settings, including the old independent drift/density switches. */
export function restoreSettings(value: unknown): Settings {
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const settings = Object.fromEntries(
    Object.entries(defaultSettings).map(([key, fallback]) => [
      key,
      typeof saved[key] === typeof fallback &&
      (typeof fallback !== "number" || Number.isFinite(saved[key]))
        ? saved[key]
        : fallback,
    ]),
  ) as unknown as Settings;
  // Directional smoothing previously followed the spatial radius.
  if (saved.dirSmooth === undefined) {
    settings.dirSmooth = settings.smooth;
  }
  settings.renderMode = RENDERING_MODES.includes(saved.renderMode as RenderingMode)
    ? (saved.renderMode as RenderingMode)
    : saved.drift === true
      ? "drift"
      : saved.density === false
        ? "fixed"
        : "density";
  return settings;
}
const prefix = "waveform-ui:";
export function readPreference<T>(name: string | null, fallback: T): T {
  if (name === null) {
    return fallback;
  }
  try {
    const value = JSON.parse(localStorage.getItem(prefix + name) || "null");
    if (value === null) {
      return fallback;
    }
    if (typeof fallback === "object" && fallback !== null && !Array.isArray(fallback)) {
      return Object.fromEntries(
        Object.entries(fallback).map(([key, defaultValue]) => [
          key,
          typeof value[key] === typeof defaultValue &&
          (typeof value[key] !== "number" || Number.isFinite(value[key]))
            ? value[key]
            : defaultValue,
        ]),
      ) as T;
    }
    return typeof value === typeof fallback && (typeof value !== "number" || Number.isFinite(value))
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}
export function usePreference<T>(name: string | null, fallback: T) {
  const [value, setValue] = useState<T>(() => readPreference(name, fallback));
  useEffect(() => {
    if (name === null) {
      return;
    }
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(prefix + name, JSON.stringify(value));
      } catch {}
    }, 120);
    return () => clearTimeout(timer);
  }, [name, value]);
  return [value, setValue] as const;
}
export interface PaneLayout {
  left: number;
  files: number;
  features: number;
}
export const defaultLayout: PaneLayout = {
  left: 350,
  files: 200,
  features: 300,
};
export function fitPaneLayout(layout: PaneLayout, width: number, height: number): PaneLayout {
  const h = Math.max(352, height);
  const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
  const files = clamp(layout.files, 90, h - 262);
  return {
    left: clamp(layout.left, 240, Math.max(240, width - 337)),
    files,
    features: clamp(layout.features, 160, h - files - 102),
  };
}

export interface WindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function fitWindowLayout(layout: WindowLayout, w: number, h: number): WindowLayout {
  const width = Math.min(Math.max(240, layout.width), w);
  const height = Math.min(Math.max(100, layout.height), Math.max(100, h - 20));
  return {
    width,
    height,
    x: Math.max(0, Math.min(w - width, layout.x)),
    y: Math.max(0, Math.min(h - height, layout.y)),
  };
}
