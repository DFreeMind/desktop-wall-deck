import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconInfo } from "./icons";

/** 提示锚定填充设置，不改变面板尺寸。 */
export function FitAdviceHint({ message }: { message: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !popup.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const box = popup.current.getBoundingClientRect();
      setPoint({
        left: Math.max(12, Math.min(rect.right - box.width, innerWidth - box.width - 12)),
        top: rect.bottom + box.height + 8 < innerHeight - 12 ? rect.bottom + 8 : Math.max(12, rect.top - box.height - 8),
      });
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, message]);
  return <>
    <button ref={trigger} type="button" className="fit-advice-trigger" aria-label="查看填充方式提示"
      aria-expanded={open} aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (document.activeElement !== trigger.current) setOpen(false); }}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      <IconInfo size={14} />
    </button>
    {open && createPortal(<div ref={popup} id={id} role="tooltip" className="fit-advice-popup" style={point}>{message}</div>, document.body)}
  </>;
}
