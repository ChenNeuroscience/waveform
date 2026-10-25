import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
export function useTileGestures({
  splitSource,
  grab,
  busy,
  scope,
  onSelect,
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
  onMerge: (a: number, b: number) => void;
  onSplit: (n: number, ch: number, t: number, v: number) => void;
  onPopOut: (n: number, x: number, y: number) => void;
  snapshot: (n: number) => string | undefined;
}) {
  const [ghost, setGhost] = useState<{
      image: string;
      x: number;
      y: number;
      width: number;
    } | null>(null),
    [target, setTarget] = useState<number | null>(null),
    [split, setSplit] = useState<{
      cell: number;
      x: number;
      y: number;
      channel: number;
      sample: number;
      threshold: number;
    } | null>(null),
    cancel = useRef<() => void>(() => {});
  useEffect(() => () => cancel.current(), [scope]);
  const begin = (event: ReactPointerEvent<HTMLElement>, cell: number) => {
    if (
      splitSource !== undefined &&
      (event.button !== 2 || ![splitSource, splitSource + 1].includes(cell))
    )
      return;
    if ((event.target as HTMLElement).closest("button,input,select")) return;
    if (grab && event.button === 0) {
      event.preventDefault();
      onPopOut(cell, event.clientX, event.clientY);
      return;
    }
    if (busy || (event.button !== 0 && event.button !== 2)) return;
    const row = event.currentTarget,
      rect = row.getBoundingClientRect(),
      wave = row.querySelector<HTMLElement>(".tile-waves")!,
      wr = wave.getBoundingClientRect();
    const right = event.button === 2;
    if (right && !(event.target as HTMLElement).closest(".tile-waves")) return;
    event.preventDefault();
    cancel.current();
    let moved = false,
      to: number | null = null,
      frame = 0,
      live = true,
      px = event.clientX,
      py = event.clientY,
      image: string | undefined;
    const origin = { x: event.clientX, y: event.clientY },
      wall = row.closest<HTMLElement>(".tile-wall")!;
    const gate = () => {
      const x = Math.max(0, Math.min(wr.width - 1, px - wr.left)),
        wx = x / wr.width,
        y = Math.max(0, Math.min(rect.height - 1, py - rect.top)),
        channel = Math.min(3, Math.floor(wx * 4)),
        sample = Math.max(
          0,
          Math.min(49, Math.round(((wx * 4 - channel - 0.08) / 0.84) * 49)),
        ),
        threshold = Math.max(
          -128,
          Math.min(127, Math.round((64 - (y / rect.height) * 128) / 0.39)),
        );
      return { cell, x, y, channel, sample, threshold };
    };
    const locate = () => {
      const hit = document
          .elementFromPoint(px, py)
          ?.closest<HTMLElement>(".cell-tile"),
        n = hit ? Number(hit.dataset.cell) : null;
      to = n !== cell ? n : null;
      setTarget(to);
    };
    const scroll = () => {
      if (!live || !moved) return;
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
      px = e.clientX;
      py = e.clientY;
      if (right) {
        setSplit(gate());
        return;
      }
      if (!moved && Math.hypot(px - origin.x, py - origin.y) > 5) {
        moved = true;
        image = snapshot(cell);
        frame = requestAnimationFrame(scroll);
      }
      if (moved) {
        if (image)
          setGhost({
            image,
            x: px - (origin.x - rect.left),
            y: py - (origin.y - rect.top),
            width: rect.width,
          });
        locate();
      }
    };
    const stop = () => {
      live = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", escape);
      setGhost(null);
      setTarget(null);
      setSplit(null);
    };
    const up = () => {
      const last = right ? gate() : null,
        merge = moved && to !== null ? to : null;
      stop();
      if (last) onSplit(cell, last.channel, last.sample, last.threshold);
      else if (merge !== null) onMerge(cell, merge);
      else if (!moved) onSelect(cell);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    cancel.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", escape);
    if (right) setSplit(gate());
  };
  return { begin, ghost, target, split };
}
