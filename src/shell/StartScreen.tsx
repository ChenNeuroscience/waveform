import video from "../../img/demo_youtube.png";

/** Shown before any files are imported. */
export function StartScreen(p: {
  busy: boolean;
  drag: boolean;
  message: string;
  onDemo: () => void;
  progress: number;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <main className="start-screen">
      <div className="start-drop">
        <h1 className={p.drag ? "drop-title-wobble" : ""}>drag &amp; drop files here</h1>
        <p className="recognised-types">the following types of data files are recognised:</p>
        <div className="supported-formats">
          <code>.set</code>
          <code>.pos</code>
          <code>.1, .2, …</code>
          <code>.cut</code>
          <code>.clu.N</code>
        </div>
        <p className="drop-extra">
          You can drag further files onto the window at any point.
          <br />
          Other file types will be ignored.
        </p>
        <p className="start-actions">
          <button aria-label="Browse files" onClick={() => p.onOpenFiles()}>
            Choose files
          </button>
          <span> · </span>
          <button onClick={() => p.onOpenFolder()}>Choose folder</button>
          <span> · </span>
          <a href="https://github.com/ChenNeuroscience/waveform" target="_blank" rel="noreferrer">
            GitHub / more information
          </a>
        </p>
        <a
          className="original-video"
          href="https://www.youtube.com/watch?v=36o69CPu-1E"
          target="_blank"
          rel="noreferrer"
        >
          <img src={video} alt="Watch the original Waveform introduction" />
          <span>Original video introduction ↗</span>
        </a>
        <button
          className="demo-files"
          draggable={false}
          aria-label="Try it now with simulated data"
          disabled={p.busy}
          onClick={p.onDemo}
        >
          <span className="demo-file-stack" aria-hidden="true">
            <span className="demo-file-card">.pos</span>
            <span className="demo-file-card">.cut</span>
            <span className="demo-file-card">.1</span>
            <svg viewBox="0 0 100 40">
              <path d="M35 4 L35 28 L42 22 L49 35 L54 32 L47 20 L59 20 Z M25 4 L20 0 M23 14 H16" />
            </svg>
          </span>
          <span>
            <b>Try it now with simulated data</b>
            <small>Click here to explore</small>
            <small>
              {new URLSearchParams(location.search).get("demo") === "quick"
                ? "Quick preview"
                : new URLSearchParams(location.search).get("demo") === "stress"
                  ? "9 million spikes · 100 cells · stress test"
                  : "~50k spikes/tetrode · 20 minutes · 5 trials"}
            </small>
          </span>
        </button>
        {p.busy && (
          <div className="demo-progress" role="status">
            <progress max="1" value={p.progress} />
            {p.message}
          </div>
        )}
      </div>
    </main>
  );
}
