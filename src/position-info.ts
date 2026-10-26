import type { Header } from "./types";
export function experimentTiming(
  headers: Record<string, Header>,
  fallbackDuration: number,
) {
  const head = { ...headers.tetrode, ...headers.position, ...headers.set };
  const duration = Math.max(
      0,
      parseFloat(head.duration) || fallbackDuration || 0,
    ),
    match = head.trial_time?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  let start: number | undefined;
  if (match && +match[1] < 24 && +match[2] < 60 && +(match[3] || 0) < 60)
    start = +match[1] * 3600 + +match[2] * 60 + +(match[3] || 0);
  else if (
    Number.isFinite(Number(head.lasttrialdatetime)) &&
    Number(head.lasttrialdatetime) > 0
  ) {
    const date = new Date(Number(head.lasttrialdatetime) * 1000);
    start = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  }
  const clock = (seconds: number) =>
    `${String(Math.floor(seconds / 3600) % 24).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
  return {
    text:
      start === undefined
        ? "Start time unavailable"
        : `${clock(start)}–${clock(start + duration)}${start + duration >= 86400 ? " (+1 day)" : ""}`,
    minutes: `${+(duration / 60).toFixed(1)} min`,
    date: head.trial_date || "",
  };
}
