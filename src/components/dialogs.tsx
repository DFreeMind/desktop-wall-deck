import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderNode } from "../lib/types";
import { IconChevron, IconFolder, IconFolderPlus } from "./icons";

interface PromptProps {
  title: string;
  /** 输入框初始值，重命名时传入原名 */
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

/**
 * 单输入弹窗。
 *
 * 用自绘而不是 `window.prompt`：WebView2 里 prompt 的样式与系统割裂，
 * 而且会被某些环境禁用。自绘还能顺便做空值校验与回车提交。
 */
export function PromptDialog({
  title,
  defaultValue = "",
  placeholder,
  confirmText = "确定",
  onCancel,
  onSubmit,
}: PromptProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Esc 关闭：弹窗的默认预期，缺了会让人以为卡住
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const trimmed = value.trim();

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h3 className="modal-title">{title}</h3>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={placeholder}
          maxLength={40}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) onSubmit(trimmed);
          }}
        />
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={!trimmed} onClick={() => onSubmit(trimmed)}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MoveProps {
  wallpaperName: string;
  folders: FolderNode[];
  /** 壁纸当前所在文件夹，用于标出「当前位置」 */
  currentFolderId: string | null;
  onCancel: () => void;
  onPick: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
}

/**
 * 「移到合集」选择器。
 *
 * 平铺展示成缩进列表而非树形展开器：合集数量通常只有几个，
 * 全展开可以一次看清全部去处，少一次点击。
 */
export function MoveDialog({
  wallpaperName,
  folders,
  currentFolderId,
  onCancel,
  onPick,
  onCreateFolder,
}: MoveProps) {
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, FolderNode[]>();
    for (const f of folders) {
      const arr = map.get(f.parentId) ?? [];
      arr.push(f);
      map.set(f.parentId, arr);
    }
    return map;
  }, [folders]);

  const renderTree = (parentId: string | null, depth: number): React.ReactNode =>
    (childrenOf.get(parentId) ?? []).map((f) => (
      <div key={f.id}>
        <div
          className={`move-item${currentFolderId === f.id ? " is-current" : ""}`}
          style={{ paddingLeft: 10 + depth * 16 }}
          onClick={() => currentFolderId !== f.id && onPick(f.id)}
        >
          <IconFolder size={14} />
          <span className="move-name">{f.name}</span>
          <span className="move-count">{f.totalCount}</span>
        </div>
        {renderTree(f.id, depth + 1)}
      </div>
    ));

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h3 className="modal-title">移动「{wallpaperName}」到</h3>
        <div className="move-list">
          <div
            className={`move-item${currentFolderId === null ? " is-current" : ""}`}
            onClick={() => currentFolderId !== null && onPick(null)}
          >
            <IconChevron size={12} className="move-root-icon" />
            <span className="move-name">库根目录（不归类）</span>
          </div>
          {folders.length === 0 ? (
            <p className="modal-hint">还没有合集，先新建一个吧。</p>
          ) : (
            renderTree(null, 0)
          )}
        </div>
        <div className="modal-actions between">
          <button onClick={() => onCreateFolder(null)}>
            <IconFolderPlus size={13} />
            新建合集
          </button>
          <button onClick={onCancel}>关闭</button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  body: string;
  confirmText?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 二次确认。删除类操作必须有，且要把「不会删什么」讲清楚。 */
export function ConfirmDialog({
  title,
  body,
  confirmText = "确定",
  danger,
  onCancel,
  onConfirm,
}: ConfirmProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className={danger ? "danger-solid" : "primary"} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
