/** The worker request protocol: each request type's payload and result, shared by
 * the client (client.ts) and the worker (engine.worker.ts) so a renamed request or
 * field fails to compile rather than at runtime. */
import type {
  AnalysisData,
  Header,
  Settings,
  Trajectory,
  ViewData,
  ViewMessage,
  FeatureMode,
  FeatureProjection,
  PcaFeatures,
} from "../types";

/** A request dropped because a newer one replaced it (another recording, a newer
 * analysis batch, an outdated export). Callers ignore these rather than report them. */
export class Superseded extends Error {
  name = "Superseded";
}
/** A new local cut created by the first edit of an original. */
export interface NewCut {
  id: string;
  name: string;
}
interface Session {
  session: string;
}
/** A brush or lasso region in one feature projection, applied to source cells. */
interface RegionEdit {
  sources: number[];
  ax: number;
  ay: number;
  polygon: number[];
  /** Identify the displayed PCA basis so a stale plot cannot cut another basis. */
  featureKey?: string;
  projection?: FeatureProjection;
}
export type EditRequest = Session & {
  dest: number;
  description: string;
  newCut?: NewCut;
} & (
    | { action: "merge"; source: number }
    | { action: "swap"; source: number }
    | ({ action: "paint" } & RegionEdit)
    | ({ action: "polygon" } & RegionEdit)
  );
export type SplitRequest = Session &
  (
    | {
        phase: "preview";
        source: number;
        channel: number;
        sample: number;
        threshold: number;
      }
    | { phase: "finish"; newCut?: NewCut }
    | { phase: "cancel" }
  );
export interface PositionRequest {
  pos?: File;
  posKey: string;
  settings: Settings;
}

/** A secondary trial to analyse for the clipboard without activating its recording. */
export interface CopyRecording {
  trialId: string;
  file: File;
  assetKey: string;
  cut?: File;
  cutKey?: string;
  pos?: File;
  posKey: string;
  set?: File;
}
export interface CopyTrialAnalysis {
  trialId: string;
  cells: { cell: number; spikes: number; data: AnalysisData | null }[];
  /** Included only for path copies, even when no cells are selected. */
  position?: {
    trajectory: Trajectory | null;
    overview: AnalysisData;
    header: Header;
    duration: number;
  };
}

/** [payload, result] for each request type. */
export interface Requests {
  features: [
    { asset: string; mode: FeatureMode; samples: number; knownKey?: string },
    (Omit<PcaFeatures, "values"> & { values?: Float32Array }) | null,
  ];
  copy_analysis: [
    {
      recordings: CopyRecording[];
      cells: number[];
      settings: Settings;
      spatialAc?: boolean;
      path?: boolean;
    },
    CopyTrialAnalysis[],
  ];
  demo: [{ options: { quick?: boolean; stress?: "1m" | "9m"; seed: number } }, File[]];
  load: [
    {
      file: File;
      assetKey: string;
      cut?: File;
      cutKey?: string;
      set?: File;
      pos?: File;
    },
    ViewData,
  ];
  view: [Session, ViewData];
  edit: [EditRequest, ViewData];
  split: [SplitRequest, ViewData];
  undo: [Session, ViewData];
  redo: [Session, ViewData];
  export: [Session & { format: "cut" | "clu"; trial: string }, Blob];
  /** Export a cut that may not be the active one (by its session key). */
  export_cut: [Session & { revision?: number; trial: string }, Blob];
  wave_batch: [{ asset: string; first: number; count: number }, { waves: Uint8Array }];
  trajectory: [PositionRequest, Trajectory | null];
  analysis: [
    Partial<Session> &
      PositionRequest & { cell: number; summary?: boolean; batch?: string; spatialAc?: boolean },
    AnalysisData,
  ];
}
export type RequestType = keyof Requests;
export type Payload<K extends RequestType> = Requests[K][0];
export type Result<K extends RequestType> = Requests[K][1];
/** What the worker sends: views omit population arrays the client already has. */
export type WorkerResult<K extends RequestType> = K extends RequestType
  ? Result<K> extends ViewData
    ? ViewMessage
    : Result<K>
  : never;
/** A request as posted to the worker. */
export type WorkerMessage = {
  [K in RequestType]: { id: number; type: K } & Payload<K>;
}[RequestType];
