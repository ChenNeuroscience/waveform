import { useEffect, useRef } from "react";
export interface RecordingSelection {
  trialId: string;
  tetNum: number;
  cutId: string;
}
const same = (a: RecordingSelection | null, b: RecordingSelection) =>
  !!a && a.trialId === b.trialId && a.tetNum === b.tetNum && a.cutId === b.cutId;
function savedSelection(value: any): RecordingSelection | null {
  return value &&
    typeof value.trialId === "string" &&
    Number.isInteger(value.tetNum) &&
    value.tetNum > 0 &&
    typeof value.cutId === "string"
    ? value
    : null;
}
/** Only recording choices enter browser history; edits refresh the current entry.
 * The start screen is an entry too (selection null), so the first recording opened
 * is pushed after it and Back returns home. */
export function useRecordingHistory(
  selection: RecordingSelection | null,
  /** Show a selection, or the start screen for null. */
  restore: (selection: RecordingSelection | null, current: () => boolean) => void | Promise<void>,
) {
  const workspace = useRef(crypto.randomUUID());
  const selected = useRef(selection);
  const callback = useRef(restore);
  const version = useRef(0);
  const restoring = useRef(false);
  selected.current = selection;
  callback.current = restore;
  const entry = (next: RecordingSelection | null) => ({
    ...(history.state && typeof history.state === "object" ? history.state : {}),
    waveform: { workspace: workspace.current, selection: next },
  });
  // Whether the current history entry is this workspace's start screen.
  const atHome = () => {
    const state = history.state?.waveform;
    return state?.workspace === workspace.current && !state.selection;
  };
  useEffect(() => {
    if (restoring.current) {
      return;
    }
    if (selection && atHome()) {
      history.pushState(entry(selection), "");
    } else {
      history.replaceState(entry(selection), "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- replace the history entry only when the selection's identity changes
  }, [selection?.trialId, selection?.tetNum, selection?.cutId]);
  useEffect(() => {
    const pop = async (event: PopStateEvent) => {
      const state = event.state?.waveform;
      const next = savedSelection(state?.selection);
      if (state?.workspace !== workspace.current || (state.selection && !next)) {
        return;
      }
      const token = ++version.current;
      restoring.current = true;
      try {
        await callback.current(next, () => token === version.current);
      } finally {
        if (token === version.current) {
          restoring.current = false;
        }
      }
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  /** Choose a recording, adding a history entry. */
  const push = (next: RecordingSelection) => {
    ++version.current;
    restoring.current = false;
    if (same(selected.current, next)) {
      history.replaceState(entry(next), "");
      return;
    }
    if (selected.current && history.state?.waveform?.workspace !== workspace.current) {
      history.replaceState(entry(selected.current), "");
    }
    history.pushState(entry(next), "");
  };
  /** Go to the start screen, adding a history entry. */
  const pushHome = () => {
    ++version.current;
    restoring.current = false;
    if (!atHome()) {
      history.pushState(entry(null), "");
    }
  };
  return { push, pushHome };
}
