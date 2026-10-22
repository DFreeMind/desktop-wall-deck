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
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => onDismiss(t.id)}
          role="status"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
