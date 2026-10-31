import { ChevronDown, Folder, FolderOpen, X } from "lucide-react";
import icon from "../../img/icon.svg";
import { ActionMenu } from "./ActionMenu";

/** File actions behind the Waveform icon. */
export function FileMenu({
  onHome,
  onOpenFiles,
  onOpenFolder,
}: {
  onHome: () => void;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <ActionMenu
      className="toolbar-home"
      label="Waveform menu"
      menuLabel="File actions"
      title="Waveform · file menu"
      icon={
        <>
          <img src={icon} alt="" width={20} height={20} />
          <ChevronDown size={10} />
        </>
      }
      shortcuts={{ o: onOpenFiles }}
      actions={[
        { label: "Add folder…", icon: <Folder size={15} />, run: onOpenFolder },
        {
          label: "Add files…",
          title: "Add files… [Ctrl/Cmd O]",
          icon: <FolderOpen size={15} />,
          run: onOpenFiles,
        },
        null,
        { label: "Clear files", icon: <X size={15} />, run: onHome },
      ]}
    />
  );
}
