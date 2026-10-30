/** Toolbar toggles for how waveforms and feature points are coloured. */
import { ToggleButton } from "./ToggleButton";
import { Palette } from "lucide-react";
import { RENDERING_MODES, type RenderingMode } from "../types";

// Icon tone follows the shared toggle's foreground and selected state.
function DriftIcon() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      {/* A blob shifting right over time: a fading trail of earlier positions. */}
      <ellipse cx="5" cy="7" rx="3.6" ry="3.2" fill="currentColor" fillOpacity="0.25" />
      <ellipse cx="9" cy="7" rx="3.9" ry="3.5" fill="currentColor" fillOpacity="0.5" />
      <ellipse cx="13.8" cy="7" rx="4.4" ry="4" fill="currentColor" />
    </svg>
  );
}
function DensityIcon() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
      {/* Three crossing traces; translucent strokes darken where they overlap. */}
      <g
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.42"
        strokeWidth="1.9"
        strokeLinecap="round"
      >
        <path d="M1 11 C5 11 6 2.5 9.5 2.5 S14 10 19 9" />
        <path d="M1 4 C4.5 4 7 11.5 10.5 10.5 S15 3.5 19 4.5" />
        <path d="M1 7.5 C4 8.5 6.5 4 9.5 5.5 S14 11.5 19 11.5" />
      </g>
    </svg>
  );
}

export function RenderingToggles({
  mode,
  onChange,
}: {
  mode: RenderingMode;
  onChange: (mode: RenderingMode) => void;
}) {
  return (
    <div className="toggle-group" role="group" aria-label="Colour mode">
      {RENDERING_MODES.map((option) => (
        <ToggleButton
          key={option}
          className="render-toggle"
          pressed={mode === option}
          aria-label={
            {
              fixed: "Fixed colours",
              density: "Density rendering",
              drift: "Drift (colour by recording time)",
            }[option]
          }
          title={
            {
              fixed: "Fixed cell colours",
              density: "Density: colour by overlap",
              drift: "Drift: mean spike time, red (start) to green (end)",
            }[option] + " · P cycles colour modes; Shift P reverses"
          }
          onClick={() => onChange(option)}
        >
          {option === "fixed" ? (
            <Palette size={17} />
          ) : option === "density" ? (
            <DensityIcon />
          ) : (
            <DriftIcon />
          )}
        </ToggleButton>
      ))}
    </div>
  );
}
