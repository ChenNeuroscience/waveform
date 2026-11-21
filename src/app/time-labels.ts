/** A trial's time labels from the worker's compute graph, for the time labels window.
 *
 * As with the other analyses, nothing is cached here: whenever the trial, recording or
 * configuration might have changed the worker is asked again, and its graph only recomputes
 * what changed. */
import { useEffect, useState } from "react";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";
import {
  positionSource,
  type HeaderEdits,
  type Settings,
  type TimeLabelsData,
  type Trial,
} from "../types";
import { timeLabelSource, timeMaskSource, type TimeLabelConfig } from "./time-label-config";

/** The trial's time labels for the loaded recording (its duration), while `show` is on. */
export function useTimeLabels({
  trial,
  recording,
  config,
  show,
  onError,
}: {
  trial: Trial | undefined;
  /** The loaded recording's key: its duration is the trial's. */
  recording: string | undefined;
  config: TimeLabelConfig;
  show: boolean;
  onError: (message: string) => void;
}) {
  const [held, setHeld] = useState<TimeLabelsData | null>(null);
  const source = timeLabelSource(trial, config);
  const { logFile: file, timeRules } = source;
  useEffect(() => {
    let live = true;
    if (!show || !recording) {
      return;
    }
    request("time_labels", source)
      .then((d) => {
        if (live) {
          // An unchanged answer keeps its arrays, so what draws them needn't.
          setHeld((h) => (h?.key === d.key && h.error === d.error ? h : d));
        }
      })
      .catch((e) => {
        if (live && !(e instanceof Superseded)) {
          onError(e.message);
        }
      });
    return () => {
      live = false;
    };
    // The source is a fresh object each render; its parts are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a fresh callback each render
  }, [show, recording, file, timeRules]);
  return show && recording ? held : null;
}

/** While `label` is set (a timeline row hovered), the trajectory in that label's times,
 * broken where it leaves them, for the position pane. */
export function useLabelPath({
  trial,
  headerEdits,
  settings,
  recording,
  config,
  label,
  onError,
}: {
  trial: Trial | undefined;
  headerEdits: HeaderEdits;
  settings: Settings;
  /** The loaded recording's key: its duration is the trial's. */
  recording: string | undefined;
  config: TimeLabelConfig;
  label: number | null;
  onError: (message: string) => void;
}) {
  const [held, setHeld] = useState<{ label: number; path: Float32Array } | null>(null);
  const position = positionSource(trial, headerEdits);
  const { timeRules, logFile } = timeLabelSource(trial, config);
  const { leds, maxSpeed, posSmooth } = settings;
  useEffect(() => {
    let live = true;
    if (label === null || !recording || !position.pos) {
      return;
    }
    request("label_path", {
      ...position,
      ...timeMaskSource(trial, config, label),
      settings,
    })
      .then((path) => live && setHeld({ label, path }))
      .catch((e) => {
        if (live && !(e instanceof Superseded)) {
          onError(e.message);
        }
      });
    return () => {
      live = false;
    };
    // The sources are fresh objects each render; their parts are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a fresh callback each render
  }, [
    label,
    recording,
    position.posFile,
    position.ppm,
    position.sync,
    timeRules,
    logFile,
    leds,
    maxSpeed,
    posSmooth,
  ]);
  // Only the hovered label's path: none while another's is on its way.
  return label !== null && held?.label === label ? held : null;
}
