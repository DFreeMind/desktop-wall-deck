import { useMemo, useState } from "react";
import type { FolderNode, LibraryScope } from "../lib/types";
import {
  IconChevron,
  IconDisplay,
  IconFolder,
  IconFolderPlus,
  IconGlobe,
  IconImage,
  IconLibrary,
  IconSettings,
} from "./icons";

export type NavView = "display" | "library" | "collections" | "sources" | "settings";

interface Props {
  view: NavView;
  onViewChange: (v: NavView) => void;
  scope: LibraryScope;
  onScopeChange: (s: LibraryScope) => void;
  folders: FolderNode[];
  totalCount: number;
  unfiledCount: number;
  /** 新建文件夹；`parentId` 为空表示建在顶层 */
  onCreateFolder: (parentId: string | null) => void;
  monitorCount: number;
}

/**
 * 左侧导航。
 *
 * 把「功能模块」和「合集目录」放在同一列，是因为它们本质上都是
 * 「切换右侧内容区的筛选条件」。分成两栏会让用户在两个方向上进进出出。
 *
 * 视图与筛选的关系：显示器 / 壁纸来源 / 设置是独立页面（不筛选壁纸），
 * 壁纸库和合集才需要 scope。所以点合集时自动把视图切到壁纸库，
 * 用户不需要理解「先选视图再选范围」这层模型。
 */
export function SideNav({
  view,
  onViewChange,
  scope,
  onScopeChange,
  folders,
  totalCount,
  unfiledCount,
  onCreateFolder,
  monitorCount,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /** 按 parentId 分组，避免每个节点都扫一遍全表。 */
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, FolderNode[]>();
    for (const f of folders) {
      const key = f.parentId;
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return map;
  }, [folders]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pickFolder = (id: string, recursive: boolean) => {
    onScopeChange({ kind: "folder", id, recursive });
    onViewChange("library");
  };

  const renderTree = (parentId: string | null, depth: number): React.ReactNode => {
    const list = childrenOf.get(parentId) ?? [];
    if (list.length === 0) return null;
    return list.map((f) => {
      const hasChildren = f.children.length > 0;
      const open = expanded.has(f.id);
      const active = scope.kind === "folder" && scope.id === f.id;
      return (
        <div key={f.id}>
          <div
            className={`nav-item nav-folder${active ? " is-active" : ""}`}
            style={{ paddingLeft: 12 + depth * 13 }}
            onClick={() => pickFolder(f.id, true)}
            title={`${f.name} · 含子合集共 ${f.totalCount} 张`}
          >
            <span
              className={`nav-caret${hasChildren ? "" : " is-hidden"}${open ? " is-open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) toggle(f.id);
              }}
            >
              <IconChevron size={11} />
            </span>
            <IconFolder size={14} />
            <span className="nav-text">{f.name}</span>
            {f.totalCount > 0 && <span className="nav-count">{f.totalCount}</span>}
          </div>
          {open && hasChildren && renderTree(f.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <aside className="sidenav">
      <div className="nav-group">
        <NavEntry
          icon={<IconDisplay size={15} />}
          label="显示器"
          badge={monitorCount > 0 ? String(monitorCount) : undefined}
          active={view === "display"}
          onClick={() => onViewChange("display")}
        />
        <NavEntry
          icon={<IconLibrary size={15} />}
          label="壁纸库"
          badge={totalCount > 0 ? String(totalCount) : undefined}
          active={view === "library" && scope.kind === "all"}
          onClick={() => {
            onScopeChange({ kind: "all" });
            onViewChange("library");
          }}
        />
        <NavEntry
          icon={<IconImage size={15} />}
          label="未归类"
          badge={unfiledCount > 0 ? String(unfiledCount) : undefined}
          active={view === "library" && scope.kind === "unfiled"}
          onClick={() => {
            onScopeChange({ kind: "unfiled" });
            onViewChange("library");
          }}
        />
      </div>

      <div className="nav-group nav-group-tree">
        <div className="nav-group-head">
          <span>合集</span>
          <button
            className="icon-btn tiny"
            title="新建合集"
            onClick={() => onCreateFolder(null)}
          >
            <IconFolderPlus size={13} />
          </button>
        </div>
        {folders.length === 0 ? (
          <p className="nav-hint">还没有合集，可用来给壁纸分场景归类，如「工作」「风景」。</p>
        ) : (
          renderTree(null, 0)
        )}
      </div>

      <div className="nav-group nav-group-bottom">
        <NavEntry
          icon={<IconGlobe size={15} />}
          label="壁纸来源"
          active={view === "sources"}
          onClick={() => onViewChange("sources")}
        />
        <NavEntry
          icon={<IconSettings size={15} />}
          label="设置"
          active={view === "settings"}
          onClick={() => onViewChange("settings")}
        />
      </div>
    </aside>
  );
}

function NavEntry({
  icon,
  label,
  badge,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`nav-item${active ? " is-active" : ""}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      {icon}
      <span className="nav-text">{label}</span>
      {badge && <span className="nav-count">{badge}</span>}
    </div>
  );
}
