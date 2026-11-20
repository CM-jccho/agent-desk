import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const taskFields = 'id, channel_id AS channelId, parent_id AS parentId, retry_of AS retryOf, bot_id AS botId, payload, status, output, error, created_at AS createdAt, updated_at AS updatedAt';

export function openStore(directory) {
  const lease = new DatabaseSync(join(directory, 'lease.sqlite'));
  try { lease.exec('BEGIN EXCLUSIVE'); }
  catch (error) {
    lease.close();
    throw new Error('이 데이터 폴더를 이미 사용 중입니다.', { cause: error });
  }
  let db;
  try {
    db = new DatabaseSync(join(directory, 'desk.sqlite'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        engine TEXT NOT NULL CHECK (engine IN ('codex','claude')), role TEXT NOT NULL, model TEXT NOT NULL, folder TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, updatedAt INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_signature TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels, bot_id TEXT NOT NULL REFERENCES bots,
        parent_id TEXT REFERENCES tasks, retry_of TEXT REFERENCES tasks, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS tasks_by_channel ON tasks(channel_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks,
        kind TEXT NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id, seq);
      INSERT OR IGNORE INTO channels VALUES
        ('general', '업무 요청', '지시를 남기고 결과를 이어서 검토합니다.'),
        ('planning', '기획·리서치', '자료 정리와 기획 초안을 준비합니다.'),
        ('review', '검토·피드백', '초안을 다른 봇에게 넘겨 검토합니다.');
      INSERT OR IGNORE INTO bots VALUES
        ('codex', 'Codex', 'codex', '분석 및 문제 해결', '', ''),
        ('claude', 'Claude Code', 'claude', '문서 작성 및 검토', '', '');
    `);
  } catch (error) {
    db?.close();
    lease.close();
    throw error;
  }

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function addEvent(id, kind, at) {
    db.prepare('INSERT INTO events(task_id, kind, at) VALUES (?, ?, ?)').run(id, kind, at);
  }
  function change(id, previous, status, output = '', error = '') {
    return transaction(() => {
      const now = Date.now();
      const updated = db.prepare('UPDATE tasks SET status=?, output=?, error=?, updated_at=? WHERE id=? AND status=?')
        .run(status, output, error, now, id, previous);
      if (updated.changes) addEvent(id, status, now);
      return Boolean(updated.changes);
    });
  }
  function recover() {
    for (const { id, status } of db.prepare("SELECT id,status FROM tasks WHERE status IN ('running','cancelling')").all()) {
      change(id, status, 'interrupted', '', '서버가 종료되어 실행 결과를 확인할 수 없습니다.');
    }
  }
  function unpack(row) {
    if (!row) return undefined;
    return {
      ...row, payload: JSON.parse(row.payload),
      events: db.prepare('SELECT kind, at FROM events WHERE task_id=? ORDER BY seq').all(row.id),
    };
  }
  function task(id) { return unpack(db.prepare('SELECT ' + taskFields + ' FROM tasks WHERE id=?').get(id)); }
  function request(id) { return db.prepare('SELECT id, request_signature AS signature FROM tasks WHERE request_id=?').get(id); }

  return {
    close() { db.close(); lease.close(); },
    recover, change, task, request,
    nextQueued(busyBots) {
      return unpack(db.prepare('SELECT ' + taskFields + " FROM tasks WHERE status='queued'" +
        ' AND bot_id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid LIMIT 1')
        .get(JSON.stringify([...busyBots])));
    },
    state() {
      const summaries = db.prepare(`
        SELECT id, channel_id AS channelId, parent_id AS parentId, retry_of AS retryOf, bot_id AS botId,
          json_extract(payload, '$.bot.name') AS botName, json_extract(payload, '$.bot.engine') AS botEngine,
          substr(json_extract(payload, '$.prompt'), 1, 160) AS prompt, status, created_at AS createdAt, updated_at AS updatedAt
        FROM tasks ORDER BY created_at DESC, rowid DESC
      `).all();
      return {
        channels: db.prepare('SELECT * FROM channels ORDER BY rowid').all(),
        bots: db.prepare('SELECT * FROM bots ORDER BY rowid').all(),
        notes: db.prepare('SELECT * FROM notes ORDER BY updatedAt DESC, rowid DESC').all(),
        tasks: summaries,
      };
    },
    channel(id) { return db.prepare('SELECT * FROM channels WHERE id=?').get(id); },
    feed(id) {
      return db.prepare(`SELECT id, json_extract(payload, '$.prompt') AS prompt, output, error
        FROM tasks WHERE channel_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30`).all(id);
    },
    bot(id) { return db.prepare('SELECT * FROM bots WHERE id=?').get(id); },
    note(id) { return db.prepare('SELECT * FROM notes WHERE id=?').get(id); },
    addChannel(name, description) {
      const id = randomUUID();
      db.prepare('INSERT INTO channels VALUES (?, ?, ?)').run(id, name, description);
      return this.channel(id);
    },
    addBot({ name, engine, role, model, folder }) {
      const id = randomUUID();
      db.prepare('INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?)').run(id, name, engine, role, model, folder);
      return this.bot(id);
    },
    editBot(id, { name, engine, role, model, folder }) {
      db.prepare('UPDATE bots SET name=?, engine=?, role=?, model=?, folder=? WHERE id=?')
        .run(name, engine, role, model, folder, id);
      return this.bot(id);
    },
    saveNote(id, title, content) {
      db.prepare(`INSERT INTO notes VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updatedAt=excluded.updatedAt`)
        .run(id, title, content, Date.now());
      return this.note(id);
    },
    deleteNote(id) { return Boolean(db.prepare('DELETE FROM notes WHERE id=?').run(id).changes); },
    addTask({ requestId, signature, channelId, botId, parentId, retryOf, payload, direct = false }) {
      return transaction(() => {
        const id = randomUUID();
        const now = Date.now();
        db.prepare(`INSERT INTO tasks (id, request_id, request_signature, channel_id, bot_id, parent_id,
          retry_of, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, requestId, signature, channelId, botId, parentId, retryOf, JSON.stringify(payload),
            direct ? 'queued' : 'pending', now, now);
        addEvent(id, 'pending', now);
        if (direct) addEvent(id, 'queued', now);
        return task(id);
      });
    },
  };
}
