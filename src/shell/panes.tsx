/** The resizable desktop layout: left panes (files, position, features) beside
 * the tile wall, with draggable dividers. Sizes persist and fit the window. */
import { useEffect, useRef } from "react";
import { usePreference, defaultLayout, fitPaneLayout } from "../preferences";

type DividerPart = "columns" | "files" | "position";

export function usePaneLayout() {
  const workspace = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = usePreference("panes", defaultLayout);
  const width = () => workspace.current?.clientWidth || innerWidth;
  const height = () => left.current?.clientHeight || innerHeight - 35;
  const fitted = fitPaneLayout(layout, width(), height());

  useEffect(() => {
    const resize = () => setLayout((saved) => fitPaneLayout(saved, width(), height()));
    resize();
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, [setLayout]);

  /** Drag a divider: between the left panes and the tile wall, or between the
   * files/position or position/feature panes. */
  const dragDivider = (e: React.PointerEvent, part: DividerPart) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (part === "columns") {
        const b = workspace.current!.getBoundingClientRect();
        setLayout((old) => fitPaneLayout({ ...old, left: ev.clientX - b.left }, b.width, height()));
        return;
      }
      const b = left.current!.getBoundingClientRect();
      const change = part === "files" ? { files: ev.clientY - b.top } : { features: b.bottom - ev.clientY };
      setLayout((old) => fitPaneLayout({ ...old, ...change }, width(), b.height));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return {
    workspace,
    left,
    columns: `minmax(240px,${fitted.left}px) 7px minmax(330px,1fr)`,
    rows: `minmax(90px,${fitted.files}px) 6px minmax(90px,1fr) 6px minmax(160px,${fitted.features}px)`,
    dragDivider,
  };
}

const DIVIDERS: Record<DividerPart, { title: string; vertical: boolean }> = {
  columns: { title: "Resize left panes and cell tile wall", vertical: true },
  files: { title: "Resize file and position panes", vertical: false },
  position: { title: "Resize position and feature panes", vertical: false },
};

export function Divider({
  part,
  onDrag,
}: {
  part: DividerPart;
  onDrag: (e: React.PointerEvent, part: DividerPart) => void;
}) {
  const { title, vertical } = DIVIDERS[part];
  return (
    <div
      className={vertical ? "desktop-splitter" : "pane-splitter"}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      title={title}
      onPointerDown={(e) => onDrag(e, part)}
    />
  );
}
