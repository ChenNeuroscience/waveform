/** A trial's time labels from the worker's compute graph, for the time labels window.
 *
 * As with the other analyses, nothing is cached here: whenever the trial, recording or
 * configuration might have changed the worker is asked again, and its graph only recomputes
 * what changed. */
import { useEffect, useState } from "react";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";
import type { TimeLabelsData, Trial } from "../types";
import { timeLabelSource, type TimeLabelConfig } from "./time-label-config";

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
