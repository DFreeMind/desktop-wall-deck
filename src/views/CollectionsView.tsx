import { useMemo, useState } from "react";
import type { FolderNode } from "../lib/types";
import { IconFolder, IconFolderPlus, IconSearch } from "../components/icons";

interface Props {
  folders: FolderNode[];
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (f: FolderNode) => void;
  onDelete: (f: FolderNode) => void;
}

/** 管理所有层级，操作直接可见，子合集不会藏在只有根目录的卡片中。 */
export function CollectionsView({ folders, onOpen, onCreate, onRename, onDelete }: Props) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    return folders.map((folder) => {
      const ancestors: string[] = [];
      const visited = new Set([folder.id]);
      let parent = folder.parentId;
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        const node = byId.get(parent);
        if (!node) break;
        ancestors.unshift(node.name);
        parent = node.parentId;
      }
      return { folder, path: [...ancestors, folder.name].join(" / "), parentPath: ancestors.join(" / ") };
    }).sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  }, [folders]);
  const filtered = rows.filter((row) => row.path.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="page collections-page">
      <header className="page-head">
        <div><h1>合集管理</h1><p className="page-sub">管理全部 {folders.length} 个合集及子合集。删除分类会将图片和子合集上移，保留所有壁纸。</p></div>
        <button className="primary" onClick={() => onCreate(null)}><IconFolderPlus size={14} />新建合集</button>
      </header>
      <label className="search collections-search"><IconSearch size={14} /><input placeholder="搜索合集名称或路径" aria-label="搜索合集" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      {folders.length === 0 ? (
        <div className="library-empty tall"><IconFolder size={40} /><p className="empty-title">还没有合集</p><p className="hint">先新建合集，再通过壁纸卡片的“移到合集”整理图片。</p><button className="primary" onClick={() => onCreate(null)}>新建第一个合集</button></div>
      ) : filtered.length === 0 ? <p className="page-note">没有匹配的合集</p> : (
        <div className="collections-table-wrap">
          <table className="collections-table">
            <thead><tr><th>合集名称 / 所在位置</th><th>壁纸数量</th><th>管理操作</th></tr></thead>
            <tbody>{filtered.map(({ folder, parentPath }) => (
              <tr key={folder.id}>
                <td><button className="collection-open" onClick={() => onOpen(folder.id)}><IconFolder size={17} /><span><strong>{folder.name}</strong><small>{parentPath || "顶层合集"}</small></span></button></td>
                <td><span>{folder.totalCount} 张</span><small className="collection-direct">本层 {folder.directCount} 张</small></td>
                <td><div className="collection-row-actions">
                  <button className="ghost small" onClick={() => onOpen(folder.id)} aria-label={`查看 ${folder.name} 的壁纸`}>查看壁纸</button>
                  <button className="ghost small" onClick={() => onCreate(folder.id)} aria-label={`在 ${folder.name} 下新建子合集`}>新建子合集</button>
                  <button className="ghost small" onClick={() => onRename(folder)} aria-label={`重命名合集 ${folder.name}`}>重命名</button>
                  <button className="ghost small danger" onClick={() => onDelete(folder)} aria-label={`删除合集 ${folder.name}`}>删除</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
