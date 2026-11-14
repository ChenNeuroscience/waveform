/** The analyses the position pane shows: the trajectory, the displayed cell's
 * analysis and, while dragging one tile onto another, the target's analysis.
 *
 * Nothing is cached here. Whenever an input might have changed, the worker is asked again
 * and answers from its cache (core/src/cache.rs) when it can. Each answer carries the
 * cache's key, and an answer with the key already held keeps the held object, so an
 * unchanged plot isn't redrawn. */
import { useEffect, useState } from "react";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";
import {
  positionSource,
  type AnalysisData,
  type HeaderEdits,
  type Settings,
  type Trajectory,
  type Trial,
  type ViewData,
} from "../types";
import type { DragComparison } from "../tiles/tile-gestures";

/** `next`, unless `held` has the same cache key (and so the same values). */
const fresh = <T extends { key?: string }>(held: T | null, next: T) =>
  held && next.key && held.key === next.key ? held : next;

export function useAnalyses({
  data,
  busy,
  trial,
  settings,
  headerEdits,
  displayCell,
  dragComparison,
  onError,
}: {
  data: ViewData | null;
  busy: boolean;
  trial: Trial | undefined;
  settings: Settings;
  headerEdits: HeaderEdits;
  displayCell: number;
  dragComparison: DragComparison | null;
  onError: (message: string) => void;
}) {
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  // Each held with what it was asked for, so a different trial or cell shows nothing
  // rather than the last one's until its answer arrives.
  const [trajectory, setTrajectory] = useState<{ posFile: string; value: Trajectory } | null>(null);
  const [speedDwell, setSpeedDwell] = useState<{ key: string; values: Float32Array } | null>(null);
  const [comparison, setComparison] = useState<{ target: number; data: AnalysisData } | null>(null);
  const position = positionSource(trial, headerEdits);
  const hasRecording = !!data;

  // The path is shared by every cell, so it is asked for apart from cells' analyses.
  useEffect(() => {
    let live = true;
    const source = positionSource(trial, headerEdits);
    if (!hasRecording || !source.pos || !source.posFile) {
      setTrajectory(null);
      return;
    }
    const posFile = source.posFile;
    request("trajectory", { ...source, settings })
      .then((t) => {
        if (live) {
          setTrajectory((held) =>
            t
              ? {
                  posFile,
                  value: held?.posFile === posFile ? fresh(held.value, t) : t,
                }
              : null,
          );
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hasRecording, trial, headerEdits, settings]);

  // The hovered (or selected) cell's analysis, debounced so sweeping the pointer
  // across tiles requests only where it settles.
  useEffect(() => {
    if (!data || busy) {
      return;
    }
    let live = true;
    const timer = setTimeout(
      () =>
        request("analysis", {
          session: data.session,
          cell: displayCell,
          ...positionSource(trial, headerEdits),
          settings,
        })
          .then((a) => {
            if (live) {
              setAnalysis((held) => (held?.cell === a.cell ? fresh(held, a) : a));
              // Every cell carries the same position-only dwell histogram. Keep its
              // array across cell, cut and tetrode changes so it isn't redrawn.
              setSpeedDwell((held) =>
                !a.speedDwellKey
                  ? null
                  : held?.key === a.speedDwellKey
                    ? held
                    : { key: a.speedDwellKey, values: a.speedDwell },
              );
            }
          })
          .catch((e) => {
            if (live && !(e instanceof Superseded)) {
              onError(e.message);
            }
          }),
      25,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a fresh callback each render
  }, [data, displayCell, trial, headerEdits, settings, busy]);

  // The drag-comparison target's analysis, for its spikes on the path.
  const target = dragComparison?.target;
  useEffect(() => {
    let live = true;
    if (!data || busy || target == null) {
      return;
    }
    const timer = setTimeout(
      () =>
        request("analysis", {
          session: data.session,
          cell: target,
          ...positionSource(trial, headerEdits),
          settings,
        })
          .then((a) => {
            if (live) {
              setComparison((held) => ({
                target,
                data: held?.target === target ? fresh(held.data, a) : a,
              }));
            }
          })
          .catch((e) => {
            if (live) {
              onError(e.message);
            }
          }),
      25,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a fresh callback each render
  }, [data, target, trial, headerEdits, settings, busy]);

  return {
    analysis,
    trajectory:
      position.posFile && trajectory?.posFile === position.posFile ? trajectory.value : null,
    speedDwell: position.pos ? (speedDwell?.values ?? null) : null,
    comparisonAnalysis: target != null && comparison?.target === target ? comparison.data : null,
    clearAnalysis: () => setAnalysis(null),
  };
}
