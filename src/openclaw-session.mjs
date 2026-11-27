import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const wechatChannels = new Set(['openclaw-weixin', 'weixin']);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 250) : null;
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const primary = (value) => text(typeof value === 'string' ? value : value?.primary);
const withProvider = (model, provider) => {
  const name = text(model);
  return name && !name.includes('/') && text(provider) ? provider + '/' + name : name;
};

export function readOpenClawConfig(stateDir) {
  if (!stateDir) return null;
  try { return JSON.parse(readFileSync(join(stateDir, 'openclaw.json'), 'utf8')); }
  catch { return null; }
}

function matchesWechat(entry, account, recipient) {
  const delivery = entry.delivery;
  return [
    delivery?.context, entry.deliveryContext,
    { channel: delivery?.route?.channel, accountId: delivery?.route?.accountId, to: delivery?.route?.target?.to },
    { channel: delivery?.origin?.provider, accountId: delivery?.origin?.accountId, to: delivery?.origin?.from },
    { channel: entry.origin?.provider, accountId: entry.origin?.accountId, to: entry.origin?.from }
  ].some((route) => wechatChannels.has(route?.channel) && route.accountId === account &&
    typeof route.to === 'string' && route.to.replace(/^(?:openclaw-weixin|weixin):/, '') === recipient);
}

function readAgentSession(agents, agentId, account, recipient) {
  const file = join(agents, agentId, 'agent', 'openclaw-agent.sqlite');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 200 });
  try {
    const rows = db.prepare(`SELECT n.session_key AS key, n.current_session_id AS id, n.entry_json AS entryJson,
      n.label, n.display_name AS displayName, n.last_interaction_at AS interactionAt, n.session_started_at AS startedAt,
      w.model, w.model_provider AS provider
      FROM session_nodes n JOIN session_windows w ON w.session_id = n.current_session_id
      WHERE w.channel IN ('openclaw-weixin','weixin') AND w.account_id = ? AND w.chat_type = 'direct' AND n.archived_at IS NULL
      ORDER BY n.last_interaction_at DESC, n.updated_at DESC`).iterate(account);
    for (const row of rows) {
      const entry = JSON.parse(row.entryJson ?? '{}');
      if (matchesWechat(entry, account, recipient)) return { ...row, entry, agentId };
    }
    return null;
  } finally {
    db.close();
  }
}

export function createOpenClawSessionReader(stateDir, account, recipient) {
  if (!stateDir || !account || !recipient) return () => null;
  let lastCheck = -Infinity;
  let cached = null;
  const agents = join(stateDir, 'agents');
  return (now = Date.now(), { fresh = false } = {}) => {
    if (!fresh && now - lastCheck < 5000) return cached;
    lastCheck = now;
    try {
      const config = readOpenClawConfig(stateDir);
      if (!config) return cached = null;
      let active = null;
      for (const directory of readdirSync(agents, { withFileTypes: true })) {
        if (!directory.isDirectory() || !/^[\w-]+$/.test(directory.name)) continue;
        const session = readAgentSession(agents, directory.name, account, recipient);
        if (session && (!active || (session.interactionAt ?? 0) > (active.interactionAt ?? 0))) active = session;
      }
      if (!active) return cached = null;
      const { entry, agentId } = active;
      const agent = config.agents?.entries?.[agentId] ?? config.agents?.list?.find((item) => item?.id === agentId);
      const configured = primary(agent?.model) ?? primary(config.agents?.defaults?.model);
      const lastUsed = withProvider(entry.model ?? active.model, entry.modelProvider ?? active.provider);
      const override = withProvider(entry.modelOverride, entry.providerOverride ?? configured?.split('/')[0]);
      const mainKey = config.session?.mainKey ?? 'main';
      cached = {
        label: text(active.label) ?? text(active.displayName) ?? (active.key === `agent:${agentId}:${mainKey}` ? '主会话' : '私聊会话'),
        agentId, sessionKey: active.key, sessionId: active.id,
        model: override ?? configured ?? lastUsed,
        modelSource: override ? 'session' : configured ? 'default' : lastUsed ? 'last_used' : null,
        lastUsed,
        startedAt: positive(active.startedAt),
        lastInteractionAt: positive(active.interactionAt),
        contextTokens: positive(entry.contextTokens),
        lastContextTokens: entry.totalTokensFresh === true ? positive(entry.totalTokens) : null
      };
    } catch {
      cached = null;
    }
    return cached;
  };
}
