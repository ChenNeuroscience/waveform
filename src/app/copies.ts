/** Floating copies of plots: a cell's tile (pop-out), the path or feature grid
 * (Space-click), and copying cells to the clipboard: the selected cell, or in copy
 * mode a set of cells picked on the tile wall, rewritten after every change. */
import { useEffect, useRef, useState, type RefObject } from "react";
import { captureTile, type TileWallHandle, type VisiblePlots } from "../tiles/TileWall";
import { captureAnalysisPlots, cellStatEntries, type AnalysisFrame } from "./copy-plots";
import { comparisonClipboard, type TrialCapture } from "./clipboard-layout";
import { captureFeatureGrid } from "../plots/FeatureView";
import { downloadBlob } from "../files";
import type { CellStat } from "../tiles/CellStats";
import {
  fileId,
  positionKey,
  type Trial,
  type Tetrode,
  type ViewData,
  type Settings,
} from "../types";
import { request } from "../worker/client";
import { Superseded, type CopyTrialAnalysis } from "../worker/protocol";

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

/** Thrown when a newer clipboard write replaces one still capturing. */
class StaleCopy extends Error {}

export function useCopies({
  trial,
  trials,
  settings,
  shown,
  rememberedCut,
  tetNum,
  cell,
  data,
  tileWall,
  onNotice,
}: {
  trial: Trial | undefined;
  trials: Trial[];
  settings: Settings;
  shown: VisiblePlots;
  rememberedCut: (tet: Tetrode) => string;
  tetNum: number;
  cell: number;
  data: ViewData | null;
  tileWall: RefObject<TileWallHandle | null>;
  onNotice: (message: string) => void;
}) {
  const [copies, setCopies] = useState<PlotCopy[]>([]);
  // Copy mode's selected cells (null outside copy mode), and the latest write.
  const [copying, setCopying] = useState<number[] | null>(null);
  const [trialIds, setTrialIds] = useState<string[]>([]);
  const [copyCuts, setCopyCuts] = useState<Record<string, string>>({});
  const [preparing, setPreparing] = useState(false);
  // Summaries only: changing the selected cells/trials can reuse completed analyses.
  const analysisCache = useRef(new Map<string, Map<number, CopyTrialAnalysis["cells"][number]>>());
  const latestWrite = useRef(0);
  // Copy mode ends when the window loses focus (its keys no longer reach it).
  useEffect(() => {
    const blur = () => {
      setCopying(null);
      setTrialIds([]);
      setCopyCuts({});
    };
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
  const writeClipboard = async (
    cells: number[],
    selectedTrials: string[] = [],
    selectedCuts = copyCuts,
  ) => {
    const wall = tileWall.current;
    if (!wall || !data) {
      return;
    }
    const id = ++latestWrite.current;
    setPreparing(true);
    const secondary = trials.filter((t) => t.id !== trial?.id && selectedTrials.includes(t.id));
    const sources = secondary.map((t) => {
      const tet = t.tetrodes.find((tet) => tet.number === tetNum && tet.file);
      const cut = tet?.cuts.find((cut) => cut.id === (selectedCuts[t.id] ?? rememberedCut(tet)));
      const recording = tet?.file
        ? {
            trialId: t.id,
            file: tet.file,
            assetKey: `${tet.id}|${fileId(tet.file)}`,
            cut: cut?.file,
            cutKey: cut?.id,
            pos: t.pos,
            posKey: positionKey(t),
          }
        : undefined;
      const key = `${recording?.assetKey}|${cut?.id}|${cut?.revision || 0}|${positionKey(t)}|${JSON.stringify(settings)}`;
      return { trial: t, recording, key, cut };
    });
    // Even an empty request cancels work for an older trial selection.
    const analyses = request("copy_analysis", {
      recordings: cells.length
        ? sources
            .filter(
              (s) =>
                s.recording && cells.some((cell) => !analysisCache.current.get(s.key)?.has(cell)),
            )
            .map((s) => s.recording!)
        : [],
      cells,
      settings,
    });
    const content = Promise.all([wall.capture(cells), analyses]).then(([captures, results]) => {
      if (id !== latestWrite.current) {
        throw new StaleCopy();
      }
      const ratio = Math.min(2, devicePixelRatio || 1);
      const frames: AnalysisFrame[] = (captures[0]?.plots || []).flatMap((plot) =>
        plot.mode === "waveforms"
          ? []
          : [
              {
                mode: plot.mode,
                name: plot.name,
                width: plot.canvas.width / ratio,
                height: plot.canvas.height / ratio,
              },
            ],
      );
      const primaryTet = trial?.tetrodes.find((t) => t.number === tetNum);
      const primaryCut = primaryTet?.cuts.find((c) => c.id === rememberedCut(primaryTet));
      const columns: TrialCapture[] = [
        { name: trial!.name, cutName: primaryCut?.name || "Unsorted", cells: captures },
      ];
      for (const source of sources) {
        const result = results.find((r) => r.trialId === source.trial.id);
        if (result) {
          const cache = analysisCache.current.get(source.key) || new Map();
          result.cells.forEach((cell) => cache.set(cell.cell, cell));
          analysisCache.current.set(source.key, cache);
        }
        columns.push({
          name: source.trial.name,
          cutName: source.cut?.name || (source.recording ? "Unsorted" : `No tetrode ${tetNum}`),
          cells: cells.map((cell) => {
            const result = analysisCache.current.get(source.key)?.get(cell);
            const spikes = result?.spikes || 0;
            return {
              cell,
              spikes,
              stats: cellStatEntries(result?.data, !!source.trial.pos, spikes),
              plots: captureAnalysisPlots(
                result?.data,
                spikes,
                !!source.trial.pos,
                settings,
                frames,
                source.recording ? "No data" : `No tetrode ${tetNum}`,
              ),
            };
          }),
        });
      }
      return comparisonClipboard(columns, tetNum);
    });
    try {
      const item = new ClipboardItem({
        "text/html": content.then(({ html }) => new Blob([html], { type: "text/html" })),
        "text/plain": content.then(({ text }) => new Blob([text], { type: "text/plain" })),
      });
      await navigator.clipboard.write([item]);
    } catch (error) {
      if (
        id === latestWrite.current &&
        !(error instanceof StaleCopy) &&
        !(error instanceof Superseded)
      ) {
        throw error;
      }
    } finally {
      if (id === latestWrite.current) {
        setPreparing(false);
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
  const copyCells = (cells: number[], selectedTrials = trialIds, selectedCuts = copyCuts) => {
    const sorted = [...cells].sort((a, b) => a - b);
    setCopying(sorted);
    setTrialIds(selectedTrials);
    setCopyCuts(selectedCuts);
    writeClipboard(sorted, selectedTrials, selectedCuts).catch((error) =>
      onNotice(`Clipboard could not be updated: ${error.message}`),
    );
  };
  const copyMode = {
    cells: copying,
    trialIds: copying === null ? [] : [trial?.id || "", ...trialIds],
    cuts: Object.fromEntries(
      trials.map((t) => {
        const tet = t.tetrodes.find((e) => e.number === tetNum);
        return [t.id, copyCuts[t.id] ?? (tet ? rememberedCut(tet) : "")];
      }),
    ),
    preparing,
    chooseCut: (t: Trial, cutId: string) => {
      if (copying === null || t.id === trial?.id) {
        return;
      }
      copyCells(copying, trialIds.includes(t.id) ? trialIds : [...trialIds, t.id], {
        ...copyCuts,
        [t.id]: cutId,
      });
    },
    toggleTrial: (t: Trial) => {
      if (copying === null || t.id === trial?.id) {
        return;
      }
      copyCells(
        copying,
        trialIds.includes(t.id) ? trialIds.filter((id) => id !== t.id) : [...trialIds, t.id],
      );
    },
    /** Enter copy mode, starting with the hovered cell if there is one. */
    start: (hovered: number | null) => {
      analysisCache.current.clear();
      copyCells(hovered === null ? [] : [hovered], [], {});
    },
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
    end: () => {
      setCopying(null);
      setTrialIds([]);
      setCopyCuts({});
    },
  };

  useEffect(() => {
    if (copying !== null) {
      writeClipboard(copying, trialIds).catch((error) =>
        onNotice(`Clipboard could not be updated: ${error.message}`),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selections write immediately in their event handlers; refresh only when plot options change
  }, [settings, shown]);

  const close = (id: string) => setCopies((cs) => cs.filter((c) => c.id !== id));
  const closeAll = () => setCopies([]);
  return { copies, popOut, popPlot, copyToClipboard, copyMode, close, closeAll };
}
