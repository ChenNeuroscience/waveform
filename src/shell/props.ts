import { type ReactNode, type RefObject } from "react";
import { type VisiblePlots } from "../tiles/TileWall";
import {
  type Trial,
  type Tetrode,
  type CutFile,
  type ViewData,
  type Trajectory,
  type AnalysisData,
  type Settings,
  type PlotMode,
  type SplitPoint,
} from "../types";
import type { DragComparison } from "../tiles/tile-gestures";
import { CutDownloads } from "../cut-downloads";
import type { SwapState, TileFeedback } from "../types";
/** Everything the desktop shell and its regions receive from App. */
export interface ShellProps {
  trials: Trial[];
  trial?: Trial;
  tetNum: number;
  cutId: string;
  data: ViewData | null;
  analysis: AnalysisData | null;
  trajectory: Trajectory | null;
  settings: Settings;
  cell: number;
  sources: number[];
  dest: number;
  tool: string;
  isolate: boolean;
  shown: VisiblePlots;
  splitPoint: SplitPoint | null;
  swap: SwapState | null;
  tileFeedback: TileFeedback | null;
  onSwapGroup: (group: number) => void;
  onCancelSwap: () => void;
  grabMode: boolean;
  hoverCell: number | null;
  dragComparison: DragComparison | null;
  comparisonAnalysis: AnalysisData | null;
  onCompare: (pair: DragComparison | null) => void;
  onHover: (n: number | null) => void;
  onTileHover: (n: number | null) => void;
  onMerge: (a: number, b: number) => void;
  onWaveSplit: (cell: number, channel: number, sample: number, threshold: number) => void;
  onPopOut: (cell: number, x?: number, y?: number) => void;
  onPopPlot: (kind: "path" | "features", x: number, y: number) => void;
  ready: boolean;
  busy: boolean;
  progress: number;
  message: string;
  error: string;
  notice: string;
  drag: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  folderInput: RefObject<HTMLInputElement | null>;
  onImport: (f: File[]) => void;
  onTrial: (t: Trial) => void;
  onTet: (n: number) => void;
  onRecording: (t: Trial, n: number, c?: string) => void;
  onCut: (id: string) => void;
  downloadVersion: number;
  cutDownloads: CutDownloads;
  onPrepareCut: (t: Trial, e: Tetrode, c: CutFile) => void;
  onCutDrag: (event: React.DragEvent, t: Trial, e: Tetrode, c: CutFile) => void;
  onCell: (n: number) => void;
  onSource: (n: number, toggle: boolean) => void;
  onDest: (n: number) => void;
  onNewGroup: () => void;
  onTool: (s: string) => void;
  onToggle: (m: PlotMode, multiple: boolean) => void;
  onPanel: (p: "settings" | "history" | "headers" | "help") => void;
  onOperation: (type: "undo" | "redo") => void;
  onPolygon: (p: number[], a: number, b: number) => void;
  onDemo: () => void;
  onError: () => void;
  onNotice: () => void;
  onDrag: (v: boolean) => void;
  onDrop: (e: React.DragEvent) => void;
  children?: ReactNode;
}
