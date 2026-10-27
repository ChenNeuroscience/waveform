/** Floating copies of plots: a cell's tile (pop-out), the path or feature grid
 * (Space-click), and copying the selected cell's tile to the clipboard. */
import { useState } from "react";
import { captureTile } from "../tiles/TileWall";
import { captureFeatureGrid } from "../plots/FeatureView";
import { downloadBlob } from "../files";
import type { CellStat } from "../tiles/CellStats";
import type { Trial, ViewData } from "../types";

export interface PlotCopy {
  id: string;
  title: string;
  image: string;
  /** Set for a copied cell tile, which shows its badge and stats. */
  cell?: number;
  stats?: CellStat[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep a window of the given size inside the viewport. */
function clampToWindow(x: number, y: number, width: number, height: number) {
  return {
    x: Math.max(0, Math.min(innerWidth - width - 8, x)),
    y: Math.max(0, Math.min(innerHeight - height - 8, y)),
  };
}

/** The hover stats currently shown on a cell's tile. */
function tileStats(cell: number): CellStat[] {
  const items = document.querySelectorAll(`.cell-tile[data-cell="${cell}"] .caption-inner`);
  return [...items].map((el) => ({
    label: el.querySelector(".stat-label")?.textContent || "",
    value: el.querySelector(".stat-value")?.textContent || "",
  }));
}

export function useCopies({
  trial,
  tetNum,
  cell,
  data,
  onNotice,
}: {
  trial: Trial | undefined;
  tetNum: number;
  cell: number;
  data: ViewData | null;
  onNotice: (message: string) => void;
}) {
  const [copies, setCopies] = useState<PlotCopy[]>([]);
  const add = (copy: Omit<PlotCopy, "id">) => {
    setCopies((cs) => [...cs, { ...copy, id: crypto.randomUUID() }]);
  };

  /** Copy a cell's tile into a floating window near (x, y). */
  const popOut = (n: number, x = 45, y = 70) => {
    const canvas = captureTile(n, "", { header: false, details: false });
    if (!canvas) {
      return;
    }
    const ratio = Math.min(2, devicePixelRatio || 1);
    const width = Math.min(innerWidth - 20, Math.max(280, canvas.width / ratio));
    const height = ((width - 2) * canvas.height) / canvas.width + 27;
    add({
      title: `${trial?.name} · T${tetNum} · cell ${n} (copy)`,
      cell: n,
      stats: tileStats(n),
      image: canvas.toDataURL(),
      ...clampToWindow(x + 15, y + 15, width, height),
      width,
      height,
    });
  };

  /** Copy the path or the feature grid into a floating window at (x, y). */
  const popPlot = (kind: "path" | "features", x: number, y: number) => {
    const source =
      kind === "features"
        ? captureFeatureGrid()
        : document.querySelector<HTMLCanvasElement>(".position-path canvas");
    if (!source) {
      return;
    }
    const ratio = Math.min(2, devicePixelRatio || 1);
    const sourceWidth = kind === "features" ? source.width / ratio : source.clientWidth;
    const width = Math.max(240, Math.min(700, sourceWidth));
    const height = ((width - 2) * source.height) / source.width + 27;
    add({
      title: `${trial?.name} · T${tetNum} · ${kind}`,
      image: source.toDataURL(),
      ...clampToWindow(x, y, width, height),
      width,
      height,
    });
  };

  /** Copy the selected cell's tile to the clipboard (or download it). */
  const copyToClipboard = () => {
    const spikes = (data?.counts[cell] || 0).toLocaleString("en-GB");
    const canvas = captureTile(
      cell,
      `${trial?.name} · T${tetNum} · cell ${cell} · ${spikes} spikes`,
    );
    canvas?.toBlob(async (blob) => {
      if (!blob) {
        return;
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        onNotice("Cell plot copied to clipboard.");
      } catch {
        downloadBlob(blob, `cell-${cell}.png`);
        onNotice("Clipboard unavailable; the plot was downloaded.");
      }
    });
  };

  const close = (id: string) => setCopies((cs) => cs.filter((c) => c.id !== id));
  return { copies, popOut, popPlot, copyToClipboard, close };
}
