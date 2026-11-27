import { createScheduler } from '../../src/delivery.mjs';
import { usageDate } from '../../src/model-usage.mjs';
import { createOpenClawModels } from '../../src/openclaw-models.mjs';
import { createApp } from '../../src/server.mjs';
import { createStore } from '../../src/store.mjs';

const port = Number(process.argv[2] ?? 28657);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new RangeError('Invalid fixture port');
const origin = `http://127.0.0.1:${port}`;
const store = createStore(':memory:');
const now = Date.now();
const turnId = 'a'.repeat(64);
store.startWechatTurn({ id: turnId, body: '记得提交材料', quote: { state: 'available', body: '提交材料' } }, now - 120_000);
store.recordWechatTurnStep(turnId, {
  key: 'model:fixture', label: '请求模型 · DeepSeek', state: 'done', at: now - 119_800,
  details: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash', durationMs: 1700 }
}, now - 118_100);
store.finishWechatTurn(turnId, 'accepted', now - 118_000);
store.recordConversation({
  id: 'archive:' + turnId, channel: 'wechat', direction: 'inbound', state: 'received',
  source: 'archive', body: '记得提交材料', at: now - 120_000
});
store.recordConversation({
  id: 'fixture-reply', channel: 'wechat', direction: 'outbound', state: 'accepted', contentOrigin: 'ai',
  source: 'reply', body: '已保存提醒。', at: now - 117_000
});
const day = usageDate(now);
store.saveModelBalance({ available: true, updatedAt: now, accounts: [{ currency: 'CNY', total: 42.50, granted: 0, toppedUp: 42.50 }] }, now);
store.saveModelUsage([{
  date: day, sessionKey: 'fixture', channel: 'openclaw-weixin',
  totals: { input: 30, output: 20, cacheRead: 950, cacheWrite: 0, totalTokens: 1000 },
  models: [{ provider: 'deepseek', model: 'deepseek-flash', totalTokens: 1000, count: 1, costCny: 0.000129 }]
}], { startDate: day, endDate: day, updatedAt: now });
store.saveTask({ title: '提交材料', dueAt: now - 60_000, repeat: 'once' }, now - 120_000);
const scheduler = createScheduler({
  store,
  sendWechat: async () => ({ status: 'rejected', detail: '本地测试：微信拒收' }),
  sendQQ: async () => ({ status: 'skipped' }),
  sendPush: async () => 'skipped'
});
await scheduler.tick();
const config = { agents: { defaults: { model: { primary: 'deepseek/deepseek-flash' } } } };
const openClawModels = createOpenClawModels({ readConfig: () => config, readSession: () => null, call: async (method, params) => {
  if (method === 'models.list') return { models: [
    { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash', available: true },
    { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', available: true },
    { provider: 'openrouter', id: 'deepseek-v4', name: 'DeepSeek via OpenRouter', available: true }
  ] };
  if (method === 'config.get') return { config, valid: true, hash: 'fixture' };
  if (method === 'config.patch') {
    config.agents.defaults.model.primary = JSON.parse(params.raw).agents.defaults.model.primary;
    return { ok: true };
  }
  throw new Error('Unexpected fixture method');
} });
const app = createApp({
  store, scheduler, origin, password: 'reminder-ios-test', sessionSecret: 'in-memory-ios-test',
  wechatConfigured: true, qqConfigured: false, openClawModels,
  readChatSession: () => ({
    label: '主会话', agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'local-fixture',
    model: config.agents.defaults.model.primary, modelSource: 'default', lastInteractionAt: now
  })
});
app.listen(port, '127.0.0.1', () => console.log(origin));
