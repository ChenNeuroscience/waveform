/** The waveform split: previews update as the gate is dragged (worker-side, without
 * history); a left click elsewhere finishes it as one undoable edit and Escape
 * cancels it. Repeated finish/cancel calls share one request. */
import { useEffect, useRef } from "react";
import { request } from "../worker/client";
import type { NewCut } from "../worker/protocol";
import type { SplitPoint, ViewData } from "../types";

export interface StatusSetters {
  setBusy: (busy: boolean) => void;
  setProgress: (fraction: number) => void;
  setMessage: (message: string) => void;
  setError: (message: string) => void;
}

export function useSplit({
  splitPoint,
  setSplitPoint,
  ready,
  session,
  newCut,
  adopt,
  setData,
  onFinishing,
  status,
}: {
  splitPoint: SplitPoint | null;
  setSplitPoint: (point: SplitPoint | null) => void;
  ready: boolean;
  session: string | undefined;
  /** A name for the local cut the finished split creates (undefined if already local). */
  newCut: () => NewCut | undefined;
  adopt: (view: ViewData) => void;
  setData: (view: ViewData) => void;
  onFinishing: () => void;
  status: StatusSetters;
}) {
  const finishing = useRef(false);
  const completion = useRef<Promise<void> | null>(null);
  const { setBusy, setProgress, setMessage, setError } = status;

  // Show the split for a gate; the source stays fixed once a split is open.
  const preview = async (source: number, channel: number, sample: number, threshold: number) => {
    if (!ready || finishing.current) {
      return;
    }
    source = splitPoint?.source ?? source;
    setSplitPoint({ source, channel, sample, threshold });
    setBusy(true);
    setMessage("Preparing split preview…");
    try {
      const view = await request(
        "split",
        { session: session!, phase: "preview", source, channel, sample, threshold },
        (p, m) => {
          setProgress(p);
          setMessage(m);
        },
      );
      setData(view);
    } catch (error) {
      setError(String(error));
      setData(await request("view", { session: session! }));
      setSplitPoint(null);
    } finally {
      if (!finishing.current) {
        setBusy(false);
      }
    }
  };

  const finish = (cancel = false): Promise<void> => {
    if (completion.current) {
      return completion.current;
    }
    if (!splitPoint) {
      return Promise.resolve();
    }
    completion.current = (async () => {
      finishing.current = true;
      setBusy(true);
      onFinishing();
      try {
        const named = cancel ? undefined : newCut();
        adopt(
          await request("split", {
            session: session!,
            phase: cancel ? "cancel" : "finish",
            ...(named ? { newCut: named } : {}),
          }),
        );
      } catch (error) {
        setError(String(error));
        setData(await request("view", { session: session! }));
      } finally {
        completion.current = null;
        setSplitPoint(null);
        finishing.current = false;
        setBusy(false);
      }
    })();
    return completion.current;
  };

  // While a split is open: a left press anywhere except the split tiles'
  // waveforms finishes it (and that click does nothing else); Escape cancels.
  useEffect(() => {
    if (!splitPoint) {
      return;
    }
    const complete = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      const tile = (event.target as Element | null)
        ?.closest(".tile-waves")
        ?.closest<HTMLElement>(".cell-tile");
      if (tile && [splitPoint.source, splitPoint.source + 1].includes(Number(tile.dataset.cell))) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopImmediatePropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 500);
      finish();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(true);
      }
    };
    window.addEventListener("pointerdown", complete, true);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", complete, true);
      window.removeEventListener("keydown", cancel, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listeners are re-registered per split point; finish reads only values fixed for the split
  }, [splitPoint]);

  return { previewSplit: preview, finishSplit: finish };
}
