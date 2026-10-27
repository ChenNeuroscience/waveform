import { request } from "./client";
import type { CutFile, Tetrode, Trial } from "./types";
export interface PreparedCut {
  file: File;
  url: string;
}
export const cutDownloadKey = (tet: Tetrode, cut: CutFile) =>
  `${tet.id}|${cut.id}|${cut.revision || 0}`;
/** A small cache of real export blobs, separate from recording and cut state. */
export class CutDownloads {
  entries = new Map<string, PreparedCut>();
  pending = new Map<string, Promise<PreparedCut>>();
  async prepare(trial: Trial, tet: Tetrode, cut: CutFile): Promise<PreparedCut> {
    const key = cutDownloadKey(tet, cut),
      cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    if (this.pending.has(key)) return this.pending.get(key)!;
    const promise = (async () => {
      const bytes = cut.local
        ? await request("export_cut", {
            session: `${tet.id}|${fileIdentity(tet.file!)}|${cut.id}`,
            revision: cut.revision,
            trial: trial.name,
          })
        : cut.file;
      const file = new File([bytes], cut.name, {
          type: "application/octet-stream",
        }),
        result = { file, url: URL.createObjectURL(file) };
      this.entries.set(key, result);
      while (this.entries.size > 4) {
        const first = this.entries.keys().next().value!;
        URL.revokeObjectURL(this.entries.get(first)!.url);
        this.entries.delete(first);
      }
      return result;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  dispose() {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
  }
}
import { fileId as fileIdentity } from "./types";
export function writeCutDrag(data: DataTransfer, cut: PreparedCut) {
  data.effectAllowed = "copy";
  data.items.add(cut.file);
  data.setData("DownloadURL", `application/octet-stream:${cut.file.name}:${cut.url}`);
  data.setData("text/uri-list", cut.url);
  data.setData("application/x-waveform-cut", cut.file.name);
}
