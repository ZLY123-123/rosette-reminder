import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { channels, defaultPolicy, jobPolicy, shouldDescend, validPolicy, wasAccepted, wechatDeferredDetail } from './routing.mjs';
import { createConversationStore } from './conversation.mjs';
import { defaultModelAlerts, usageDate } from './model-usage.mjs';
import { wechatResumeDue, wechatResumeTitle, wechatResumeBody } from './wechat-resume.mjs';

const shanghaiOffset = 8 * 60 * 60 * 1000;
const taskColumns = 'id, title, due_at AS dueAt, dual, completed, version, repeat, repeat_until AS repeatUntil, archived_at AS archivedAt';
const repetition = { daily: 86_400_000, weekly: 604_800_000 };
const alertColumns = 'id, title, body, created_at AS createdAt, read';

export function shanghaiTime(now = Date.now()) {
  return new Date(now + shanghaiOffset).toISOString();
}

export function formatTime(time) {
  return shanghaiTime(time).slice(0, 16).replace('T', ' ');
}

export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at INTEGER, dual INTEGER NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), due_at INTEGER NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, dual INTEGER NOT NULL, stage TEXT NOT NULL, wechat TEXT NOT NULL DEFAULT 'pending',
      push TEXT NOT NULL DEFAULT 'pending', detail TEXT, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS due_jobs ON jobs(stage, due_at);
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY REFERENCES jobs(id), title TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_attempts (
      job_id TEXT NOT NULL REFERENCES jobs(id), endpoint TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, PRIMARY KEY (job_id, endpoint)
    );
    CREATE INDEX IF NOT EXISTS pending_push ON push_attempts(status, next_at);
    CREATE TABLE IF NOT EXISTS task_request_keys (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS inbox_request_keys (
      key TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, changed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), daily TEXT, dual INTEGER NOT NULL DEFAULT 0,
      badge_revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS wechat_turns (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, received_at INTEGER NOT NULL, finished_at INTEGER,
      quote_state TEXT, quote_body TEXT
    );
    CREATE INDEX IF NOT EXISTS wechat_turns_pending ON wechat_turns(received_at) WHERE finished_at IS NULL;
    CREATE TABLE IF NOT EXISTS wechat_turn_steps (
      seq INTEGER PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES wechat_turns(id), step_key TEXT NOT NULL,
      label TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(turn_id, step_key)
    );
    CREATE TABLE IF NOT EXISTS model_usage_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_usage_daily (
      date TEXT NOT NULL, session_key TEXT NOT NULL, channel TEXT NOT NULL,
      totals TEXT NOT NULL, models TEXT NOT NULL, PRIMARY KEY(date, session_key)
    );
    CREATE TABLE IF NOT EXISTS wechat_delivery_holds (
      scope TEXT PRIMARY KEY, inbound_at INTEGER NOT NULL
    );
  `);
  for (const [table, name, definition] of [
    ['tasks', 'repeat', "TEXT NOT NULL DEFAULT 'once'"],
    ['tasks', 'repeat_until', 'TEXT'],
    ['tasks', 'archived_at', 'INTEGER'],
    ['inbox', 'archive_key', 'TEXT'],
    ['inbox', 'archived_at', 'INTEGER'],
    ['jobs', 'qq', "TEXT NOT NULL DEFAULT 'skipped'"],
    ['jobs', 'qq_detail', 'TEXT'],
    ['jobs', 'route_plan', 'TEXT'],
    ['jobs', 'route_level', 'INTEGER NOT NULL DEFAULT 0'],
    ['jobs', 'activated_at', 'INTEGER'],
    ['jobs', 'wechat_followup_at', 'INTEGER'],
    ['settings', 'delivery_policy', 'TEXT'],
    ['settings', 'token_saving', 'INTEGER NOT NULL DEFAULT 0'],
    ['wechat_turns', 'status', "TEXT NOT NULL DEFAULT 'received'"],
    ['wechat_turn_steps', 'details', 'TEXT']
  ]) {
    if (!db.prepare('PRAGMA table_info(' + table + ')').all().some((column) => column.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  const get = (query, ...args) => db.prepare(query).get(...args);
  const all = (query, ...args) => db.prepare(query).all(...args);
  const run = (query, ...args) => db.prepare(query).run(...args);
  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function enqueue(id, taskId, dueAt, title, body, dual, stage = 'pending') {
    return run(`INSERT OR IGNORE INTO jobs(id, task_id, due_at, title, body, dual, stage)
      VALUES(?, ?, ?, ?, ?, ?, ?)`, id, taskId, dueAt, title, body, Number(dual), stage);
  }

  function badge() {
    return get(`SELECT (SELECT COUNT(*) FROM inbox WHERE read = 0 AND archived_at IS NULL) AS count, badge_revision AS revision
      FROM settings WHERE id = 1`);
  }

  function saveInbox(job, now) {
    const change = run('INSERT OR IGNORE INTO inbox(id, title, body, created_at) VALUES(?, ?, ?, ?)',
      job.id, job.title, job.body, now);
    if (change.changes) run('UPDATE settings SET badge_revision = badge_revision + 1 WHERE id = 1');
  }

  function modelUsageState(key) {
    return JSON.parse(get('SELECT value FROM model_usage_state WHERE key = ?', key)?.value ?? 'null');
  }

  function saveModelUsageState(key, value) {
    run('INSERT INTO model_usage_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value));
  }

  function modelAlertSettings() {
    return modelUsageState('alerts') ?? { ...defaultModelAlerts };
  }

  function checkModelBalanceAlerts(balance, settings, now) {
    if (!settings.enabled) {
      saveModelUsageState('alerted', []);
      return;
    }
    if (!balance || now - balance.updatedAt > 10 * 60_000) return;
    const alerted = new Set(modelUsageState('alerted') ?? []);
    for (const { currency, total } of balance.accounts) {
      if (currency !== 'CNY' && currency !== 'USD') continue;
      if (balance.available !== false && total > settings[currency]) {
        alerted.delete(currency);
        continue;
      }
      if (alerted.has(currency)) continue;
      const id = 'model-balance:' + randomUUID();
      const title = 'DeepSeek 余额偏低';
      const value = new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(total);
      const body = '账户余额 ' + value + '（' + currency + '）。打开「设置 → OpenClaw 模型」查看。';
      enqueue(id, null, now, title, body, false, 'done');
      run("UPDATE jobs SET wechat = 'skipped', push = 'inbox_only', finished_at = ? WHERE id = ?", now, id);
      saveInbox({ id, title, body }, now);
      alerted.add(currency);
    }
    saveModelUsageState('alerted', [...alerted]);
  }

  function createPush(job, now) {
    saveInbox(job, now);
    run(`INSERT OR IGNORE INTO push_attempts(job_id, endpoint, status, next_at)
      SELECT ?, endpoint, 'pending', ? FROM subscriptions`, job.id, now);
    return pushStatus(job.id);
  }

  function pushStatus(jobId) {
    const counts = get(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
      COUNT(*) FILTER (WHERE status = 'pending') AS waiting
      FROM push_attempts WHERE job_id = ?`, jobId);
    if (!counts.total) return 'inbox_only';
    if (counts.waiting) return 'pending';
    return counts.accepted === counts.total ? 'accepted' : counts.accepted ? 'partial' : 'failed';
  }

  const inflight = (status) => status === 'pending' || status === 'sending';

  function startLevel(job, active, now) {
    for (const channel of active) {
      const status = channel === 'push' ? createPush(job, now) : 'pending';
      run(`UPDATE jobs SET ${channel} = ? WHERE id = ?`, status, job.id);
    }
  }

  function advance(id, now) {
    let job = get("SELECT * FROM jobs WHERE id = ? AND stage = 'active'", id);
    if (!job) return;
    const plan = JSON.parse(job.route_plan);
    let level = job.route_level;
    for (;;) {
      const statuses = plan.levels[level].map((channel) => job[channel]);
      if (statuses.some(inflight)) return;
      if (plan.levels[level + 1] && shouldDescend(statuses, plan.fallback)) {
        level++;
        run('UPDATE jobs SET route_level = ? WHERE id = ?', level, id);
        startLevel(job, plan.levels[level], now);
        job = get('SELECT * FROM jobs WHERE id = ?', id);
        continue;
      }
      if (plan.earlyPush && inflight(job.push)) return;
      if (!channels.some((channel) => wasAccepted(job[channel]))) saveInbox(job, now);
      run("UPDATE jobs SET stage = 'done', finished_at = ? WHERE id = ?", now, id);
      return;
    }
  }

  function beginRoute(job, policy, now) {
    const plan = jobPolicy(policy, job.dual);
    run(`UPDATE jobs SET stage = 'active', route_plan = ?, route_level = 0, wechat = 'skipped', qq = 'skipped', push = 'skipped',
      activated_at = COALESCE(activated_at, ?) WHERE id = ?`, JSON.stringify(plan), now, job.id);
    startLevel(job, plan.earlyPush ? [...plan.levels[0], 'push'] : plan.levels[0], now);
    advance(job.id, now);
  }

  function settleWechatTurn(turn, outcome, now) {
    run('UPDATE wechat_turns SET finished_at = ?, status = ? WHERE id = ?', now, outcome, turn.id);
    if (!['unknown', 'rejected'].includes(outcome)) return;
    const id = 'reply:' + turn.id;
    const original = turn.body.trim().slice(0, 140);
    enqueue(id, null, now, '微信回复反馈',
      '微信消息处理结果待核对。请先打开 ROSETTE 工作台查看对话和待办，再决定是否重试。' +
        (original ? '\n原消息：' + original : ''), false, 'feedback');
    const job = get('SELECT * FROM jobs WHERE id = ?', id);
    saveInbox(job, now);
    const policy = get('SELECT delivery_policy FROM settings WHERE id = 1').delivery_policy;
    const configured = policy ? JSON.parse(policy) : defaultPolicy;
    const levels = configured.levels.map((level) => level.filter((channel) => channel !== 'wechat')).filter((group) => group.length);
    if (levels.length) beginRoute(job, { levels, fallback: configured.fallback }, now);
    else run("UPDATE jobs SET stage = 'done', push = 'inbox_only', activated_at = ?, finished_at = ? WHERE id = ?", now, now, id);
    const detail = outcome === 'rejected' ? '微信拒收了本次回复' : '微信的最终回复暂缺或送达待确认';
    run('UPDATE jobs SET wechat = ?, detail = ? WHERE id = ?', outcome, detail, id);
  }

  const task = (id) => get(`SELECT ${taskColumns} FROM tasks WHERE id = ?`, id);

  function persistTask(input, now, reuse) {
    const { requestKey, ...fields } = input;
    const payload = requestKey ? JSON.stringify(fields) : null;
    const previous = requestKey && get('SELECT * FROM task_request_keys WHERE key = ?', requestKey);
    if (previous) {
      if (previous.payload !== payload) return { conflict: '这次请求的内容已变化，请重新发起操作。' };
      return task(previous.task_id);
    }
    if (requestKey && input.dueAt !== undefined && input.dueAt !== null && input.dueAt <= now) {
      return { invalid: '请选择一个带时区的未来时间。' };
    }
    const remember = (task) => {
      if (requestKey) run('INSERT INTO task_request_keys(key, payload, task_id) VALUES(?, ?, ?)', requestKey, payload, task.id);
      return task;
    };
    if (reuse) return remember(reuse);
    const existing = input.id && task(input.id);
    if (input.id && !existing) return null;
    const id = existing?.id ?? randomUUID();
    const completed = Number(input.completed ?? Boolean(existing?.completed));
    const archivedAt = input.archived === true ? existing?.archivedAt ?? now :
      input.archived === false ? null : existing?.archivedAt ?? null;
    const title = input.title ?? existing?.title;
    let dueAt = Object.hasOwn(input, 'dueAt') ? input.dueAt : existing?.dueAt ?? null;
    const repeat = input.repeat ?? existing?.repeat ?? 'once';
    const period = repetition[repeat];
    const repeatUntil = period ? (Object.hasOwn(input, 'repeatUntil') ? input.repeatUntil : existing?.repeatUntil ?? null) : null;
    if (!period && input.repeatUntil) return { invalid: '请为截止日期选择每天或每周重复。' };
    if (repeatUntil && dueAt !== null && shanghaiTime(dueAt).slice(0, 10) > repeatUntil) {
      return { invalid: '截止日期应在首次提醒当天或之后。' };
    }
    const ended = existing?.repeatUntil && existing.dueAt === null && dueAt === null &&
      repeatUntil === existing.repeatUntil && repeat === existing.repeat && !Object.hasOwn(input, 'dueAt');
    if (period && dueAt === null && !ended) return { invalid: '周期提醒需要设置时间。' };
    if (period && dueAt !== null && dueAt <= now && !completed && archivedAt === null) {
      dueAt += period * (1 + Math.floor((now - dueAt) / period));
      if (repeatUntil && shanghaiTime(dueAt).slice(0, 10) > repeatUntil) dueAt = null;
    }
    const dual = Number(input.dual ?? Boolean(existing?.dual));
    const version = (existing?.version ?? 0) + 1;
    if (existing && title === existing.title && dueAt === existing.dueAt &&
      dual === existing.dual && completed === existing.completed && repeat === existing.repeat &&
      repeatUntil === existing.repeatUntil && archivedAt === existing.archivedAt) return remember(existing);
    if (existing) {
      run('UPDATE tasks SET title = ?, due_at = ?, dual = ?, completed = ?, version = ?, repeat = ?, repeat_until = ?, archived_at = ? WHERE id = ?',
        title, dueAt, dual, completed, version, repeat, repeatUntil, archivedAt, id);
      run(`UPDATE jobs SET stage = 'done', wechat = 'cancelled', push = 'skipped', finished_at = ?
        WHERE task_id = ? AND stage = 'pending'`, now, id);
    } else {
      run('INSERT INTO tasks(id, title, due_at, dual, completed, version, created_at, repeat, repeat_until) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, title, dueAt, dual, completed, version, now, repeat, repeatUntil);
    }
    if (dueAt !== null && dueAt > now && !completed && archivedAt === null) {
      enqueue(`task:${id}:${version}`, id, dueAt, '待办提醒', title, dual);
    }
    return remember(task(id));
  }

  return {
    ...createConversationStore(db),
    close: () => db.close(),
    badge,
    modelUsageState,
    modelAlertSettings,
    saveModelAlertSettings(settings, now) {
      return transaction(() => {
        saveModelUsageState('alerts', settings);
        checkModelBalanceAlerts(modelUsageState('balance'), settings, now);
        return settings;
      });
    },
    saveModelBalance(balance, now) {
      transaction(() => {
        if (balance.updatedAt < (modelUsageState('balance')?.updatedAt ?? 0)) return;
        saveModelUsageState('balance', balance);
        checkModelBalanceAlerts(balance, modelAlertSettings(), now);
      });
    },
    saveModelUsage(rows, { startDate, endDate, updatedAt }) {
      transaction(() => {
        const upsert = db.prepare(`INSERT INTO model_usage_daily(date, session_key, channel, totals, models)
          VALUES(?, ?, ?, ?, ?) ON CONFLICT(date, session_key) DO UPDATE SET
          channel = excluded.channel, totals = excluded.totals, models = excluded.models`);
        for (const row of rows) upsert.run(row.date, row.sessionKey, row.channel, JSON.stringify(row.totals), JSON.stringify(row.models));
        const periods = [...(modelUsageState('coverage')?.periods ?? []), { startDate, endDate }]
          .sort((a, b) => a.startDate.localeCompare(b.startDate));
        const merged = [];
        for (const period of periods) {
          const previous = merged.at(-1);
          if (previous && period.startDate <= usageDate(Date.parse(previous.endDate), 1)) {
            if (period.endDate > previous.endDate) previous.endDate = period.endDate;
          } else {
            merged.push(period);
          }
        }
        saveModelUsageState('coverage', { startDate: merged[0].startDate, endDate, updatedAt, periods: merged });
      });
    },
    modelUsageDays(startDate, endDate) {
      return all('SELECT date, channel, totals, models FROM model_usage_daily WHERE date BETWEEN ? AND ?', startDate, endDate)
        .map((row) => ({ ...row, totals: JSON.parse(row.totals), models: JSON.parse(row.models) }));
    },
    startWechatTurn({ id, body, quote }, now) {
      return run('INSERT OR IGNORE INTO wechat_turns(id, body, received_at, quote_state, quote_body) VALUES(?, ?, ?, ?, ?)',
        id, body, now, quote?.state ?? null, quote?.body ?? null).changes !== 0;
    },
    advanceWechatTurn(id, phase) {
      run(`UPDATE wechat_turns SET status = ? WHERE id = ? AND finished_at IS NULL AND
        (status = 'received' OR (status = 'processing' AND ? = 'sending'))`, phase, id, phase);
    },
    recordWechatTurnStep(id, { key, label, state, at, details }, now) {
      run(`INSERT INTO wechat_turn_steps(turn_id, step_key, label, state, at, updated_at, details)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM wechat_turns WHERE id = ?)
        AND ((SELECT count(*) FROM wechat_turn_steps WHERE turn_id = ?) < 48
          OR EXISTS (SELECT 1 FROM wechat_turn_steps WHERE turn_id = ? AND step_key = ?))
        ON CONFLICT(turn_id, step_key) DO UPDATE SET
          at = min(wechat_turn_steps.at, excluded.at),
          state = CASE WHEN wechat_turn_steps.state = 'running' THEN excluded.state ELSE wechat_turn_steps.state END,
          updated_at = CASE WHEN wechat_turn_steps.state = 'running' AND excluded.state != 'running'
            THEN excluded.updated_at ELSE wechat_turn_steps.updated_at END,
          details = CASE WHEN excluded.state = 'running' THEN coalesce(wechat_turn_steps.details, excluded.details)
            ELSE coalesce(excluded.details, wechat_turn_steps.details) END`,
      id, key, label, state, at, now, details ? JSON.stringify(details) : null, id, id, id, key);
    },
    finishWechatTurn(id, outcome, now) {
      return transaction(() => {
        const turn = get('SELECT id, body FROM wechat_turns WHERE id = ? AND finished_at IS NULL', id);
        if (turn) settleWechatTurn(turn, outcome, now);
      });
    },
    listTasks: ({ archived = false, query = '' } = {}) => all(`SELECT ${taskColumns} FROM tasks
      WHERE (archived_at IS NOT NULL) = ? AND instr(lower(title), lower(?)) > 0
      ORDER BY completed, due_at IS NULL, due_at, created_at DESC`, Number(archived), query),
    saveTask: (input, now) => transaction(() => persistTask(input, now)),
    task,
    saveSchedule(entries, now, apply) {
      const process = () => entries.map(({ timeText, ...input }) => {
        const occurrence = { title: input.title, dueAt: timeText };
        if (input.dueAt <= now) return { ...occurrence, status: 'past' };
        const prior = input.requestKey && get('SELECT task_id FROM task_request_keys WHERE key = ?', input.requestKey);
        const existing = prior ? task(prior.task_id) : get(`SELECT ${taskColumns} FROM tasks
          WHERE title = ? AND due_at = ? AND repeat = 'once' AND completed = 0 AND archived_at IS NULL
          ORDER BY created_at, id LIMIT 1`, input.title, input.dueAt);
        if (prior && (!existing || existing.title !== input.title || existing.dueAt !== input.dueAt ||
          existing.repeat !== 'once' || existing.completed || existing.archivedAt !== null)) {
          return { ...occurrence, status: 'changed' };
        }
        if (!apply && !existing) return { ...occurrence, status: 'planned' };
        const saved = apply ? persistTask(input, now, existing) : existing;
        if (!saved?.id) throw Object.assign(new Error(saved?.conflict ?? saved?.invalid ?? '日程无法保存。'), { status: 409 });
        return { ...occurrence, status: existing ? 'existing' : 'created', taskId: saved.id, dual: Boolean(saved.dual) };
      });
      return apply ? transaction(process) : process();
    },
    taskIdForRequest(key) { return get('SELECT task_id AS id FROM task_request_keys WHERE key = ?', key)?.id; },
    inbox: (archived = false) => all(`SELECT ${alertColumns}, archived_at AS archivedAt FROM inbox
      WHERE (archived_at IS NOT NULL) = ? ORDER BY read, created_at DESC LIMIT 100`, Number(archived)),
    markRead(id) { return this.changeInbox('read', id).badge; },
    changeInbox(action, id, now = Date.now(), requestKey) {
      return transaction(() => {
        const previous = requestKey && get('SELECT * FROM inbox_request_keys WHERE key = ?', requestKey);
        if (previous) {
          if (previous.action !== action || previous.target !== id) return { conflict: true };
          return { changed: previous.changed, badge: badge() };
        }
        let result;
        if (action === 'archive') {
          result = run(`UPDATE inbox SET archived_at = ?, archive_key = ? WHERE archived_at IS NULL
            AND (? = 'all' OR id = ?)`, now, requestKey ?? randomUUID(), id, id);
        } else if (action === 'restore') {
          const key = id === 'latest' ? get(`SELECT archive_key AS key FROM inbox WHERE archived_at IS NOT NULL
            ORDER BY archived_at DESC, rowid DESC LIMIT 1`)?.key : null;
          result = run(`UPDATE inbox SET archived_at = NULL, archive_key = NULL WHERE archived_at IS NOT NULL
            AND (? = 'all' OR id = ? OR archive_key = ?)`, id, id, key ?? null);
        } else {
          const read = Number(action === 'read');
          result = run(`UPDATE inbox SET read = ? WHERE archived_at IS NULL AND read != ? AND (? = 'all' OR id = ?)`,
            read, read, id, id);
        }
        if (result.changes) run('UPDATE settings SET badge_revision = badge_revision + 1 WHERE id = 1');
        if (requestKey) run('INSERT INTO inbox_request_keys VALUES (?, ?, ?, ?)', requestKey, action, id, result.changes);
        return { changed: result.changes, badge: badge() };
      });
    },
    history: (taskId = null) => all(`SELECT id, task_id AS taskId, title, substr(body, 1, 85) AS preview,
      due_at AS dueAt, finished_at AS finishedAt, wechat, qq, push, detail, qq_detail AS qqDetail
      FROM jobs WHERE stage != 'pending' AND wechat != 'cancelled' AND (? IS NULL OR task_id = ?)
      ORDER BY due_at DESC LIMIT 25`, taskId, taskId),
    missedWechat(before, now) {
      return all(`SELECT id, title, substr(body, 1, 100) AS preview, due_at AS dueAt FROM jobs
        WHERE stage = 'done' AND (wechat IN ('rejected','unknown','failed') OR (wechat = 'skipped' AND detail = ?))
          AND wechat_followup_at IS NULL
          AND (task_id IS NOT NULL OR id LIKE 'daily:%') AND finished_at <= ? AND due_at >= ?
        ORDER BY due_at DESC LIMIT 3`, wechatDeferredDetail, before, now - 2 * 86_400_000);
    },
    isWechatDeferred(scope, lastInboundAt) {
      if (!scope) return false;
      const hold = get('SELECT inbound_at FROM wechat_delivery_holds WHERE scope = ?', scope);
      return Boolean(hold && (lastInboundAt ?? 0) <= hold.inbound_at);
    },
    deferScheduledWechat(scope, inboundAt) {
      run(`INSERT INTO wechat_delivery_holds(scope, inbound_at) VALUES(?, ?)
        ON CONFLICT(scope) DO UPDATE SET inbound_at = max(wechat_delivery_holds.inbound_at, excluded.inbound_at)`,
      scope, inboundAt);
    },
    scheduleWechatResume(scope, window, now) {
      if (!scope || !wechatResumeDue(window, now) || this.isWechatDeferred(scope, window.inboundAt)) return;
      const id = 'wechat-resume:' + scope + ':' + window.inboundAt;
      return transaction(() => {
        if (!enqueue(id, null, now, wechatResumeTitle, wechatResumeBody, false).changes) return;
        const policy = this.settings().policy;
        const backups = policy.levels.map((level) => level.filter((channel) => channel !== 'wechat')).filter((level) => level.length);
        beginRoute(get('SELECT * FROM jobs WHERE id = ?', id), { levels: [['wechat'], ...backups], fallback: policy.fallback }, now);
      });
    },
    cancelWechatResume(id, now) {
      run("UPDATE jobs SET stage = 'done', wechat = 'cancelled', qq = 'skipped', push = 'skipped', finished_at = ? WHERE id = ?", now, id);
      run("UPDATE push_attempts SET status = 'cancelled' WHERE job_id = ? AND status = 'pending'", id);
    },
    markWechatFollowup(ids, now) {
      transaction(() => {
        for (const id of ids) run('UPDATE jobs SET wechat_followup_at = ? WHERE id = ? AND wechat_followup_at IS NULL', now, id);
      });
    },
    settings() {
      const { delivery_policy, token_saving, ...settings } = get(
        'SELECT daily, dual, delivery_policy, token_saving FROM settings WHERE id = 1');
      return { ...settings, tokenSaving: Boolean(token_saving), policy: delivery_policy ? JSON.parse(delivery_policy) : defaultPolicy };
    },
    tokenSaving() {
      return Boolean(get('SELECT token_saving FROM settings WHERE id = 1').token_saving);
    },
    saveTokenSaving(enabled) {
      run('UPDATE settings SET token_saving = ? WHERE id = 1', Number(enabled));
    },
    saveSettings(daily, dual) {
      run('UPDATE settings SET daily = ?, dual = ? WHERE id = 1', daily, Number(dual));
      return this.settings();
    },
    savePolicy(policy) {
      if (!validPolicy(policy)) throw new Error('投递策略无效。');
      run('UPDATE settings SET delivery_policy = ? WHERE id = 1', JSON.stringify(policy));
      return this.settings().policy;
    },
    scheduleDaily(now) {
      const settings = this.settings();
      const local = shanghaiTime(now);
      if (!settings.daily || local.slice(11, 16) < settings.daily) return;
      const id = 'daily:' + local.slice(0, 10);
      if (get('SELECT id FROM jobs WHERE id = ?', id)) return;
      const total = get('SELECT COUNT(*) AS total FROM tasks WHERE completed = 0 AND archived_at IS NULL').total;
      const pending = all(`SELECT title, due_at AS dueAt FROM tasks WHERE completed = 0 AND archived_at IS NULL
        ORDER BY due_at IS NULL, due_at, created_at LIMIT 5`);
      const endOfDay = Date.parse(local.slice(0, 10) + 'T23:59:59+08:00');
      const counts = get(`SELECT COUNT(*) FILTER (WHERE due_at < ?) AS late,
        COUNT(*) FILTER (WHERE due_at >= ? AND due_at <= ?) AS today,
        COUNT(*) FILTER (WHERE due_at > ?) AS upcoming,
        COUNT(*) FILTER (WHERE due_at IS NULL) AS unscheduled FROM tasks WHERE completed = 0 AND archived_at IS NULL`, now, now, endOfDay, endOfDay);
      const summary = pending.map((task) => {
        const prefix = task.dueAt === null ? '待安排' : task.dueAt < now ? '逾期' : formatTime(task.dueAt).slice(5);
        return '• [' + prefix + '] ' + Array.from(task.title).slice(0, 48).join('');
      }).join('\n');
      const body = total ? `还有 ${total} 项待办 · 逾期 ${counts.late} · 今日 ${counts.today} · 后续 ${counts.upcoming} · 待安排 ${counts.unscheduled}\n${summary}${total > pending.length ? '\n更多待办请打开网页查看。' : ''}`
        : '今天的待办全部完成。';
      enqueue(id, null, Date.parse(local.slice(0, 10) + 'T' + settings.daily + ':00+08:00'),
        '每日待办总结', body, settings.dual);
    },
    subscribe(subscription) {
      run(`INSERT INTO subscriptions(endpoint, config) VALUES(?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET config = excluded.config`, subscription.endpoint, JSON.stringify(subscription));
    },
    unsubscribe(endpoint) {
      run('DELETE FROM subscriptions WHERE endpoint = ?', endpoint);
    },
    subscriptionCount: () => get('SELECT COUNT(*) AS count FROM subscriptions').count,
    testPush(now, testQQ = false, requestKey) {
      return transaction(() => {
        const id = 'test:' + (requestKey ?? randomUUID());
        if (get('SELECT id FROM jobs WHERE id = ?', id)) return id;
        enqueue(id, null, now, testQQ ? '备用渠道测试' : '手机通知测试',
          testQQ ? '模拟微信拒收，验证 QQ、Web Push 和主屏幕角标。' : '这条通知用于验证 Web Push 和主屏幕角标。', true, 'test');
        if (testQQ) run("UPDATE jobs SET wechat = 'rejected', detail = '手动测试：模拟拒收', qq = 'pending' WHERE id = ?", id);
        else run("UPDATE jobs SET wechat = 'skipped' WHERE id = ?", id);
        const status = createPush(get('SELECT * FROM jobs WHERE id = ?', id), now);
        run('UPDATE jobs SET stage = ?, push = ?, finished_at = ? WHERE id = ?',
          status === 'pending' ? 'push' : 'done', status, status === 'pending' ? null : now, id);
        return id;
      });
    },
    activateDue(now) {
      transaction(() => {
        for (const turn of all('SELECT id, body FROM wechat_turns WHERE finished_at IS NULL AND received_at <= ? LIMIT 32', now - 120_000)) {
          settleWechatTurn(turn, 'unknown', now);
        }
        const policy = this.settings().policy;
        for (const job of all("SELECT * FROM jobs WHERE stage = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 32", now)) {
          beginRoute(job, policy, now);
          const task = job.task_id ? this.task(job.task_id) : null;
          const period = repetition[task?.repeat];
          if (period && !task.completed && task.archivedAt === null) {
            const next = job.due_at + period * (1 + Math.floor((now - job.due_at) / period));
            const nextDue = task.repeatUntil && shanghaiTime(next).slice(0, 10) > task.repeatUntil ? null : next;
            run('UPDATE tasks SET due_at = ? WHERE id = ?', nextDue, task.id);
            if (nextDue !== null) enqueue(`task:${task.id}:${task.version}:${nextDue}`, task.id, nextDue, '待办提醒', task.title, task.dual);
          }
        }
      });
    },
    recoverDelivery(now) {
      transaction(() => {
        for (const job of all("SELECT * FROM jobs WHERE stage = 'wechat_sending'")) {
          beginRoute(job, defaultPolicy, now);
          run("UPDATE jobs SET wechat = 'unknown', detail = '微信发送期间服务重启' WHERE id = ?", job.id);
          advance(job.id, now);
        }
        for (const job of all("SELECT id, wechat, qq FROM jobs WHERE wechat = 'sending' OR qq = 'sending'")) {
          if (job.wechat === 'sending') run("UPDATE jobs SET wechat = 'unknown', detail = '微信发送期间服务重启' WHERE id = ?", job.id);
          if (job.qq === 'sending') run("UPDATE jobs SET qq = 'unknown', qq_detail = 'QQ 发送期间服务重启' WHERE id = ?", job.id);
          advance(job.id, now);
        }
      });
    },
    claimChannel(channel) {
      if (channel !== 'wechat' && channel !== 'qq') throw new Error('无效聊天渠道。');
      const stage = channel === 'wechat' ? "stage = 'active'" : "stage IN ('active', 'push', 'done')";
      return get(`UPDATE jobs SET ${channel} = 'sending' WHERE id = (
        SELECT id FROM jobs WHERE ${channel} = 'pending' AND ${stage}
        ORDER BY (id LIKE 'wechat-resume:%') DESC, due_at LIMIT 1) RETURNING *`);
    },
    claimWechatBatch() {
      return transaction(() => {
        const first = this.claimChannel('wechat');
        if (!first) return [];
        if (!first.task_id) return [first];
        const rest = all(`SELECT * FROM jobs WHERE wechat = 'pending' AND stage = 'active'
          AND task_id IS NOT NULL AND due_at = ? AND route_plan = ? AND route_level = ?
          ORDER BY id LIMIT 9`, first.due_at, first.route_plan, first.route_level);
        for (const job of rest) run("UPDATE jobs SET wechat = 'sending' WHERE id = ?", job.id);
        return [first, ...rest];
      });
    },
    finishChannel(channel, job, result, now) {
      this.finishBatch(channel, [job], result, now);
    },
    finishBatch(channel, jobs, result, now, hold) {
      if (channel !== 'wechat' && channel !== 'qq') throw new Error('无效聊天渠道。');
      const detail = channel === 'wechat' ? 'detail' : 'qq_detail';
      transaction(() => {
        if (hold) this.deferScheduledWechat(hold.scope, hold.inboundAt);
        for (const job of jobs) {
          run(`UPDATE jobs SET ${channel} = ?, ${detail} = ? WHERE id = ?`, result.status, result.detail ?? null, job.id);
          advance(job.id, now);
        }
      });
    },
    nextPush(now) {
      return get(`SELECT attempt.*, subscriptions.config, jobs.title, jobs.body, jobs.route_plan, jobs.route_level
        FROM push_attempts AS attempt
        JOIN jobs ON jobs.id = attempt.job_id
        LEFT JOIN subscriptions ON subscriptions.endpoint = attempt.endpoint
        WHERE attempt.status = 'pending' AND attempt.next_at <= ?
        ORDER BY attempt.next_at, attempt.job_id LIMIT 1`, now);
    },
    finishPush(target, result, now) {
      transaction(() => {
        const delays = [60_000, 300_000, 900_000];
        const plan = target.route_plan && JSON.parse(target.route_plan);
        const handoff = plan?.levels[target.route_level + 1] && plan.levels[target.route_level].includes('push');
        const delay = result === 'retry' && !(handoff && plan.fallback === 'unaccepted') ? delays[target.attempts] : undefined;
        const status = delay ? 'pending' : result === 'retry' ? 'unknown' : result;
        run('UPDATE push_attempts SET attempts = attempts + 1, status = ?, next_at = ? WHERE job_id = ? AND endpoint = ?',
          status, now + (delay ?? 0), target.job_id, target.endpoint);
        if (status === 'expired') this.unsubscribe(target.endpoint);
        const outcome = pushStatus(target.job_id);
        if (outcome === 'failed' && get("SELECT 1 FROM push_attempts WHERE job_id = ? AND status = 'unknown'", target.job_id)) {
          run("UPDATE jobs SET push = 'unknown' WHERE id = ?", target.job_id);
        } else {
          run('UPDATE jobs SET push = ? WHERE id = ?', outcome, target.job_id);
        }
        run("UPDATE jobs SET stage = 'done', finished_at = ? WHERE id = ? AND stage = 'push' AND push != 'pending'", now, target.job_id);
        advance(target.job_id, now);
      });
    }
  };
}
