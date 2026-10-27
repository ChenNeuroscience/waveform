/** The worker request protocol: each request type's payload and result, shared by
 * the client (client.ts) and the worker (engine.worker.ts) so a renamed request or
 * field fails to compile rather than at runtime. */
import type {
  AnalysisData,
  Settings,
  Trajectory,
  ViewData,
  ViewMessage,
} from "./types";

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
}
export type EditRequest = Session & {
  dest: number;
  description: string;
  newCut?: NewCut;
} & (
    | { action: "sort" }
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

/** [payload, result] for each request type. */
export interface Requests {
  demo: [
    { options: { quick?: boolean; stress?: boolean; seed: number } },
    File[],
  ];
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
  wave_batch: [
    { asset: string; first: number; count: number },
    { waves: Uint8Array },
  ];
  trajectory: [PositionRequest, Trajectory | null];
  analysis: [
    Partial<Session> &
      PositionRequest & { cell: number; summary?: boolean; batch?: string },
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
