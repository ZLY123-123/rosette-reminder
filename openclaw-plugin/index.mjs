import { createReminderContextEngine, tokenSavingPrompt } from './context.mjs';

const channelNames = new Map([['openclaw-weixin', 'wechatSender'], ['weixin', 'wechatSender'],
  ['qqbot', 'qqSender'], ['openclaw-qqbot', 'qqSender']]);

function canonicalSender(value) {
  return String(value ?? '').trim().replace(/^(?:openclaw-weixin:|weixin:|qqbot:c2c:|qqbot:|c2c:)/, '');
}

function address(value, path) {
  const url = new URL(value || 'http://127.0.0.1:3100');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('请选择 HTTPS 或本机的待办 API 地址。');
  return new URL('/api/agent/' + path, url);
}

const hash = (value) => createHash('sha256').update(value).digest('hex');

function createClient(config, token, fetcher = fetch) {
  return async (path, { body, query, requestKey, timeout = 5000 } = {}) => {
    const url = address(config.apiBase, path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return fetcher(url, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(requestKey ? { ...body, requestKey } : body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(timeout)
    });
  };
}

async function readTokenSaving(config, token) {
  if (!token || token.length < 32) return false;
  try {
    const response = await createClient(config, token)('token-saving', { timeout: 1000 });
    return response.ok && (await response.json()).enabled === true;
  } catch {
    return false;
  }
}

function output(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
}

const fields = (source, names) => Object.fromEntries(names.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
const taskFields = ['title', 'dueAt', 'repeat', 'repeatUntil', 'dual', 'completed'];
const taskTarget = ['id', 'match'];
const operations = {
  list: (p) => ['tasks', { query: fields(p, ['query', 'archived', 'offset']) }],
  status: (p) => ['status', { query: { taskId: p.id, query: p.match ?? p.query } }],
  create: (p) => ['tasks', { body: fields(p, taskFields) }],
  plan_schedule: (p) => ['schedule/plan', { body: { schedule: p.schedule } }],
  apply_schedule: (p) => ['schedule/apply', { body: { schedule: p.schedule } }],
  update: (p) => ['tasks', { body: fields(p, [...taskFields, ...taskTarget]) }],
  stop_reminder: (p) => ['tasks', { body: { ...fields(p, taskTarget), dueAt: null, repeat: 'once', repeatUntil: null } }],
  archive_task: (p) => ['tasks', { body: { ...fields(p, taskTarget), archived: true } }],
  restore_task: (p) => ['tasks', { body: { ...fields(p, taskTarget), archived: false } }],
  inbox: (p) => ['inbox', { query: fields(p, ['archived']) }],
  inbox_read: (p) => ['inbox', { body: { action: 'read', id: p.id } }],
  inbox_unread: (p) => ['inbox', { body: { action: 'unread', id: p.id } }],
  inbox_archive: (p) => ['inbox', { body: { action: 'archive', id: p.id } }],
  inbox_clear: () => ['inbox', { body: { action: 'archive', id: 'all' } }],
  inbox_restore: (p) => ['inbox', { body: { action: 'restore', id: p.id ?? 'latest' } }],
  set_daily: (p) => ['daily', { body: fields(p, ['daily', 'dual']) }],
  set_delivery: (p) => ['delivery', { body: fields(p, ['levels', 'fallback']) }],
  test_push: () => ['test', { body: { channel: 'push' } }],
  test_fallback: () => ['test', { body: { channel: 'fallback' } }]
};
const targeted = new Set(['update', 'stop_reminder', 'archive_task', 'restore_task']);
const agentGuidance = 'ROSETTE 工具是当前能力与状态的依据，旧聊天中的能力说明可能已过时。' +
  '给定日期集合或有界范围里的指定日程，使用 plan_schedule 或 apply_schedule，服务器按北京时间展开为单次提醒并校验与去重。' +
  '每天或每周重复用于明确要求的规则循环，repeatUntil 包含截止日。按工具返回的日期、时段和状态确认结果。' +
  '用户明确要求管理任务、收件箱、日报或投递时，使用对应的 ROSETTE 工具完成。先查或匹配目标，歧义时给出真实候选。' +
  '完成多个明确步骤后逐项核对。工具拒绝或调用异常时说明该步未完成。';

export function makeTool(context, { config, token, fetcher = fetch }) {
  const identity = channelNames.get(context.messageChannel ?? context.deliveryContext?.channel);
  const owner = canonicalSender(identity && config[identity]);
  if (!owner || owner !== canonicalSender(context.requesterSenderId) || context.senderIsOwner === false) return null;
  if (!token || token.length < 32) return null;
  const request = createClient(config, token, fetcher);
  return {
    name: 'reminder_tasks',
    label: 'ROSETTE 工作台',
    description: '操作 ROSETTE 工作台的数据。list 查待办和当前时间，status 查设置或投递。plan_schedule 预览日程，apply_schedule 按具体日期或有限范围内符合星期筛选的日期批量创建单次提醒，支持补充或跳过日期、多时段和多事项。create 创建单项或明确要求的周期，update 编辑、完成或恢复，stop_reminder 停止定时，archive_task / restore_task 归档或恢复任务。inbox 查询提醒收件箱，inbox_read / inbox_unread 修改已读，inbox_archive / inbox_clear 归档单条或清空，inbox_restore 撤销归档。set_daily 调整日报，set_delivery 调整投递，test_push / test_fallback 测试对应渠道。每天和每周都支持结束日期 repeatUntil，包含当天。始终核对工具返回的真实结果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: Object.keys(operations) },
        id: { type: 'string', description: '已有任务或提醒的 ID。收件箱已读、未读可用 all，恢复可用 latest 或 all。' },
        match: { type: 'string', description: '已有待办的名称，用于编辑、暂停、归档、恢复、查询该任务状态。和 id 二选一。' },
        query: { type: 'string', description: 'list 的名称搜索关键词。' },
        offset: { type: 'integer', minimum: 0, description: 'list 分页位置，每页最多 100 项。' },
        archived: { type: 'boolean', description: 'list 或 inbox 查询已归档记录时设 true。' },
        title: { type: 'string', description: '待办创建时的名称，或编辑后的新名称。' },
        dueAt: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '包含时区的绝对时间；null 移除提醒时间' },
        repeat: { type: 'string', enum: ['once', 'daily', 'weekly'] },
        repeatUntil: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '范围重复应传最后一天，YYYY-MM-DD，包含当天。创建周期时必须明确传日期或 null，null 表示长期重复。' },
        dual: { type: 'boolean', description: '待办或日报同时发送已启用的手机通知。' },
        completed: { type: 'boolean', description: '待办完成为 true，恢复待处理为 false。' },
        schedule: {
          type: 'object', additionalProperties: false, required: ['slots'],
          description: '日程预览与保存的参数。dates 与 range 取并集后去除 excludeDates。',
          properties: {
            dates: { type: 'array', items: { type: 'string' }, description: '指定或补充的日期，YYYY-MM-DD。' },
            range: {
              type: 'object', additionalProperties: false, required: ['from', 'through'],
              properties: {
                from: { type: 'string', description: '起始日期，YYYY-MM-DD。' },
                through: { type: 'string', description: '最后日期，YYYY-MM-DD，包含当天。' },
                on: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
                  description: '选定星期，省略时选择范围内全部日期。' }
              }
            },
            excludeDates: { type: 'array', items: { type: 'string' }, description: '跳过的日期，YYYY-MM-DD。' },
            slots: { type: 'array', items: {
              type: 'object', additionalProperties: false, required: ['time', 'title'],
              properties: {
                time: { type: 'string', description: '北京时间 HH:mm。' },
                title: { type: 'string', description: '该时段的待办名称。' },
                dual: { type: 'boolean', description: '同时发送已启用的手机通知。' }
              }
            } }
          }
        },
        daily: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '北京时间 HH:mm，null 关闭日报。' },
        levels: { type: 'array', items: { type: 'array', items: { type: 'string', enum: ['wechat', 'qq', 'push'] } },
          description: '投递优先级的分组，同组同时发送。wechat 是微信，qq 是 QQ，push 是 PWA。' },
        fallback: { type: 'string', enum: ['unaccepted', 'rejected'], description: 'unaccepted 包含超时或结果待确认，rejected 仅明确失败或全组不可用时备用。' }
      }
    },
    async execute(_callId, params) {
      if (!Object.hasOwn(operations, params?.action)) return output({ error: '请提供有效操作。' }, true);
      const action = params.action;
      if (targeted.has(action) && !params.id && !params.match) return output({ error: '请提供目标待办名称 match 或 ID。' }, true);
      if ((targeted.has(action) || action === 'status') && params.id !== undefined && !/^[\da-f-]{36}$/.test(params.id)) {
        return output({ error: '请使用查询返回的有效待办 ID。' }, true);
      }
      if (action === 'create' && ['daily', 'weekly'].includes(params.repeat) && !Object.hasOwn(params, 'repeatUntil')) {
        return output({ error: '请填写 repeatUntil。用户指定范围时传最后一天，长期重复时显式传 null。' }, true);
      }
      if (action === 'update' && !taskFields.some((key) => Object.hasOwn(params, key))) {
        return output({ error: '请填写实际要修改的字段。' }, true);
      }
      try {
        const [path, args] = operations[action](params);
        const requestKey = args.body && context.runId ? hash(JSON.stringify([context.runId, owner, action, args.body])) : undefined;
        const response = await request(path, { ...args, requestKey });
        return output(await response.json(), !response.ok);
      } catch {
        return output({ error: '待办服务暂时无法连接，请稍后重试。' }, true);
      }
    }
  };
}

function observeConversation(api, config, token) {
  if (!token || token.length < 32 || !api.on) return;
  const request = createClient(config, token);
  const followups = new Map();
  const owns = (id, channel, ctx) => {
    const key = channelNames.get(ctx.channelId);
    return key === channel + 'Sender' && Boolean(config[key]) &&
      canonicalSender(id) === canonicalSender(config[key]) &&
      (!config.wechatAccount || channel !== 'wechat' || ctx.accountId === config.wechatAccount);
  };
  const channelFor = (ctx) => channelNames.get(ctx.channelId) === 'wechatSender' ? 'wechat' : 'qq';
  const report = async (record) => {
    try {
      if (!(await request('conversation', { body: record })).ok) throw Error('conversation request rejected');
    } catch {
      api.logger?.warn('ROSETTE 聊天记录同步暂缓。');
    }
  };
  api.on('message_received', async (event, ctx) => {
    const channel = channelFor(ctx);
    if (!owns(event.senderId ?? ctx.senderId ?? event.from, channel, ctx)) return;
    const content = typeof event.content === 'string' ? event.content.slice(0, 5000) : '';
    if (!content && !event.media?.length) return;
    const at = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
    const nativeId = event.messageId ?? ctx.messageId ?? [at, content];
    await report({ id: hash(JSON.stringify(['inbound', channel, ctx.accountId, nativeId])), channel,
      direction: 'inbound', state: 'received', body: content || '附件', at });
  });
  api.on('message_sending', async (event, ctx) => {
    const runId = event.metadata?.runId ?? ctx.runId;
    if (!runId || !owns(event.to, 'wechat', ctx) || event.metadata?.mediaUrls ||
      typeof event.content !== 'string' || !event.content.trim() || event.content.length > 3200) return;
    if (event.content.startsWith('微信通道提醒\n')) return;
    const now = Date.now();
    for (const [key, entry] of followups) if (now - entry.startedAt >= 180_000) followups.delete(key);
    if (followups.has(runId)) return;
    try {
      const response = await request('wechat-followup');
      if (!response.ok) return;
      const { reminders } = await response.json();
      if (!reminders.length) return;
      const items = reminders.map((row) => '• ' + (row.preview || row.title).split('\n', 1)[0]);
      const text = event.content + '\n\n此前微信投递待确认\n' + items.join('\n') + '\n打开 ROSETTE 可查看投递记录。';
      followups.set(runId, { ids: reminders.map((row) => row.id), text, startedAt: now });
      return { content: text };
    } catch {
      api.logger?.warn('ROSETTE 微信补报查询暂缓。');
    }
  });
  api.on('message_sent', async (event, ctx) => {
    const channel = channelFor(ctx);
    if (!owns(event.to, channel, ctx) || typeof event.success !== 'boolean' || typeof event.content !== 'string') return;
    const at = Date.now();
    const runId = event.metadata?.runId ?? ctx.runId;
    const body = event.content.slice(0, 5000);
    const state = event.success ? 'accepted' : /\b(?:ret|errcode)\s*[:=]\s*-\d+\b/i.test(event.error ?? '') ? 'rejected' : 'unknown';
    const pending = runId && followups.get(runId);
    const followupIds = event.success && pending?.text === body ? pending.ids : undefined;
    if (followupIds) followups.delete(runId);
    const observedOrigin = event.metadata?.reminderContentOrigin;
    const contentOrigin = observedOrigin === 'ai' && followupIds ? 'mixed' : observedOrigin;
    const serverId = event.metadata?.reminderServerMessageId;
    const archiveId = channel === 'wechat' && event.success && typeof serverId === 'string' && serverId &&
      'archive:' + hash(JSON.stringify([ctx.accountId, canonicalSender(event.to), serverId]));
    const nativeId = serverId || (event.messageId ?? ctx.messageId ?? [runId ?? Math.floor(at / 1000), body, state]);
    await report({ id: hash(JSON.stringify(['outbound', channel, ctx.accountId, nativeId])), channel,
      direction: 'outbound', state, body, at, followupIds, contentOrigin, archiveId: archiveId || undefined });
  });
}

const operationNames = {
  list: '查询待办', status: '核对工作台状态', create: '创建待办', update: '更新待办',
  plan_schedule: '预览日程', apply_schedule: '保存日程',
  stop_reminder: '暂停提醒', archive_task: '归档待办', restore_task: '恢复待办',
  inbox: '读取收件箱', inbox_read: '标记已读', inbox_unread: '标记未读', inbox_archive: '归档提醒',
  inbox_clear: '清空收件箱', inbox_restore: '恢复提醒', set_daily: '更新日报',
  set_delivery: '更新投递设置', test_push: '测试手机通知', test_fallback: '测试备用链路'
};

function observeWechatProcessing(api) {
  if (!api.on) return;
  const safeName = (value) => typeof value === 'string' && /^[\w./:-]{1,64}$/.test(value) ? value : '';
  const traceFor = (event, ctx) => {
    const trace = globalThis[Symbol.for('reminder-desk:wechat-runs')]?.get(event.runId ?? ctx.runId);
    return trace?.expiresAt > Date.now() ? trace : undefined;
  };
  const record = (event, ctx, type, callId, label, state, details) => {
    const runId = event.runId ?? ctx.runId;
    const trace = traceFor(event, ctx);
    if (!trace || (typeof callId !== 'string' && typeof callId !== 'number')) return;
    trace.recordStep(hash(JSON.stringify([type, runId, callId])), label.slice(0, 100), state, details);
  };
  const observeModel = (event, ctx, finished) => {
    const provider = safeName(event.provider ?? ctx.modelProviderId);
    const model = safeName(event.model ?? ctx.modelId);
    if (!provider || !model) return;
    const trace = traceFor(event, ctx);
    if (trace?.tokenSavingSelected && !trace.tokenSavingRecorded) {
      trace.tokenSavingRecorded = true;
      trace.recordStep('context:token-saving', '使用短上下文', 'done', { kind: 'context', mode: 'token-saving' });
    }
    if (finished && event.outcome === 'completed') {
      trace?.noteModelOutput?.();
    }
    const name = provider.toLowerCase() === 'deepseek' ? 'DeepSeek' : provider;
    const details = { kind: 'model', provider, model, durationMs: event.durationMs,
      errorCategory: safeName(event.failureKind ?? event.errorCategory) || undefined };
    record(event, ctx, 'model', event.callId, '模型请求 · ' + name + ' · ' + model,
      finished ? (event.outcome === 'completed' ? 'done' : 'failed') : 'running', details);
  };
  const observeTool = (event, ctx, finished) => {
    const tool = safeName(event.toolName);
    if (!tool) return;
    let label = '调用工具 · ' + tool;
    if (tool === 'reminder_tasks' && Object.hasOwn(operationNames, event.params?.action)) {
      label = operationNames[event.params.action];
      if (event.params.action === 'update' && event.params.completed === true) label = '标记待办完成';
      if (event.params.action === 'update' && event.params.completed === false) label = '恢复待处理';
    }
    record(event, ctx, 'tool', event.toolCallId, label,
      finished ? (event.error || event.result?.isError ? 'failed' : 'done') : 'running');
  };
  api.on('llm_input', (event, ctx) => {
    const trace = traceFor(event, ctx);
    if (trace) trace.tokenSavingSelected = event.systemPrompt?.includes(tokenSavingPrompt) === true;
  });
  api.on('model_call_started', (event, ctx) => observeModel(event, ctx, false));
  api.on('model_call_ended', (event, ctx) => observeModel(event, ctx, true));
  api.on('llm_output', (event, ctx) => {
    if (Array.isArray(event.assistantTexts) && event.assistantTexts.some((value) => typeof value === 'string' && value.trim())) {
      globalThis[Symbol.for('reminder-desk:wechat-runs')]?.get(event.runId ?? ctx.runId)?.noteModelOutput?.();
    }
    const provider = safeName(event.provider);
    const model = safeName(event.model);
    if (!provider || !model || !event.usage) return;
    const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total']
      .filter((key) => Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0)
      .map((key) => [key, event.usage[key]]));
    if (!Object.keys(usage).length) return;
    const name = provider.toLowerCase() === 'deepseek' ? 'DeepSeek' : provider;
    record(event, ctx, 'model_usage', provider + '/' + model, '模型执行用量 · ' + name + ' · ' + model, 'done',
      { kind: 'model_usage', provider, model, usage });
  });
  api.on('before_tool_call', (event, ctx) => observeTool(event, ctx, false));
  api.on('after_tool_call', (event, ctx) => observeTool(event, ctx, true));
}

export default {
  id: 'reminder-desk',
  name: 'ROSETTE 待办',
  register(api) {
    const config = api.pluginConfig ?? {};
    const token = process.env.REMINDER_AGENT_TOKEN;
    api.registerTool((context) => makeTool(context, { config, token }), { name: 'reminder_tasks' });
    api.registerContextEngine?.('reminder-desk', () => createReminderContextEngine({
      isEnabled: () => readTokenSaving(config, token),
      compact: async (params) => {
        const { delegateCompactionToRuntime } = await import('openclaw/plugin-sdk/core');
        return delegateCompactionToRuntime(params);
      }
    }));
    api.on?.('before_prompt_build', (_event, ctx) => {
      if (ctx.toolAuthority?.allows('reminder_tasks')) return { prependContext: agentGuidance };
    }, { requiresToolAuthority: true });
    observeConversation(api, config, token);
    observeWechatProcessing(api);
  }
};
import { createHash } from 'node:crypto';
