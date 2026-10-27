export interface CellStat {
  label: string;
  value: string;
}
export function CellStats({
  entries,
  className = "tile-caption",
  label,
}: {
  entries: CellStat[];
  className?: string;
  label?: string;
}) {
  return (
    <div className={className} aria-label={label}>
      {entries.map((entry) => (
        <div className="caption-inner" key={entry.label}>
          <span className="stat-value">{entry.value}</span>
          <div className="stat-label">{entry.label}</div>
        </div>
      ))}
    </div>
  );
}
