import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const wechatQuietMs = 12 * 3_600_000;
export const wechatResumeAfter = 9;
export const wechatResumeTitle = '微信通道提醒';
export const wechatResumeBody = '请在这个聊天窗发「继续」，刷新微信提醒通道。';
export const wechatResumeWaiting = 'reminder: waiting for a new WeChat message';
export const wechatResumeObsolete = 'reminder: WeChat resume notice is no longer due';
const resumeText = wechatResumeTitle + '\n' + wechatResumeBody;

export function readWechatWindow(stateDir, account, recipient) {
  if (!stateDir || !account || !recipient) return null;
  let archive, ledger;
  try {
    const file = join(stateDir, 'openclaw-weixin', 'ref-messages.sqlite');
    if (!existsSync(file)) return null;
    archive = new DatabaseSync(file, { readOnly: true, timeout: 300 });
    const current = archive.prepare(`WITH inbound AS (
      SELECT max(created_at) AS inbound_at FROM quote_messages
      WHERE account_id = ? AND conversation_id = ? AND direction = 'inbound'
    )
    SELECT inbound_at,
      (SELECT count(*) FROM quote_messages WHERE account_id = ? AND conversation_id = ?
        AND direction = 'outbound' AND created_at >= inbound_at) AS sent,
      (SELECT count(*) FROM quote_messages WHERE account_id = ? AND conversation_id = ?
        AND direction = 'outbound' AND created_at >= inbound_at AND body = ?) AS notices
    FROM inbound`).get(account, recipient, account, recipient, account, recipient, resumeText);
    if (!Number.isSafeInteger(current.inbound_at) || current.inbound_at <= 0) return null;
    const ledgerPath = join(stateDir, 'openclaw-weixin', 'reminder-outbound.sqlite');
    if (existsSync(ledgerPath)) {
      ledger = new DatabaseSync(ledgerPath, { readOnly: true, timeout: 300 });
      const saved = ledger.prepare('SELECT sent, notice FROM windows WHERE account = ? AND recipient = ? AND inbound_at = ?')
        .get(account, recipient, current.inbound_at);
      if (saved) return { inboundAt: current.inbound_at, sent: Math.max(current.sent, saved.sent), notice: Boolean(saved.notice || current.notices) };
    }
    return { inboundAt: current.inbound_at, sent: current.sent, notice: current.notices > 0 };
  } catch {
    return null;
  } finally {
    ledger?.close();
    archive?.close();
  }
}

export function wechatResumeDue(window, now) {
  return Boolean(window && window.inboundAt <= now && !window.notice &&
    (window.sent >= wechatResumeAfter || now - window.inboundAt >= wechatQuietMs));
}

function configuredRecipient(stateDir, account, recipient) {
  if (!stateDir || !account || !recipient) return false;
  try {
    const config = JSON.parse(readFileSync(join(stateDir, 'openclaw.json'), 'utf8'));
    const binding = config.plugins?.entries?.['reminder-desk']?.config;
    return binding?.wechatAccount === account &&
      binding.wechatSender?.replace(/^(?:openclaw-weixin:|weixin:)/, '') === recipient;
  } catch {
    return false;
  }
}

export function createWechatResumeSender(send, { stateDir = process.env.OPENCLAW_STATE_DIR, now = Date.now } = {}) {
  const pending = new Map();
  const record = (account, recipient, current, sent, notice) => {
    const ledger = new DatabaseSync(join(stateDir, 'openclaw-weixin', 'reminder-outbound.sqlite'), { timeout: 500 });
    try {
      ledger.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS windows (
          account TEXT NOT NULL, recipient TEXT NOT NULL, inbound_at INTEGER NOT NULL,
          sent INTEGER NOT NULL, notice INTEGER NOT NULL, PRIMARY KEY(account, recipient)
        );`);
      ledger.prepare(`INSERT INTO windows(account, recipient, inbound_at, sent, notice) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(account, recipient) DO UPDATE SET inbound_at = excluded.inbound_at, sent = excluded.sent, notice = excluded.notice
        WHERE windows.inbound_at <= excluded.inbound_at`).run(account, recipient, current.inboundAt, sent, Number(notice));
    } finally {
      ledger.close();
    }
  };

  return async (params, account) => {
    const message = params.body?.msg;
    const recipient = message?.to_user_id;
    if (!configuredRecipient(stateDir, account, recipient)) return send(params);
    const key = JSON.stringify([account, recipient]);
    const previous = pending.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const current = readWechatWindow(stateDir, account, recipient);
      const notice = message.item_list?.length === 1 && message.item_list[0].text_item?.text === resumeText;
      if (notice && !wechatResumeDue(current, now())) throw new Error(wechatResumeObsolete);
      if (current && (notice ? current.sent > wechatResumeAfter
        : current.sent >= wechatResumeAfter || wechatResumeDue(current, now()))) {
        throw new Error(wechatResumeWaiting);
      }
      if (notice) record(account, recipient, current, current.sent, true);
      const result = await send(params);
      if (current) record(account, recipient, current, current.sent + 1, current.notice || notice);
      return result;
    });
    pending.set(key, work);
    try {
      return await work;
    } finally {
      if (pending.get(key) === work) pending.delete(key);
    }
  };
}
