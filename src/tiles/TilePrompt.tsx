import type { ReactNode } from "react";

/** Instructions for a tile-wall mode (swap, split, merge, copy), centred above the
 * wall, with any controls below. Without controls it ignores the pointer, so it
 * never blocks the tiles beneath it. */
export function TilePrompt({
  label,
  instructions,
  children,
}: {
  label: string;
  instructions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`tile-prompt ${children ? "" : "passive"}`} role="region" aria-label={label}>
      <div className="tile-prompt-instructions" role="status">
        {instructions}
      </div>
      {children}
    </div>
  );
}
