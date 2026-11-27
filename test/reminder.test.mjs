import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { zstdCompressSync } from 'node:zlib';
import { classifyQQ, classifyWechat, createQQSender, createScheduler, createWechatSender, normalizeSubscription, wechatDeliveryScope } from '../src/delivery.mjs';
import { createApp } from '../src/server.mjs';
import { parseConversationCursor } from '../src/conversation.mjs';
import { createOpenClawSessionReader } from '../src/openclaw-session.mjs';
import { createModelUsage } from '../src/model-usage.mjs';
import { createOpenClawModels } from '../src/openclaw-models.mjs';
import { createStore } from '../src/store.mjs';
import { createWechatResumeSender, readWechatWindow, wechatQuietMs, wechatResumeDue, wechatResumeTitle,
  wechatResumeBody, wechatResumeWaiting } from '../src/wechat-resume.mjs';
import reminderPlugin, { makeTool } from '../openclaw-plugin/index.mjs';
import { createReminderContextEngine, tokenSavingPrompt } from '../openclaw-plugin/context.mjs';
import { createWechatTurnFeedback, emptyReplyText, failedReplyText, needsQuoteClarification,
  quoteClarification, quoteContext, resumeReplyText } from '../deploy/openclaw/weixin-turn-feedback.mjs';

const clock = Date.parse('2054-11-19T10:00:00+08:00');
const subscription = { endpoint: 'https://web.push.apple.com/reminder',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };

test('微信私聊等待最终回复，并处理空回复、异常和送达失败', async (context) => {
  const sent = [];
  const events = [];
  let refused = false;
  let newMessage = true;
  const create = (overrides = {}) => createWechatTurnFeedback({
    config: { plugins: { entries: { 'reminder-desk': { config: { wechatSender: 'owner', wechatAccount: 'account' } } } } },
    accountId: 'account', senderId: 'owner', messageId: 'message', body: '已完成', contextToken: 'test-token',
    token: 'test-credential'.repeat(3), warn: assert.fail,
    send: async (text) => { sent.push(text); if (refused) throw new Error('ret=-2'); },
    fetcher: async (_url, request) => {
      const event = JSON.parse(request.body);
      events.push(event);
      return Response.json(event.action === 'start' ? { created: newMessage } : { ok: true });
    },
    ...overrides
  });
  assert.equal(create({ senderId: 'another-user' }), undefined);
  await create().finish();
  await create().finish(new Error('session persistence failed'));
  const answered = create();
  answered.sending();
  answered.accepted();
  await answered.finish();
  const rejected = create();
  rejected.sending();
  rejected.failed(new Error('ret=-2'));
  await rejected.finish();
  refused = true;
  await create().finish();
  refused = false;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const repliesBeforeWaiting = sent.length;
  const slow = create();
  slow.processing();
  slow.bindRun('verified-run');
  const hooks = new Map();
  reminderPlugin.register({ registerTool() {}, on: (key, callback) => hooks.set(key, callback) });
  hooks.get('llm_input')({ runId: 'another-run', systemPrompt: tokenSavingPrompt }, {});
  hooks.get('model_call_started')({ runId: 'another-run', callId: '1', provider: 'deepseek', model: 'deepseek-chat' }, {});
  const firstCall = { runId: 'verified-run', callId: '1', provider: 'deepseek', model: 'deepseek-chat' };
  hooks.get('model_call_started')(firstCall, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.step?.details?.kind === 'context').length, 0);
  hooks.get('llm_input')({ runId: 'verified-run', systemPrompt: '系统说明\n' + tokenSavingPrompt }, {});
  hooks.get('model_call_started')({ ...firstCall, callId: '2' }, {});
  assert.equal(slow.deliveryOrigin({ text: '尚待确认来源' }), undefined);
  hooks.get('model_call_ended')({
    runId: 'verified-run', callId: '2', provider: 'deepseek', model: 'deepseek-chat', outcome: 'completed', durationMs: 230
  }, {});
  assert.equal(slow.deliveryOrigin({ text: '模型回复' }), 'ai');
  assert.equal(slow.deliveryOrigin({ text: '平台错误信息', isError: true }), 'program');
  assert.equal(slow.deliveryOrigin({ text: '模型切换通知', isFallbackNotice: true }), 'program');
  hooks.get('llm_output')({ runId: 'verified-run', sessionId: 'one', provider: 'deepseek', model: 'deepseek-chat',
    usage: { input: 12, cacheRead: 15, output: 3, total: 30 }, assistantTexts: ['private-text'] }, {});
  hooks.get('before_tool_call')({
    runId: 'verified-run', toolCallId: '2', toolName: 'reminder_tasks', params: { action: 'update', completed: true }
  }, {});
  hooks.get('after_tool_call')({
    runId: 'verified-run', toolCallId: '2', toolName: 'reminder_tasks', params: { action: 'update', completed: true }, result: {}
  }, {});
  context.mock.timers.tick(21_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, repliesBeforeWaiting);
  slow.sending();
  slow.accepted();
  await slow.finish();
  context.mock.timers.reset();
  const reference = create({ quote: { state: 'missing' } });
  await reference.clarify();
  await reference.finish();
  newMessage = false;
  await create().finish();
  assert.deepEqual(sent, [emptyReplyText, failedReplyText, emptyReplyText, quoteClarification]);
  assert.deepEqual(events.filter((event) => event.action === 'finish').map((event) => event.outcome),
    ['acknowledged', 'acknowledged', 'accepted', 'rejected', 'rejected', 'accepted', 'clarified']);
  assert.deepEqual(events.filter((event) => event.step?.key === 'context:token-saving').map((event) => event.step.details),
    [{ kind: 'context', mode: 'token-saving' }]);
  const details = events.flatMap((event) => event.step ? [event.step] : []);
  assert.deepEqual(details.filter(({ label }) => label.startsWith('模型请求')).map(({ label, state }) => [label, state]),
    [['模型请求 · DeepSeek · deepseek-chat', 'running'], ['模型请求 · DeepSeek · deepseek-chat', 'running'],
      ['模型请求 · DeepSeek · deepseek-chat', 'done']]);
  assert.equal(details.find(({ details }) => details?.kind === 'model' && details.durationMs)?.details.durationMs, 230);
  assert.deepEqual(details.find(({ details }) => details?.kind === 'model_usage')?.details.usage,
    { input: 12, output: 3, cacheRead: 15, total: 30 });
  assert.ok(!JSON.stringify(details).includes('private-text'));
  assert.deepEqual(details.filter(({ label }) => label === '标记待办完成').map(({ state }) => state), ['running', 'done']);
});

test('绑定微信发来独立的继续指令时刷新会话并直达固定回复，重复回执只发送一次', async () => {
  const events = [];
  const sent = [];
  const items = [{ type: 1, text_item: { text: ' 继续 ' } }];
  let created = true;
  let refreshed = 0;
  let rejected = false;
  const make = (options = {}) => createWechatTurnFeedback({
    config: { plugins: { entries: { 'reminder-desk': { config: { wechatSender: 'owner', wechatAccount: 'bound' } } } } },
    accountId: 'bound', senderId: 'owner', messageId: 'resume', body: '继续', contextToken: 'context',
    token: 'agent-key-'.repeat(4), warn: assert.fail,
    send: async (text) => { if (rejected) throw new Error('ret=-2'); sent.push(text); },
    fetcher: async (_url, request) => {
      const event = JSON.parse(request.body);
      events.push(event);
      return Response.json(event.action === 'start' ? { created } : { ok: true });
    },
    ...options
  });
  assert.equal(make({ senderId: 'other' }), undefined);
  assert.equal(make({ accountId: 'other' }), undefined);
  assert.equal(make({ quote: { state: 'available', body: '历史消息' } }).matchesResume(items), false);
  const command = make();
  assert.equal(command.matchesResume(items), true);
  assert.equal(command.matchesResume([{ type: 1, text_item: { text: '继续执行' } }]), false);
  assert.equal(command.matchesResume([{ ...items[0], ref_msg: {} }]), false);
  assert.equal(command.matchesResume([...items, { type: 2 }]), false);
  await command.resume(() => refreshed++);
  await command.finish();
  created = false;
  const replay = make();
  await replay.resume(() => refreshed++);
  await replay.finish();
  assert.deepEqual(sent, [resumeReplyText]);
  assert.equal(refreshed, 1);
  created = true;
  rejected = true;
  const failed = make({ messageId: 'new-resume' });
  await failed.resume(() => refreshed++);
  await failed.finish();
  assert.deepEqual(events.filter(({ action }) => action === 'finish').map(({ outcome }) => outcome), ['accepted', 'rejected']);
  assert.equal(events.some(({ action }) => action === 'processing'), false);
  assert.ok(events.some(({ step }) => step?.key === 'resume'));
});

test('微信引用缺少正文时请用户指明事项，微信发送失败和网关中断转备用并留收件箱', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const successful = 'c'.repeat(64);
  const missing = quoteContext(true, '[引用消息内容未缓存]');
  assert.deepEqual(missing, { state: 'missing' });
  assert.equal(needsQuoteClarification('已完成', missing), true);
  assert.equal(needsQuoteClarification('已完成提交材料', missing), false);
  assert.equal(needsQuoteClarification('已完成', quoteContext(true, '[引用消息内容未缓存]', '提交材料')), false);
  assert.equal(store.startWechatTurn({ id: first, body: '已完成', quote: missing }, clock), true);
  assert.equal(store.startWechatTurn({ id: first, body: '重复', quote: missing }, clock), false);
  store.recordConversation({ id: 'archive:' + first, channel: 'wechat', direction: 'inbound', state: 'received',
    source: 'archive', body: '已完成', at: clock });
  assert.equal(store.conversation().messages[0].quoteState, 'missing');
  assert.equal(store.conversation().messages[0].replyStage, 'received');
  store.advanceWechatTurn(first, 'processing');
  assert.equal(store.conversation().messages[0].replyStage, 'processing');
  store.advanceWechatTurn(first, 'sending');
  store.advanceWechatTurn(first, 'processing');
  assert.equal(store.conversation().messages[0].replyStage, 'sending');
  store.recordWechatTurnStep(first, { key: 'model', label: '模型请求 · DeepSeek', state: 'done', at: clock + 50 }, clock + 50);
  store.recordWechatTurnStep(first, { key: 'model', label: '模型请求 · DeepSeek', state: 'running', at: clock + 10 }, clock + 75);
  assert.deepEqual(store.conversation().messages[0].replySteps[0], {
    label: '模型请求 · DeepSeek', state: 'done', at: clock + 10, updatedAt: clock + 50
  });
  store.finishWechatTurn(first, 'rejected', clock + 100);
  store.finishWechatTurn(first, 'rejected', clock + 300);
  store.startWechatTurn({ id: second, body: '网关中断的请求' }, clock);
  store.startWechatTurn({ id: successful, body: '正常回复的请求' }, clock);
  store.finishWechatTurn(successful, 'accepted', clock + 2);
  let push = 0;
  const scheduler = createScheduler({ store, now: () => clock + 120_001,
    sendWechat: async () => assert.fail('已处理过的微信回复应直接使用备用渠道'),
    sendPush: async () => { push++; return 'accepted'; }
  });
  await scheduler.tick();
  assert.equal(push, 2);
  assert.equal(store.badge().count, 2);
  assert.equal(store.inbox().length, 2);
  assert.ok(store.inbox().some(({ body }) => body.includes('原消息：已完成')));
  assert.deepEqual(new Set(store.history().map(({ wechat }) => wechat)), new Set(['rejected', 'unknown']));
  const original = store.conversation().messages.find(({ kind }) => kind === 'message');
  assert.equal(original.replyStage, 'rejected');
  assert.equal(original.inbox, 1);
  assert.equal(original.push, 'accepted');
});

test('对话详情匹配绑定微信的当前会话、会话模型与最近实际使用的模型', (context) => {
  const state = mkdtempSync(join(tmpdir(), 'reminder-session-test-'));
  context.after(() => rmSync(state, { recursive: true, force: true }));
  const dir = join(state, 'agents', 'main', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: { primary: 'deepseek/deepseek-flash' } } } }));
  const stored = new DatabaseSync(join(dir, 'openclaw-agent.sqlite'));
  stored.exec(`
    CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, entry_json TEXT, label TEXT, display_name TEXT,
      last_interaction_at INTEGER, session_started_at INTEGER, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE session_windows (session_id TEXT, model TEXT, model_provider TEXT, channel TEXT, account_id TEXT, chat_type TEXT);
  `);
  const session = (key, id, to, updated) => {
    const entry = { delivery: { context: { to, accountId: 'bound-account', channel: 'openclaw-weixin' } },
      authProfileOverride: 'internal-field', totalTokensFresh: true, totalTokens: 42, contextTokens: 1000000 };
    stored.prepare('INSERT INTO session_nodes VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)')
      .run(key, id, JSON.stringify(entry), updated, clock, updated);
    stored.prepare('INSERT INTO session_windows VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'deepseek-flash', 'deepseek', 'openclaw-weixin', 'bound-account', 'direct');
    return entry;
  };
  try {
    const bound = session('agent:main:main', 'current-session', 'openclaw-weixin:owner@im.wechat', clock + 2);
    session('agent:main:other', 'different-session', 'other@im.wechat', clock + 9);
    const reader = createOpenClawSessionReader(state, 'bound-account', 'owner@im.wechat');
    const metadata = reader(clock + 10);
    assert.equal(metadata.sessionKey, 'agent:main:main');
    assert.equal(metadata.model, 'deepseek/deepseek-flash');
    assert.equal(metadata.contextTokens, 1000000);
    assert.equal(Object.hasOwn(metadata, 'authProfileOverride'), false);
    stored.prepare('UPDATE session_nodes SET entry_json = ? WHERE session_key = ?')
      .run(JSON.stringify({ ...bound, modelOverride: 'deepseek-v4-pro', providerOverride: 'deepseek' }), 'agent:main:main');
    const refreshed = reader(clock + 5010);
    assert.equal(refreshed.model, 'deepseek/deepseek-v4-pro');
    assert.equal(refreshed.modelSource, 'session');
    assert.equal(refreshed.lastUsed, 'deepseek/deepseek-flash');
    assert.equal(createOpenClawSessionReader(state, 'different', 'owner@im.wechat')(), null);
  } finally {
    stored.close();
  }
});

function memory(context) {
  const store = createStore(':memory:');
  context.after(() => store.close());
  return store;
}

test('微信错误码、未知结果、客户端编号与服务端编号分开处理', () => {
  assert.equal(classifyWechat('', 'sendMessage ret=-2 errmsg=prepare failed', 1).status, 'rejected');
  assert.equal(classifyWechat('{"ret":0}').status, 'unknown');
  assert.equal(classifyWechat('{"payload":{"result":{"messageId":"client-only"}}}').status, 'accepted');
  assert.equal(classifyWechat('{"messageId":"client-only"}', '', 0, true).status, 'unknown');
  assert.equal(classifyWechat('{"payload":{"results":[{"serverMessageId":"123"}]}}', '', 0, true).status, 'accepted');
  assert.equal(classifyWechat('{"deliveryStatus":"suppressed","messageId":"123"}').status, 'unknown');
  assert.equal(classifyQQ('{"payload":{"result":{"messageId":"qq-1"}}}').status, 'accepted');
  assert.equal(classifyQQ('', 'permission denied', 1).status, 'unknown');
});

test('通过实际子进程传递官方渠道参数并捕获拒收', async () => {
  const entry = fileURLToPath(new URL('./fixtures/openclaw-cli.mjs', import.meta.url));
  const job = { title: '提醒', body: "提交材料 & 文件名有空格" };
  const sendWechat = createWechatSender({ target: 'OWNER@im.wechat', entry });
  const sendQQ = createQQSender({ target: 'OWNER_QQ', entry });
  assert.equal((await sendWechat(job)).status, 'rejected');
  assert.equal((await sendQQ(job)).status, 'accepted');
});

test('通过网关投递时传递任务幂等键并识别受理和拒收', async () => {
  const entry = fileURLToPath(new URL('./fixtures/openclaw-cli.mjs', import.meta.url));
  const job = { id: 'job-1', title: '提醒', body: '提交材料 & 文件名有空格' };
  const sendWechat = createWechatSender({ target: 'OWNER@im.wechat', account: 'weixin-account', entry, viaGateway: true });
  const sendQQ = createQQSender({ target: 'OWNER_QQ', entry, viaGateway: true });
  assert.deepEqual(await sendWechat(job), { status: 'accepted', detail: '插件受理，手机端待确认' });
  assert.deepEqual(await sendQQ(job), { status: 'rejected', detail: 'QQ错误码 -2' });
});

test('微信拒收时 QQ 阻塞仍可发送 PWA，并按服务器未读数更新角标', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  store.saveTask({ title: '提交材料', dueAt: clock + 1 }, clock);
  let releaseQQ;
  const gate = new Promise((resolve) => { releaseQQ = resolve; });
  let observed;
  const pushStarted = new Promise((resolve) => { observed = resolve; });
  const scheduler = createScheduler({ store, now: () => clock + 5,
    sendWechat: async () => ({ status: 'rejected', detail: '微信错误码 -2' }),
    sendQQ: async () => { await gate; return { status: 'accepted' }; },
    sendPush: async (_target, badge) => { observed(badge); return 'accepted'; }
  });
  const running = scheduler.tick();
  try { assert.deepEqual({ ...await pushStarted }, { count: 1, revision: 1 }); }
  finally { releaseQQ(); await running; }
  const alert = store.inbox()[0];
  assert.equal(alert.body, '提交材料');
  assert.deepEqual({ ...store.markRead(alert.id) }, { count: 0, revision: 2 });
  assert.deepEqual({ ...store.markRead(alert.id) }, { count: 0, revision: 2 });
  assert.deepEqual(store.history().map(({ wechat, qq, push }) => [wechat, qq, push]), [['rejected', 'accepted', 'accepted']]);
});

test('微信受理时普通任务只走微信，重要任务同时走 PWA', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  store.saveTask({ title: '普通', dueAt: clock + 1 }, clock);
  store.saveTask({ title: '重要', dueAt: clock + 2, dual: true }, clock);
  let pushes = 0;
  const scheduler = createScheduler({ store, now: () => clock + 3,
    sendWechat: async () => ({ status: 'accepted' }),
    sendQQ: async () => assert.fail('QQ should not be used'),
    sendPush: async () => { pushes += 1; return 'accepted'; }
  });
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(pushes, 1);
  assert.deepEqual(store.inbox().map(({ body }) => body), ['重要']);
});

test('重要事项的 PWA 通道可先于微信完成', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  store.saveTask({ title: '重要双发', dueAt: clock + 1, dual: true }, clock);
  let unblock, notify;
  const wechatGate = new Promise((resolve) => { unblock = resolve; });
  const pushed = new Promise((resolve) => { notify = resolve; });
  const scheduler = createScheduler({ store, now: () => clock + 5,
    sendWechat: async () => { await wechatGate; return { status: 'accepted' }; },
    sendPush: async () => { notify(); return 'accepted'; }
  });
  const running = scheduler.tick();
  try { await pushed; } finally { unblock(); await running; }
  assert.equal(store.history()[0].push, 'accepted');
  assert.equal(store.badge().count, 1);
});

test('重启将发送中的微信转备用，周期提醒向前推进一次', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'reminder-test-'));
  const db = join(dir, 'test.sqlite');
  let store = createStore(db);
  context.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = store.saveTask({ title: '每周整理', dueAt: clock + 1, repeat: 'weekly' }, clock);
  store.activateDue(clock + 2);
  assert.equal(store.claimChannel('wechat').wechat, 'sending');
  store.close();
  store = createStore(db);
  store.recoverDelivery(clock + 3);
  assert.equal(store.task(task.id).dueAt, clock + 1 + 604_800_000);
  assert.equal(store.inbox().length, 1);
  assert.equal(store.history()[0].wechat, 'unknown');
  assert.equal(store.claimChannel('qq').qq, 'sending');
  store.recoverDelivery(clock + 4);
  assert.equal(store.history()[0].qq, 'unknown');
  assert.equal(store.claimChannel('qq'), undefined);
  assert.equal(store.inbox().length, 1);
});

test('改期和完成取消旧提醒；日报按北京日期去重且包含待安排事项', (context) => {
  const store = memory(context);
  const task = store.saveTask({ title: '会议', dueAt: clock + 10 }, clock);
  store.saveTask({ id: task.id, dueAt: clock + 20 }, clock);
  store.activateDue(clock + 11);
  assert.equal(store.claimChannel('wechat'), undefined);
  store.saveTask({ id: task.id, completed: true }, clock + 12);
  store.activateDue(clock + 21);
  assert.equal(store.claimChannel('wechat'), undefined);
  store.saveTask({ title: '买牛奶' }, clock);
  store.saveSettings('10:01', true);
  store.scheduleDaily(clock);
  store.activateDue(clock);
  assert.equal(store.claimChannel('wechat'), undefined);
  store.scheduleDaily(clock + 61_000);
  store.scheduleDaily(clock + 62_000);
  store.activateDue(clock + 63_000);
  const summary = store.claimChannel('wechat');
  assert.match(summary.body, /待安排 1/);
  assert.match(summary.body, /买牛奶/);
  assert.doesNotMatch(summary.body, /会议/);
  store.activateDue(clock + 64_000);
  assert.equal(store.claimChannel('wechat'), undefined);
});

test('PWA 临时失败延迟重试，永久过期回收订阅，网页仍保留提醒', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  let now = clock + 2;
  let calls = 0;
  store.saveTask({ title: '需兜底', dueAt: clock + 1 }, clock);
  const scheduler = createScheduler({ store, now: () => now,
    sendWechat: async () => { throw Error('timeout'); },
    sendQQ: async () => ({ status: 'unknown' }),
    sendPush: async () => { calls += 1; return calls === 1 ? 'retry' : 'expired'; }
  });
  await scheduler.tick();
  assert.equal(store.history()[0].push, 'pending');
  await scheduler.tick();
  assert.equal(calls, 1);
  now += 60_001;
  await scheduler.tick();
  assert.equal(calls, 2);
  assert.equal(store.subscriptionCount(), 0);
  assert.equal(store.history()[0].push, 'failed');
  assert.equal(store.badge().count, 1);
});

test('逐级策略可设 QQ 优先；明确失败后调用下一层，受理后停止', async (context) => {
  const store = memory(context);
  store.savePolicy({ levels: [['qq'], ['wechat'], ['push']], fallback: 'rejected' });
  store.subscribe(subscription);
  store.saveTask({ title: '逐级提醒', dueAt: clock + 1 }, clock);
  const calls = [];
  const scheduler = createScheduler({ store, now: () => clock + 2,
    sendQQ: async () => { calls.push('qq'); return { status: 'rejected' }; },
    sendWechat: async () => { calls.push('wechat'); return { status: 'accepted' }; },
    sendPush: async () => { calls.push('push'); return 'accepted'; }
  });
  await scheduler.tick();
  assert.deepEqual(calls, ['qq', 'wechat']);
  assert.equal(store.history()[0].push, 'skipped');
  assert.equal(store.inbox().length, 0);
});

test('同级三个渠道并发；明确失败模式遇到待确认时保留网页提醒', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  store.savePolicy({ levels: [['wechat', 'qq', 'push']], fallback: 'unaccepted' });
  store.saveTask({ title: '并发提醒', dueAt: clock + 1 }, clock);
  const calls = [];
  let unlock;
  const gate = new Promise((resolve) => { unlock = resolve; });
  const scheduler = createScheduler({ store, now: () => clock + 2,
    sendWechat: async () => { calls.push('wechat'); await gate; return { status: 'unknown' }; },
    sendQQ: async () => { calls.push('qq'); return { status: 'accepted' }; },
    sendPush: async () => { calls.push('push'); return 'accepted'; }
  });
  const running = scheduler.tick();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.sort(), ['push', 'qq', 'wechat']);
  } finally { unlock(); await running; }
  calls.length = 0;
  store.savePolicy({ levels: [['wechat'], ['qq']], fallback: 'rejected' });
  store.saveTask({ title: '严格拒收模式', dueAt: clock + 1 }, clock);
  await scheduler.tick();
  assert.deepEqual(calls, ['wechat']);
  assert.ok(store.inbox().some((item) => item.body === '严格拒收模式'));
});

test('策略快照在重启后保留，新的优先级用于尚未投递的任务', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'reminder-route-'));
  const dbPath = join(directory, 'test.sqlite');
  let store = createStore(dbPath);
  context.after(() => { store.close(); rmSync(directory, { force: true, recursive: true }); });
  store.savePolicy({ levels: [['wechat'], ['qq']], fallback: 'unaccepted' });
  store.saveTask({ title: '旧策略任务', dueAt: clock + 1 }, clock);
  store.saveTask({ title: '新策略任务', dueAt: clock + 5, dual: true }, clock);
  store.activateDue(clock + 2);
  assert.equal(store.claimChannel('wechat').body, '旧策略任务');
  const nextPolicy = { levels: [['qq']], fallback: 'rejected' };
  store.savePolicy(nextPolicy);
  store.close();
  store = createStore(dbPath);
  assert.deepEqual(store.settings().policy, nextPolicy);
  store.recoverDelivery(clock + 3);
  assert.equal(store.claimChannel('qq').body, '旧策略任务');
  store.activateDue(clock + 6);
  assert.equal(store.claimChannel('qq').body, '新策略任务');
  assert.equal(store.nextPush(clock + 6), undefined);
});

test('PWA 优先但缺授权时继续备用；已有受理的同级阻止降级', async (context) => {
  const store = memory(context);
  store.savePolicy({ levels: [['push'], ['qq']], fallback: 'rejected' });
  store.saveTask({ title: '无手机订阅', dueAt: clock + 1 }, clock);
  const calls = [];
  const scheduler = createScheduler({ store, now: () => clock + 2,
    sendWechat: async () => { calls.push('wechat'); return { status: 'rejected' }; },
    sendQQ: async () => { calls.push('qq'); return { status: 'accepted' }; },
    sendPush: async () => { calls.push('push'); return 'accepted'; }
  });
  await scheduler.tick();
  assert.deepEqual(calls, ['qq']);
  assert.equal(store.history()[0].push, 'inbox_only');
  calls.length = 0;
  store.savePolicy({ levels: [['wechat', 'qq'], ['push']], fallback: 'unaccepted' });
  store.subscribe(subscription);
  store.saveTask({ title: '同级有受理', dueAt: clock + 1 }, clock);
  await scheduler.tick();
  assert.deepEqual(calls.sort(), ['qq', 'wechat']);
  assert.equal(store.inbox().length, 1);
});

test('PWA 优先的临时错误在宽松模式下立即交给备用渠道', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  store.savePolicy({ levels: [['push'], ['qq']], fallback: 'unaccepted' });
  store.saveTask({ title: '手机推送超时', dueAt: clock + 1 }, clock);
  const calls = [];
  const scheduler = createScheduler({ store, now: () => clock + 2,
    sendPush: async () => { calls.push('push'); return 'retry'; },
    sendQQ: async () => { calls.push('qq'); return { status: 'accepted' }; }
  });
  await scheduler.tick();
  assert.deepEqual(calls, ['push', 'qq']);
  assert.equal(store.history()[0].push, 'unknown');
});

test('短上下文保留最近两轮答复、当前引用和运行中的工具链', async () => {
  const user = (content) => ({ role: 'user', content });
  const reply = (text) => ({ role: 'assistant', stopReason: 'stop', content: [
    { type: 'thinking', thinking: '历史推理' }, { type: 'text', text }
  ] });
  const call = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: '1' }] };
  const result = { role: 'toolResult', toolCallId: '1', content: [{ type: 'text', text: '工具原始输出' }] };
  const system = { role: 'system', content: '系统设置' };
  const quote = user([{ type: 'text', text: '改到明天（引用：提交材料）' }, { type: 'image', data: 'img' }]);
  const history = [system, user('过期历史'), reply('旧答复'), user('提醒提交材料'), call, result,
    reply('提交材料已排到 19:00'), user('晚上还有什么'), reply('还有设备巡检'), quote, call, result];
  let enabled = false;
  const compact = async (params) => params;
  const engine = createReminderContextEngine({ isEnabled: () => enabled, compact });
  const availableTools = new Set(['reminder_tasks']);
  const assemble = (messages = history) => engine.assemble({ messages, availableTools }).then((entry) => entry.messages);
  assert.equal(await assemble(), history);
  assert.equal((await engine.assemble({ messages: history, availableTools })).systemPromptAddition, undefined);
  enabled = true;
  assert.equal((await engine.assemble({ messages: history, availableTools })).systemPromptAddition, tokenSavingPrompt);
  assert.equal((await engine.assemble({ messages: history, availableTools: new Set() })).messages, history);
  const short = await assemble();
  assert.deepEqual(short.map((message) => message.role),
    ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'toolResult']);
  assert.equal(short[2].content[0].text, '提交材料已排到 19:00');
  assert.equal(short[2].content.length, 1);
  assert.equal(short[5], quote);
  assert.equal(short[6], call);
  assert.equal(short[7], result);
  assert.equal(history[6].content.length, 2);
  const failed = [user('本轮消息'), call, result];
  assert.equal(await assemble(failed), failed);
  const params = { sessionId: 's' };
  assert.equal(await engine.compact(params), params);
});

test('HTTP 登录、CSRF、网页与机器人待办共用同一数据源', async (context) => {
  const store = memory(context);
  const origin = 'https://reminder.example.test';
  const agentToken = 'agent-key-'.repeat(4);
  const server = createApp({ store, origin, password: 'strong-password', sessionSecret: 'session-key-'.repeat(4),
    agentToken, vapidKey: 'public-key', now: () => clock, wechatConfigured: true, qqConfigured: true,
    scheduler: { tick: async () => {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, { method = 'GET', headers = {}, body } = {}) => fetch(base + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: 'strong-password' } })).status, 403);
  const login = await request('/api/login', { method: 'POST', headers: { origin }, body: { password: 'strong-password' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  const browser = { origin, cookie: cookie.split(';')[0] };
  const agent = { authorization: 'Bearer ' + agentToken };
  assert.equal((await request('/api/agent/tasks')).status, 401);
  assert.equal((await request('/api/agent/token-saving')).status, 401);
  const tokenSaving = () => request('/api/agent/token-saving', { headers: agent }).then((response) => response.json());
  assert.deepEqual(await tokenSaving(), { enabled: false });
  const changeMode = (enabled, headers = browser) => request('/api/settings/token-saving',
    { method: 'PUT', headers, body: { enabled } });
  assert.equal((await changeMode(true, agent)).status, 403);
  assert.equal((await changeMode(true, { ...agent, origin })).status, 401);
  assert.equal((await changeMode('true')).status, 400);
  assert.equal((await changeMode(true)).status, 200);
  assert.deepEqual(await tokenSaving(), { enabled: true });
  assert.equal((await request('/api/agent/tasks', { method: 'POST', headers: agent,
    body: { title: '无时间周期', repeat: 'daily' } })).status, 400);
  assert.equal((await request('/api/tasks', { method: 'POST', headers: browser,
    body: { title: '错误日期', dueAt: '2027-02-30T10:00+08:00' } })).status, 400);
  const create = await request('/api/agent/tasks', { method: 'POST', headers: agent,
    body: { title: '机器人创建', dueAt: '2054-11-20T10:00+08:00' } });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).localTime, '2054-11-20 10:00');
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', headers: browser, body: subscription })).status, 201);
  assert.equal((await request('/api/push/test', { method: 'POST', headers: browser, body: {} })).status, 202);
  const state = await (await request('/api/state', { headers: browser })).json();
  assert.equal(state.tasks[0].title, '机器人创建');
  assert.equal(state.badge.count, 1);
  assert.equal(state.qqConfigured, true);
  assert.equal(state.settings.tokenSaving, true);
  assert.equal((await changeMode(false)).status, 200);
  assert.deepEqual(await tokenSaving(), { enabled: false });
  assert.equal((await request('/settings')).status, 200);
  const policy = { levels: [['push', 'qq'], ['wechat']], fallback: 'rejected' };
  assert.equal((await request('/api/settings/delivery', { method: 'PUT', headers: { origin }, body: policy })).status, 401);
  for (const levels of [[], [['qq'], ['qq']], [['unlisted']], [['qq'], []]]) {
    assert.equal((await request('/api/settings/delivery', { method: 'PUT', headers: browser,
      body: { levels, fallback: 'rejected' } })).status, 400);
  }
  assert.equal((await request('/api/settings/delivery', { method: 'PUT', headers: browser, body: policy })).status, 200);
  const refreshed = await (await request('/api/state', { headers: browser })).json();
  assert.deepEqual(refreshed.settings.policy, policy);
  assert.equal((await request('/api/fallback/test', { method: 'POST', headers: browser, body: {} })).status, 202);
  assert.equal(store.history().find(({ title }) => title === '备用渠道测试').qq, 'pending');
  const icon = Buffer.from(await (await request('/icon-192.png')).arrayBuffer());
  assert.equal(icon.readUInt32BE(16), 192);
  assert.equal((await request('/sw.js')).status, 200);
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/manifest.webmanifest')).status, 200);
});

test('服务端只接收允许的推送域名', () => {
  assert.ok(normalizeSubscription(subscription));
  assert.equal(normalizeSubscription({ ...subscription, endpoint: 'https://web.push.apple.com.invalid/resource' }), null);
  assert.equal(normalizeSubscription({ ...subscription, endpoint: 'https://user@web.push.apple.com/resource' }), null);
  assert.equal(normalizeSubscription({ ...subscription, endpoint: 'https://127.0.0.1/resource' }), null);
});

test('OpenClaw 工具由真实渠道身份约束，且 API 字段严格转发', async () => {
  let sent;
  const options = { config: { wechatSender: 'owner@im.wechat', qqSender: 'OWNER_OPEN_ID' }, token: 'x'.repeat(32),
    fetcher: async (_url, args) => {
      sent = args;
      return new Response('{"ok":true}');
    } };
  assert.equal(makeTool({ messageChannel: 'openclaw-weixin', requesterSenderId: 'other@im.wechat' }, options), null);
  assert.equal(makeTool({ messageChannel: 'telegram', requesterSenderId: 'owner@im.wechat' }, options), null);
  assert.equal(makeTool({ messageChannel: 'qqbot', requesterSenderId: 'OWNER_OPEN_ID', senderIsOwner: false }, options), null);
  assert.ok(makeTool({ messageChannel: 'qqbot', requesterSenderId: 'qqbot:c2c:OWNER_OPEN_ID' }, options));
  const tool = makeTool({ messageChannel: 'openclaw-weixin', requesterSenderId: 'owner@im.wechat' }, options);
  assert.equal((await tool.execute('test', { action: 'update', id: '../bad' })).isError, true);
  await tool.execute('test', { action: 'create', title: '开会', id: 'ignored field', completed: false });
  assert.deepEqual(JSON.parse(sent.body), { title: '开会', completed: false });
  assert.equal(sent.headers.authorization, 'Bearer ' + options.token);
});

test('区间重复在北京时间的截止当天发出，并在重复请求下只创建一条任务', async (context) => {
  const store = memory(context);
  const first = Date.parse('2054-11-20T22:00:00+08:00');
  const input = { title: '巡检', dueAt: first, repeat: 'daily', repeatUntil: '2054-11-22', requestKey: 'A' };
  const original = store.saveTask(input, clock);
  const dispatched = [];
  let now = first;
  const scheduler = createScheduler({ store, now: () => now, sendWechat: async (job) => {
    dispatched.push(job.due_at);
    return { status: 'accepted' };
  } });
  for (let day = 0; day < 4; day++) {
    now = first + day * 86400000;
    await scheduler.tick();
  }
  const existing = store.saveTask(input, now);
  assert.equal(existing.id, original.id);
  assert.equal(existing.dueAt, null);
  assert.equal(existing.repeatUntil, '2054-11-22');
  assert.equal(store.listTasks().length, 1);
  assert.deepEqual(dispatched.map((value) => (value - first) / 86400000), [0, 1, 2]);
  assert.ok(store.saveTask({ ...input, title: '同键不同事项' }, now).conflict);
  assert.ok(store.saveTask({ title: '无效区间', dueAt: now + 1, repeat: 'daily', repeatUntil: '2054-11-22' }, now).invalid);
  assert.equal(store.saveTask({ id: existing.id, completed: true }, now).completed, 1);
});

test('同一时刻的微信待办合并，拒收逐项进入备用并可等待下次对话补报', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  const tasks = ['归还设备', '巡检'].map((title) => store.saveTask({ title, dueAt: clock + 1000 }, clock));
  const sent = [];
  let pushCount = 0;
  const scheduler = createScheduler({ store, now: () => clock + 1000, sendWechat: async (job) => {
    sent.push(job.body);
    return { status: 'rejected', detail: '微信错误码 -2' };
  }, sendPush: async () => { pushCount++; return 'accepted'; } });
  await scheduler.tick();
  assert.equal(sent.length, 1);
  for (const task of tasks) assert.match(sent[0], new RegExp(task.title));
  assert.equal(pushCount, 2);
  assert.equal(store.wechatActivity(clock + 1000).attempts, 1);
  const missed = store.missedWechat(clock + 1001, clock + 1001);
  assert.equal(missed.length, 2);
  store.markWechatFollowup(missed.map((job) => job.id), clock + 1002);
  assert.deepEqual(store.missedWechat(clock + 1003, clock + 1003), []);
});

test('长时间静默后的明确拒收暂停同一微信会话，备用照常投递且新入站恢复', async (context) => {
  const store = memory(context);
  store.savePolicy({ levels: [['wechat'], ['push']], fallback: 'rejected' });
  store.subscribe(subscription);
  const sendTimes = [];
  const pushed = [];
  let now = clock + 86_400_000;
  let verifiedInboundAt = clock;
  const inbound = (id, at) => store.recordConversation({ id, channel: 'wechat', direction: 'inbound',
    source: 'archive', state: 'received', body: '测试微信入站', at });
  inbound('before-silence', clock);
  const wechatScope = wechatDeliveryScope('my-bot', 'owned-conversation');
  const options = { store, wechatScope, now: () => now, readWechatInbound: () => verifiedInboundAt, sendWechat: async () => {
    sendTimes.push(now);
    return sendTimes.length === 1 ? classifyWechat('', 'sendMessage ret=-2 errmsg=prepare failed', 1) : { status: 'accepted' };
  }, sendPush: async (job) => { pushed.push(job.body); return 'accepted'; } };
  const schedule = async (title) => {
    const task = store.saveTask({ title, dueAt: now + 1 }, now);
    now++;
    await createScheduler(options).tick();
    return store.history(task.id)[0];
  };
  const first = await schedule('首次尝试');
  assert.equal(first.wechat, 'rejected');
  assert.match(first.detail, /prepare failed/);
  assert.equal(first.push, 'accepted');
  assert.equal(store.isWechatDeferred(wechatScope, store.lastWechatInbound()), true);
  assert.equal(store.isWechatDeferred(wechatDeliveryScope('unused-bot', 'different-conversation'), clock), false);
  const second = await schedule('暂用备用');
  assert.equal(second.wechat, 'skipped');
  assert.match(second.detail, /会话待刷新/);
  assert.equal(second.push, 'accepted');
  assert.equal(sendTimes.length, 1);
  assert.deepEqual(pushed, ['首次尝试', '暂用备用']);
  inbound('workbench-only', ++now);
  const third = await schedule('继续用备用');
  assert.equal(third.wechat, 'skipped');
  assert.equal(third.push, 'accepted');
  assert.equal(sendTimes.length, 1);
  verifiedInboundAt = ++now;
  inbound('after-silence', now);
  assert.equal(store.isWechatDeferred(wechatScope, verifiedInboundAt), false);
  assert.deepEqual(store.missedWechat(now, now).map(({ id }) => id), [third.id, second.id, first.id]);
  assert.equal((await schedule('会话恢复')).wechat, 'accepted');
  assert.equal(sendTimes.length, 2);
});

test('授权聊天页显示已绑定的手机内容，补报成功后按回执结案', async (context) => {
  const store = memory(context);
  let now = clock;
  store.savePolicy({ levels: [['wechat']], fallback: 'unaccepted' });
  const task = store.saveTask({ title: '现场巡检', dueAt: clock + 1 }, clock);
  store.activateDue(++now);
  const job = store.claimChannel('wechat');
  store.finishChannel('wechat', job, { status: 'rejected' }, now);
  const token = 'agent-key-'.repeat(4);
  const server = createApp({ store, origin: 'https://reminder.example.test', password: 'strong-password',
    sessionSecret: 'session-key-'.repeat(4), agentToken: token, now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const previous = process.env.REMINDER_AGENT_TOKEN;
  process.env.REMINDER_AGENT_TOKEN = token;
  const hooks = new Map();
  try {
    reminderPlugin.register({
      pluginConfig: { apiBase: base, wechatSender: 'owner@im.wechat', wechatAccount: 'bound-account' }, registerTool() {},
      on: (name, handler) => hooks.set(name, handler)
    });
  } finally {
    if (previous === undefined) delete process.env.REMINDER_AGENT_TOKEN;
    else process.env.REMINDER_AGENT_TOKEN = previous;
  }
  const channel = { channelId: 'openclaw-weixin', accountId: 'bound-account' };
  await hooks.get('message_received')({ from: 'outsider@im.wechat', content: '外部消息', timestamp: ++now }, channel);
  await hooks.get('message_received')({ from: 'owner@im.wechat', content: '手机原文 <b>纯文本</b>',
    messageId: 'native-inbound', timestamp: ++now }, channel);
  await hooks.get('message_received')({ from: 'owner@im.wechat', content: '另一个账号', timestamp: now },
    { ...channel, accountId: 'other-account' });
  const outgoing = { to: 'owner@im.wechat', content: '收到。', metadata: { runId: 'reply-1' } };
  const sent = await hooks.get('message_sending')(outgoing, channel);
  assert.match(sent.content, /现场巡检/);
  assert.equal(store.missedWechat(now, now).length, 1);
  await hooks.get('message_sent')({ ...outgoing, ...sent, success: true, metadata: {
    ...outgoing.metadata, reminderContentOrigin: 'ai', reminderServerMessageId: 'fixture-message-id'
  } }, channel);
  assert.equal(store.missedWechat(now, now).length, 0);
  const status = await fetch(base + '/api/agent/status?taskId=' + task.id, { headers: { authorization: 'Bearer ' + token } });
  assert.equal((await status.json()).history[0].wechat, 'rejected');
  assert.equal((await fetch(base + '/api/chat')).status, 401);
  assert.equal((await fetch(base + '/api/chat/media/1')).status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST',
    headers: { origin: 'https://reminder.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'strong-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const chat = await (await fetch(base + '/api/chat', { headers: { cookie } })).json();
  assert.equal(chat.messages.filter((item) => item.kind === 'message').length, 2);
  assert.equal(chat.messages.find((item) => item.direction === 'inbound').body, '手机原文 <b>纯文本</b>');
  assert.match(chat.messages.find((item) => item.direction === 'outbound').body, /现场巡检/);
  assert.equal(chat.messages.find((item) => item.direction === 'outbound').contentOrigin, 'mixed');
});

test('同文的微信消息按真实归档编号合并并继承各自来源，历史记录保留未知', (context) => {
  const store = memory(context);
  const archiveA = 'archive:' + 'a'.repeat(64);
  const archiveB = 'archive:' + 'b'.repeat(64);
  const oldArchive = 'archive:' + 'c'.repeat(64);
  const defaults = { channel: 'wechat', direction: 'outbound', state: 'accepted', body: '相同文字', at: clock };
  store.recordConversation({ ...defaults, id: 'provider-a', source: 'hook', archiveId: archiveA, contentOrigin: 'ai' });
  store.recordConversation({ ...defaults, id: archiveB, source: 'archive', at: clock + 1100 });
  assert.equal(store.conversation().messages.length, 2);
  store.recordConversation({ ...defaults, id: archiveA, source: 'archive', at: clock + 20_000 });
  store.recordConversation({ ...defaults, id: 'provider-b', source: 'hook', archiveId: archiveB, contentOrigin: 'program' });
  store.recordConversation({ ...defaults, id: oldArchive, source: 'archive', at: clock + 21_000 });
  store.recordConversation({ ...defaults, id: 'rejected', source: 'hook', state: 'rejected', contentOrigin: 'program' });
  const rows = store.conversation().messages;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((row) => row.source === 'archive').map((row) => row.contentOrigin), ['program', 'ai', null]);
  assert.equal(rows.find((row) => row.state === 'rejected').contentOrigin, 'program');
});

test('聊天时间线合并成功、拒收及网关恢复的发送副本，并保留原渠道结果', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  const trigger = clock + 4000;
  const body = '需在服务台登记' + '、领取物资和签名'.repeat(12);
  store.saveTask({ title: body, dueAt: clock + 1 }, clock);
  const reject = createScheduler({ store, now: () => trigger, sendWechat: async () => ({
    status: 'rejected', detail: '微信错误码 -2'
  }), sendPush: async () => 'accepted' });
  await reject.tick();
  for (const [state, offset] of [['rejected', 0], ['unknown', 10_000]]) {
    store.recordConversation({ id: 'hook-failure-' + state, channel: 'wechat', direction: 'outbound',
      body: '待办提醒\n' + body, source: 'hook', state, at: trigger + offset });
  }
  const pushOnly = '仅推送到手机的提醒内容';
  store.savePolicy({ levels: [['push']], fallback: 'unaccepted' });
  store.saveTask({ title: pushOnly, dueAt: clock + 2 }, clock);
  await reject.tick();
  const sent = '微信收到的提醒内容';
  store.savePolicy({ levels: [['wechat']], fallback: 'unaccepted' });
  store.saveTask({ title: sent, dueAt: clock + 3 }, clock);
  await createScheduler({ store, now: () => trigger, sendWechat: async () => ({ status: 'accepted' }) }).tick();
  for (const [id, text, direction] of [
    ['quoted-reminder', '待办提醒\n' + sent, 'outbound'], ['separate-message', '普通聊天消息', 'inbound']
  ]) store.recordConversation({ id, channel: 'wechat', direction, body: text, source: 'archive',
    state: direction === 'outbound' ? 'accepted' : 'received', at: trigger });
  const all = store.conversation().messages;
  assert.equal(all.length, 4);
  const failed = all.find((item) => item.body === body);
  assert.equal(failed.kind, 'reminder');
  assert.equal(failed.contentOrigin, 'program');
  assert.equal(failed.wechat, 'rejected');
  assert.equal(failed.detail, '微信错误码 -2');
  assert.equal(failed.push, 'accepted');
  assert.equal(failed.at, trigger);
  assert.equal(all.find((item) => item.body === pushOnly).kind, 'reminder');
  assert.equal(all.filter((item) => item.kind === 'message').length, 1);
  const { attempts, accepted } = store.wechatActivity(trigger + 10_000);
  assert.deepEqual([attempts, accepted], [2, 1]);
  const latest = store.conversation(undefined, 2);
  const earlier = store.conversation(parseConversationCursor(latest.before), 2);
  assert.deepEqual([...earlier.messages, ...latest.messages].map((item) => item.id), all.map((item) => item.id));
  assert.equal(earlier.before, null);
  assert.deepEqual(parseConversationCursor('123:9'), [123, 'm:00000000000000000009']);
});

test('助手按日期范围与星期预览和保存单次日程，处理例外日期、过去时段与重试', async (context) => {
  const store = memory(context);
  let now = Date.parse('2054-11-20T23:57:20+08:00');
  const token = 'schedule-agent-'.repeat(3);
  const server = createApp({ store, origin: 'https://reminder.example.test', password: 'strong-password',
    sessionSecret: 'session-key-'.repeat(4), agentToken: token, now: () => now, scheduler: { tick: async () => {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { apiBase: 'http://127.0.0.1:' + server.address().port, wechatSender: 'owner@im.wechat' };
  const tool = (runId) => makeTool({ runId, messageChannel: 'openclaw-weixin',
    requesterSenderId: config.wechatSender }, { config, token });
  const run = async (action, schedule, runId = 'first-turn') => {
    const result = await tool(runId).execute('calendar', { action, schedule });
    return { body: JSON.parse(result.content[0].text), failed: Boolean(result.isError) };
  };
  const slots = [
    { time: '08:00', title: '检查库存' }, { time: '12:00', title: '设备巡检' },
    { time: '14:00', title: '检查库存' }, { time: '18:00', title: '设备巡检' }
  ];
  const weekend = { range: { from: '2054-11-20', through: '2054-11-29', on: ['sat', 'sun'] }, slots };
  const dates = ['2054-11-21', '2054-11-22', '2054-11-28', '2054-11-29'];
  const preview = await run('plan_schedule', weekend);
  assert.equal(preview.failed, false);
  assert.deepEqual(preview.body.dates, dates);
  assert.equal(preview.body.counts.planned, 16);
  assert.equal(store.listTasks().length, 0);
  const planned = await run('apply_schedule', weekend);
  assert.equal(planned.failed, false);
  assert.equal(planned.body.counts.created, 16);
  assert.deepEqual(planned.body.occurrences.map(({ dueAt, title }) => [dueAt, title]),
    dates.flatMap((date) => slots.map(({ title, time }) => [date + 'T' + time + ':00+08:00', title])));
  assert.ok(store.listTasks().every((task) => task.repeat === 'once' && task.repeatUntil === null));
  const supplemental = await run('apply_schedule', { dates: ['2054-11-30'], slots }, 'next-turn');
  assert.equal(supplemental.body.counts.created, 4);
  assert.equal((await run('apply_schedule', weekend, 'retry-turn')).body.counts.existing, 16);
  assert.equal(store.listTasks().length, 20);

  const edited = planned.body.occurrences[0];
  store.saveTask({ id: edited.taskId, archived: true }, now);
  const replay = await run('apply_schedule', weekend);
  assert.equal(replay.body.counts.changed, 1);
  assert.equal(store.listTasks().length, 19);
  now = Date.parse('2054-11-21T09:30:00+08:00');
  const exceptions = { dates: ['2054-11-30', '2054-12-01'], range: weekend.range,
    excludeDates: ['2054-11-28'], slots };
  const exceptionPreview = await run('plan_schedule', exceptions);
  assert.deepEqual(exceptionPreview.body.dates, ['2054-11-21', '2054-11-22', '2054-11-29', '2054-11-30', '2054-12-01']);
  assert.equal(exceptionPreview.body.counts.past, 1);
  assert.equal(exceptionPreview.body.counts.planned, 4);
  const invalid = await run('apply_schedule', { dates: ['2026-12-02'], slots: [...slots, { time: '24:01', title: '无效时段' }] });
  assert.equal(invalid.failed, true);
  assert.equal(store.listTasks().length, 19);
});

test('助手可跨待办、收件箱与设置操作，并报告同名歧义和重复请求', async (context) => {
  const store = memory(context);
  store.subscribe(subscription);
  const agentToken = 'agent-operations-key-'.repeat(3);
  const server = createApp({ store, origin: 'https://reminder.example.test', password: 'strong-password',
    sessionSecret: 'session-key-'.repeat(4), agentToken, now: () => clock, vapidKey: 'test-key',
    qqConfigured: true, scheduler: { tick: async () => {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = { apiBase: base, wechatSender: 'owner@im.wechat' };
  const caller = { messageChannel: 'openclaw-weixin', requesterSenderId: config.wechatSender, senderIsOwner: true };
  const tool = makeTool({ ...caller, runId: 'first-turn' }, { config, token: agentToken });
  const parse = async (params, via = tool) => {
    const result = await via.execute('tool', params);
    return { ...JSON.parse(result.content[0].text), ...(result.isError && { errorResult: true }) };
  };
  const tomorrow = '2054-11-20T22:00+08:00';
  assert.equal((await parse({ action: 'create', title: '巡检', dueAt: tomorrow, repeat: 'daily' })).errorResult, true);
  const { task } = await parse({ action: 'create', title: '设备巡检', dueAt: tomorrow, repeat: 'daily', repeatUntil: '2054-11-30' });
  assert.equal(task.repeatUntil, '2054-11-30');
  store.saveTask({ title: '其他设备巡检' }, clock);
  assert.equal((await parse({ action: 'update', match: '巡检', title: '巡检记录' })).matches.length, 2);
  const edited = await parse({ action: 'update', match: '设备巡检', title: '社区设备巡检' });
  assert.equal(edited.task.id, task.id);
  assert.equal(edited.task.repeatUntil, task.repeatUntil);
  const archive = { action: 'archive_task', match: '社区设备巡检' };
  assert.equal((await parse(archive)).task.archivedAt, clock);
  assert.equal((await parse(archive)).task.id, task.id);
  assert.equal((await parse({ action: 'list', query: '社区设备巡检' })).total, 0);
  assert.equal((await parse({ action: 'list', query: '社区设备巡检', archived: true })).total, 1);
  assert.equal((await parse({ action: 'restore_task', match: '社区设备巡检' })).task.archivedAt, null);
  const paused = await parse({ action: 'stop_reminder', match: '社区设备巡检' });
  assert.equal(paused.task.dueAt, null);
  assert.equal(paused.task.repeatUntil, null);
  assert.equal(paused.task.completed, 0);

  const original = store.testPush(clock);
  assert.equal((await parse({ action: 'inbox_clear' })).changed, 1);
  assert.equal((await parse({ action: 'inbox' })).badge.count, 0);
  assert.equal((await parse({ action: 'inbox', archived: true })).inbox[0].id, original);
  const arrived = store.testPush(clock + 1);
  assert.equal((await parse({ action: 'inbox_clear' })).changed, 1);
  assert.equal((await parse({ action: 'inbox' })).inbox[0].id, arrived);
  assert.equal((await parse({ action: 'inbox_restore' })).changed, 1);
  assert.equal((await parse({ action: 'inbox_read', id: 'all' })).badge.count, 0);
  assert.equal((await parse({ action: 'inbox_unread', id: original })).badge.count, 1);

  assert.equal((await parse({ action: 'set_daily', daily: '20:45' })).daily, '20:45');
  assert.equal((await parse({ action: 'set_daily', daily: null })).daily, null);
  assert.deepEqual((await parse({ action: 'set_delivery', levels: [['wechat'], ['push', 'qq']], fallback: 'rejected' })).levels,
    [['wechat'], ['push', 'qq']]);
  assert.equal((await parse({ action: 'set_delivery', fallback: 'unaccepted' })).fallback, 'unaccepted');
  const firstTest = await parse({ action: 'test_push' });
  assert.equal((await parse({ action: 'test_push' })).id, firstTest.id);
});

test('模型用量按会话和北京时间保存，过期且不可用的用量与零值分开', async (context) => {
  const store = memory(context);
  const origin = 'http://localhost';
  let now = Date.parse('2054-11-21T00:02:00+08:00');
  let balance = 4.5;
  let sessionId = 'archived-session';
  let unavailable = false;
  let partial = false;
  const methods = [];
  const stateDir = mkdtempSync(join(tmpdir(), 'reminder-model-usage-'));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const agentDir = join(stateDir, 'agents', 'main', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const transcript = new DatabaseSync(join(agentDir, 'openclaw-agent.sqlite'));
  transcript.exec(`CREATE TABLE transcript_events (session_id TEXT, message_role TEXT, created_at INTEGER,
    event_json TEXT, event_zstd BLOB)`);
  const archive = { message: { timestamp: now, provider: 'deepseek', model: 'deepseek-flash',
    usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, totalTokens: 35 } } };
  transcript.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, 'assistant', now, null, zstdCompressSync(Buffer.from(JSON.stringify(archive))));
  transcript.close();
  const modelUsage = createModelUsage({ store, stateDir, now: () => now, call: async (method, params) => {
    methods.push(method);
    if (unavailable) throw new Error('remote secret or error details');
    if (method === 'usage.status') return { updatedAt: now, providers: [{ provider: 'deepseek',
      billing: [{ type: 'balance', amount: balance, unit: 'CNY' }, { type: 'balance', amount: 2, unit: 'USD' }],
      summary: balance === 4.5 ? 'Balance ¥4.50 · Granted ¥4.50 · Balance $2.00' : 'Balance ¥20.00 · Balance $2.00' }] };
    assert.equal(params.timeZone, 'Asia/Shanghai');
    assert.equal(params.endDate, '2054-11-21');
    const date = '2054-11-21';
    return { startDate: params.startDate, endDate: params.endDate, cacheStatus: { status: partial ? 'partial' : 'fresh' },
      sessions: [{ agentId: 'main', channel: 'openclaw-weixin', usage: {
        sessionId, dailyBreakdown: [{ date, input: 10, output: 5, cacheRead: 20, totalTokens: 35, totalCost: 0.00015 }],
        dailyModelUsage: [{ date, provider: 'deepseek', model: 'deepseek-flash', tokens: 35, cost: 0.00015, count: 1 }]
      } }] };
  } });
  const server = createApp({ store, origin, password: 'strong-password', sessionSecret: 'session-key-'.repeat(4),
    scheduler: { tick: async () => {} }, now: () => now, modelUsage });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/';
  assert.equal((await fetch(base + 'model-usage')).status, 401);
  assert.deepEqual(methods, []);
  const login = await fetch(base + 'login', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'strong-password' }) });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const report = async (params) => (await fetch(base + 'model-usage?' + params, { headers: { cookie } })).json();
  const [recent, extended] = await Promise.all([report('days=7'), report('days=90')]);
  assert.deepEqual(methods, ['usage.status', 'sessions.usage']);
  assert.equal(recent.usage.totals.totalTokens, 35);
  assert.equal(recent.usage.daily[0].totalTokens, 0);
  assert.equal(extended.usage.daily[0].totalTokens, null);
  assert.equal(recent.usage.models[0].model, 'deepseek-flash');
  assert.equal(recent.usage.channels[0].totalTokens, 35);
  assert.equal(recent.usage.currency, 'USD');
  assert.equal(recent.usage.costCny, 0.0000304);
  assert.equal(recent.usage.models[0].costCny, recent.usage.costCny);
  assert.equal(recent.usage.partialCost, false);
  assert.deepEqual(recent.balance.accounts[0], { currency: 'CNY', total: 4.5, granted: 4.5, toppedUp: 0, low: true });
  assert.equal(recent.balance.accounts[1].low, false);
  assert.equal(store.inbox().length, 0);
  const alerts = (value) => fetch(base + 'settings/model-alerts', {
    method: 'PUT', headers: { origin, cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  assert.equal((await alerts({ enabled: true, CNY: -1, USD: 1 })).status, 400);
  assert.equal((await alerts({ enabled: true, CNY: 5, USD: 1 })).status, 200);
  assert.equal(store.inbox().length, 1);
  const firstAlertId = store.inbox()[0].id;
  await report('days=1&refresh=true');
  assert.equal(methods.length, 2);
  now += 60_000;
  balance = 20;
  sessionId = 'current-session';
  const afterReset = await report('days=1&refresh=true');
  assert.equal(afterReset.usage.totals.totalTokens, 70);
  assert.equal(afterReset.usage.costCny, recent.usage.costCny);
  assert.equal(afterReset.usage.partialCost, true);
  assert.equal(afterReset.balance.accounts[0].low, false);
  balance = 4.5;
  now += 60_000;
  partial = true;
  const incomplete = await report('days=1&refresh=true');
  assert.equal(incomplete.usage.status, 'stale');
  assert.equal(incomplete.usage.totals.totalTokens, 70);
  assert.equal(store.inbox().length, 2);
  assert.notEqual(store.inbox()[0].id, firstAlertId);
  unavailable = true;
  now += 60_000;
  const stale = await report('days=30&refresh=true');
  assert.equal(stale.balance.status, 'stale');
  assert.equal(stale.usage.status, 'stale');
  assert.ok(!JSON.stringify(stale).includes('remote secret'));
  assert.equal(store.inbox().length, 2);
});

test('切换 OpenClaw 模型和供应商，DeepSeek 用量仅对生效的 DeepSeek 供应商开放', async (context) => {
  const store = memory(context);
  const origin = 'http://localhost';
  const deepSeek = 'deepseek/deepseek-flash';
  const alternate = 'other/chat';
  const fallback = 'deepseek/deepseek-v4-pro';
  const config = { agents: { list: [{ id: 'main', modelPolicy: { allow: ['deepseek/deepseek-fl*', fallback, 'other/*'] } }],
    defaults: { model: { primary: deepSeek, fallbacks: [fallback] },
    models: { [deepSeek]: {}, [alternate]: {}, [fallback]: {}, 'other/unavailable': {} } } } };
  const session = { agentId: 'main', sessionKey: 'bound-wechat', sessionId: 'owned-session',
    model: deepSeek, modelSource: 'session' };
  const methods = [];
  const modelChanges = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === 'models.list') return { models: [
      { provider: 'deepseek', id: 'deepseek-flash', name: 'Flash', available: true, recommended: true },
      { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'V4 Pro', available: true },
      { provider: 'deepseek', id: 'legacy', available: true },
      { provider: 'other', id: 'secondary', name: 'Secondary', available: true },
      { provider: 'other', id: 'chat', name: 'Other', available: true, recommended: true },
      { provider: 'other', id: 'unavailable', available: false },
      { provider: 'untouched', id: 'chat', available: false }
    ] };
    if (method === 'config.get') return { config, valid: true, hash: 'checked-hash' };
    if (method === 'config.patch') {
      assert.equal(params.baseHash, 'checked-hash');
      const patch = JSON.parse(params.raw);
      const expected = [alternate, deepSeek, fallback][modelChanges.length];
      assert.deepEqual(patch, { agents: { defaults: { model: { primary: expected } } } });
      modelChanges.push(expected);
      config.agents.defaults.model.primary = patch.agents.defaults.model.primary;
      return { ok: true };
    }
    if (method === 'sessions.patch') {
      assert.deepEqual(params, { key: 'bound-wechat', agentId: 'main', expectedSessionId: 'owned-session', model: null });
      session.modelSource = 'default';
      return { ok: true };
    }
    assert.fail('Unexpected gateway method ' + method);
  };
  const openClawModels = createOpenClawModels({ call, readConfig: () => config, readSession: () => session });
  const server = createApp({ store, origin, password: 'strong-password', sessionSecret: 'session-key-'.repeat(4),
    scheduler: { tick: async () => {} }, openClawModels });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/';
  assert.equal((await fetch(base + 'openclaw/models')).status, 401);
  const login = await fetch(base + 'login', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'strong-password' }) });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const get = (path) => fetch(base + path, { headers: { cookie } });
  const select = (selection) => fetch(base + 'openclaw/models', { method: 'PUT',
    headers: { origin, cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(selection) });
  const options = await (await get('openclaw/models')).json();
  assert.equal(options.current, deepSeek);
  assert.equal(options.pinned, true);
  assert.deepEqual(options.choices.map(({ id }) => id), [deepSeek, fallback, 'other/secondary', alternate]);
  assert.deepEqual(Object.fromEntries(options.providers.map(({ id, status }) => [id, status])),
    { other: 'ready', deepseek: 'ready' });
  assert.equal((await get('model-usage')).status, 200);
  assert.equal((await select({ model: 'deepseek/legacy' })).status, 409);
  assert.equal((await select({ provider: 'untouched' })).status, 409);
  assert.equal((await select({ provider: 'other', model: deepSeek })).status, 400);
  assert.ok(!methods.includes('config.patch'));
  const switched = await (await select({ provider: 'other' })).json();
  assert.equal(switched.current, alternate);
  assert.equal(switched.provider, 'other');
  assert.equal(switched.pinned, false);
  assert.deepEqual(config.agents.defaults.model.fallbacks, [fallback]);
  assert.equal((await get('model-usage')).status, 409);
  const restored = await (await select({ provider: 'deepseek' })).json();
  assert.equal(restored.current, deepSeek);
  assert.equal((await get('model-usage')).status, 200);
  const onSameProvider = await (await select({ model: fallback })).json();
  assert.equal(onSameProvider.current, fallback);
  assert.equal(onSameProvider.provider, 'deepseek');
  assert.equal((await get('model-usage')).status, 200);
  assert.deepEqual(config.agents.defaults.model.fallbacks, [fallback]);
});

test('静默计数串行保留第十条，时间触发和新入站也使用同一微信会话', async (context) => {
  const setup = mkdtempSync(join(tmpdir(), 'reminder-wechat-resume-'));
  mkdirSync(join(setup, 'openclaw-weixin'));
  writeFileSync(join(setup, 'openclaw.json'), JSON.stringify({
    plugins: { entries: { 'reminder-desk': { config: { wechatAccount: 'bot', wechatSender: 'owner' } } } }
  }));
  const archive = new DatabaseSync(join(setup, 'openclaw-weixin', 'ref-messages.sqlite'));
  context.after(() => {
    archive.close();
    rmSync(setup, { recursive: true, force: true });
  });
  archive.exec("CREATE TABLE quote_messages(account_id TEXT, conversation_id TEXT, message_id TEXT PRIMARY KEY, direction TEXT, body TEXT, created_at INTEGER)");
  const add = (id, direction, timestamp) => archive.prepare('INSERT INTO quote_messages VALUES (?, ?, ?, ?, ?, ?)')
    .run('bot', 'owner', id, direction, '同一条文字', timestamp);
  add('received', 'inbound', clock);
  for (let i = 1; i <= 8; i++) add('sent'+i, 'outbound', clock + i);
  let now = clock + 600_000;
  const sent = [];
  const send = createWechatResumeSender(async (params) => {
    const text = params.body.msg.item_list[0].text_item.text;
    if (text === '模拟拒收') throw new Error('ret=-2');
    sent.push(text);
    return { ret: 0 };
  }, { stateDir: setup, now: () => now });
  const read = () => readWechatWindow(setup, 'bot', 'owner');
  const from = (text) => send({ body: { msg: { to_user_id: 'owner', item_list: [{ text_item: { text } }] } } }, 'bot');
  assert.equal(read().sent, 8);
  assert.equal(wechatResumeDue(read(), now), false);
  await assert.rejects(from('模拟拒收'), /ret=-2/);
  assert.equal(read().sent, 8);
  const results = await Promise.allSettled([from('第九条普通消息'), from('竞争中的普通消息')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, wechatResumeWaiting);
  assert.equal(read().sent, 9);
  const store = memory(context);
  const scope = wechatDeliveryScope('bot', 'owner');
  const scheduler = createScheduler({ store, wechatScope: scope, readWechatInbound: () => read().inboundAt,
    readWechatWindow: read, now: () => now, sendWechat: async ({ title, body }) => {
      await from(title + '\n' + body);
      return { status: 'accepted' };
    } });
  await scheduler.tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], wechatResumeTitle + '\n' + wechatResumeBody);
  assert.deepEqual(read(), { inboundAt: clock, sent: 10, notice: true });
  now = clock + wechatQuietMs;
  await scheduler.tick();
  assert.equal(sent.length, 2);
  assert.equal(store.history().filter((row) => row.title === wechatResumeTitle).length, 1);
  await assert.rejects(from('已经达到预留条数'), /waiting for a new WeChat message/);

  const nextInbound = ++now;
  add('new-message', 'inbound', nextInbound);
  await from('新的回复');
  assert.equal(read().sent, 1);
  now += wechatQuietMs - 1;
  await scheduler.tick();
  assert.equal(sent.length, 3);
  now++;
  await scheduler.tick();
  assert.equal(sent[3], wechatResumeTitle + '\n' + wechatResumeBody);
  assert.equal(read().notice, true);
  assert.equal(store.history().filter((row) => row.title === wechatResumeTitle).length, 2);
});

test('服务工作线程显示通知、更新数字并能清除角标', async () => {
  const handlers = new Map();
  const updates = [];
  const notifications = [];
  const self = { addEventListener: (name, handler) => handlers.set(name, handler),
    registration: { scope: 'https://example.test/reminder/', showNotification: (title) => notifications.push(title) },
    navigator: { setAppBadge: (value) => updates.push(value), clearAppBadge: () => updates.push(0) } };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'),
    { self, URL, indexedDB: { open: () => { throw Error('storage denied'); } } });
  let completion;
  handlers.get('push')({ data: { json: () => ({ title: '开会', badge: { count: 2, revision: 5 } }) },
    waitUntil: (promise) => { completion = promise; } });
  await completion;
  handlers.get('message')({ data: { type: 'badge', badge: { count: 0, revision: 6 } },
    waitUntil: (promise) => { completion = promise; } });
  await completion;
  handlers.get('push')({ data: { json: () => ({ title: '晚到的通知', badge: { count: 1, revision: 4 } }) },
    waitUntil: (promise) => { completion = promise; } });
  await completion;
  assert.deepEqual(notifications, ['开会', '晚到的通知']);
  assert.deepEqual(updates, [2, 0]);
});
