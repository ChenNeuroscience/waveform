/** Floating copies of plots: a cell's tile (pop-out), the path or feature grid
 * (Space-click), and copying the selected cell's tile to the clipboard. */
import { useState } from "react";
import { captureTile, captureTilePlots } from "../tiles/TileWall";
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

/** Escape text for inclusion in clipboard HTML. */
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  /** Copy the selected cell to the clipboard as text plus one image per plot
   * (or download the tile if the clipboard is unavailable). */
  const copyToClipboard = async () => {
    const spikes = (data?.counts[cell] || 0).toLocaleString("en-GB");
    const title = `${trial?.name} · T${tetNum} · cell ${cell}`;
    const stats = tileStats(cell).filter((s) => s.label !== "n spikes");
    const details = [`${spikes} spikes`, ...stats.map((s) => `${s.label}: ${s.value}`)].join(" · ");
    const plots = captureTilePlots(cell);
    const ratio = Math.min(2, devicePixelRatio || 1);
    const images = plots.map(
      ({ name, canvas }) =>
        `<img src="${canvas.toDataURL()}" alt="${name}" width="${Math.round(canvas.width / ratio)}" height="${Math.round(canvas.height / ratio)}">`,
    );
    const html = [
      `<p style="margin:0"><b>${escapeHtml(title)}</b> · ${escapeHtml(details)}</p>`,
      `<p style="margin:0">${images.join(" ")}</p>`,
    ].join("");
    const text = `${title} · ${details}`;
    try {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      onNotice(`Cell ${cell}: text and ${plots.length} plots copied to clipboard.`);
    } catch {
      captureTile(cell, text)?.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, `cell-${cell}.png`);
        }
      });
      onNotice("Clipboard unavailable; the plot was downloaded.");
    }
  };

  const close = (id: string) => setCopies((cs) => cs.filter((c) => c.id !== id));
  return { copies, popOut, popPlot, copyToClipboard, close };
}
