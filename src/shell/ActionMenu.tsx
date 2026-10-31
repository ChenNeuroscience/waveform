import { useEffect, useRef, useState, type ReactNode } from "react";

interface MenuAction {
  label: string;
  title?: string;
  icon: ReactNode;
  run: () => void;
}

/** Shared dropdown behaviour and styling for the file and projection menus. */
export function ActionMenu({
  label,
  title,
  menuLabel,
  icon,
  actions,
  className = "",
  shortcuts = {},
}: {
  label: string;
  title?: string;
  menuLabel?: string;
  icon: ReactNode;
  actions: (MenuAction | null)[];
  className?: string;
  shortcuts?: Record<string, () => void>;
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
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[lastItem.current ? items.length - 1 : 0]?.focus();
    return () => {
      removeEventListener("pointerdown", dismiss, true);
      removeEventListener("focusin", dismiss);
    };
  }, [isOpen]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const run = (action: () => void) => {
    close();
    action();
  };
  return (
    <div
      className={`action-menu ${className}`}
      ref={root}
      onKeyDown={(event) => {
        if (isOpen || ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
          event.stopPropagation();
        }
        if (isOpen && event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (
          isOpen &&
          (event.ctrlKey || event.metaKey) &&
          shortcuts[event.key.toLowerCase()]
        ) {
          event.preventDefault();
          run(shortcuts[event.key.toLowerCase()]);
        } else if (!isOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          lastItem.current = event.key === "ArrowUp";
          setOpen(true);
        } else if (isOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
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
        } else if (isOpen && event.key === "Tab") {
          setOpen(false);
        }
      }}
    >
      <button
        ref={button}
        title={title || label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => {
          lastItem.current = false;
          setOpen((current) => !current);
        }}
      >
        {icon}
      </button>
      {isOpen && (
        <div
          className="waveform-menu"
          role="menu"
          aria-label={menuLabel || `${label} actions`}
          ref={menu}
        >
          {actions.map((action, i) =>
            action ? (
              <button
                key={action.label}
                role="menuitem"
                title={action.title}
                onClick={() => run(action.run)}
              >
                {action.icon}
                {action.label}
              </button>
            ) : (
              <div key={i} className="menu-separator" role="separator" />
            ),
          )}
        </div>
      )}
    </div>
  );
}
