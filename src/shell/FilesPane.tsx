import { cutDownloadKey } from "../cut-downloads";
import type { ShellProps } from "./props";

/** Tetrode navigation and the trials with their tetrode and cut files. */
export function FilesPane(
  p: Pick<
    ShellProps,
    | "cutDownloads"
    | "cutId"
    | "onCutDrag"
    | "onPrepareCut"
    | "onRecording"
    | "onTet"
    | "onTrial"
    | "tetNum"
    | "trial"
    | "trials"
  >,
) {
  const numbers = [...new Set(p.trials.flatMap((t) => t.tetrodes.map((t) => t.number)))].sort(
    (a, b) => a - b,
  );
  return (
    <section className="files-pane">
      <div className="tetrode-navigation">
        <span>Tetrode:</span>
        {numbers.map((n) => (
          <button
            key={n}
            className={n === p.tetNum ? "active" : ""}
            aria-label={String(n).padStart(2, "0")}
            disabled={!p.trial?.tetrodes.find((t) => t.number === n)?.file}
            onClick={() => p.onTet(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="trial-list">
        {p.trials.map((t) => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            aria-label={`${t.name} ${t.tetrodes.length}`}
            onClick={() => p.onTrial(t)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                e.stopPropagation();
                p.onTrial(t);
              }
            }}
            className={`trial-block ${t.id === p.trial?.id ? "selected" : ""}`}
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
                      title={e.file.name}
                      aria-label={`${t.name} tetrode ${e.number}`}
                      className={
                        t.id === p.trial?.id && e.number === p.tetNum && !p.cutId ? "active" : ""
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        p.onRecording(t, e.number, "");
                      }}
                    >
                      ~.{e.number}
                    </button>
                  )}
                  {e.cuts.map((c) => (
                    <button
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
                      className={`cut-file ${c.local ? "local-cut" : ""} ${t.id === p.trial?.id && e.number === p.tetNum && p.cutId === c.id ? "active" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        p.onRecording(t, e.number, c.id);
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
