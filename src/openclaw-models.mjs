import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const validRef = (value) => typeof value === 'string' && /^[\w.-]+\/[\w./:@+-]+$/.test(value) && value.length <= 180;
const validProvider = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,79}$/.test(value);
const providerOf = (id) => id.split('/', 1)[0].toLowerCase();
const primary = (model) => typeof model === 'string' ? model : model?.primary;
const fault = (status, message) => Object.assign(new Error(message), { status });

export function createGatewayRPC({ bin, entry }) {
  return async (method, params = {}) => {
    const args = ['gateway', 'call', method, '--json', '--timeout', '12000', '--params', JSON.stringify(params)];
    const { stdout } = await execute(entry ? process.execPath : bin, entry ? [entry, ...args] : args,
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  };
}

function resolve(config, session) {
  const agents = config?.agents;
  const agentId = session?.agentId ?? agents?.list?.find((agent) => agent.default)?.id ?? 'main';
  const entry = agents?.entries?.[agentId];
  const agent = entry ?? agents?.list?.find((agent) => agent.id === agentId);
  const configured = primary(agent?.model) ?? primary(agents?.defaults?.model);
  const configuredModel = validRef(configured) ? configured : null;
  const pinned = session?.modelSource === 'session' && validRef(session.model);
  const current = pinned ? session.model : configuredModel ?? (validRef(session?.model) ? session.model : null);
  const provider = current ? providerOf(current) : null;
  const allow = agent?.modelPolicy?.allow ?? (agents?.defaults?.models ? Object.keys(agents.defaults.models) : []);
  return { current, provider, configuredModel, pinned, agentId, agent, entry, allow };
}

function visibleSelection(selection) {
  const { current, provider, configuredModel, pinned } = selection;
  return { current, provider, configuredModel, pinned };
}

function allowsModel(id, patterns) {
  return !patterns.length || patterns.some((pattern) => {
    if (pattern === id) return true;
    if (typeof pattern !== 'string' || !pattern.includes('*')) return false;
    const escaped = pattern.split('*').map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')).join('.*');
    return new RegExp('^' + escaped + '$', 'i').test(id);
  });
}

function choicesFromCatalog(catalog, selection) {
  const { allow } = selection;
  const models = new Map();
  for (const item of catalog?.models ?? []) {
    if (!validProvider(item.provider) || typeof item.id !== 'string') continue;
    const id = item.provider + '/' + item.id;
    if (item.available !== true || !validRef(id)) continue;
    if (!allowsModel(id, allow)) continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 120) : '';
    models.set(id, { id, name: name || id, ...(item.recommended === true && { recommended: true }) });
  }
  return [...models.values()].sort((a, b) => Number(b.id === selection.current) - Number(a.id === selection.current));
}

function selectionResult(selection, choices, status = 'ready') {
  const ids = new Set(choices.map(({ id }) => providerOf(id)));
  const providers = [...ids].map((id) => ({ id, status: 'ready' }));
  return { ...visibleSelection(selection), choices, providers, status };
}

export function createOpenClawModels({ call, readConfig, readSession, now = Date.now }) {
  let catalog;
  let catalogAgent;
  let catalogAt = -Infinity;
  let pending;
  let mutating = false;
  const selection = (fresh = false) => resolve(readConfig(), readSession(now(), { fresh }));
  const isDeepSeek = () => selection().provider === 'deepseek';
  async function getCatalog(agentId, fresh) {
    if (!fresh && catalogAgent === agentId && now() - catalogAt < 60_000) return catalog;
    if (pending?.agentId === agentId) return pending.work;
    const work = (async () => {
      const result = await call('models.list', { agentId, preparedOnly: true });
      if (!Array.isArray(result?.models)) throw new Error('Model catalog unavailable');
      catalog = result;
      catalogAgent = agentId;
      catalogAt = now();
      return catalog;
    })();
    pending = { agentId, work };
    try { return await work; }
    finally { if (pending?.work === work) pending = undefined; }
  }

  async function get({ refresh = false } = {}) {
    const model = selection(refresh);
    if (!call) return selectionResult(model, [], 'unavailable');
    try {
      const inventory = await getCatalog(model.agentId, refresh);
      return selectionResult(model, choicesFromCatalog(inventory, model));
    } catch {
      return selectionResult(model, [], 'unavailable');
    }
  }

  async function set(model, provider) {
    if (provider === undefined ? !validRef(model) : model !== undefined || !validProvider(provider)) {
      throw fault(400, '请选择有效的 OpenClaw 供应商或模型。');
    }
    if (!call) throw fault(503, 'OpenClaw 网关暂不可用。');
    if (mutating) throw fault(409, '正在应用 OpenClaw 模型设置，请稍后再试。');
    mutating = true;
    try {
      const session = readSession(now(), { fresh: true });
      const snapshot = await call('config.get');
      if (!snapshot?.valid || typeof snapshot.hash !== 'string' || !snapshot.config) {
        throw fault(503, '网关配置暂不可用，请稍后再试。');
      }
      const previous = resolve(snapshot.config, session);
      const inventory = await getCatalog(previous.agentId, true);
      const choices = choicesFromCatalog(inventory, previous);
      if (provider !== undefined) {
        const matches = choices.filter((choice) => providerOf(choice.id) === provider);
        model = matches.find((choice) => choice.id === previous.current)?.id ??
          matches.find((choice) => choice.id === previous.configuredModel)?.id ??
          matches.find((choice) => choice.recommended)?.id ?? matches[0]?.id;
        if (!model) throw fault(409, '该供应商暂无可用模型，请检查 OpenClaw 授权和模型权限。');
      } else if (!choices.some((choice) => choice.id === model)) {
        throw fault(409, '这个模型当前不可选，请刷新模型列表。');
      }
      if (previous.configuredModel !== model) {
        const next = { primary: model };
        const agents = previous.agent?.model !== undefined ? previous.entry
          ? { entries: { [previous.agentId]: { model: next } } }
          : { list: [{ id: previous.agentId, model: next }] }
          : { defaults: { model: next } };
        const result = await call('config.patch', {
          baseHash: snapshot.hash, raw: JSON.stringify({ agents }), response: 'summary', note: 'ROSETTE model selection'
        });
        if (result?.ok !== true) throw fault(503, '网关未确认模型更改，请刷新状态。');
      }
      if (session?.sessionKey && previous.pinned) {
        const patch = { key: session.sessionKey, agentId: session.agentId, expectedSessionId: session.sessionId, model: null };
        for (const retry of [false, true]) {
          try {
            await call('sessions.patch', patch);
            break;
          } catch {
            const current = selection(true);
            if (!current.pinned) break;
            if (retry) return { ...selectionResult(current, choices), sessionPending: true };
            await delay(1200);
          }
        }
      }
      const current = selection(true);
      return { ...selectionResult(current, choices),
        ...(session && current.pinned && current.current !== model ? { sessionPending: true } : {}) };
    } catch (error) {
      if (error.status) throw error;
      throw fault(503, '网关暂未确认模型更改，请刷新状态后重试。');
    } finally {
      mutating = false;
    }
  }

  return { get, set, isDeepSeek };
}
