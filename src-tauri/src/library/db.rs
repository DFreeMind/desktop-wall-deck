//! 数据库层：壁纸元数据与显示器映射的持久化。
//!
//! 采用单连接 + `Mutex` 的形式。壁纸库的读写频率很低（导入时才写，浏览时读），
//! 不构成并发瓶颈；换来的是无需连接池与事务跨线程传递的复杂度。

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use super::error::{LibError, LibResult};
use super::model::{Folder, FolderNode, MonitorBinding, Wallpaper};

/// 库内壁纸条目（含数据库内部字段）。
#[derive(Debug, Clone)]
pub struct WallpaperRecord {
    pub id: String,
    pub file_path: String,
    pub thumb_path: String,
    pub source_path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub created_at: i64,
    pub folder_id: Option<String>,
    pub storage_kind: String,
    pub source_stamp: String,
    pub cached_path: Option<String>,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(db_path: &Path) -> LibResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LibError::Io(format!("创建数据目录失败：{e}")))?;
        }
        let conn = Connection::open(db_path)
            .map_err(|e| LibError::Db(format!("打开数据库失败：{e}")))?;

        // WAL 让读写互不阻塞；壁纸库在导入时可能同时被浏览界面读取。
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();

        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS wallpapers (
                id          TEXT PRIMARY KEY,
                file_path   TEXT NOT NULL UNIQUE,
                thumb_path  TEXT NOT NULL,
                source_path TEXT NOT NULL,
                name        TEXT NOT NULL,
                width       INTEGER NOT NULL,
                height      INTEGER NOT NULL,
                bytes       INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
            );

            -- source_path 用于去重：同一文件重复导入不应产生多条记录
            CREATE INDEX IF NOT EXISTS idx_wallpapers_source ON wallpapers(source_path);
            CREATE INDEX IF NOT EXISTS idx_wallpapers_created ON wallpapers(created_at DESC);

            -- 显示器逻辑身份 → 壁纸的绑定关系
            -- 主键用 identity 而非 device_path，正是为了扛住换端口
            CREATE TABLE IF NOT EXISTS monitor_bindings (
                identity    TEXT PRIMARY KEY,
                wallpaper_id TEXT,
                position    TEXT NOT NULL DEFAULT 'fill',
                updated_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS online_origins (
                wallpaper_id TEXT PRIMARY KEY,
                metadata TEXT NOT NULL
            );

            -- 壁纸文件夹：单层父子自引用，支持任意深度
            CREATE TABLE IF NOT EXISTS folders (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
            "#,
        )
        .map_err(|e| LibError::Db(format!("初始化表结构失败：{e}")))?;

        // 增量迁移：老库没有 folder_id 列，用 PRAGMA 判断后再加。
        // 不能直接写进上面的 CREATE TABLE，因为对已存在的表 CREATE 会被忽略。
        let has_folder_col: bool = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(wallpapers)")
                .map_err(|e| LibError::Db(e.to_string()))?;
            let cols = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(|e| LibError::Db(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| LibError::Db(e.to_string()))?;
            cols.iter().any(|c| c == "folder_id")
        };

        if !has_folder_col {
            conn.execute_batch("ALTER TABLE wallpapers ADD COLUMN folder_id TEXT;")
                .map_err(|e| LibError::Db(format!("添加 folder_id 列失败：{e}")))?;
        }

        let has_rendered_path = {
            let mut stmt = conn.prepare("PRAGMA table_info(monitor_bindings)")?;
            let columns = stmt.query_map([], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            columns.iter().any(|c| c == "rendered_path")
        };
        if !has_rendered_path {
            conn.execute_batch("ALTER TABLE monitor_bindings ADD COLUMN rendered_path TEXT;")?;
        }

        let columns: Vec<String> = conn.prepare("PRAGMA table_info(wallpapers)")?
            .query_map([], |r| r.get(1))?.collect::<Result<_, _>>()?;
        for (name, definition) in [("storage_kind", "TEXT NOT NULL DEFAULT 'managed'"), ("source_stamp", "TEXT NOT NULL DEFAULT ''"), ("cached_path", "TEXT")] {
            if !columns.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE wallpapers ADD COLUMN {name} {definition}"))?;
            }
        }
        conn.execute_batch("CREATE TABLE IF NOT EXISTS source_folders (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, folder_id TEXT);")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS excluded_sources (path TEXT PRIMARY KEY);")?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_wallpapers_folder ON wallpapers(folder_id);",
        )
        .map_err(|e| LibError::Db(e.to_string()))?;

        Ok(())
    }

    /// 按源路径查重，命中则返回已有记录。
    pub fn find_by_source(&self, source_path: &str) -> LibResult<Option<WallpaperRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at, folder_id, storage_kind, source_stamp, cached_path
             FROM wallpapers WHERE source_path = ?1 OR (?2 != '' AND source_path = ?2 COLLATE NOCASE) LIMIT 1",
        )?;
        let rec = stmt
            .query_row(params![source_path, if source_path.starts_with("http") { String::new() } else { format!(r"\\?\{source_path}") }], map_record)
            .optional()?;
        Ok(rec)
    }

    pub fn insert(&self, rec: &WallpaperRecord) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO wallpapers
             (id, file_path, thumb_path, source_path, name, width, height, bytes, created_at, folder_id, storage_kind, source_stamp, cached_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                rec.id,
                rec.file_path,
                rec.thumb_path,
                rec.source_path,
                rec.name,
                rec.width,
                rec.height,
                rec.bytes,
                rec.created_at,
                rec.folder_id,
                rec.storage_kind,
                rec.source_stamp,
                rec.cached_path
            ],
        )?;
        Ok(())
    }

    pub fn list(&self) -> LibResult<Vec<WallpaperRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at, folder_id, storage_kind, source_stamp, cached_path
             FROM wallpapers ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], map_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get(&self, id: &str) -> LibResult<Option<WallpaperRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at, folder_id, storage_kind, source_stamp, cached_path
             FROM wallpapers WHERE id = ?1",
        )?;
        Ok(stmt.query_row(params![id], map_record).optional()?)
    }

    pub fn delete(&self, id: &str) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM wallpapers WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM online_origins WHERE wallpaper_id = ?1", params![id])?;
        // 级联清理绑定，避免指向已删除的壁纸
        conn.execute(
            "UPDATE monitor_bindings SET wallpaper_id = NULL WHERE wallpaper_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn update_index(&self, rec: &WallpaperRecord) -> LibResult<()> {
        self.conn.lock().execute("UPDATE wallpapers SET file_path=?2, source_path=?3, width=?4, height=?5,
            bytes=?6, source_stamp=?7, cached_path=NULL WHERE id=?1 AND storage_kind='indexed'",
            params![rec.id, rec.file_path, rec.source_path, rec.width, rec.height, rec.bytes, rec.source_stamp])?;
        Ok(())
    }

    pub fn cache_path(&self, id: &str, path: &str) -> LibResult<()> {
        self.conn.lock().execute("UPDATE wallpapers SET cached_path=?2 WHERE id=?1", params![id, path])?;
        Ok(())
    }

    pub fn relocate_indexed(&self, id: &str, path: &str, records: &[WallpaperRecord]) -> LibResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let old_path: String = tx.query_row("SELECT path FROM source_folders WHERE id=?1", params![id], |r| r.get(0))?;
        if old_path != path {
            let excluded: Vec<String> = tx.prepare("SELECT path FROM excluded_sources")?
                .query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for old in excluded {
                if let Ok(relative) = Path::new(&old).strip_prefix(&old_path) {
                    let replacement = Path::new(path).join(relative).to_string_lossy().to_string();
                    tx.execute("INSERT OR IGNORE INTO excluded_sources(path) VALUES (?1)", params![replacement])?;
                    tx.execute("DELETE FROM excluded_sources WHERE path=?1", params![old])?;
                }
            }
        }
        for rec in records {
            tx.execute("UPDATE wallpapers SET file_path=?2,source_path=?3,width=?4,height=?5,bytes=?6,
                source_stamp=?7,cached_path=NULL WHERE id=?1 AND storage_kind='indexed'",
                params![rec.id,rec.file_path,rec.source_path,rec.width,rec.height,rec.bytes,rec.source_stamp])?;
        }
        tx.execute("UPDATE source_folders SET path=?2 WHERE id=?1", params![id,path])?;
        tx.commit()?;
        Ok(())
    }

    pub fn source_folders(&self) -> LibResult<Vec<super::model::SourceFolder>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id, path, folder_id FROM source_folders ORDER BY path")?;
        let result = stmt.query_map([], |row| {
            let path: String = row.get(1)?;
            Ok(super::model::SourceFolder { id: row.get(0)?, available: Path::new(&path).is_dir(), path, folder_id: row.get(2)? })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }

    pub fn save_source(&self, source: &super::model::SourceFolder) -> LibResult<()> {
        self.conn.lock().execute("INSERT INTO source_folders(id,path,folder_id) VALUES (?1,?2,?3)
            ON CONFLICT(path) DO UPDATE SET folder_id=excluded.folder_id", params![source.id, source.path, source.folder_id])?;
        Ok(())
    }

    pub fn remove_source(&self, id: &str) -> LibResult<()> {
        self.conn.lock().execute("DELETE FROM source_folders WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn excluded(&self, path: &str) -> LibResult<bool> {
        Ok(self.conn.lock().query_row("SELECT 1 FROM excluded_sources WHERE path=?1", params![path], |_| Ok(()))
            .optional()?.is_some())
    }

    pub fn exclude(&self, path: &str) -> LibResult<()> {
        self.conn.lock().execute("INSERT OR IGNORE INTO excluded_sources(path) VALUES (?1)", params![path])?;
        Ok(())
    }

    pub fn unexclude(&self, path: &str) -> LibResult<()> {
        self.conn.lock().execute("DELETE FROM excluded_sources WHERE path=?1", params![path])?;
        Ok(())
    }

    /// 更新壁纸显示名。
    pub fn rename(&self, id: &str, name: &str) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE wallpapers SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        Ok(())
    }

    /// 把壁纸移动到指定文件夹，`None` 表示移到库根目录。
    pub fn move_to_folder(&self, id: &str, folder_id: Option<&str>) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE wallpapers SET folder_id = ?2 WHERE id = ?1",
            params![id, folder_id],
        )?;
        Ok(())
    }

    // ---------------- 文件夹 ----------------

    pub fn create_folder(&self, id: &str, name: &str, parent_id: Option<&str>) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO folders (id, name, parent_id, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, parent_id, chrono_now()],
        )?;
        Ok(())
    }

    pub fn rename_folder(&self, id: &str, name: &str) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE folders SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn get_folder(&self, id: &str) -> LibResult<Option<Folder>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT id, name, parent_id, created_at FROM folders WHERE id = ?1")?;
        Ok(stmt
            .query_row(params![id], |r| {
                Ok(Folder {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })
            .optional()?)
    }

    pub fn list_folders(&self) -> LibResult<Vec<Folder>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, parent_id, created_at FROM folders ORDER BY name COLLATE NOCASE")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Folder {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 删除文件夹。
    ///
    /// 内部壁纸不删，而是上移到父文件夹，避免用户误删目录时连带丢掉图片。
    /// 子文件夹同理上移一级，保持层级连续而不是被整个删掉。
    pub fn delete_folder(&self, id: &str) -> LibResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        let parent: Option<String> = tx
            .query_row(
                "SELECT parent_id FROM folders WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();

        tx.execute(
            "UPDATE wallpapers SET folder_id = ?2 WHERE folder_id = ?1",
            params![id, parent],
        )?;
        tx.execute("UPDATE source_folders SET folder_id=?2 WHERE folder_id=?1", params![id,parent])?;
        tx.execute(
            "UPDATE folders SET parent_id = ?2 WHERE parent_id = ?1",
            params![id, parent],
        )?;
        tx.execute("DELETE FROM folders WHERE id = ?1", params![id])?;

        tx.commit()?;
        Ok(())
    }

    /// 以 `root` 为起点，返回它自己及所有后代文件夹的 id（广度优先）。
    ///
    /// 深度上限 32，防止脏数据里出现环导致死循环。
    pub fn collect_subtree_ids(&self, root: &str) -> LibResult<Vec<String>> {
        let all = self.list_folders()?;
        let mut result = vec![root.to_string()];
        let mut frontier = vec![root.to_string()];

        for _ in 0..32 {
            if frontier.is_empty() {
                break;
            }
            let mut next = Vec::new();
            for f in &all {
                if let Some(pid) = &f.parent_id {
                    if frontier.iter().any(|x| x == pid) && !result.contains(&f.id) {
                        result.push(f.id.clone());
                        next.push(f.id.clone());
                    }
                }
            }
            frontier = next;
        }
        Ok(result)
    }

    /// 统计每个文件夹的直接壁纸数与子树总数，供目录树展示。
    pub fn folder_tree(&self) -> LibResult<Vec<FolderNode>> {
        let folders = self.list_folders()?;
        let counts = self.folder_direct_counts()?;

        let mut nodes: Vec<FolderNode> = folders
            .iter()
            .map(|f| FolderNode {
                folder: f.clone(),
                direct_count: counts
                    .iter()
                    .find(|(id, _)| id == &f.id)
                    .map(|(_, c)| *c)
                    .unwrap_or(0),
                total_count: 0,
                children: folders
                    .iter()
                    .filter(|c| c.parent_id.as_deref() == Some(f.id.as_str()))
                    .map(|c| c.id.clone())
                    .collect(),
            })
            .collect();

        // 自底向上累加：先算叶子，再算父级。
        // 循环次数取文件夹数量即可保证收敛（最坏情况是一条链）。
        for _ in 0..folders.len().max(1) {
            let snapshot: Vec<(String, usize)> =
                nodes.iter().map(|n| (n.folder.id.clone(), n.total_count)).collect();
            let mut changed = false;
            for n in nodes.iter_mut() {
                let subtree_total = n.direct_count
                    + snapshot
                        .iter()
                        .filter(|(cid, _)| n.children.contains(cid))
                        .map(|(_, c)| *c)
                        .sum::<usize>();
                if n.total_count != subtree_total {
                    n.total_count = subtree_total;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        Ok(nodes)
    }

    /// 各文件夹内的直接壁纸数量。
    fn folder_direct_counts(&self) -> LibResult<Vec<(String, usize)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT folder_id, COUNT(*) FROM wallpapers WHERE folder_id IS NOT NULL GROUP BY folder_id",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 按文件夹集合筛选壁纸；传空集合表示不过滤（返回全部）。
    pub fn list_by_folders(&self, folder_ids: &[String]) -> LibResult<Vec<WallpaperRecord>> {
        if folder_ids.is_empty() {
            return self.list();
        }
        let conn = self.conn.lock();
        // 动态占位符：数量随选中文件夹变化，无法用固定 SQL
        let placeholders = vec!["?"; folder_ids.len()].join(",");
        let sql = format!(
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at, folder_id, storage_kind, source_stamp, cached_path
             FROM wallpapers WHERE folder_id IN ({placeholders}) ORDER BY created_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let params_iter = rusqlite::params_from_iter(folder_ids.iter());
        let rows = stmt
            .query_map(params_iter, map_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- 显示器绑定 ----

    /// 保存原图页面、作者与许可，入库后仍能追溯在线来源。
    pub fn save_online_origin(&self, wallpaper_id: &str, metadata: &str) -> LibResult<()> {
        self.conn.lock().execute(
            "INSERT INTO online_origins (wallpaper_id, metadata) VALUES (?1, ?2)
             ON CONFLICT(wallpaper_id) DO UPDATE SET metadata = excluded.metadata",
            params![wallpaper_id, metadata],
        )?;
        Ok(())
    }

    pub fn save_bindings(&self, bindings: &[MonitorBinding]) -> LibResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = chrono_now();
        for b in bindings {
            tx.execute(
                "INSERT INTO monitor_bindings (identity, wallpaper_id, position, updated_at, rendered_path)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(identity) DO UPDATE SET
                   wallpaper_id = excluded.wallpaper_id,
                   position     = excluded.position,
                   updated_at   = excluded.updated_at,
                   rendered_path = excluded.rendered_path",
                params![b.identity, b.wallpaper_id, b.position, now, b.rendered_path],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_bindings(&self) -> LibResult<Vec<MonitorBinding>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT identity, wallpaper_id, position, rendered_path FROM monitor_bindings",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MonitorBinding {
                    identity: row.get(0)?,
                    wallpaper_id: row.get(1)?,
                    position: row.get(2)?,
                    rendered_path: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

}

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<WallpaperRecord> {
    Ok(WallpaperRecord {
        id: row.get(0)?,
        file_path: row.get(1)?,
        thumb_path: row.get(2)?,
        source_path: row.get(3)?,
        name: row.get(4)?,
        width: row.get::<_, i64>(5)? as u32,
        height: row.get::<_, i64>(6)? as u32,
        bytes: row.get::<_, i64>(7)? as u64,
        created_at: row.get(8)?,
        folder_id: row.get(9)?,
        storage_kind: row.get(10)?,
        source_stamp: row.get(11)?,
        cached_path: row.get(12)?,
    })
}

impl From<WallpaperRecord> for Wallpaper {
    fn from(r: WallpaperRecord) -> Self {
        let missing = !Path::new(&r.file_path).is_file();
        Wallpaper {
            storage_kind: r.storage_kind,
            cached_path: r.cached_path,
            missing,
            id: r.id,
            name: r.name,
            file_path: r.file_path,
            thumb_path: r.thumb_path,
            width: r.width,
            height: r.height,
            bytes: r.bytes,
            created_at: r.created_at,
            folder_id: r.folder_id,
        }
    }
}

/// 当前 Unix 秒。仅用于排序与展示，无需更高精度。
pub fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 旧库迁移并保留跨屏绑定且普通投放清除分片路径() {
        let dir = std::env::temp_dir().join(format!("dwd-binding-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE monitor_bindings (
            identity TEXT PRIMARY KEY, wallpaper_id TEXT, position TEXT NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO monitor_bindings VALUES ('screen', 'wallpaper', 'fit', 0);").unwrap();
        drop(conn);
        let db = Db::open(&path).unwrap();
        let mut bindings = db.load_bindings().unwrap();
        assert_eq!(bindings[0].position, "fit");
        assert!(bindings[0].rendered_path.is_none());
        bindings[0].rendered_path = Some("C:\\data\\span\\piece.png".into());
        db.save_bindings(&bindings).unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        let mut bindings = db.load_bindings().unwrap();
        assert_eq!(bindings[0].rendered_path.as_deref(), Some("C:\\data\\span\\piece.png"));
        bindings[0].rendered_path = None;
        db.save_bindings(&bindings).unwrap();
        assert!(db.load_bindings().unwrap()[0].rendered_path.is_none());
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 旧版十列壁纸表迁移默认托管并保留记录与绑定且可重复打开() {
        let dir = std::env::temp_dir().join(format!("dwd-wallpaper-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE folders (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL);
             INSERT INTO folders VALUES ('collection-old', '旧合集', NULL, 123);
             CREATE TABLE wallpapers (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL UNIQUE,
                thumb_path TEXT NOT NULL,
                source_path TEXT NOT NULL,
                name TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                bytes INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                folder_id TEXT);
             INSERT INTO wallpapers VALUES (
                'wallpaper-old', 'C:\\wallpapers\\old.jpg', 'C:\\app\\thumbs\\old.jpg',
                'https://wallhaven.cc/w/old', '旧版保留名称', 1920, 1080, 345678, 456,
                'collection-old');
             CREATE TABLE monitor_bindings (
                identity TEXT PRIMARY KEY, wallpaper_id TEXT,
                position TEXT NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO monitor_bindings VALUES ('monitor-old', 'wallpaper-old', 'fit', 789);",
        ).unwrap();
        drop(conn);

        for _ in 0..2 {
            let db = Db::open(&path).unwrap();
            let wallpaper = db.get("wallpaper-old").unwrap().unwrap();
            assert_eq!(wallpaper.storage_kind, "managed");
            assert_eq!(wallpaper.file_path, "C:\\wallpapers\\old.jpg");
            assert_eq!(wallpaper.name, "旧版保留名称");
            assert_eq!(wallpaper.folder_id.as_deref(), Some("collection-old"));
            assert_eq!((wallpaper.width, wallpaper.height, wallpaper.bytes), (1920, 1080, 345678));

            let bindings = db.load_bindings().unwrap();
            assert_eq!(bindings.len(), 1);
            assert_eq!(bindings[0].identity, "monitor-old");
            assert_eq!(bindings[0].wallpaper_id.as_deref(), Some("wallpaper-old"));
            assert_eq!(bindings[0].position, "fit");
            assert!(bindings[0].rendered_path.is_none());
        }

        std::fs::remove_dir_all(dir).unwrap();
    }
}
