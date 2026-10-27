import type { RefObject } from "react";

/** The hidden file and folder pickers behind "open files" / "open folder". */
export function FileInputs({
  fileInput,
  folderInput,
  onImport,
}: {
  fileInput: RefObject<HTMLInputElement | null>;
  folderInput: RefObject<HTMLInputElement | null>;
  onImport: (files: File[]) => void;
}) {
  const importChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      onImport([...e.target.files]);
    }
    // Allow choosing the same files again.
    e.target.value = "";
  };
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        aria-label="Import recording files"
        multiple
        hidden
        onChange={importChosen}
      />
      <input
        ref={folderInput}
        type="file"
        aria-label="Import recording folder"
        multiple
        hidden
        {...({ webkitdirectory: "" } as object)}
        onChange={importChosen}
      />
    </>
  );
}
