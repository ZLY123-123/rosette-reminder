import { createHash } from 'node:crypto';
import { readDeepSeekSessionCosts } from './deepseek-pricing.mjs';

const dayMs = 86_400_000;
const balanceInterval = 5 * 60_000;
const usageInterval = 15 * 60_000;
const retryInterval = 60_000;
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'totalCost', 'missingCostEntries'];
const counters = [...fields, 'count', 'costCny'];
export const defaultModelAlerts = { enabled: false, CNY: 5, USD: 1 };

export function usageDate(timestamp, offset = 0) {
  return new Date(timestamp + 8 * 3_600_000 + offset * dayMs).toISOString().slice(0, 10);
}

const amount = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const label = (value) => typeof value === 'string' && /^[\w./:-]{1,100}$/.test(value) ? value : '';
const dateInRange = (date, start, end) => typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(date) && start <= date && date <= end;

export function modelStepDetails(value) {
  if (value?.kind === 'context' && value.mode === 'token-saving') {
    return { kind: 'context', mode: 'token-saving' };
  }
  if (!['model', 'model_usage'].includes(value?.kind)) return null;
  const provider = label(value.provider);
  const model = label(value.model);
  if (!provider || !model) return null;
  const details = { kind: value.kind, provider, model };
  if (value.kind === 'model') {
    if (Number.isSafeInteger(value.durationMs) && value.durationMs >= 0) details.durationMs = value.durationMs;
    if (label(value.errorCategory)) details.errorCategory = value.errorCategory;
  } else {
    const usage = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      if (Number.isSafeInteger(value.usage?.[key]) && value.usage[key] >= 0) usage[key] = value.usage[key];
    }
    if (!Object.keys(usage).length) return null;
    details.usage = usage;
  }
  return details;
}

function readBalance(report) {
  const provider = report?.providers?.find((row) => row.provider === 'deepseek');
  if (!provider || provider.error) return null;
  const accounts = [];
  // The built-in report has numeric totals and a stable, rounded display summary for the breakdown.
  const parts = typeof provider.summary === 'string' ? provider.summary.split(' · ') : [];
  let group;
  const breakdown = new Map();
  for (const part of parts) {
    const match = /^(Balance|Granted|Topped up) ([¥$])(-?\d+\.\d{2})$/.exec(part);
    if (!match) continue;
    const [, field, symbol, value] = match;
    const currency = symbol === '¥' ? 'CNY' : 'USD';
    if (field === 'Balance') {
      group = { currency, total: Number(value), granted: 0 };
      breakdown.set(currency, group);
    } else if (group?.currency === currency) {
      if (field === 'Granted') group.granted = Number(value);
      else group.toppedUp = Number(value);
    }
  }
  for (const item of Array.isArray(provider.billing) ? provider.billing : []) {
    const currency = item.unit === 'RMB' ? 'CNY' : label(item.unit);
    if (item.type !== 'balance' || !currency || !Number.isFinite(item.amount)) continue;
    const detail = breakdown.get(currency);
    accounts.push({ currency, total: item.amount, ...(detail ? { granted: detail.granted,
      toppedUp: detail.toppedUp ?? Math.max(0, item.amount - detail.granted) } : {}) });
    breakdown.delete(currency);
  }
  for (const detail of breakdown.values()) if (detail.total < 0) accounts.push(detail);
  if (!accounts.length) return null;
  return { available: provider.plan !== 'Unavailable', accounts };
}

function usageRows(report, start, end, stateDir) {
  const rows = [];
  if (!Array.isArray(report?.sessions) || report.startDate !== start || report.endDate !== end) return null;
  if (report.cacheStatus && report.cacheStatus.status !== 'fresh') return null;
  if (report.sessions.length >= 1000 || report.sessions.some((session) => session.computing)) return null;
  for (const session of report.sessions) {
    const usage = session.usage;
    if (!Array.isArray(usage?.dailyBreakdown)) continue;
    const id = usage.sessionId ?? session.sessionId;
    if (typeof id !== 'string' || !id) continue;
    const sessionKey = createHash('sha256').update(JSON.stringify([session.agentId, id])).digest('hex');
    const channel = label(session.channel) || 'other';
    const dailyModels = Array.isArray(usage.dailyModelUsage) ? usage.dailyModelUsage : [];
    const prices = dailyModels.some((model) => model.provider === 'deepseek')
      ? readDeepSeekSessionCosts(stateDir, session.agentId, id, start, end) : new Map();
    const modelsByDate = new Map();
    for (const model of dailyModels) {
      if (!dateInRange(model.date, start, end)) continue;
      const provider = label(model.provider);
      const name = label(model.model);
      if (!provider || !name) continue;
      if (!modelsByDate.has(model.date)) modelsByDate.set(model.date, []);
      const item = { provider, model: name, totalTokens: amount(model.tokens),
        totalCost: amount(model.cost), count: amount(model.count) };
      const price = provider === 'deepseek' && prices.get(`${model.date}/${name}`);
      if (price && price.tokens === item.totalTokens && price.count === item.count) item.costCny = price.total;
      modelsByDate.get(model.date).push(item);
    }
    for (const day of usage.dailyBreakdown) {
      if (!dateInRange(day.date, start, end)) continue;
      const totals = Object.fromEntries(fields.map((key) => [key, amount(day[key])]));
      rows.push({ date: day.date, sessionKey, channel, totals, models: modelsByDate.get(day.date) ?? [] });
    }
  }
  return rows;
}

function accumulate(target, row) {
  for (const key of counters) {
    if (Object.hasOwn(row, key)) target[key] = (target[key] ?? 0) + row[key];
  }
}

function classifySnapshot(snapshot, error, now, interval) {
  if (!snapshot) return 'unavailable';
  return error || now - snapshot.updatedAt > interval * 2 ? 'stale' : 'ready';
}

export function createModelUsage({ store, call, stateDir, now = Date.now, enabled = () => true }) {
  let nextBalance = 0;
  let nextUsage = 0;
  let attemptedBalance = -Infinity;
  let attemptedUsage = -Infinity;
  let balanceError = false;
  let usageError = false;
  let pending;

  async function refresh({ force = false } = {}) {
    if (!call || !enabled()) return;
    if (pending) return pending;
    const timestamp = now();
    if (timestamp < Math.min(nextBalance, nextUsage) && !force) return;
    pending = (async () => {
      if (timestamp >= nextBalance || (force && timestamp - attemptedBalance >= retryInterval)) {
        attemptedBalance = timestamp;
        try {
          const report = await call('usage.status');
          if (!enabled()) return;
          const balance = readBalance(report);
          if (!balance) throw new Error('Balance unavailable');
          const updatedAt = Number.isFinite(report.updatedAt) ? Math.min(now(), report.updatedAt) : now();
          store.saveModelBalance({ ...balance, updatedAt }, now());
          balanceError = false;
          nextBalance = now() + balanceInterval;
        } catch {
          balanceError = true;
          nextBalance = now() + retryInterval;
        }
      }
      if (timestamp >= nextUsage || (force && timestamp - attemptedUsage >= retryInterval)) {
        if (!enabled()) return;
        attemptedUsage = timestamp;
        try {
          const startDate = usageDate(timestamp, -29);
          const endDate = usageDate(timestamp);
          const report = await call('sessions.usage', { startDate, endDate, mode: 'specific', timeZone: 'Asia/Shanghai', limit: 1000 });
          if (!enabled()) return;
          const rows = usageRows(report, startDate, endDate, stateDir);
          if (!rows) throw new Error('Usage report incomplete');
          store.saveModelUsage(rows, { startDate, endDate, updatedAt: now() });
          usageError = false;
          nextUsage = now() + usageInterval;
        } catch {
          usageError = true;
          nextUsage = now() + retryInterval;
        }
      }
    })().finally(() => { pending = undefined; });
    return pending;
  }

  function overview(days) {
    const timestamp = now();
    const endDate = usageDate(timestamp);
    const startDate = usageDate(timestamp, 1 - days);
    const balance = store.modelUsageState('balance');
    const coverage = store.modelUsageState('coverage');
    const alerts = store.modelAlertSettings();
    const rows = store.modelUsageDays(startDate, endDate);
    const savedDays = new Map();
    const totals = Object.fromEntries(fields.map((key) => [key, 0]));
    const models = new Map();
    const channels = new Map();
    let costCny = null;
    let partialCost = false;
    for (const row of rows) {
      if (!savedDays.has(row.date)) savedDays.set(row.date, { date: row.date });
      if (!channels.has(row.channel)) channels.set(row.channel, { channel: row.channel });
      accumulate(savedDays.get(row.date), row.totals);
      accumulate(totals, row.totals);
      accumulate(channels.get(row.channel), row.totals);
      if (row.models.reduce((sum, item) => sum + item.totalTokens, 0) < row.totals.totalTokens) partialCost = true;
      for (const item of row.models) {
        const key = item.provider + '/' + item.model;
        if (!models.has(key)) models.set(key, { provider: item.provider, model: item.model });
        const model = models.get(key);
        accumulate(model, item);
        if (item.provider !== 'deepseek') continue;
        if (Number.isFinite(item.costCny)) costCny = (costCny ?? 0) + item.costCny;
        else if (item.totalTokens > 0) model.partialCost = partialCost = true;
      }
    }
    const daily = Array.from({ length: days }, (_, index) => {
      const date = usageDate(timestamp, 1 - days + index);
      const covered = coverage?.periods.some((period) => date >= period.startDate && date <= period.endDate);
      return savedDays.get(date) ?? { date, totalTokens: covered ? 0 : null };
    });
    const byTokens = (a, b) => b.totalTokens - a.totalTokens;
    return {
      alerts, timeZone: 'Asia/Shanghai',
      balance: { ...balance, status: classifySnapshot(balance, balanceError, timestamp, balanceInterval),
        accounts: (balance?.accounts ?? []).map((account) => ({ ...account, low: balance.available === false ||
          (Object.hasOwn(alerts, account.currency) && account.total <= alerts[account.currency]) })) },
      usage: { status: classifySnapshot(coverage, usageError, timestamp, usageInterval),
        ...coverage, range: { startDate, endDate, days }, daily, totals, currency: 'USD',
        costCny: costCny ?? (partialCost ? null : 0), partialCost,
        models: [...models.values()].sort(byTokens), channels: [...channels.values()].sort(byTokens) }
    };
  }

  return { refresh, overview, close: () => pending };
}
