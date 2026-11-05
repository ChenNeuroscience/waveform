import { ChevronDown, Folder, FolderOpen, Github, RotateCcw, X } from "lucide-react";
import icon from "../../img/icon.svg";
import { version } from "../../package.json";
import { ActionMenu } from "./ActionMenu";

const REPOSITORY = "https://github.com/ChenNeuroscience/waveform";

/** File actions behind the Waveform icon. */
export function FileMenu({
  onHome,
  onOpenFiles,
  onOpenFolder,
  onResetSettings,
}: {
  onHome: () => void;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  onResetSettings: () => void;
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
      footer={`Version ${version}`}
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
        { label: "Reset settings…", icon: <RotateCcw size={15} />, run: onResetSettings },
        null,
        {
          label: "View on GitHub",
          icon: <Github size={15} />,
          run: () => open(REPOSITORY, "_blank", "noopener,noreferrer"),
        },
      ]}
    />
  );
}
