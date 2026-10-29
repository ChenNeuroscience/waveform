import type { CellCapture, PlotCapture } from "./copy-plots";

export interface TrialCapture {
  name: string;
  cutName: string;
  cells: CellCapture[];
}

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plotImage(plot: PlotCapture, width: number, alt: string, flow = "block") {
  const height = Math.round((plot.canvas.height / plot.canvas.width) * width);
  const style = flow === "inline" ? "vertical-align:middle;" : "display:block;margin:0 auto;";
  return `<img src="${plot.canvas.toDataURL()}" alt="${escapeHtml(alt)}" width="${Math.round(width)}" height="${height}" style="${style}${plot.mode === "spatial" ? "image-rendering:pixelated;" : ""}">`;
}

/** The original single-trial layout: title and stats, then all plots in one row. */
function singleTrialClipboard(trial: TrialCapture, tetNum: number) {
  const ratio = Math.min(2, devicePixelRatio || 1);
  const html: string[] = [];
  const text: string[] = [];
  for (const cell of trial.cells) {
    const title = `${trial.name} · t${tetNum} c${cell.cell}`;
    const rates = cell.stats
      .filter((s) => s.label !== "n spikes")
      .map((s) => `${s.label}: ${s.value.replace(/(\d)Hz$/, "$1 Hz")}`);
    const details = [`${cell.spikes.toLocaleString("en-GB")} spikes`, ...rates].join(" · ");
    const images = cell.plots.map((plot) => {
      const width = Math.min(
        plot.mode === "waveforms" ? 192 : Infinity,
        (plot.canvas.width / ratio) * 0.55,
      );
      return plotImage(plot, width, plot.name, "inline");
    });
    html.push(
      `<p style="margin:0;font:11px Arial;"><b>${escapeHtml(title)}</b> · ${escapeHtml(details)}</p>`,
      `<p style="margin:0 0 9px;white-space:nowrap;">${images.join(" ")}</p>`,
    );
    text.push(`${title} · ${details}`);
  }
  return { html: html.join(""), text: text.join("\n") };
}

/** A borderless HTML table keeps editable text and compact plot images aligned
 * when pasted into Word or Google Docs, without depending on whitespace or fonts. */
export function comparisonClipboard(trials: TrialCapture[], tetNum: number) {
  const primary = trials[0];
  if (trials.length === 1) {
    return singleTrialClipboard(primary, tetNum);
  }
  const ratio = Math.min(2, devicePixelRatio || 1);
  const cells = primary.cells;
  const frames = cells[0]?.plots.filter((p) => p.mode !== "waveforms") || [];
  const wave = cells.flatMap((cell) => cell.plots).find((p) => p.mode === "waveforms");
  let commonPrefix = trials.length > 1 ? trials[0].name : "";
  for (const trial of trials) {
    while (!trial.name.startsWith(commonPrefix)) {
      commonPrefix = commonPrefix.slice(0, -1);
    }
  }
  if (trials.some((trial) => trial.name === commonPrefix)) {
    commonPrefix = "";
  }
  const names = trials.map((trial) => trial.name.slice(commonPrefix.length));
  const fit = Math.min(1, 600 / ((wave ? 200 : 110) + trials.length * 88));
  const labelWidth = Math.floor((wave ? 200 : 110) * fit);
  const columnWidth = Math.floor(88 * fit);
  const tableWidth = labelWidth + trials.length * columnWidth;
  const plotScale = Math.min(
    0.55,
    (columnWidth - 8) / Math.max(128, ...frames.map((p) => p.canvas.width / ratio)),
  );
  const html: string[] = [];
  const text: string[] = [];
  const cellStyle =
    "border:0;padding:0;vertical-align:middle;font-weight:normal;word-wrap:break-word;";
  const labelStyle = `${cellStyle}text-align:left;`;
  const valueStyle = `${cellStyle}text-align:center;`;
  const textRow = (label: string, values: string[]) => {
    html.push(
      `<tr><th scope="row" width="${labelWidth}" style="${labelStyle}">${escapeHtml(label)}</th>${values
        .map(
          (value) => `<td width="${columnWidth}" style="${valueStyle}">${escapeHtml(value)}</td>`,
        )
        .join("")}</tr>`,
    );
  };
  html.push(
    `<table border="0" cellpadding="0" cellspacing="0" width="${tableWidth}" style="border:0;border-collapse:collapse;table-layout:fixed;width:${tableWidth}px;font:11px Arial;">`,
    `<colgroup><col width="${labelWidth}">${trials.map(() => `<col width="${columnWidth}">`).join("")}</colgroup>`,
    `<thead><tr><th width="${labelWidth}" style="${labelStyle}"></th>${names
      .map(
        (name) =>
          `<th scope="col" width="${columnWidth}" style="${valueStyle}padding-bottom:4px;">${escapeHtml(name)}</th>`,
      )
      .join("")}</tr></thead>`,
  );

  for (const capture of cells) {
    html.push(
      `<tbody style="page-break-inside:avoid;"><tr><th colspan="${trials.length + 1}" scope="rowgroup" style="border:0;padding:9px 0 3px;text-align:left;">t${tetNum} c${capture.cell}</th></tr>`,
    );
    const columns = trials.map((trial) => trial.cells.find((c) => c.cell === capture.cell)!);
    columns.forEach((cell, i) => {
      const rates = cell.stats
        .filter((s) => s.label !== "n spikes")
        .map((s) => `${s.label}: ${s.value}`)
        .join(" · ");
      text.push(
        `${trials[i].name} · t${tetNum} c${cell.cell} · ${cell.spikes.toLocaleString("en-GB")} spikes${cell.spikes ? "" : " · No data"}${rates ? ` · ${rates}` : ""}`,
      );
    });
    const stats = [
      ...new Set(["n spikes", ...columns.flatMap((cell) => cell.stats.map((s) => s.label))]),
    ];
    const labels: Record<string, string> = {
      "n spikes": "Spikes",
      "spa max": "Spatial max",
      "dir max": "Direction max",
    };
    for (const stat of stats) {
      textRow(
        labels[stat] || stat,
        columns.map((cell) =>
          stat === "n spikes"
            ? cell.spikes.toLocaleString("en-GB")
            : (cell.stats.find((s) => s.label === stat)?.value || "—").replace(/(\d)Hz$/, "$1 Hz"),
        ),
      );
    }
    const waveform = capture.plots.find((p) => p.mode === "waveforms");
    const chartRows: (PlotCapture | null)[] = frames.length ? frames : wave ? [null] : [];
    chartRows.forEach((frame, index) => {
      const waveWidth = labelWidth - 8;
      const waveHeight = waveform
        ? (waveform.canvas.height / waveform.canvas.width) * waveWidth
        : 0;
      const height = Math.ceil(
        Math.max(
          frame ? (frame.canvas.height / ratio) * plotScale : 0,
          index === 0 ? waveHeight : 0,
        ) + 6,
      );
      html.push(
        `<tr><td width="${labelWidth}" height="${height}" align="center" valign="middle" style="${valueStyle}">${index === 0 && waveform ? plotImage(waveform, waveWidth, "Waveforms") : ""}</td>`,
        ...columns.map((cell, i) => {
          const plot = frame && cell.plots.find((p) => p.mode === frame.mode);
          const graphic = plot
            ? plotImage(
                plot,
                (plot.canvas.width / ratio) * plotScale,
                `${plot.name} · ${trials[i].name} · t${tetNum} c${cell.cell}${plot.missing ? ` — ${plot.missing}` : ""}`,
              )
            : "";
          return `<td width="${columnWidth}" height="${height}" align="center" valign="middle" style="${valueStyle}">${graphic}</td>`;
        }),
        "</tr>",
      );
    });
    html.push("</tbody>");
  }
  html.push("</table>");
  if (wave) {
    const footnote = `Waveforms from ${primary.name} only (T${tetNum}).`;
    html.push(`<p style="margin:6px 0;font:10px Arial;color:#666;">${escapeHtml(footnote)}</p>`);
    text.push("", footnote);
  }
  const provenance = `Trials and cuts: ${trials
    .map((trial, i) => `${commonPrefix ? `${names[i]} = ` : ""}${trial.name} (${trial.cutName})`)
    .join("; ")}.`;
  html.push(`<p style="margin:4px 0;font:10px Arial;color:#666;">${escapeHtml(provenance)}</p>`);
  text.push("", provenance);
  return { html: html.join(""), text: text.join("\n") };
}
