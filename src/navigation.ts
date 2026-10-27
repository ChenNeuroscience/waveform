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
/** Only recording choices enter browser history. Edits refresh the current entry. */
export function useRecordingHistory(
  selection: RecordingSelection | null,
  restore: (selection: RecordingSelection, current: () => boolean) => void | Promise<void>,
) {
  const workspace = useRef(crypto.randomUUID()),
    selected = useRef(selection),
    callback = useRef(restore),
    version = useRef(0),
    restoring = useRef(false);
  selected.current = selection;
  callback.current = restore;
  const entry = (next: RecordingSelection) => ({
    ...(history.state && typeof history.state === "object" ? history.state : {}),
    waveform: { workspace: workspace.current, selection: next },
  });
  useEffect(() => {
    if (selection && !restoring.current) history.replaceState(entry(selection), "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- replace the history entry only when the selection's identity changes
  }, [selection?.trialId, selection?.tetNum, selection?.cutId]);
  useEffect(() => {
    const pop = async (event: PopStateEvent) => {
      const state = event.state?.waveform,
        next = savedSelection(state?.selection);
      if (!next || state.workspace !== workspace.current) return;
      const token = ++version.current;
      restoring.current = true;
      try {
        await callback.current(next, () => token === version.current);
      } finally {
        if (token === version.current) restoring.current = false;
      }
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  return (next: RecordingSelection) => {
    ++version.current;
    restoring.current = false;
    if (same(selected.current, next)) {
      history.replaceState(entry(next), "");
      return;
    }
    if (selected.current && history.state?.waveform?.workspace !== workspace.current)
      history.replaceState(entry(selected.current), "");
    history.pushState(entry(next), "");
  };
}
