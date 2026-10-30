/** The analyses the position pane shows: the trajectory, the displayed cell's
 * analysis and, while dragging one tile onto another, the target's analysis. */
import { useEffect, useState } from "react";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";
import {
  fileId,
  positionKey,
  type AnalysisData,
  type Settings,
  type Trajectory,
  type Trial,
  type ViewData,
} from "../types";
import type { DragComparison } from "../tiles/tile-gestures";

export function useAnalyses({
  data,
  busy,
  trial,
  settings,
  displayCell,
  dragComparison,
  onError,
}: {
  data: ViewData | null;
  busy: boolean;
  trial: Trial | undefined;
  settings: Settings;
  displayCell: number;
  dragComparison: DragComparison | null;
  onError: (message: string) => void;
}) {
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [trajectory, setTrajectory] = useState<{ key: string; value: Trajectory | null } | null>(
    null,
  );
  const [speedDwell, setSpeedDwell] = useState<{ key: string; values: Float32Array } | null>(null);
  const [comparison, setComparison] = useState<{ key: string; data: AnalysisData } | null>(null);
  const trajectoryKey =
    data && trial?.pos
      ? `${positionKey(trial)}|${settings.leds}|${settings.maxSpeed}|${settings.posSmooth}`
      : "";
  const speedDwellKey = trajectoryKey
    ? `${trajectoryKey}|${settings.speedBin}|${settings.speedMax}`
    : "";

  // The path is shared by every cell, so it is fetched once per position file and
  // processing settings rather than with each cell's analysis.
  useEffect(() => {
    let live = true;
    if (!trajectoryKey || !trial?.pos) {
      setTrajectory(null);
      return;
    }
    request("trajectory", { pos: trial.pos, posKey: positionKey(trial), settings })
      .then((t) => {
        if (live) {
          setTrajectory({ key: trajectoryKey, value: t });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trajectoryKey covers recording availability, position identity and processing settings; tetrode and cut changes reuse the path
  }, [trajectoryKey]);

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
          pos: trial?.pos,
          posKey: positionKey(trial),
          settings,
        })
          .then((a) => {
            if (live) {
              setAnalysis(a);
              // Every cell carries the same position-only dwell histogram. Retain
              // its array across cell, cut and tetrode changes so it isn't redrawn.
              if (speedDwellKey) {
                setSpeedDwell((current) =>
                  current?.key === speedDwellKey
                    ? current
                    : { key: speedDwellKey, values: a.speedDwell },
                );
              }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the listed analysis settings change the result; trial.id travels with trial.pos
  }, [
    data,
    displayCell,
    trial?.pos,
    settings.binCm,
    settings.smooth,
    settings.acWindow,
    settings.leds,
    settings.maxSpeed,
    settings.posSmooth,
    settings.dirBin,
    settings.speedBin,
    settings.speedMax,
    busy,
  ]);

  // The drag-comparison target's analysis, for its spikes on the path.
  const comparisonKey = [
    data?.session,
    data?.revision,
    trial?.id,
    trial?.pos ? fileId(trial.pos) : "",
    settings.leds,
    settings.maxSpeed,
    settings.posSmooth,
    dragComparison?.target,
  ].join("|");
  useEffect(() => {
    let live = true;
    const target = dragComparison?.target;
    if (!data || busy || target == null) {
      return;
    }
    const timer = setTimeout(
      () =>
        request("analysis", {
          session: data.session,
          cell: target,
          pos: trial?.pos,
          posKey: positionKey(trial),
          settings,
        })
          .then((a) => {
            if (live) {
              setComparison({ key: comparisonKey, data: a });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- comparisonKey covers the comparison's inputs
  }, [comparisonKey, trial?.pos, busy]);

  return {
    analysis,
    trajectory: trajectory?.key === trajectoryKey ? trajectory.value : null,
    speedDwell: speedDwell?.key === speedDwellKey ? speedDwell.values : null,
    comparisonAnalysis: comparison?.key === comparisonKey ? comparison.data : null,
    clearAnalysis: () => setAnalysis(null),
  };
}
