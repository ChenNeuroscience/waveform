import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { wavePoint } from "./plot-geometry";
export interface DragComparison {
  source: number;
  target: number | null;
}
interface TileImage {
  source: number;
  image: string;
  x: number;
  y: number;
  width: number;
  height: number;
  snapped: boolean;
}
export function useTileGestures({
  splitSource,
  grab,
  busy,
  scope,
  onSelect,
  onCompare,
  onMerge,
  onSplit,
  onPopOut,
  snapshot,
}: {
  splitSource?: number;
  grab: boolean;
  busy: boolean;
  scope: string;
  onSelect: (n: number) => void;
  onCompare: (pair: DragComparison | null) => void;
  onMerge: (a: number, b: number) => void;
  onSplit: (n: number, ch: number, t: number, v: number) => void;
  onPopOut: (n: number, x: number, y: number) => void;
  snapshot: (n: number) => string | undefined;
}) {
  const [ghost, setGhost] = useState<TileImage | null>(null);
  const [settling, setSettling] = useState<TileImage | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [split, setSplit] = useState<{
    cell: number;
    x: number;
    y: number;
    channel: number;
    sample: number;
    threshold: number;
  } | null>(null);
  const cancel = useRef<() => void>(() => {});
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      cancel.current();
      clearTimeout(settleTimer.current);
      setSettling(null);
    },
    [scope],
  );
  const begin = (event: ReactPointerEvent<HTMLElement>, cell: number) => {
    // While splitting, either button on the two split tiles adjusts the gate.
    const splitting = splitSource !== undefined;
    if (splitting && ![splitSource, splitSource + 1].includes(cell)) {
      return;
    }
    if ((event.target as HTMLElement).closest("button,input,select")) {
      return;
    }
    if (grab && !splitting && event.button === 0) {
      event.preventDefault();
      onPopOut(cell, event.clientX, event.clientY);
      return;
    }
    if (busy || (event.button !== 0 && event.button !== 2)) {
      return;
    }
    const row = event.currentTarget;
    const rect = row.getBoundingClientRect();
    const wave = row.querySelector<HTMLElement>(".tile-waves")!;
    const wr = wave.getBoundingClientRect();
    const gating = splitting || event.button === 2;
    if (gating && !(event.target as HTMLElement).closest(".tile-waves")) {
      return;
    }
    event.preventDefault();
    cancel.current();
    clearTimeout(settleTimer.current);
    setSettling(null);
    let moved = false;
    let to: number | null = null;
    let frame = 0;
    let scrollFrame = 0;
    let live = true;
    let px = event.clientX;
    let py = event.clientY;
    let image: string | undefined;
    const origin = { x: event.clientX, y: event.clientY };
    const wall = row.closest<HTMLElement>(".tile-wall")!;
    const initialScroll = { left: wall.scrollLeft, top: wall.scrollTop };
    const pointerId = event.pointerId;
    const button = event.button;
    const gate = () => {
      const x = Math.max(0, Math.min(wr.width - 1, px - wr.left));
      const plotWidth = Number(wave.dataset.plotWidth) || wr.width;
      const plotHeight = Number(wave.dataset.plotHeight) || rect.height;
      const plotTop = Number(wave.dataset.plotTop) || 0;
      const y = Math.max(0, Math.min(rect.height - 1, py - rect.top));
      return {
        cell,
        x,
        y,
        ...wavePoint(x / plotWidth, (y - plotTop) / plotHeight),
      };
    };
    const locate = () => {
      const hit = document.elementFromPoint(px, py)?.closest<HTMLElement>(".cell-tile");
      const valid = hit?.closest(".tile-wall") === wall;
      const n = valid ? Number(hit!.dataset.cell) : null;
      const next = n !== cell ? n : null;
      if (next !== to) {
        to = next;
        setTarget(to);
        onCompare({ source: cell, target: to });
      }
      if (image) {
        const snap = to !== null ? hit!.getBoundingClientRect() : null;
        setGhost({
          source: cell,
          image,
          x: snap ? snap.left : px - (origin.x - rect.left),
          y: snap ? snap.top : py - (origin.y - rect.top),
          width: rect.width,
          height: rect.height,
          snapped: !!snap,
        });
      }
    };
    const scroll = () => {
      if (!live || !moved) {
        return;
      }
      const b = wall.getBoundingClientRect();
      if (px >= b.left && px <= b.right) {
        const dy = py < b.top + 24 ? -10 : py > b.bottom - 24 ? 10 : 0;
        if (dy) {
          wall.scrollTop += dy;
          locate();
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      px = e.clientX;
      py = e.clientY;
      if (gating) {
        setSplit(gate());
        return;
      }
      if (!moved && Math.hypot(px - origin.x, py - origin.y) > 5) {
        moved = true;
        image = snapshot(cell);
        setDragging(cell);
        onCompare({ source: cell, target: null });
        frame = requestAnimationFrame(scroll);
      }
      if (moved) {
        locate();
      }
    };
    const stop = () => {
      if (!live) {
        return;
      }
      live = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(scrollFrame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", abort);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", reposition, true);
      setGhost(null);
      setDragging(null);
      setTarget(null);
      setSplit(null);
      if (moved) {
        onCompare(null);
      }
    };
    const restore = () => {
      if (!image) {
        return;
      }
      const source = wall.querySelector<HTMLElement>(`.cell-tile[data-cell="${cell}"]`);
      const bounds = source?.getBoundingClientRect();
      const viewport = wall.getBoundingClientRect();
      let home = bounds;
      if (
        !home ||
        home.bottom <= viewport.top ||
        home.top >= viewport.bottom ||
        home.right <= viewport.left ||
        home.left >= viewport.right
      ) {
        wall.scrollTop = initialScroll.top;
        wall.scrollLeft = initialScroll.left;
        home = rect;
      }
      setSettling({
        source: cell,
        image,
        x: home.left,
        y: home.top,
        width: rect.width,
        height: rect.height,
        snapped: false,
      });
      settleTimer.current = setTimeout(() => setSettling(null), 650);
    };
    const abort = () => {
      const returning = moved && !gating;
      stop();
      if (returning) {
        restore();
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || e.button !== button) {
        return;
      }
      px = e.clientX;
      py = e.clientY;
      if (moved && !gating) {
        locate();
      } // Only the actual release target can merge.
      const last = gating ? gate() : null;
      const merge = moved ? to : null;
      stop();
      if (last) {
        onSplit(cell, last.channel, last.sample, last.threshold);
      } else if (merge !== null) {
        onMerge(cell, merge);
      } else if (moved) {
        restore();
      } else {
        onSelect(cell);
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        abort();
      }
    };
    const reposition = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        if (live && moved) {
          locate();
        }
      });
    };
    cancel.current = stop; // A different recording/layout cancels without a stale image.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", reposition, true);
    if (gating) {
      setSplit(gate());
    }
  };
  return { begin, ghost, settling, dragging, target, split };
}
