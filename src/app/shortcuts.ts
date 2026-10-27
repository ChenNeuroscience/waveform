/** Global keyboard shortcuts. The listener is registered once and reads the
 * latest state and actions through a ref, so it never acts on a stale render. */
import { useEffect, useRef, type RefObject } from "react";
import type { PlotMode, Settings, SwapState, SplitPoint, Trial } from "../types";

export interface ShortcutContext {
  ready: boolean;
  /** A tile drag comparison is in progress: swallow keys. */
  dragging: boolean;
  swap: SwapState | null;
  splitPoint: SplitPoint | null;
  pane: string | null;
  hoverCell: number | null;
  hoveredTile: RefObject<number | null>;
  settings: Settings;
  tetNum: number;
  cutId: string;
  trial: Trial | undefined;
  trials: Trial[];
  setGrabMode: (on: boolean) => void;
  openFiles: () => void;
  operation: (type: "undo" | "redo") => void;
  copyPlot: () => void;
  exportCut: () => void;
  cancelSwap: () => void;
  startSwap: (cell: number) => void;
  closePane: () => void;
  togglePane: (pane: "help" | "headers" | "history") => void;
  setTool: (tool: string) => void;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  selectDest: (group: number) => void;
  selectSource: (group: number, toggle: boolean) => void;
  newDestination: () => void;
  chooseTet: (n: number) => void;
  chooseTrial: (t: Trial) => void;
  /** Choose a cut of the current tetrode ("" for no cut). */
  chooseCut: (cutId: string) => void;
  showPlot: (mode: PlotMode, multiple: boolean) => void;
}
/** The item `delta` steps from `current` in `items`, or undefined past either end. */
function step<T>(items: T[], current: T, delta: number) {
  const i = items.indexOf(current);
  return i < 0 ? undefined : items[i + delta];
}

/** Arrow keys: up/down step through trials; left/right through the trial's
 * tetrodes (each restores its last cut); Shift-left/right through the current
 * tetrode's options, no cut first and then each cut file. */
function navigateByArrow(c: ShortcutContext, key: string, shift: boolean) {
  const delta = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
  if (!c.trial) {
    return;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const next = step(c.trials, c.trial, delta);
    if (next) {
      c.chooseTrial(next);
    }
    return;
  }
  if (shift) {
    const tet = c.trial.tetrodes.find((t) => t.number === c.tetNum);
    const options = ["", ...(tet?.cuts.map((cut) => cut.id) ?? [])];
    const next = step(options, c.cutId, delta);
    if (next !== undefined) {
      c.chooseCut(next);
    }
    return;
  }
  const numbers = c.trial.tetrodes
    .filter((t) => t.file)
    .map((t) => t.number)
    .sort((a, b) => a - b);
  const next = step(numbers, c.tetNum, delta);
  if (next !== undefined) {
    c.chooseTet(next);
  }
}

const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

const plotKeys: Record<string, PlotMode> = {
  w: "waveforms",
  r: "spatial",
  c: "direction",
  v: "speed",
  t: "ac",
};
export function useShortcuts(context: ShortcutContext) {
  const latest = useRef(context);
  latest.current = context;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const c = latest.current;
      if ((e.target as HTMLElement).matches("input,select,textarea")) {
        return;
      }
      if (c.dragging) {
        e.preventDefault();
        return;
      }
      if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!c.swap) {
          c.setGrabMode(true);
        }
        return;
      }
      if (c.splitPoint) {
        e.preventDefault();
        return;
      }
      const cmd = e.ctrlKey || e.metaKey;
      if (cmd && e.key === "o") {
        e.preventDefault();
        c.openFiles();
        return;
      }
      if (cmd && e.key.toLowerCase() === "z") {
        e.preventDefault();
        c.operation(e.shiftKey ? "redo" : "undo");
        return;
      }
      if (cmd && e.key === "y") {
        e.preventDefault();
        c.operation("redo");
        return;
      }
      if (cmd && e.key === "c" && c.ready) {
        e.preventDefault();
        c.copyPlot();
        return;
      }
      if (cmd && e.key === "s") {
        e.preventDefault();
        c.exportCut();
        return;
      }
      // Browser commands (reload, close tab, back, etc.) must never fall
      // through to the unmodified plot/navigation shortcuts.
      if (cmd || e.altKey) {
        return;
      }
      if (c.swap) {
        e.preventDefault();
        if (e.key === "Escape" || (e.key.toLowerCase() === "s" && !e.repeat)) {
          c.cancelSwap();
        }
        return;
      }
      const hovered = c.hoveredTile.current;
      if (e.key === "s" && c.ready && !e.repeat && hovered !== null) {
        e.preventDefault();
        c.startSwap(hovered);
        return;
      }
      if (e.key === "Escape") {
        c.closePane();
        return;
      }
      if (e.key === "k" || e.key === "?") {
        c.togglePane("help");
      }
      if (e.key === "h") {
        c.togglePane("headers");
      }
      if (e.key === "z") {
        c.togglePane("history");
      }
      if (e.key === "d") {
        c.update("drift", !c.settings.drift);
      }
      if (e.key === "p") {
        c.update("density", !c.settings.density);
      }
      const group = c.ready && !e.repeat ? c.hoverCell : null;
      if (e.key.toLowerCase() === "e" && group !== null) {
        c.selectDest(group);
      }
      if (e.key.toLowerCase() === "f" && group !== null) {
        c.selectSource(group, e.shiftKey);
      }
      if (e.key === "l") {
        c.setTool("lasso");
      }
      if (e.key === "Enter" && c.ready) {
        e.preventDefault();
        c.newDestination();
      }
      if (/^[0-9]$/.test(e.key)) {
        c.chooseTet(Math.floor(c.tetNum / 10) * 10 + +e.key);
      }
      if (e.key === "o") {
        c.chooseTet(c.tetNum >= 10 ? c.tetNum - 10 : c.tetNum + 10);
      }
      const mode = plotKeys[e.key.toLowerCase()];
      if (mode) {
        c.showPlot(mode, e.shiftKey);
      }
      if (ARROWS.includes(e.key)) {
        // Arrows navigate recordings rather than scrolling the page.
        e.preventDefault();
        navigateByArrow(c, e.key, e.shiftKey);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
}
