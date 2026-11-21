/** The timeline icon (the toolbar's timeline toggle), and the mark it makes with a label's
 * colour wherever a plot shows only one label's times. */
import { labelColor } from "../app/time-label-config";

/** A timeline: a bar in labelled segments (one filled, as a label is picked out) above a
 * ticked time axis. */
export function TimelineIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="5" width="20" height="8" rx="1.5" />
      <path d="M8.5 5v8M15.5 5v8" />
      <rect x="8.5" y="5" width="7" height="8" fill="currentColor" stroke="none" />
      <path d="M2 19h20M2 17v4M12 17v4M22 17v4" />
    </svg>
  );
}

/** Marks a plot as one time label's: the timeline icon and the label, in its colour. */
export function LabelMark({ label, className = "" }: { label: number; className?: string }) {
  return (
    <span
      className={`label-mark ${className}`}
      style={{ background: labelColor(label) }}
      title={`Timeline label ${label} only`}
      aria-label={`Timeline label ${label}`}
    >
      <TimelineIcon size={11} />
      {label}
    </span>
  );
}

/** `LabelMark` drawn on a canvas (CSS pixels), centred on `cx` with its top at `y`. */
export function drawLabelMark(ctx: CanvasRenderingContext2D, cx: number, y: number, label: number) {
  const [icon, gap, height] = [11, 2, 14];
  ctx.save();
  ctx.font = "bold 9px Arial, sans-serif";
  const text = String(label);
  const width = 2 + icon + gap + ctx.measureText(text).width + 3;
  const x = Math.round(cx - width / 2);
  ctx.fillStyle = labelColor(label);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 3);
  ctx.fill();
  // The icon's paths (on a 24 unit grid), as the SVG draws them.
  ctx.save();
  ctx.translate(x + 2, y + (height - icon) / 2);
  ctx.scale(icon / 24, icon / 24);
  ctx.strokeStyle = ctx.fillStyle = "#1f2328";
  ctx.lineWidth = 2;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.roundRect(2, 5, 20, 8, 1.5);
  ctx.stroke(new Path2D("M8.5 5v8M15.5 5v8M2 19h20M2 17v4M12 17v4M22 17v4"));
  ctx.stroke();
  ctx.fillRect(8.5, 5, 7, 8);
  ctx.restore();
  ctx.fillStyle = "#1f2328";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 2 + icon + gap, y + height / 2 + 0.5);
  ctx.restore();
}

/** `LabelMark` as a small PNG, for copied text (sized in CSS pixels). */
export function labelMarkImage(label: number) {
  const dpr = 2;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = "bold 9px Arial, sans-serif";
  const text = measure.measureText(String(label)).width;
  const [width, height] = [Math.ceil(2 + 11 + 2 + text + 3), 14];
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  drawLabelMark(ctx, width / 2, 0, label);
  return { url: canvas.toDataURL(), width, height };
}
