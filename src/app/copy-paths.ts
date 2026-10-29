/** Position exports use one text heading and one plot line per trial, followed by
 * a shared editable legend. Only selected cells' spike positions cross the worker. */
import { drawAnalysis } from "../plots/AnalysisPlot";
import { drawPathBase, drawSpikeLayers, type SpikeLayer } from "../plots/PathPlot";
import { experimentTiming } from "../shell/position-info";
import { color, type Settings } from "../types";
import { request } from "../worker/client";
import type { CopyRecording, CopyTrialAnalysis } from "../worker/protocol";
import { escapeHtml } from "./clipboard-layout";

export interface PathSource {
  name: string;
  id: string;
  key: string;
  recording?: CopyRecording;
}

export function pathLayers(result: CopyTrialAnalysis | undefined, cells: number[]): SpikeLayer[] {
  return cells.flatMap((cell) => {
    const data = result?.cells.find((c) => c.cell === cell)?.data;
    return data ? [{ cell, spikes: data.spikes, color: color(cell) }] : [];
  });
}

export async function capturePaths(
  sources: PathSource[],
  cells: number[],
  settings: Settings,
  tetNum: number,
  cache: Map<string, CopyTrialAnalysis>,
  checkCurrent: () => void,
) {
  const results = await request("copy_analysis", {
    recordings: sources
      .filter(
        (s) =>
          s.recording &&
          (!cache.has(s.key) ||
            cells.some((cell) => !cache.get(s.key)!.cells.some((c) => c.cell === cell))),
      )
      .map((s) => s.recording!),
    cells,
    settings,
    path: true,
  });
  checkCurrent();
  for (const result of results) {
    const source = sources.find((s) => s.id === result.trialId)!;
    const previous = cache.get(source.key);
    const merged = new Map(previous?.cells.map((c) => [c.cell, c]));
    result.cells.forEach((c) => merged.set(c.cell, c));
    cache.set(source.key, { ...result, cells: [...merged.values()] });
  }
  const html: string[] = [];
  const text: string[] = [];
  const size = 160;
  const ratio = Math.min(2, devicePixelRatio || 1);
  for (const source of sources) {
    const result = cache.get(source.key);
    const position = result?.position;
    const timing = position && experimentTiming({ tetrode: position.header }, position.duration);
    const title = `${source.name} · t${tetNum}${timing ? ` · ${timing.durationText}${timing.text !== "Start time unavailable" ? ` · ${timing.text}` : ""}${timing.date ? ` · ${timing.date}` : ""}` : ""}`;
    html.push(`<p style="margin:0;font:11px Arial;"><b>${escapeHtml(title)}</b></p>`);
    text.push(title);
    if (!position?.trajectory) {
      const unavailable = source.recording ? "No position data" : `No tetrode ${tetNum}`;
      html.push(`<p style="margin:0 0 9px;font:11px Arial;color:#777;">${unavailable}</p>`);
      text.push(unavailable);
      continue;
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    drawPathBase(ctx, size, size, position.trajectory);
    drawSpikeLayers(ctx, size, size, position.trajectory, pathLayers(result, cells));
    const speed = document.createElement("canvas");
    drawAnalysis(speed, 32, size, {
      data: position.overview,
      mode: "speed",
      maxRate: 0,
      compact: true,
      positionSpeed: true,
      speedAlignment: "left",
    });
    const imageStyle = "vertical-align:middle;";
    html.push(
      `<p style="margin:0 0 9px;white-space:nowrap;"><img src="${canvas.toDataURL()}" width="${size}" height="${size}" alt="Position path · ${escapeHtml(source.name)}" style="${imageStyle}"> <img src="${speed.toDataURL()}" width="32" height="${size}" alt="Speed dwell · ${escapeHtml(source.name)}" style="${imageStyle}"> <span style="font:10px Arial;">${settings.speedMax} cm/s max</span></p>`,
    );
  }
  if (cells.length) {
    html.push(
      `<p style="margin:4px 0;font:11px Arial;">${cells
        .map(
          (cell) =>
            `<span style="white-space:nowrap;"><span style="color:${color(cell)};">■</span> t${tetNum} c${cell}</span>`,
        )
        .join("　 ")}</p>`,
    );
    text.push(cells.map((cell) => `■ t${tetNum} c${cell}`).join("   "));
  }
  return {
    html: html.join(""),
    text: text.join("\n"),
    layers: pathLayers(cache.get(sources[0]?.key), cells),
  };
}
