import { useMemo, useState } from "react";
import type { FolderNode } from "../lib/types";
import { IconFolder, IconFolderPlus, IconMore } from "../components/icons";

interface Props {
  folders: FolderNode[];
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (f: FolderNode) => void;
  onDelete: (f: FolderNode) => void;
}

/**
 * 合集总览页。
 *
 * 只在顶层合集上做卡片，子合集在卡片里用一行文字提示数量——
 * 壁纸的合集通常不超过两层，把整棵树摊成卡片会让页面很快失控。
 * 需要逐层操作时回到侧栏目录树即可。
 */
export function CollectionsView({ folders, onOpen, onCreate, onRename, onDelete }: Props) {
  const roots = useMemo(() => folders.filter((f) => !f.parentId), [folders]);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const subCountOf = (id: string) => folders.filter((f) => f.parentId === id).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>合集</h1>
          <p className="page-sub">给壁纸分场景归类。合集可以嵌套，浏览父合集时会一并显示子集内容。</p>
        </div>
        <button className="primary" onClick={() => onCreate(null)}>
          <IconFolderPlus size={14} />
          新建合集
        </button>
      </header>

      {roots.length === 0 ? (
        <div className="library-empty tall">
          <span className="empty-art" aria-hidden>
            <IconFolder size={44} />
          </span>
          <p className="empty-title">还没有合集</p>
          <p className="hint">
            试试按使用场景分组：「工作」「风景」「抽象」「家人照片」——
            之后在多屏上切换场景只要点一下。
          </p>
          <button className="primary" onClick={() => onCreate(null)}>
            新建第一个合集
          </button>
        </div>
      ) : (
        <div className="collection-grid">
          {roots.map((f) => {
            const subs = subCountOf(f.id);
            return (
              <article key={f.id} className="collection-card">
                <div
                  className="collection-main"
                  onClick={() => onOpen(f.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(f.id);
                  }}
                >
                  <span className="collection-icon">
                    <IconFolder size={19} />
                  </span>
                  <div className="collection-info">
                    <h2>{f.name}</h2>
                    <p>
                      {f.totalCount} 张
                      {subs > 0 && ` · ${subs} 个子合集`}
                    </p>
                  </div>
                </div>
                <div className="collection-menu">
                  <button
                    className="icon-btn tiny"
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor((cur) => (cur === f.id ? null : f.id));
                    }}
                  >
                    <IconMore size={14} />
                  </button>
                  {menuFor === f.id && (
                    <div className="collection-menu-pop">
                      <button
                        onClick={() => {
                          onRename(f);
                          setMenuFor(null);
                        }}
                      >
                        重命名
                      </button>
                      <button
                        onClick={() => {
                          onCreate(f.id);
                          setMenuFor(null);
                        }}
                      >
                        新建子合集
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          onDelete(f);
                          setMenuFor(null);
                        }}
                      >
                        删除合集
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
