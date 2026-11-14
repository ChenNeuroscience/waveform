/** Header values changed in the browser, on top of what the files say. See `HeaderEdits`. */
import { SYNC_HEADER, type Header, type HeaderEdits } from "../types";

/** The headers that can be changed, by section of the headers panel: what a new value must
 * be, and how far the up and down arrow keys move it. */
const EDITABLE: Record<
  string,
  Record<string, { valid: (n: number) => boolean; rule: string; step: number }>
> = {
  position: {
    pixels_per_metre: { valid: (n) => n > 0, rule: "A number above 0", step: 5 },
    [SYNC_HEADER]: {
      valid: (n) => Math.abs(n) <= 10000,
      rule: "ms added to position times, within ±10,000",
      step: 20,
    },
  },
};
/** Headers shown even when the file lacks them, with their value until edited. */
const IN_MEMORY: Record<string, Header> = { position: { [SYNC_HEADER]: "0" } };

/** What a new value of `key` must be, if it can be changed. */
export const headerRule = (section: string, key: string) => EDITABLE[section]?.[key]?.rule;
/** `text` moved by `direction` arrow-key steps, or unchanged if that isn't a valid value. */
export function stepHeader(section: string, key: string, text: string, direction: 1 | -1) {
  const rule = EDITABLE[section]?.[key];
  const value = Number(text);
  if (!rule || text.trim() === "" || !Number.isFinite(value)) {
    return text;
  }
  // Rounded so repeated steps from a decimal don't gather floating-point noise.
  const next = Number((value + direction * rule.step).toFixed(6));
  return rule.valid(next) ? String(next) : text;
}
/** Whether `text` can be the new value of `key`. */
export function validHeader(section: string, key: string, text: string) {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && !!EDITABLE[section]?.[key]?.valid(value);
}

export function editHeader(all: HeaderEdits, file: string, key: string, value: string) {
  return { ...all, [file]: { ...all[file], [key]: value } };
}
export function resetHeaders(all: HeaderEdits, file: string) {
  const { [file]: _reset, ...rest } = all;
  return rest;
}
/** Whether any of the active files has a value that isn't the file's. */
export function headersChanged(
  files: Record<string, string | undefined>,
  edits: HeaderEdits,
  estimated: Record<string, Header>,
) {
  return (
    Object.values(files).some((id) => id && edits[id]) ||
    Object.values(estimated).some((header) => Object.keys(header).length > 0)
  );
}
/** A section's rows for the headers panel: the file's, with edits and estimates in place of
 * its values, then those it doesn't have. */
export function headerRows(
  section: string,
  header: Header,
  edits: Header = {},
  estimated: Header = {},
) {
  const memory = IN_MEMORY[section] ?? {};
  const keys = [
    ...new Set([
      ...Object.keys(header),
      ...Object.keys(edits),
      ...Object.keys(estimated),
      ...Object.keys(memory),
    ]),
  ];
  return keys.map((key) => {
    const inFile = header[key];
    const was = inFile === undefined ? "not in the file" : `file says ${inFile}`;
    const note =
      key in edits
        ? `edited, ${was}`
        : key in estimated
          ? `estimated, ${was}`
          : inFile === undefined && key in memory
            ? "in memory only"
            : "";
    return {
      key,
      value: edits[key] ?? estimated[key] ?? inFile ?? memory[key],
      note,
      editable: !!EDITABLE[section]?.[key],
    };
  });
}
