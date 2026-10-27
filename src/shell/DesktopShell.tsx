import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { color, type AnalysisData } from "../types";
import { usePreference, defaultLayout, fitPaneLayout } from "../preferences";
import { experimentTiming } from "./position-info";
import type { ShellProps } from "./props";
import { Toolbar } from "./Toolbar";
import { FilesPane } from "./FilesPane";
import { PositionPane } from "./PositionPane";
import { FeaturePane } from "./FeaturePane";
import { TileArea } from "./TileArea";
import { StartScreen } from "./StartScreen";

export function DesktopShell(p: ShellProps) {
  const root = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = usePreference("panes", defaultLayout);
  const fitted = fitPaneLayout(
    layout,
    root.current?.clientWidth || innerWidth,
    left.current?.clientHeight || innerHeight - 35,
  );
  const split = fitted.left;
  const rows = [fitted.files, fitted.features];
  const timing = experimentTiming(p.data?.headers || {}, p.data?.duration || 0);
  useEffect(() => {
    const resize = () =>
      setLayout((saved) =>
        fitPaneLayout(
          saved,
          root.current?.clientWidth || innerWidth,
          left.current?.clientHeight || innerHeight - 35,
        ),
      );
    resize();
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, [setLayout]);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>(".trial-block.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [p.trial?.id]);
  const pathCell = p.dragComparison?.source ?? p.hoverCell;
  const primary = p.analysis?.cell === pathCell ? p.analysis : null;
  const secondary =
    p.dragComparison?.target != null && p.comparisonAnalysis?.cell === p.dragComparison.target
      ? p.comparisonAnalysis
      : null;
  // Stable unless the overlaid analyses change, so unrelated renders (hover,
  // progress, selection) do not repaint the full-resolution trajectory.
  const pathLayers = useMemo(
    () =>
      [primary, secondary]
        .filter((a): a is AnalysisData => !!a)
        .map((a) => ({
          cell: a.cell,
          spikes: a.spikes,
          color: color(a.cell),
        })),
    [primary, secondary],
  );
  const ready = p.ready;
  const dragSplit = (e: React.PointerEvent, part: "horizontal" | "files" | "position") => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (part === "horizontal") {
        const b = root.current!.getBoundingClientRect();
        setLayout((old) =>
          fitPaneLayout({ ...old, left: ev.clientX - b.left }, b.width, left.current!.clientHeight),
        );
      } else {
        const b = left.current!.getBoundingClientRect();
        setLayout((old) =>
          fitPaneLayout(
            {
              ...old,
              ...(part === "files"
                ? { files: ev.clientY - b.top }
                : { features: b.bottom - ev.clientY }),
            },
            root.current!.clientWidth,
            b.height,
          ),
        );
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  // Files dragged in from outside (not a cut dragged out of the organiser).
  const dragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const types = e.dataTransfer.types;
    if (types.includes("Files") && !types.includes("application/x-waveform-cut")) {
      p.onDrag(true);
    }
  };
  const importChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      p.onImport([...e.target.files]);
    }
    // Allow choosing the same files again.
    e.target.value = "";
  };
  return (
    <div
      className={`app desktop-app ${p.grabMode ? "grab-mode" : ""} ${p.splitPoint ? "splitting" : ""}`}
      data-ready={ready ? "true" : "false"}
      onDragOver={dragOver}
      onDragLeave={(e) => !e.relatedTarget && p.onDrag(false)}
      onDrop={p.onDrop}
    >
      <input
        ref={p.fileInput}
        type="file"
        aria-label="Import recording files"
        multiple
        hidden
        onChange={importChosen}
      />
      <input
        ref={p.folderInput}
        type="file"
        aria-label="Import recording folder"
        multiple
        hidden
        {...({ webkitdirectory: "" } as any)}
        onChange={importChosen}
      />
      {p.trials.length > 0 ? (
        <>
          <Toolbar {...p} timing={timing} />
          <div
            className="desktop-workspace"
            ref={root}
            style={{
              gridTemplateColumns: `minmax(240px,${split}px) 7px minmax(330px,1fr)`,
            }}
          >
            <div
              className="left-workspace"
              ref={left}
              style={{
                gridTemplateRows: `minmax(90px,${rows[0]}px) 6px minmax(90px,1fr) 6px minmax(160px,${rows[1]}px)`,
              }}
            >
              <FilesPane {...p} />
              <div
                className="pane-splitter"
                role="separator"
                aria-orientation="horizontal"
                title="Resize file and position panes"
                onPointerDown={(e) => dragSplit(e, "files")}
              />
              <PositionPane
                {...p}
                timing={timing}
                pathLayers={pathLayers}
                primary={primary}
                secondary={secondary}
              />
              <div
                className="pane-splitter"
                role="separator"
                aria-orientation="horizontal"
                title="Resize position and feature panes"
                onPointerDown={(e) => dragSplit(e, "position")}
              />
              <FeaturePane {...p} />
            </div>
            <div
              className="desktop-splitter"
              role="separator"
              aria-orientation="vertical"
              title="Resize left panes and cell tile wall"
              onPointerDown={(e) => dragSplit(e, "horizontal")}
            />
            <TileArea {...p} />
          </div>
        </>
      ) : (
        <StartScreen {...p} />
      )}
      {(p.error || p.notice) && (
        <div
          className={`desktop-notice ${p.error ? "error" : ""}`}
          role={p.error ? "alert" : "status"}
        >
          <span>{p.error || p.notice}</span>
          <button
            aria-label={p.error ? "Dismiss error" : "Dismiss notification"}
            onClick={p.error ? p.onError : p.onNotice}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {p.drag && p.trials.length > 0 && (
        <div className="drag-overlay">
          <p className="drop-title-wobble">drag &amp; drop files here</p>
          <small>.set · .pos · .1, .2, … · .cut · .clu.N</small>
        </div>
      )}
      {p.children}
    </div>
  );
}
