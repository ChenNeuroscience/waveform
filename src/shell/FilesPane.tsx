import { cutDownloadKey, type CutDownloads } from "../app/cut-downloads";
import type { CutFile, Tetrode, Trial } from "../types";
import { useEffect, useRef } from "react";
import { ToggleButton } from "./ToggleButton";

/** Tetrode navigation and the trials with their tetrode and cut files. */
export function FilesPane(p: {
  cutDownloads: CutDownloads;
  cutId: string;
  onCutDrag: (event: React.DragEvent, t: Trial, e: Tetrode, c: CutFile) => void;
  onPrepareCut: (t: Trial, e: Tetrode, c: CutFile) => void;
  onRecording: (t: Trial, n: number, c?: string) => void;
  onTet: (n: number) => void;
  onTrial: (t: Trial) => void;
  tetNum: number;
  trial?: Trial;
  trials: Trial[];
  copying: boolean;
  copyTrialIds: string[];
  onCopyTrial: (t: Trial) => void;
  copyCuts: Record<string, string>;
  onCopyCut: (t: Trial, cut: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    navigation.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [p.tetNum]);
  // Keep the selected trial in view when it changes.
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(".trial-block.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [p.trial?.id]);
  const numbers = [...new Set(p.trials.flatMap((t) => t.tetrodes.map((t) => t.number)))].sort(
    (a, b) => a - b,
  );
  return (
    <section className="files-pane">
      <div className="tetrode-navigation">
        <span>Tetrode:</span>
        <div className="toggle-group" role="group" aria-label="Tetrodes" ref={navigation}>
          {numbers.map((n) => (
            <ToggleButton
              key={n}
              pressed={n === p.tetNum}
              aria-label={String(n).padStart(2, "0")}
              disabled={p.copying || !p.trial?.tetrodes.find((t) => t.number === n)?.file}
              onClick={() => p.onTet(n)}
            >
              {n}
            </ToggleButton>
          ))}
        </div>
      </div>
      <div className="trial-list" ref={list} data-copying={p.copying ? "" : undefined}>
        {p.trials.map((t) => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            aria-label={`${t.name} ${t.tetrodes.length}`}
            aria-pressed={p.copying ? p.copyTrialIds.includes(t.id) : t.id === p.trial?.id}
            aria-current={t.id === p.trial?.id ? "true" : undefined}
            onClick={() => (p.copying ? p.onCopyTrial(t) : p.onTrial(t))}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                e.stopPropagation();
                if (p.copying) {
                  p.onCopyTrial(t);
                } else {
                  p.onTrial(t);
                }
              }
            }}
            className={`trial-block ${t.id === p.trial?.id ? "selected" : ""} ${p.copying && p.copyTrialIds.includes(t.id) ? "copy-included" : ""}`}
          >
            <div className="trial-heading">
              <span className="trial-name" title={t.folder || t.name}>
                <b>Trial '{t.name}'</b>
              </span>
              <span className={`file-tag ${t.set ? "" : "missing"}`}>~.set</span>
              <span className={`file-tag ${t.pos ? "" : "missing"}`}>~.pos</span>
              {!!t.otherFiles?.length && (
                <span
                  className="other-files"
                  title={`Other files (not loaded):\n${t.otherFiles.join("\n")}`}
                >
                  {t.otherFiles.length} other {t.otherFiles.length === 1 ? "file" : "files"}
                </span>
              )}
              <small>{t.folder}</small>
            </div>
            <div className="trial-tetrodes">
              {t.tetrodes.map((e) => (
                <div
                  key={e.id}
                  className={`tetrode-file-block ${e.number === p.tetNum ? "expanded" : ""}`}
                  data-tetrode={e.number}
                >
                  {e.file && (
                    <button
                      disabled={
                        p.copying && (e.number !== p.tetNum || (t.id === p.trial?.id && !!p.cutId))
                      }
                      title={e.file.name}
                      aria-label={`${t.name} tetrode ${e.number}`}
                      className={
                        e.number === p.tetNum &&
                        ((t.id === p.trial?.id && !p.cutId) ||
                          (p.copying && p.copyTrialIds.includes(t.id) && p.copyCuts[t.id] === ""))
                          ? "active"
                          : ""
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (p.copying) {
                          p.onCopyCut(t, "");
                        } else {
                          p.onRecording(t, e.number, "");
                        }
                      }}
                    >
                      ~.{e.number}
                    </button>
                  )}
                  {e.cuts.map((c) => (
                    <button
                      disabled={
                        p.copying &&
                        (e.number !== p.tetNum || (t.id === p.trial?.id && c.id !== p.cutId))
                      }
                      key={c.id}
                      title={`${c.name}${c.local ? " (modified cut)" : ""}`}
                      data-local={c.local ? "true" : undefined}
                      data-export-ready={
                        p.cutDownloads.entries.has(cutDownloadKey(e, c)) ? "true" : "false"
                      }
                      draggable
                      onMouseEnter={() => p.onPrepareCut(t, e, c)}
                      onPointerDown={() => p.onPrepareCut(t, e, c)}
                      onDragStart={(event) => p.onCutDrag(event, t, e, c)}
                      aria-label={c.name.replace(t.name, "~")}
                      className={`cut-file ${c.local ? "local-cut" : ""} ${e.number === p.tetNum && ((t.id === p.trial?.id && p.cutId === c.id) || (p.copying && p.copyTrialIds.includes(t.id) && p.copyCuts[t.id] === c.id)) ? "active" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (p.copying) {
                          p.onCopyCut(t, c.id);
                        } else {
                          p.onRecording(t, e.number, c.id);
                        }
                      }}
                    >
                      {c.name.replace(t.name, "~")}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
