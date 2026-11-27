import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const day = 86_400_000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const visible = `NOT (
  e.source != 'archive' AND e.state IN ('received', 'accepted') AND EXISTS (
    SELECT 1 FROM conversation_events AS a WHERE a.source = 'archive'
      AND a.channel = e.channel AND a.direction = e.direction AND a.body = e.body
      AND (a.event_id = e.archive_id OR (e.archive_id IS NULL AND a.at BETWEEN e.at - 15000 AND e.at + 15000))
  )
)`;
const sentReminderCopy = `e.direction = 'outbound' AND e.source != 'scheduler' AND EXISTS (
  SELECT 1 FROM conversation_events AS attempt WHERE attempt.source = 'scheduler'
    AND attempt.channel = e.channel AND attempt.direction = 'outbound'
    AND (attempt.state = e.state OR (attempt.state = 'rejected' AND e.state = 'unknown'))
    AND attempt.body = e.body AND attempt.at BETWEEN e.at - 15000 AND e.at + 15000
)`;

export function parseConversationCursor(value) {
  if (value === null) return undefined;
  const match = /^(\d+):(m:\d{20}|r:[\w:-]{1,150}|\d{1,16})$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  const key = /^\d/.test(match[2]) ? 'm:' + match[2].padStart(20, '0') : match[2];
  return [Number(match[1]), key];
}

export function createConversationStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_events (
      seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL,
      direction TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
      body TEXT NOT NULL, at INTEGER NOT NULL, media_path TEXT, media_mime TEXT, media_name TEXT,
      content_origin TEXT, archive_id TEXT
    );
    CREATE INDEX IF NOT EXISTS conversation_time ON conversation_events(at, seq);
    CREATE INDEX IF NOT EXISTS conversation_channel_time ON conversation_events(channel, direction, at);
  `);
  const columns = db.prepare('PRAGMA table_info(conversation_events)').all();
  for (const name of ['content_origin', 'archive_id']) {
    if (!columns.some((column) => column.name === name)) db.exec('ALTER TABLE conversation_events ADD COLUMN ' + name + ' TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS conversation_archive_id ON conversation_events(archive_id)');
  const insert = db.prepare(`INSERT INTO conversation_events
    (event_id, channel, direction, source, state, body, at, media_path, media_mime, media_name, content_origin, archive_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      content_origin = COALESCE(excluded.content_origin, conversation_events.content_origin),
      archive_id = COALESCE(excluded.archive_id, conversation_events.archive_id)
    WHERE excluded.content_origin IS NOT NULL OR excluded.archive_id IS NOT NULL`);
  const add = ({ id, channel, direction, source, state, body, at, mediaPath, mediaMime, mediaName, contentOrigin, archiveId }) =>
    insert.run(id, channel, direction, source, state, body, at, mediaPath ?? null, mediaMime ?? null, mediaName ?? null,
      contentOrigin ?? null, archiveId ?? null);
  const latestWechatInbound = db.prepare("SELECT max(at) AS at FROM conversation_events WHERE channel = 'wechat' AND direction = 'inbound'");
  const lastWechatInbound = () => latestWechatInbound.get().at;
  return {
    recordConversation: add,
    lastWechatInbound,
    importConversation(events) {
      if (!events.length) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const event of events) add(event);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    conversation(before, limit = 60) {
      const [at, key] = before ?? [Number.MAX_SAFE_INTEGER, 'z:'];
      const rows = db.prepare(`WITH timeline AS (
        SELECT 'message' AS kind, e.seq AS id, printf('m:%020d', e.seq) AS sortKey, e.at, e.body,
          e.channel, e.direction, e.source, e.state, e.media_mime AS mediaMime, e.media_name AS mediaName,
          e.media_path IS NOT NULL AS hasMedia, NULL AS title, reply.wechat, reply.qq, reply.push,
          COALESCE(e.content_origin, CASE WHEN e.source = 'archive' AND e.direction = 'outbound' THEN
            COALESCE(
              (SELECT h.content_origin FROM conversation_events AS h WHERE h.archive_id = e.event_id
                AND h.channel = e.channel AND h.direction = 'outbound' AND h.state = 'accepted'
                AND h.content_origin IS NOT NULL ORDER BY h.seq DESC LIMIT 1),
              (SELECT CASE WHEN count(DISTINCT h.content_origin) = 1 THEN min(h.content_origin) END
                FROM conversation_events AS h WHERE h.archive_id IS NULL AND h.channel = e.channel
                AND h.direction = 'outbound' AND h.source = 'hook' AND h.state = 'accepted' AND h.body = e.body
                AND h.at BETWEEN e.at - 15000 AND e.at + 15000)
            ) END) AS contentOrigin,
          reply.detail, reply.qq_detail AS qqDetail, reply.id IS NOT NULL AS inbox,
          w.quote_state AS quoteState, w.quote_body AS quoteBody,
          CASE WHEN w.finished_at IS NOT NULL AND w.status = 'received' THEN COALESCE(reply.wechat, 'finished')
            ELSE w.status END AS replyStage,
          w.received_at AS replyReceivedAt, w.finished_at AS replyFinishedAt, w.id AS turnId
        FROM conversation_events AS e
        LEFT JOIN wechat_turns AS w ON w.id = substr(e.event_id, 9) AND e.source = 'archive' AND e.direction = 'inbound'
        LEFT JOIN jobs AS reply ON reply.id = 'reply:' || w.id
        WHERE (e.at, printf('m:%020d', e.seq)) < (?, ?)
          AND e.source != 'scheduler' AND ${visible} AND NOT (${sentReminderCopy})
        UNION ALL
        SELECT 'reminder', 'r:' || j.id, 'r:' || j.id, COALESCE(j.activated_at, j.due_at), j.body,
          NULL, NULL, NULL, NULL, NULL, NULL, 0, j.title, j.wechat, j.qq, j.push, 'program', j.detail, j.qq_detail,
          EXISTS (SELECT 1 FROM inbox WHERE id = j.id), NULL, NULL, NULL, NULL, NULL, NULL
        FROM jobs AS j
        WHERE (COALESCE(j.activated_at, j.due_at), 'r:' || j.id) < (?, ?)
          AND j.stage != 'pending' AND j.wechat != 'cancelled'
      )
      SELECT * FROM timeline ORDER BY at DESC, sortKey DESC LIMIT ?`).all(at, key, at, key, limit + 1);
      const messages = rows.slice(0, limit);
      const last = messages.at(-1);
      const turnIds = messages.flatMap(({ turnId }) => turnId ? [turnId] : []);
      const stepsByTurn = new Map();
      if (turnIds.length) {
        const steps = db.prepare(`SELECT turn_id AS turnId, label, state, at, updated_at AS updatedAt, details
          FROM wechat_turn_steps WHERE turn_id IN (${turnIds.map(() => '?').join(', ')}) ORDER BY at, seq`).all(...turnIds);
        for (const { turnId, details, ...step } of steps) {
          if (!stepsByTurn.has(turnId)) stepsByTurn.set(turnId, []);
          stepsByTurn.get(turnId).push(details ? { ...step, details: JSON.parse(details) } : step);
        }
      }
      return {
        messages: messages.reverse().map(({ sortKey: _key, turnId, ...item }) => turnId
          ? { ...item, replySteps: stepsByTurn.get(turnId) ?? [] }
          : item),
        before: rows.length > limit ? `${last.at}:${last.sortKey}` : null
      };
    },
    conversationAttachment(id) {
      return db.prepare(`SELECT media_path AS path, media_mime AS mime, media_name AS name
        FROM conversation_events WHERE seq = ? AND source = 'archive' AND media_path IS NOT NULL`).get(id);
    },
    wechatActivity(now) {
      const latest = lastWechatInbound();
      const activity = db.prepare(`SELECT max(e.at) AS lastOutboundAt, count(*) AS attempts,
        count(*) FILTER (WHERE e.state = 'accepted') AS accepted
        FROM conversation_events AS e WHERE e.channel = 'wechat' AND e.direction = 'outbound'
          AND e.at >= ? AND (e.source = 'scheduler' OR (${visible} AND NOT (${sentReminderCopy})))`).get(latest ?? now - day);
      return { lastInboundAt: latest, ...activity, observationSince: latest ?? now - day };
    }
  };
}

export function createWechatArchive(stateDir, account, recipient, store) {
  if (!stateDir || !account || !recipient) return () => {};
  const file = join(stateDir, 'openclaw-weixin', 'ref-messages.sqlite');
  let lastCheck = -Infinity;
  let recent = 0;
  return (now) => {
    if (now - lastCheck < 5000) return;
    lastCheck = now;
    if (!existsSync(file)) return;
    let archive;
    try {
      archive = new DatabaseSync(file, { readOnly: true, timeout: 500 });
      const rows = archive.prepare(`SELECT message_id, direction, body, created_at, media_path, media_mime, media_name
        FROM quote_messages WHERE account_id = ? AND conversation_id = ?
        AND direction IN ('inbound','outbound') AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10000`).all(account, recipient, Math.max(0, recent - 60_000));
      store.importConversation(rows.reverse().map((row) => ({
        id: 'archive:' + digest(JSON.stringify([account, recipient, row.message_id])),
        channel: 'wechat', source: 'archive', direction: row.direction,
        state: row.direction === 'inbound' ? 'received' : 'accepted',
        body: row.body, at: row.created_at, mediaPath: row.media_path, mediaMime: row.media_mime, mediaName: row.media_name
      })));
      if (rows.length) recent = Math.max(recent, rows.at(-1).created_at);
    } catch (error) {
      console.error('微信历史读取暂缓。', error.code ?? error.name);
    } finally {
      archive?.close();
    }
  };
}

export function readBoundWechatInbound(stateDir, account, recipient) {
  if (!stateDir || !account || !recipient) return null;
  const file = join(stateDir, 'openclaw-weixin', 'ref-messages.sqlite');
  let archive;
  try {
    archive = new DatabaseSync(file, { readOnly: true, timeout: 500 });
    return archive.prepare(`SELECT max(created_at) AS at FROM quote_messages
      WHERE account_id = ? AND conversation_id = ? AND direction = 'inbound'`).get(account, recipient).at;
  } catch {
    return null;
  } finally {
    archive?.close();
  }
}

export function resolveConversationAttachment(attachment, root) {
  if (!attachment || !root || !isAbsolute(attachment.path)) return null;
  try {
    const path = realpathSync(attachment.path);
    const child = relative(realpathSync(root), path);
    if (!child || child.startsWith('..') || isAbsolute(child)) return null;
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 32_000_000) return null;
    const mime = /^(image\/(?:jpeg|png|gif|webp)|audio\/(?:mpeg|mp4|ogg|wav)|video\/mp4)$/.test(attachment.mime)
      ? attachment.mime : 'application/octet-stream';
    return { path, mime, size: metadata.size, name: basename(attachment.name || path).slice(0, 180) };
  } catch {
    return null;
  }
}
