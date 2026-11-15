/** The selected `.egf` file's frequency distribution, for the position pane.
 *
 * As with the other analyses, nothing is cached here: whenever the trial, file or settings
 * might have changed the worker is asked again, and its compute graph only recomputes what
 * changed. A distribution with an unchanged key keeps its held array, so its plot isn't
 * redrawn. */
import { useEffect, useState } from "react";
import { request } from "../worker/client";
import { Superseded } from "../worker/protocol";
import { egfSource, type LfpDistribution, type Settings, type Trial } from "../types";

export function useLfp({
  trial,
  egfNum,
  settings,
  show,
  onError,
}: {
  trial: Trial | undefined;
  egfNum: number;
  settings: Settings;
  /** Whether the plot is on: off, nothing is asked for. */
  show: boolean;
  onError: (message: string) => void;
}) {
  // Held with the file it is of, so another file shows nothing until its answer arrives.
  const [held, setHeld] = useState<{ egfFile: string; value: LfpDistribution } | null>(null);
  const { egfFile } = egfSource(trial, egfNum);
  const { lfpLow, lfpHigh, lfpFreqBin } = settings;
  useEffect(() => {
    let live = true;
    const source = egfSource(trial, egfNum);
    // Off, nothing is read or computed.
    if (!show || !source.egf || !source.egfFile) {
      return;
    }
    const file = source.egfFile;
    request("lfp", { ...source, settings })
      .then((d) => {
        if (live && d) {
          setHeld((h) => ({
            egfFile: file,
            value: h?.egfFile === file && h.value.key === d.key ? h.value : d,
          }));
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
    // Only the LFP settings matter; the rest would re-ask for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError is a fresh callback each render
  }, [trial, egfNum, show, lfpLow, lfpHigh, lfpFreqBin]);
  return show && egfFile && held?.egfFile === egfFile ? held.value : null;
}
