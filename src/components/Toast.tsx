import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";

export interface ToastItem {
  id: string;
  text: string;
  kind: "info" | "success" | "warn" | "error";
}

interface Props {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}

/**
 * 轻量提示条。
 *
 * 不用阻塞式弹窗：设置壁纸是高频操作，弹窗会打断连续操作节奏。
 * 失败信息同样用提示条，但停留时间更长且可手动关闭。
 */
export function Toast({ items, onDismiss }: Props) {
  const reduced = useReducedMotion();
  return (
    <div className="toasts">
      <AnimatePresence>
        {items.map((t) => (
        <m.div
          key={t.id}
          className={`toast toast-${t.kind}`}
          initial={{ opacity: 0, y: reduced ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : 4 }}
          transition={{ duration: reduced ? 0 : .16 }}
          onClick={() => onDismiss(t.id)}
          role="status"
        >
          {t.text}
        </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
