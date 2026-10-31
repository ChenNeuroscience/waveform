import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Outline {
  x: number;
  y: number;
  width: number;
  height: number;
}
const targets = ".floating-window,.cell-tile,.position-path,.feature-stage";

/** A viewport overlay stays above WebGL canvases, plot labels and floating
 * windows without changing their stacking order or intercepting the grab. */
export function GrabOutline({ active }: { active: boolean }) {
  const [outline, setOutline] = useState<Outline | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    let target: Element | null = null;
    let point: { x: number; y: number } | null = null;
    let frame = 0;
    const resize = new ResizeObserver(() => refresh());
    const refresh = () => {
      const next = point
        ? document.elementFromPoint(point.x, point.y)?.closest(targets) || null
        : document.querySelector(
            ".floating-window:hover,.cell-tile:hover,.position-path:hover,.feature-stage:hover",
          );
      if (next !== target) {
        resize.disconnect();
        target = next;
        if (target) {
          resize.observe(target);
        }
      }
      const box = target?.getBoundingClientRect();
      const rect =
        box && box.width > 0 && box.height > 0
          ? { x: box.x, y: box.y, width: box.width, height: box.height }
          : null;
      setOutline((previous) =>
        previous?.x === rect?.x &&
        previous?.y === rect?.y &&
        previous?.width === rect?.width &&
        previous?.height === rect?.height
          ? previous
          : rect,
      );
    };
    const move = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      refresh();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    const leave = (event: PointerEvent) => {
      if (!event.relatedTarget) {
        point = null;
        target = null;
        resize.disconnect();
        setOutline(null);
      }
    };
    const mutations = new MutationObserver(refresh);
    mutations.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", move, true);
    document.addEventListener("pointerout", leave, true);
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", move, true);
      document.removeEventListener("pointerout", leave, true);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [active]);
  return active && outline
    ? createPortal(
        <div
          className="grab-outline"
          aria-hidden="true"
          style={{ left: outline.x, top: outline.y, width: outline.width, height: outline.height }}
        />,
        document.body,
      )
    : null;
}
