import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePreference, fitWindowLayout } from "../preferences";
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
  preferenceKey,
  comparison = false,
  autoHeight = false,
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
  preferenceKey?: string;
  comparison?: boolean;
  autoHeight?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = usePreference(preferenceKey || null, {
    x,
    y,
    width,
    height,
  });
  const [z, setZ] = useState(() => ++top);
  const position = fitWindowLayout(geometry, innerWidth, innerHeight);
  useEffect(() => {
    const clamp = () => setGeometry((g) => fitWindowLayout(g, innerWidth, innerHeight));
    clamp();
    const observer = new ResizeObserver(() => {
      const b = root.current!.getBoundingClientRect();
      setGeometry((g) =>
        Math.abs(g.width - b.width) > 0.5 || Math.abs(g.height - b.height) > 0.5
          ? fitWindowLayout({ ...g, width: b.width, height: b.height }, innerWidth, innerHeight)
          : g,
      );
    });
    observer.observe(root.current!);
    addEventListener("resize", clamp);
    return () => {
      observer.disconnect();
      removeEventListener("resize", clamp);
    };
  }, [setGeometry]);
  useEffect(() => {
    if (!autoHeight || !content.current) {
      return;
    }
    const fitContent = () => {
      const height =
        content.current!.getBoundingClientRect().height +
        root.current!.querySelector("header")!.getBoundingClientRect().height +
        2;
      setGeometry((g) => {
        const next = fitWindowLayout({ ...g, height }, innerWidth, innerHeight);
        return Math.abs(next.height - g.height) > 0.5 || next.y !== g.y ? next : g;
      });
    };
    const observer = new ResizeObserver(fitContent);
    observer.observe(content.current);
    addEventListener("resize", fitContent);
    return () => {
      observer.disconnect();
      removeEventListener("resize", fitContent);
    };
  }, [autoHeight, setGeometry]);
  const focus = () => {
    setZ(++top);
    onFocus?.();
  };
  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,select,textarea,a")) {
      return;
    }
    e.preventDefault();
    const origin = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    const move = (event: PointerEvent) =>
      setGeometry((g) =>
        fitWindowLayout(
          {
            ...g,
            x: event.clientX - origin.x,
            y: event.clientY - origin.y,
          },
          innerWidth,
          innerHeight,
        ),
      );
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  // Space-click (grab mode) closes a window; any other press brings it to front.
  const pressWindow = (event: React.PointerEvent) => {
    if (grabMode && event.button === 0) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else {
      focus();
    }
  };
  return (
    <section
      ref={root}
      className={`floating-window ${comparison ? "comparison-window" : ""} ${autoHeight ? "fit-content-window" : ""}`}
      onPointerDown={comparison ? drag : undefined}
      role="dialog"
      aria-modal="false"
      aria-label={label || title}
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height,
        zIndex: z,
      }}
      onPointerDownCapture={pressWindow}
    >
      <header className="floating-titlebar" onPointerDown={comparison ? undefined : drag}>
        <span>{title}</span>
        <button aria-label="Close panel" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      <div className="floating-content">
        {autoHeight ? <div ref={content}>{children}</div> : children}
      </div>
    </section>
  );
}
