import { FloatingWindow } from "./FloatingWindow";
import { CellStats } from "../tiles/CellStats";
import { badgeStyle } from "../types";
import type { PlotCopy } from "../app/copies";

/** A floating plot copy; a copied cell tile also shows its badge and stats. */
export function CopyWindow({
  copy,
  grabMode,
  onClose,
}: {
  copy: PlotCopy;
  grabMode: boolean;
  onClose: () => void;
}) {
  const { title, x, y, width, height, image, cell, stats } = copy;
  return (
    <FloatingWindow comparison {...{ grabMode, title, x, y, width, height, onClose }}>
      {cell !== undefined ? (
        <div className="tile-copy">
          <img className="plot-copy" src={image} alt="Copied cell plots" draggable={false} />
          <span className="tile-copy-badge" style={badgeStyle(cell)}>
            {cell}
          </span>
          <CellStats
            entries={stats || []}
            className="tile-copy-stats"
            label="Copied cell statistics"
          />
        </div>
      ) : (
        <img className="plot-copy" src={image} alt="Copied plot" draggable={false} />
      )}
    </FloatingWindow>
  );
}
