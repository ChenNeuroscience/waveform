import type { ButtonHTMLAttributes } from "react";

/** Shared pressed-state language for plot, rendering and feature-tool choices. */
export function ToggleButton({
  pressed,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean }) {
  return (
    <button
      type="button"
      {...props}
      aria-pressed={pressed}
      className={`toggle-button ${pressed ? "active" : ""} ${className}`}
    />
  );
}
