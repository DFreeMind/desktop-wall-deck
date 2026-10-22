//! 数据库层：壁纸元数据与显示器映射的持久化。
//!
//! 采用单连接 + `Mutex` 的形式。壁纸库的读写频率很低（导入时才写，浏览时读），
//! 不构成并发瓶颈；换来的是无需连接池与事务跨线程传递的复杂度。

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use super::error::{LibError, LibResult};
use super::model::{MonitorBinding, Wallpaper};

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
            "#,
        )
        .map_err(|e| LibError::Db(format!("初始化表结构失败：{e}")))?;
        Ok(())
    }

    /// 按源路径查重，命中则返回已有记录。
    pub fn find_by_source(&self, source_path: &str) -> LibResult<Option<WallpaperRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at
             FROM wallpapers WHERE source_path = ?1 LIMIT 1",
        )?;
        let rec = stmt
            .query_row(params![source_path], map_record)
            .optional()?;
        Ok(rec)
    }

    pub fn insert(&self, rec: &WallpaperRecord) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO wallpapers
             (id, file_path, thumb_path, source_path, name, width, height, bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                rec.id,
                rec.file_path,
                rec.thumb_path,
                rec.source_path,
                rec.name,
                rec.width,
                rec.height,
                rec.bytes,
                rec.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list(&self) -> LibResult<Vec<WallpaperRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at
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
            "SELECT id, file_path, thumb_path, source_path, name, width, height, bytes, created_at
             FROM wallpapers WHERE id = ?1",
        )?;
        Ok(stmt.query_row(params![id], map_record).optional()?)
    }

    pub fn delete(&self, id: &str) -> LibResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM wallpapers WHERE id = ?1", params![id])?;
        // 级联清理绑定，避免指向已删除的壁纸
        conn.execute(
            "UPDATE monitor_bindings SET wallpaper_id = NULL WHERE wallpaper_id = ?1",
            params![id],
        )?;
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

    // ---- 显示器绑定 ----

    pub fn save_bindings(&self, bindings: &[MonitorBinding]) -> LibResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let now = chrono_now();
        for b in bindings {
            tx.execute(
                "INSERT INTO monitor_bindings (identity, wallpaper_id, position, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(identity) DO UPDATE SET
                   wallpaper_id = excluded.wallpaper_id,
                   position     = excluded.position,
                   updated_at   = excluded.updated_at",
                params![b.identity, b.wallpaper_id, b.position, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_bindings(&self) -> LibResult<Vec<MonitorBinding>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT identity, wallpaper_id, position FROM monitor_bindings",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MonitorBinding {
                    identity: row.get(0)?,
                    wallpaper_id: row.get(1)?,
                    position: row.get(2)?,
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
    })
}

impl From<WallpaperRecord> for Wallpaper {
    fn from(r: WallpaperRecord) -> Self {
        Wallpaper {
            id: r.id,
            name: r.name,
            file_path: r.file_path,
            thumb_path: r.thumb_path,
            width: r.width,
            height: r.height,
            bytes: r.bytes,
            created_at: r.created_at,
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
