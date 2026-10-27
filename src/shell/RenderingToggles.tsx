/** Toolbar toggles for how waveforms and feature points are coloured. */

// Grayscale icons: the toggle's border and background show its state.
function DriftIcon() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      {/* A blob shifting right over time: a fading trail of earlier positions. */}
      <ellipse cx="5" cy="7" rx="3.6" ry="3.2" fill="#dadada" />
      <ellipse cx="9" cy="7" rx="3.9" ry="3.5" fill="#a9a9a9" />
      <ellipse cx="13.8" cy="7" rx="4.4" ry="4" fill="#3f3f3f" />
    </svg>
  );
}
function DensityIcon() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      {/* Three crossing traces; translucent strokes darken where they overlap. */}
      <g fill="none" stroke="#1f1f1f" strokeOpacity="0.42" strokeWidth="1.9" strokeLinecap="round">
        <path d="M1 11 C5 11 6 2.5 9.5 2.5 S14 10 19 9" />
        <path d="M1 4 C4.5 4 7 11.5 10.5 10.5 S15 3.5 19 4.5" />
        <path d="M1 7.5 C4 8.5 6.5 4 9.5 5.5 S14 11.5 19 11.5" />
      </g>
    </svg>
  );
}

export function RenderingToggles({
  drift,
  density,
  onToggle,
}: {
  drift: boolean;
  density: boolean;
  onToggle: (mode: "drift" | "density") => void;
}) {
  return (
    <>
      <button
        className={`render-toggle ${drift ? "checked" : ""}`}
        aria-label="Drift (colour by recording time)"
        aria-pressed={drift}
        title="Drift: colour by mean spike time, red (start) to green (end) [D]"
        onClick={() => onToggle("drift")}
      >
        <DriftIcon />
      </button>
      <button
        className={`render-toggle ${density ? "checked" : ""}`}
        aria-label="Density rendering"
        aria-pressed={density}
        title="Waveform density rendering [P]"
        onClick={() => onToggle("density")}
      >
        <DensityIcon />
      </button>
    </>
  );
}
