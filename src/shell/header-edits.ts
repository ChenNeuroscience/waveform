/** Header values changed in the browser, on top of what the files say. See `HeaderEdits`. */
import type { Header, HeaderEdits } from "../types";

/** The headers that can be changed, by section of the headers panel. */
const EDITABLE: Record<string, string[]> = { position: ["pixels_per_metre"] };

/** Whether `text` can be a header's new value. */
export const validHeader = (text: string) => Number(text) > 0 && Number.isFinite(Number(text));

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
  const keys = [
    ...new Set([...Object.keys(header), ...Object.keys(edits), ...Object.keys(estimated)]),
  ];
  return keys.map((key) => {
    const inFile = header[key];
    const was = inFile === undefined ? "not in the file" : `file says ${inFile}`;
    const note = key in edits ? `edited, ${was}` : key in estimated ? `estimated, ${was}` : "";
    return {
      key,
      value: edits[key] ?? estimated[key] ?? inFile,
      note,
      editable: EDITABLE[section]?.includes(key) ?? false,
    };
  });
}
