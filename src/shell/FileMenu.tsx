import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderOpen, X } from "lucide-react";
import icon from "../../img/icon.svg";

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
  const [isOpen, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lastItem = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    addEventListener("pointerdown", dismiss, true);
    addEventListener("focusin", dismiss);
    return () => {
      removeEventListener("pointerdown", dismiss, true);
      removeEventListener("focusin", dismiss);
    };
  }, [isOpen]);
  useEffect(() => {
    if (isOpen) {
      const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      items?.[lastItem.current ? items.length - 1 : 0]?.focus();
    }
  }, [isOpen]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const open = (action: () => void) => {
    close();
    action();
  };
  const key = (event: React.KeyboardEvent) => {
    if (
      isOpen ||
      (event.target === button.current &&
        ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key))
    ) {
      event.stopPropagation();
    }
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      close();
      return;
    }
    if (isOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      open(onOpenFiles);
      return;
    }
    if (!isOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      lastItem.current = event.key === "ArrowUp";
      setOpen(true);
      return;
    }
    if (isOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    }
  };
  return (
    <div className="toolbar-home" ref={root} onKeyDown={key}>
      <button
        ref={button}
        className="home-button"
        title="Waveform · file menu"
        aria-label="Waveform menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => {
          lastItem.current = false;
          setOpen((current) => !current);
        }}
      >
        <img src={icon} alt="" width={20} height={20} />
        <ChevronDown size={10} />
      </button>
      {isOpen && (
        <div className="waveform-menu" role="menu" aria-label="File actions" ref={menu}>
          <button role="menuitem" onClick={() => open(onOpenFolder)}>
            <Folder size={15} />
            Add folder…
          </button>
          <button role="menuitem" title="Add files… [Ctrl/Cmd O]" onClick={() => open(onOpenFiles)}>
            <FolderOpen size={15} />
            Add files…
          </button>
          <div className="menu-separator" role="separator" />
          <button role="menuitem" onClick={() => open(onHome)}>
            <X size={15} />
            Clear files
          </button>
        </div>
      )}
    </div>
  );
}
