//! 标记系统 + 固定(pin)系统,SQLite 持久化。
//!
//! ## 标记(mark)
//! - 给日志行打上颜色分组标记 + 可选备注(注释用途,色板 [`PALETTE`])
//! - 行号使用 **1-based**(与显示层一致),文件以路径字符串作为 `file_id`
//! - 同一文件同一行只能有一个标记(UNIQUE(file_id, line_no)),重复添加即覆盖(upsert)
//!
//! ## 固定(pin)
//! - 独立于颜色标记的书签功能(Notepad++/klogg 风格),一行只能固定一次
//! - 固定必须归入某个分组 [`PinGroup`](PinGroup)(自定义分组;不指定时进"默认"组)
//! - 组内以 `position` 排序,前端拖拽排序后调用 [`reorder_pins`](MarkStore::reorder_pins)
//! - 表: `pin_groups`(file_id, name 唯一)+ `pins`(line_no, group_id, position)

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

/// 预设颜色组(与前端色板顺序一致):红/橙/黄/绿/蓝/紫/青/琥珀
pub const PALETTE: [u32; 8] = [
    0xE74C3C, 0xF39C12, 0xF1C40F, 0x2ECC71, 0x3498DB, 0x9B59B6, 0x1ABC9C, 0xE67E22,
];

/// 单条标记
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub id: i64,
    pub file_id: String,
    /// 1-based 行号
    pub line_no: usize,
    /// PALETTE 下标
    pub color: u8,
    pub note: String,
    /// unix 秒
    pub created_at: i64,
}

/// 固定分组(自定义名称,文件级)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinGroup {
    pub id: i64,
    pub name: String,
}

/// 一条固定记录
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub id: i64,
    pub file_id: String,
    /// 1-based 行号
    pub line_no: usize,
    /// 所属分组;None 仅存于旧数据,读取时归入默认组
    pub group_id: Option<i64>,
    /// 组内排序序号(前端拖拽重排)
    pub position: i64,
    /// 自定义名称(可空;面板显示时优先于行号)
    pub name: String,
    /// unix 秒
    pub created_at: i64,
}

/// list_pins 返回:分组列表 + 全部固定(组内按 position 升序)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PinList {
    pub groups: Vec<PinGroup>,
    pub pins: Vec<Pin>,
}

/// 默认分组名(不指定分组时固定进入的组)
pub const DEFAULT_PIN_GROUP: &str = "默认";

/// SQLite 持久化的标记仓库。内部持锁,线程安全。
pub struct MarkStore {
    conn: Mutex<Connection>,
}

impl MarkStore {
    /// 打开(不存在则创建)数据库并建表。
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS marks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id    TEXT    NOT NULL,
                line_no    INTEGER NOT NULL,
                color      INTEGER NOT NULL,
                note       TEXT    NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                UNIQUE(file_id, line_no)
            );
            CREATE INDEX IF NOT EXISTS idx_marks_file ON marks(file_id);

            CREATE TABLE IF NOT EXISTS pin_groups (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id TEXT NOT NULL,
                name    TEXT NOT NULL,
                UNIQUE(file_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_pin_groups_file ON pin_groups(file_id);

            CREATE TABLE IF NOT EXISTS pins (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id    TEXT    NOT NULL,
                line_no    INTEGER NOT NULL,
                group_id   INTEGER REFERENCES pin_groups(id) ON DELETE SET NULL,
                position   INTEGER NOT NULL DEFAULT 0,
                name       TEXT    NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                UNIQUE(file_id, line_no)
            );
            CREATE INDEX IF NOT EXISTS idx_pins_file ON pins(file_id);",
        )?;
        // 旧库迁移:早期版本 pins 表无 name 列
        let has_name: bool = conn
            .prepare("PRAGMA table_info(pins)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|c| c == "name");
        if !has_name {
            conn.execute(
                "ALTER TABLE pins ADD COLUMN name TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        Ok(MarkStore { conn: Mutex::new(conn) })
    }

    /// 添加标记;若同一文件同一行已存在则覆盖颜色与备注。
    pub fn add(&self, file_id: &str, line_no: usize, color: u8, note: &str) -> rusqlite::Result<Mark> {
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO marks (file_id, line_no, color, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(file_id, line_no) DO UPDATE SET
               color = excluded.color, note = excluded.note, created_at = excluded.created_at",
            params![file_id, line_no as i64, color as i64, note, now],
        )?;
        Self::by_line_locked(&conn, file_id, line_no)
            .map(|m| m.expect("just inserted"))
    }

    /// 删除标记。
    pub fn remove(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM marks WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 修改标记的颜色和/或备注(None 表示不改)。返回更新后的标记。
    pub fn update(&self, id: i64, color: Option<u8>, note: Option<&str>) -> rusqlite::Result<Option<Mark>> {
        let conn = self.conn.lock().unwrap();
        if let Some(c) = color {
            conn.execute("UPDATE marks SET color = ?1 WHERE id = ?2", params![c as i64, id])?;
        }
        if let Some(n) = note {
            conn.execute("UPDATE marks SET note = ?1 WHERE id = ?2", params![n, id])?;
        }
        Self::get_by_id_locked(&conn, id)
    }

    /// 某文件的全部标记,按行号升序。
    pub fn list(&self, file_id: &str) -> rusqlite::Result<Vec<Mark>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, file_id, line_no, color, note, created_at
             FROM marks WHERE file_id = ?1 ORDER BY line_no",
        )?;
        let rows = stmt.query_map(params![file_id], row_to_mark)?;
        rows.collect()
    }

    /// 某文件某行上的标记(无则 None)。
    pub fn by_line(&self, file_id: &str, line_no: usize) -> rusqlite::Result<Option<Mark>> {
        let conn = self.conn.lock().unwrap();
        Self::by_line_locked(&conn, file_id, line_no)
    }

    /// 删除某文件全部标记与固定(文件关闭时清理)。
    pub fn clear_file(&self, file_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM marks WHERE file_id = ?1", params![file_id])?;
        conn.execute("DELETE FROM pins WHERE file_id = ?1", params![file_id])?;
        conn.execute("DELETE FROM pin_groups WHERE file_id = ?1", params![file_id])?;
        Ok(())
    }

    // ── 固定(pin):独立于颜色标记的书签功能 ──

    /// 取(或创建)"默认"分组。
    fn ensure_default_group_locked(conn: &Connection, file_id: &str) -> rusqlite::Result<i64> {
        conn.execute(
            "INSERT OR IGNORE INTO pin_groups (file_id, name) VALUES (?1, ?2)",
            params![file_id, DEFAULT_PIN_GROUP],
        )?;
        conn.query_row(
            "SELECT id FROM pin_groups WHERE file_id = ?1 AND name = ?2",
            params![file_id, DEFAULT_PIN_GROUP],
            |r| r.get(0),
        )
    }

    /// 固定一行到某分组(不指定 → 默认组,自动创建);`name` 为空表示不命名。
    /// 同一行重复固定会改分组、更新名字并置尾。
    pub fn add_pin(&self, file_id: &str, line_no: usize, group_id: Option<i64>, name: &str) -> rusqlite::Result<Pin> {
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        let gid = match group_id {
            Some(g) => {
                let ok: bool = conn
                    .query_row(
                        "SELECT 1 FROM pin_groups WHERE id = ?1 AND file_id = ?2",
                        params![g, file_id],
                        |_| Ok(true),
                    )
                    .optional()?
                    .is_some();
                if ok { g } else { Self::ensure_default_group_locked(&conn, file_id)? }
            }
            None => Self::ensure_default_group_locked(&conn, file_id)?,
        };
        // 追加到组尾
        let pos: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM pins WHERE file_id = ?1 AND group_id = ?2",
            params![file_id, gid],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO pins (file_id, line_no, group_id, position, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(file_id, line_no) DO UPDATE SET
               group_id = excluded.group_id, position = excluded.position,
               name = excluded.name, created_at = excluded.created_at",
            params![file_id, line_no as i64, gid, pos, name, now],
        )?;
        Ok(Self::pin_by_line_locked(&conn, file_id, line_no)?.expect("just inserted"))
    }

    /// 重命名固定(空名清除名称)。
    pub fn rename_pin(&self, id: i64, name: &str) -> rusqlite::Result<Option<Pin>> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE pins SET name = ?1 WHERE id = ?2", params![name, id])?;
        conn.query_row(
            "SELECT id, file_id, line_no, group_id, position, name, created_at
             FROM pins WHERE id = ?1",
            params![id],
            row_to_pin,
        )
        .optional()
    }

    /// 取消固定。
    pub fn remove_pin(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM pins WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 某文件的全部固定:分组 + 固定行(组内按 position 升序)。
    pub fn list_pins(&self, file_id: &str) -> rusqlite::Result<PinList> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name FROM pin_groups WHERE file_id = ?1 ORDER BY id",
        )?;
        let groups = stmt
            .query_map(params![file_id], |r| {
                Ok(PinGroup { id: r.get(0)?, name: r.get(1)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_id, line_no, group_id, position, name, created_at
             FROM pins WHERE file_id = ?1 ORDER BY group_id, position, line_no",
        )?;
        let pins = stmt
            .query_map(params![file_id], row_to_pin)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(PinList { groups, pins })
    }

    /// 新建分组(同名已存在则返回现有)。
    pub fn create_pin_group(&self, file_id: &str, name: &str) -> rusqlite::Result<PinGroup> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO pin_groups (file_id, name) VALUES (?1, ?2)",
            params![file_id, name],
        )?;
        conn.query_row(
            "SELECT id, name FROM pin_groups WHERE file_id = ?1 AND name = ?2",
            params![file_id, name],
            |r| Ok(PinGroup { id: r.get(0)?, name: r.get(1)? }),
        )
    }

    /// 删除分组:组内固定移到默认组(不丢失数据)。
    pub fn delete_pin_group(&self, file_id: &str, group_id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let def = Self::ensure_default_group_locked(&conn, file_id)?;
        if group_id != def {
            conn.execute(
                "UPDATE pins SET group_id = ?1 WHERE group_id = ?2",
                params![def, group_id],
            )?;
        }
        conn.execute("DELETE FROM pin_groups WHERE id = ?1", params![group_id])?;
        Ok(())
    }

    /// 组内全量重排(拖拽排序后调用):`ids` 的顺序即新 position(0..n)。
    pub fn reorder_pins(&self, file_id: &str, group_id: i64, ids: &[i64]) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        for (i, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE pins SET position = ?1 WHERE id = ?2 AND file_id = ?3 AND group_id = ?4",
                params![i as i64, id, file_id, group_id],
            )?;
        }
        Ok(())
    }

    /// 把固定移到另一分组末尾(跨组拖拽)。
    pub fn move_pin_to_group(&self, pin_id: i64, file_id: &str, group_id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let pos: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM pins WHERE file_id = ?1 AND group_id = ?2",
            params![file_id, group_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "UPDATE pins SET group_id = ?1, position = ?2 WHERE id = ?3",
            params![group_id, pos, pin_id],
        )?;
        Ok(())
    }

    /// 某文件某行上的固定(无则 None)。
    pub fn pin_by_line(&self, file_id: &str, line_no: usize) -> rusqlite::Result<Option<Pin>> {
        let conn = self.conn.lock().unwrap();
        Self::pin_by_line_locked(&conn, file_id, line_no)
    }

    fn pin_by_line_locked(conn: &Connection, file_id: &str, line_no: usize) -> rusqlite::Result<Option<Pin>> {
        conn.query_row(
            "SELECT id, file_id, line_no, group_id, position, name, created_at
             FROM pins WHERE file_id = ?1 AND line_no = ?2",
            params![file_id, line_no as i64],
            row_to_pin,
        )
        .optional()
    }

    fn by_line_locked(conn: &Connection, file_id: &str, line_no: usize) -> rusqlite::Result<Option<Mark>> {
        conn.query_row(
            "SELECT id, file_id, line_no, color, note, created_at
             FROM marks WHERE file_id = ?1 AND line_no = ?2",
            params![file_id, line_no as i64],
            row_to_mark,
        )
        .optional()
    }

    fn get_by_id_locked(conn: &Connection, id: i64) -> rusqlite::Result<Option<Mark>> {
        conn.query_row(
            "SELECT id, file_id, line_no, color, note, created_at
             FROM marks WHERE id = ?1",
            params![id],
            row_to_mark,
        )
        .optional()
    }
}

fn row_to_pin(row: &rusqlite::Row<'_>) -> rusqlite::Result<Pin> {
    Ok(Pin {
        id: row.get(0)?,
        file_id: row.get(1)?,
        line_no: row.get::<_, i64>(2)? as usize,
        group_id: row.get(3)?,
        position: row.get(4)?,
        name: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn row_to_mark(row: &rusqlite::Row<'_>) -> rusqlite::Result<Mark> {
    Ok(Mark {
        id: row.get(0)?,
        file_id: row.get(1)?,
        line_no: row.get::<_, i64>(2)? as usize,
        color: row.get::<_, i64>(3)? as u8,
        note: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MarkStore {
        let dir = tempfile::tempdir().unwrap();
        MarkStore::open(dir.path().join("test.db")).unwrap()
    }

    #[test]
    fn add_list_remove() {
        let s = store();
        s.add("a.log", 10, 1, "").unwrap();
        s.add("a.log", 20, 3, "critical").unwrap();
        s.add("b.log", 5, 0, "").unwrap();

        let marks = s.list("a.log").unwrap();
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0].line_no, 10);
        assert_eq!(marks[0].color, 1);
        assert_eq!(marks[1].line_no, 20);
        assert_eq!(marks[1].note, "critical");
        assert_eq!(s.list("b.log").unwrap().len(), 1);

        s.remove(marks[0].id).unwrap();
        assert_eq!(s.list("a.log").unwrap().len(), 1);
    }

    #[test]
    fn upsert_same_line_overwrites() {
        let s = store();
        let a = s.add("a.log", 10, 1, "first").unwrap();
        let b = s.add("a.log", 10, 5, "second").unwrap();
        // 同一文件同一行只有一个标记,颜色/备注被覆盖
        assert_eq!(a.id, b.id);
        let all = s.list("a.log").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].color, 5);
        assert_eq!(all[0].note, "second");
    }

    #[test]
    fn update_color_and_note() {
        let s = store();
        let m = s.add("a.log", 3, 0, "").unwrap();
        let updated = s.update(m.id, Some(6), Some("explain here")).unwrap().unwrap();
        assert_eq!(updated.color, 6);
        assert_eq!(updated.note, "explain here");
        // 只改颜色不动备注
        let c = s.update(m.id, Some(2), None).unwrap().unwrap();
        assert_eq!(c.color, 2);
        assert_eq!(c.note, "explain here");
    }

    #[test]
    fn by_line_and_clear_file() {
        let s = store();
        s.add("a.log", 7, 2, "").unwrap();
        let m = s.by_line("a.log", 7).unwrap().unwrap();
        assert_eq!(m.color, 2);
        assert!(s.by_line("a.log", 8).unwrap().is_none());

        s.clear_file("a.log").unwrap();
        assert!(s.list("a.log").unwrap().is_empty());
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.db");
        {
            let s = MarkStore::open(&path).unwrap();
            s.add("a.log", 42, 4, "kept").unwrap();
        }
        let s2 = MarkStore::open(&path).unwrap();
        let marks = s2.list("a.log").unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].line_no, 42);
        assert_eq!(marks[0].color, 4);
        assert_eq!(marks[0].note, "kept");
    }

    #[test]
    fn concurrent_adds_are_serialized() {
        let s = std::sync::Arc::new(store());
        let mut handles = vec![];
        for i in 0..8 {
            let s = s.clone();
            handles.push(std::thread::spawn(move || {
                for n in 1..=20 {
                    s.add("a.log", n, (i % 8) as u8, "").unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // 8 线程 × 20 行并发写入,最终每行一个标记
        assert_eq!(s.list("a.log").unwrap().len(), 20);
    }

    // ── 固定(pin)──

    #[test]
    fn pin_default_group_and_list() {
        let s = store();
        let p1 = s.add_pin("a.log", 10, None, "").unwrap();
        let p2 = s.add_pin("a.log", 20, None, "").unwrap();
        let all = s.list_pins("a.log").unwrap();
        assert_eq!(all.groups.len(), 1);
        assert_eq!(all.groups[0].name, DEFAULT_PIN_GROUP);
        assert_eq!(all.pins.len(), 2);
        // 追加顺序 = position 顺序
        assert_eq!(all.pins[0].line_no, 10);
        assert_eq!(all.pins[1].line_no, 20);
        assert_eq!(p1.group_id, Some(all.groups[0].id));
        assert_eq!(p2.group_id, Some(all.groups[0].id));
    }

    #[test]
    fn pin_groups_create_move_delete() {
        let s = store();
        // 先固定一行到默认组(触发"默认"组创建)
        s.add_pin("a.log", 1, None, "").unwrap();
        let g = s.create_pin_group("a.log", "崩溃栈").unwrap();
        let p = s.add_pin("a.log", 55, Some(g.id), "").unwrap();
        assert_eq!(p.group_id, Some(g.id));

        // 跨组移动:回到默认组
        let def = s.list_pins("a.log").unwrap().groups
            .iter().find(|x| x.name == DEFAULT_PIN_GROUP).unwrap().id;
        s.move_pin_to_group(p.id, "a.log", def).unwrap();
        let moved = s.pin_by_line("a.log", 55).unwrap().unwrap();
        assert_eq!(moved.group_id, Some(def));

        // 删除分组:组内固定落回默认组
        let g2 = s.create_pin_group("a.log", "临时").unwrap();
        s.add_pin("a.log", 77, Some(g2.id), "").unwrap();
        s.delete_pin_group("a.log", g2.id).unwrap();
        let all = s.list_pins("a.log").unwrap();
        assert!(!all.groups.iter().any(|x| x.id == g2.id));
        assert!(all.pins.iter().any(|x| x.line_no == 77));
    }

    #[test]
    fn pin_reorder_and_duplicate_line() {
        let s = store();
        let g = s.create_pin_group("a.log", "G").unwrap();
        let p1 = s.add_pin("a.log", 1, Some(g.id), "").unwrap();
        let p2 = s.add_pin("a.log", 2, Some(g.id), "").unwrap();
        let p3 = s.add_pin("a.log", 3, Some(g.id), "").unwrap();

        // 拖拽排序:3 挪到最前
        s.reorder_pins("a.log", g.id, &[p3.id, p1.id, p2.id]).unwrap();
        let pins = s.list_pins("a.log").unwrap().pins;
        let lines: Vec<usize> = pins.iter().map(|p| p.line_no).collect();
        assert_eq!(lines, vec![3, 1, 2]);

        // 同一行重复固定:不新增,改为最新分组
        let p3b = s.add_pin("a.log", 3, None, "").unwrap();
        assert_eq!(p3b.id, p3.id);
        assert_eq!(s.list_pins("a.log").unwrap().pins.len(), 3);
    }

    #[test]
    fn pin_name_and_rename() {
        let s = store();
        let p = s.add_pin("a.log", 5, None, "首次启动异常").unwrap();
        assert_eq!(p.name, "首次启动异常");
        // 重命名
        let renamed = s.rename_pin(p.id, "已确认").unwrap().unwrap();
        assert_eq!(renamed.name, "已确认");
        // 清空名称
        let cleared = s.rename_pin(p.id, "").unwrap().unwrap();
        assert_eq!(cleared.name, "");
        // 重复固定会更新名字
        let again = s.add_pin("a.log", 5, None, "新名字").unwrap();
        assert_eq!(again.id, p.id);
        assert_eq!(again.name, "新名字");
    }

    #[test]
    fn clear_file_clears_pins_too() {
        let s = store();
        s.add_pin("a.log", 9, None, "").unwrap();
        s.create_pin_group("a.log", "G").unwrap();
        s.clear_file("a.log").unwrap();
        let all = s.list_pins("a.log").unwrap();
        assert!(all.pins.is_empty());
        assert!(all.groups.is_empty());
    }
}
