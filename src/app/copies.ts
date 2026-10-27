/** Floating copies of plots: a cell's tile (pop-out), the path or feature grid
 * (Space-click), and copying cells to the clipboard: the selected cell, or in copy
 * mode a set of cells picked on the tile wall, rewritten after every change. */
import { useEffect, useRef, useState, type RefObject } from "react";
import { captureTile, type CellCapture, type TileWallHandle } from "../tiles/TileWall";
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

/** Clipboard HTML and plain text for captured cells: per cell, a line with its
 * bold title and stats, then (HTML only) one image per plot. */
function clipboardContent(captures: CellCapture[], prefix: string, counts: Uint32Array) {
  const ratio = Math.min(2, devicePixelRatio || 1);
  const html: string[] = [];
  const text: string[] = [];
  for (const { cell, stats, plots } of captures) {
    const title = `${prefix} · cell ${cell}`;
    const spikes = `${(counts[cell] || 0).toLocaleString("en-GB")} spikes`;
    const rates = stats.filter((s) => s.label !== "n spikes").map((s) => `${s.label}: ${s.value}`);
    const details = [spikes, ...rates].join(" · ");
    const images = plots.map(
      ({ name, canvas }) =>
        `<img src="${canvas.toDataURL()}" alt="${name}" width="${Math.round(canvas.width / ratio)}" height="${Math.round(canvas.height / ratio)}">`,
    );
    html.push(
      `<p style="margin:0"><b>${escapeHtml(title)}</b> · ${escapeHtml(details)}</p>`,
      `<p style="margin:0">${images.join(" ")}</p>`,
    );
    text.push(`${title} · ${details}`);
  }
  return { html: html.join(""), text: text.join("\n") };
}

/** Thrown when a newer clipboard write replaces one still capturing. */
class StaleCopy extends Error {}

export function useCopies({
  trial,
  tetNum,
  cell,
  data,
  tileWall,
  onNotice,
}: {
  trial: Trial | undefined;
  tetNum: number;
  cell: number;
  data: ViewData | null;
  tileWall: RefObject<TileWallHandle | null>;
  onNotice: (message: string) => void;
}) {
  const [copies, setCopies] = useState<PlotCopy[]>([]);
  // Copy mode's selected cells (null outside copy mode), and the latest write.
  const [copying, setCopying] = useState<number[] | null>(null);
  const latestWrite = useRef(0);
  // Copy mode ends when the window loses focus (its keys no longer reach it).
  useEffect(() => {
    const blur = () => setCopying(null);
    addEventListener("blur", blur);
    return () => removeEventListener("blur", blur);
  }, []);
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

  /** Put cells on the clipboard. The item is handed over at once (keeping the key
   * press or click that allows it) and filled when the plots are captured; a
   * newer write makes an older one fail quietly. */
  const writeClipboard = async (cells: number[]) => {
    const wall = tileWall.current;
    if (!wall || !data) {
      return;
    }
    const id = ++latestWrite.current;
    const counts = data.counts;
    const content = wall.capture(cells).then((captures) => {
      if (id !== latestWrite.current) {
        throw new StaleCopy();
      }
      return clipboardContent(captures, `${trial?.name} · T${tetNum}`, counts);
    });
    try {
      const item = new ClipboardItem({
        "text/html": content.then(({ html }) => new Blob([html], { type: "text/html" })),
        "text/plain": content.then(({ text }) => new Blob([text], { type: "text/plain" })),
      });
      await navigator.clipboard.write([item]);
    } catch (error) {
      if (id === latestWrite.current && !(error instanceof StaleCopy)) {
        throw error;
      }
    }
  };

  /** Copy the selected cell (or download its tile if the clipboard is unavailable). */
  const copyToClipboard = async () => {
    try {
      await writeClipboard([cell]);
    } catch {
      captureTile(cell, `${trial?.name} · T${tetNum} · cell ${cell}`)?.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, `cell-${cell}.png`);
        }
      });
      onNotice("Clipboard unavailable; the plot was downloaded.");
    }
  };

  /** Set the copy-mode selection and put it on the clipboard. */
  const copyCells = (cells: number[]) => {
    const sorted = [...cells].sort((a, b) => a - b);
    setCopying(sorted);
    if (sorted.length) {
      writeClipboard(sorted).catch(() => onNotice("Clipboard unavailable."));
    }
  };
  const copyMode = {
    cells: copying,
    /** Enter copy mode, starting with the hovered cell if there is one. */
    start: (hovered: number | null) => copyCells(hovered === null ? [] : [hovered]),
    toggle: (n: number) => {
      const current = copying ?? [];
      copyCells(current.includes(n) ? current.filter((c) => c !== n) : [...current, n]);
    },
    selectAll: () => {
      const all: number[] = [];
      data?.counts.forEach((count, n) => {
        if (count > 0) {
          all.push(n);
        }
      });
      copyCells(all);
    },
    end: () => setCopying(null),
  };

  const close = (id: string) => setCopies((cs) => cs.filter((c) => c.id !== id));
  const closeAll = () => setCopies([]);
  return { copies, popOut, popPlot, copyToClipboard, copyMode, close, closeAll };
}
