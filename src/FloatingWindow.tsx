import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
let top = 100;
export function FloatingWindow({
  title,
  children,
  onClose,
  onFocus,
  x = 35,
  y = 65,
  width = 365,
  height = 470,
  label,
  grabMode = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onFocus?: () => void;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  grabMode?: boolean;
}) {
  const [position, setPosition] = useState({ x, y }),
    [z, setZ] = useState(() => ++top);
  const focus = () => {
    setZ(++top);
    onFocus?.();
  };
  return (
    <section
      className="floating-window"
      role="dialog"
      aria-modal="false"
      aria-label={label || title}
      style={{ left: position.x, top: position.y, width, height, zIndex: z }}
      onPointerDownCapture={(event) => {
        if (grabMode && event.button === 0) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else focus();
      }}
    >
      <header
        className="floating-titlebar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          const origin = {
            x: e.clientX - position.x,
            y: e.clientY - position.y,
          };
          const move = (event: PointerEvent) =>
            setPosition({
              x: Math.max(
                0,
                Math.min(innerWidth - 80, event.clientX - origin.x),
              ),
              y: Math.max(
                0,
                Math.min(innerHeight - 30, event.clientY - origin.y),
              ),
            });
          const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", end);
        }}
      >
        <span>{title}</span>
        <button aria-label="Close panel" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <div className="floating-content">{children}</div>
    </section>
  );
}
