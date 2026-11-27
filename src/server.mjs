import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWechatArchive, parseConversationCursor, readBoundWechatInbound, resolveConversationAttachment } from './conversation.mjs';
import { createOpenClawSessionReader, readOpenClawConfig } from './openclaw-session.mjs';
import { createGatewayRPC, createOpenClawModels } from './openclaw-models.mjs';
import { createPushSender, createQQSender, createScheduler, createWechatSender, normalizeSubscription, wechatDeliveryScope } from './delivery.mjs';
import { createModelUsage, modelStepDetails } from './model-usage.mjs';
import { validPolicy } from './routing.mjs';
import { expandSchedule } from './schedule.mjs';
import { createStore, formatTime } from './store.mjs';
import { readWechatWindow, wechatResumeAfter } from './wechat-resume.mjs';

const types = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/settings': ['index.html', 'text/html; charset=utf-8'],
  '/chat': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/rosette-day.webp': ['rosette-day.webp', 'image/webp'],
  '/rosette-night.webp': ['rosette-night.webp', 'image/webp'],
  '/rosette-letter.webp': ['rosette-letter.webp', 'image/webp'],
  '/rosette-orbit.svg': ['rosette-orbit.svg', 'image/svg+xml'],
  '/rosette-mark.svg': ['rosette-mark.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/fonts/CabinSketch-Regular.ttf': ['fonts/CabinSketch-Regular.ttf', 'font/ttf'],
  '/fonts/Italianno-Regular.ttf': ['fonts/Italianno-Regular.ttf', 'font/ttf'],
  '/fonts/CabinSketch-OFL.txt': ['fonts/CabinSketch-OFL.txt', 'text/plain; charset=utf-8'],
  '/fonts/Italianno-OFL.txt': ['fonts/Italianno-OFL.txt', 'text/plain; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']
};
const cookieName = 'reminder_session';
const sessionSeconds = 30 * 24 * 60 * 60;

function sameSecret(actual, expected) {
  const digest = (value) => createHash('sha256').update(value).digest();
  return typeof actual === 'string' && Boolean(expected) && timingSafeEqual(digest(actual), digest(expected));
}

function fault(status, message, details) {
  return Object.assign(new Error(message), { status, details });
}

const validTaskId = (id) => typeof id === 'string' && /^[\da-f-]{36}$/.test(id);
function searchTerm(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 180) throw fault(400, '请提供有效的待办名称。');
  return value.trim();
}
function getRequestKey(body) {
  const value = body.requestKey;
  if (value !== undefined && (typeof value !== 'string' || !/^[\da-f]{64}$/.test(value))) {
    throw fault(400, '请求编号无效。');
  }
  return value;
}

async function readJSON(request, optional = false) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    if (optional && !request.headers['content-length'] && !request.headers['transfer-encoding']) return {};
    throw fault(415, '请提交 JSON 数据。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw fault(413, '请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw fault(400, '请提交 JSON 对象。');
}

function taskInput(body, id, now, requestKey) {
  const input = id ? { id } : {};
  if (!id || Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 180) {
      throw fault(400, '待办标题请填写 1 至 180 字。');
    }
    input.title = body.title.trim();
  }
  if (Object.hasOwn(body, 'dueAt')) {
    const time = body.dueAt === null ? null :
      typeof body.dueAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(body.dueAt)
        ? Date.parse(body.dueAt) : NaN;
    if (time !== null && (!Number.isFinite(time) || (!requestKey && time <= now))) throw fault(400, '请选择一个带时区的未来时间。');
    if (time !== null) {
      const [year, month, day] = body.dueAt.slice(0, 10).split('-').map(Number);
      if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw fault(400, '日期超出该月份范围。');
    }
    input.dueAt = time;
  }
  if (Object.hasOwn(body, 'repeat')) {
    if (!['once', 'daily', 'weekly'].includes(body.repeat)) throw fault(400, '请选择单次、每天或每周。');
    input.repeat = body.repeat;
  }
  if (Object.hasOwn(body, 'repeatUntil')) {
    const date = body.repeatUntil;
    const time = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date) : NaN;
    if (date !== null && (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date)) {
      throw fault(400, '请输入有效的重复截止日期。');
    }
    input.repeatUntil = date;
  }
  for (const key of ['dual', 'completed', 'archived']) {
    if (Object.hasOwn(body, key)) {
      if (key === 'archived' && !id) throw fault(400, '归档需要已有的待办。');
      if (typeof body[key] !== 'boolean') throw fault(400, '开关值应为 true 或 false。');
      input[key] = body[key];
    }
  }
  return requestKey ? { ...input, requestKey } : input;
}

export function createApp({ store, scheduler, origin, password, sessionSecret, agentToken, vapidKey, wechatConfigured,
  qqConfigured = false, syncWechat = () => {}, readChatSession = () => null, chatMediaRoot, wechatScope, now = Date.now,
  modelUsage = createModelUsage({ store, now }), openClawModels, readWechatInbound = store.lastWechatInbound,
  readWechatObservation }) {
  const secure = origin.startsWith('https:');
  const files = new Map(Object.entries(types).map(([route, [file, type]]) =>
    [route, [readFileSync(new URL('../public/' + file, import.meta.url)), type]]));
  let attempts = [];
  const sign = (data) => createHmac('sha256', sessionSecret).update(data).digest('base64url');
  const cookie = (value, seconds) =>
    `${cookieName}=${value}; Max-Age=${seconds}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  function validSession(request) {
    const token = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!token || !/^\d+\.[\w-]{24}\.[\w-]{43}$/.test(token)) return false;
    const [expires, nonce, signature] = token.split('.');
    return Number(expires) > now() && sameSecret(signature, sign(expires + '.' + nonce));
  }
  function json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  const trigger = () => scheduler.tick().catch(() => console.error('调度执行失败，将在下一轮继续。'));
  const saveTask = (body, id, requestKey) => {
    const timestamp = now();
    const task = store.saveTask(taskInput(body, id, timestamp, requestKey), timestamp);
    if (task?.invalid) throw fault(400, task.invalid);
    if (task?.conflict) throw fault(409, task.conflict);
    if (!task) throw fault(404, '未找到该待办。');
    return task;
  };
  function matchTask(id, name, archived = false) {
    if (id !== undefined && id !== null) {
      if (!validTaskId(id)) throw fault(400, '待办 ID 无效。');
      if (!store.task(id)) throw fault(404, '未找到该待办。');
      return id;
    }
    const query = searchTerm(name);
    if (!query) throw fault(400, '请提供要操作的待办名称或 ID。');
    const found = store.listTasks({ archived, query });
    const exact = found.filter((task) => task.title.toLocaleLowerCase() === query.toLocaleLowerCase());
    const matches = exact.length ? exact : found;
    if (!matches.length) throw fault(404, '未找到该待办。');
    if (matches.length > 1) throw fault(409, '找到多个匹配待办，请根据时间或状态选定一项。', {
      matches: matches.slice(0, 12).map(({ id, title, dueAt, completed }) => ({ id, title, dueAt, completed }))
    });
    return matches[0].id;
  }
  function updateInbox({ action, id, requestKey }) {
    if (!['read', 'unread', 'archive', 'restore'].includes(action) ||
      typeof id !== 'string' || !id || id.length > 150 || (id === 'latest' && action !== 'restore')) {
      throw fault(400, '请提供有效的提醒操作和范围。');
    }
    const result = store.changeInbox(action, id, now(), getRequestKey({ requestKey }));
    if (result.conflict) throw fault(409, '请求内容已变化，请重新发起操作。');
    return result;
  }
  function updateDaily(body, partial = false) {
    const settings = store.settings();
    if (partial && !Object.hasOwn(body, 'daily') && !Object.hasOwn(body, 'dual')) throw fault(400, '请选择日报时间或同步投递方式。');
    const daily = partial && !Object.hasOwn(body, 'daily') ? settings.daily : body.daily;
    const dual = partial && !Object.hasOwn(body, 'dual') ? Boolean(settings.dual) : body.dual;
    if (daily !== null && (typeof daily !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily))) {
      throw fault(400, '请选择有效的每日汇总时间。');
    }
    if (typeof dual !== 'boolean') throw fault(400, '请设置日报的推送方式。');
    return store.saveSettings(daily, dual);
  }
  function updatePolicy(body, partial = false) {
    const policy = partial ? { ...store.settings().policy, ...body } : body;
    if (partial && !Object.hasOwn(body, 'levels') && !Object.hasOwn(body, 'fallback')) throw fault(400, '请选择投递顺序或降级条件。');
    if (!validPolicy(policy)) throw fault(400, '请选择至少一个渠道，每个渠道可加入一个优先级。');
    return store.savePolicy({ levels: policy.levels, fallback: policy.fallback });
  }
  function queueTest(backup, requestKey) {
    if (backup && !qqConfigured) throw fault(409, '请先配置 QQ 私聊收件人。');
    if (!backup && (!vapidKey || !store.subscriptionCount())) throw fault(409, '请先在手机端启用通知。');
    const id = store.testPush(now(), backup, requestKey);
    void trigger();
    return { id };
  }
  function operationalStatus(taskId) {
    const timestamp = now();
    syncWechat(timestamp);
    const wechatActivity = store.wechatActivity(timestamp);
    const window = readWechatObservation?.();
    const inboundAt = window?.inboundAt ?? (wechatScope ? readWechatInbound() : wechatActivity.lastInboundAt);
    return { now: new Date(timestamp).toISOString(), timeZone: 'Asia/Shanghai', repeatUntilSupported: true, scheduleSupported: true,
      settings: store.settings(), wechatConfigured, qqConfigured, subscriptions: store.subscriptionCount(),
      wechatActivity: { ...wechatActivity, lastInboundAt: inboundAt,
        accepted: window?.sent ?? wechatActivity.accepted,
        silentForMs: inboundAt ? Math.max(0, timestamp - inboundAt) : null,
        deferred: store.isWechatDeferred(wechatScope, inboundAt) || (window?.sent ?? 0) >= wechatResumeAfter },
      history: store.history(taskId).slice(0, taskId ? 12 : 8) };
  }

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, origin);
      const route = url.pathname;
      const method = request.method;
      if (method === 'GET' && files.has(route)) {
        const [body, type] = files.get(route);
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return response.end(body);
      }
      if (method === 'GET' && route === '/healthz') return json(response, 200, { ok: true });
      if (!route.startsWith('/api/')) throw fault(404, '页面不存在。');
      if (route.startsWith('/api/agent/')) {
        if (!sameSecret(request.headers.authorization, agentToken ? 'Bearer ' + agentToken : '')) {
          throw fault(401, '需要有效的机器人凭据。');
        }
        if (route === '/api/agent/token-saving' && method === 'GET') {
          return json(response, 200, { enabled: store.tokenSaving() });
        }
        if (route === '/api/agent/status' && method === 'GET') {
          const supplied = url.searchParams.get('taskId');
          const name = url.searchParams.get('query');
          const id = supplied || name ? matchTask(supplied, name) : null;
          return json(response, 200, operationalStatus(id));
        }
        if (method === 'POST' && ['/api/agent/schedule/plan', '/api/agent/schedule/apply'].includes(route)) {
          const body = await readJSON(request);
          const apply = route.endsWith('/apply');
          const timestamp = now();
          const key = getRequestKey(body);
          const entries = expandSchedule(body.schedule).map((entry) => ({
            ...entry, repeat: 'once',
            ...(apply && key ? { requestKey: createHash('sha256')
              .update(JSON.stringify([key, entry.dueAt, entry.title])).digest('hex') } : {})
          }));
          const occurrences = store.saveSchedule(entries, timestamp, apply);
          const counts = { planned: 0, created: 0, existing: 0, past: 0, changed: 0 };
          for (const { status } of occurrences) counts[status]++;
          if (counts.created) void trigger();
          return json(response, 200, { timeZone: 'Asia/Shanghai', repeat: 'once', counts,
            dates: [...new Set(occurrences.map((item) => item.dueAt.slice(0, 10)))], occurrences });
        }
        if (route === '/api/agent/inbox') {
          if (method === 'GET') return json(response, 200, { inbox: store.inbox(url.searchParams.get('archived') === 'true'), badge: store.badge() });
          if (method === 'POST') return json(response, 200, updateInbox(await readJSON(request)));
        }
        if (method === 'POST' && route === '/api/agent/daily') return json(response, 200, updateDaily(await readJSON(request), true));
        if (method === 'POST' && route === '/api/agent/delivery') return json(response, 200, updatePolicy(await readJSON(request), true));
        if (method === 'POST' && route === '/api/agent/test') {
          const body = await readJSON(request);
          if (!['push', 'fallback'].includes(body.channel)) throw fault(400, '请选择测试手机通知或备用链路。');
          return json(response, 202, queueTest(body.channel === 'fallback', getRequestKey(body)));
        }
        if (route === '/api/agent/wechat-turn' && method === 'POST') {
          const { id, action, body, quote, outcome, step } = await readJSON(request);
          if (typeof id !== 'string' || !/^[\da-f]{64}$/.test(id)) throw fault(400, '微信回执无效。');
          if (action === 'start' && typeof body === 'string' && body.length <= 5000 &&
              (!quote || (quote.state === 'missing' && quote.body === undefined) ||
                (quote.state === 'available' && typeof quote.body === 'string' && quote.body.length <= 2000))) {
            return json(response, 200, { created: store.startWechatTurn({ id, body, quote }, now()) });
          }
          if (action === 'processing' || action === 'sending') {
            store.advanceWechatTurn(id, action);
            return json(response, 200, { ok: true });
          }
          if (action === 'step' && typeof step?.key === 'string' && /^[\w:-]{1,80}$/.test(step.key) &&
              typeof step.label === 'string' && step.label.trim() && step.label.length <= 100 &&
              ['running', 'done', 'failed'].includes(step.state)) {
            const timestamp = now();
            const at = Number.isSafeInteger(step.at) && step.at > 0 && step.at <= timestamp ? step.at : timestamp;
            store.recordWechatTurnStep(id, { ...step, at, details: modelStepDetails(step.details) }, timestamp);
            return json(response, 200, { ok: true });
          }
          if (action === 'finish' && ['accepted', 'acknowledged', 'clarified', 'unknown', 'rejected'].includes(outcome)) {
            store.finishWechatTurn(id, outcome, now());
            if (['unknown', 'rejected'].includes(outcome)) void trigger();
            return json(response, 200, { ok: true });
          }
          throw fault(400, '微信回执无效。');
        }
        if (route === '/api/agent/conversation' && method === 'POST') {
          const { id, channel, direction, state, body, at, followupIds, contentOrigin, archiveId } = await readJSON(request);
          const timestamp = now();
          if (typeof id !== 'string' || !/^[\da-f]{64}$/.test(id) || !['wechat', 'qq'].includes(channel) ||
            !['inbound', 'outbound'].includes(direction) ||
            !(direction === 'inbound' ? state === 'received' : ['accepted', 'rejected', 'unknown'].includes(state)) ||
            typeof body !== 'string' || body.length > 5000) throw fault(400, '聊天事件无效。');
          store.recordConversation({ id, channel, direction, state, body, source: 'hook',
            contentOrigin: direction === 'outbound' && ['program', 'ai', 'mixed'].includes(contentOrigin) ? contentOrigin : undefined,
            archiveId: channel === 'wechat' && direction === 'outbound' && state === 'accepted' &&
              typeof archiveId === 'string' && /^archive:[\da-f]{64}$/.test(archiveId) ? archiveId : undefined,
            at: Number.isSafeInteger(at) && at > 0 && at <= timestamp + 60_000 ? at : timestamp });
          if (channel === 'wechat' && direction === 'outbound' && state === 'accepted' && Array.isArray(followupIds)) {
            store.markWechatFollowup(followupIds.filter((value) => typeof value === 'string' && value.length <= 150).slice(0, 3), timestamp);
          }
          return json(response, 200, { ok: true });
        }
        if (route === '/api/agent/wechat-followup' && method === 'GET') {
          const timestamp = now();
          syncWechat(timestamp);
          const { lastInboundAt } = store.wechatActivity(timestamp);
          const since = lastInboundAt && timestamp - lastInboundAt < 120_000 ? lastInboundAt : null;
          return json(response, 200, { reminders: since ? store.missedWechat(since, timestamp) : [] });
        }
        if (route !== '/api/agent/tasks') throw fault(404, '接口不存在。');
        if (method === 'GET') {
          const tasks = store.listTasks({ archived: url.searchParams.get('archived') === 'true', query: searchTerm(url.searchParams.get('query')) });
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0) throw fault(400, '分页位置无效。');
          return json(response, 200, { tasks: tasks.slice(offset, offset + 100), total: tasks.length,
            repeatUntilSupported: true, timeZone: 'Asia/Shanghai', now: new Date(now()).toISOString() });
        }
        if (method === 'POST') {
          const body = await readJSON(request);
          const key = getRequestKey(body);
          const id = Object.hasOwn(body, 'id') || Object.hasOwn(body, 'match')
            ? matchTask(body.id ?? (key && store.taskIdForRequest(key)), body.match, body.archived === false) : undefined;
          const task = saveTask(body, id, key);
          return json(response, id ? 200 : 201, { task, localTime: task.dueAt ? formatTime(task.dueAt) : null });
        }
        throw fault(405, '请求方法不受支持。');
      }
      if (method !== 'GET' && request.headers.origin !== origin) throw fault(403, '请从本站发起操作。');
      if (method === 'POST' && route === '/api/login') {
        const body = await readJSON(request);
        attempts = attempts.filter((at) => now() - at < 60_000);
        if (attempts.length >= 8) throw fault(429, '请稍等一分钟后再试。');
        if (!sameSecret(body.password, password)) {
          attempts.push(now());
          throw fault(401, '登录口令有误。');
        }
        const session = `${now() + sessionSeconds * 1000}.${randomBytes(18).toString('base64url')}`;
        response.setHeader('Set-Cookie', cookie(session + '.' + sign(session), sessionSeconds));
        return json(response, 200, { ok: true });
      }
      if (!validSession(request)) throw fault(401, '请先登录待办工作台。');
      if (method === 'POST' && route === '/api/logout') {
        response.setHeader('Set-Cookie', cookie('', 0));
        return json(response, 200, { ok: true });
      }
      if (method === 'GET' && route === '/api/badge') return json(response, 200, store.badge());
      if (route === '/api/openclaw/models' && method === 'GET') {
        return json(response, 200, await openClawModels?.get({ refresh: url.searchParams.get('refresh') === 'true' })
          ?? { current: null, provider: null, choices: [], providers: [], status: 'unavailable' });
      }
      if (route === '/api/openclaw/models' && method === 'PUT') {
        const { model, provider } = await readJSON(request);
        if (!openClawModels) throw fault(503, 'OpenClaw 网关暂不可用。');
        return json(response, 200, await openClawModels.set(model, provider));
      }
      if (method === 'GET' && route === '/api/model-usage') {
        if (openClawModels && !openClawModels.isDeepSeek()) throw fault(409, '当前供应商为 DeepSeek 时可查询。');
        const days = url.searchParams.get('days') ?? '30';
        if (!['1', '7', '30', '90'].includes(days)) throw fault(400, '请选择今日、近 7 天、近 30 天或近 90 天。');
        await modelUsage.refresh({ force: url.searchParams.get('refresh') === 'true' });
        if (openClawModels && !openClawModels.isDeepSeek()) throw fault(409, '当前供应商为 DeepSeek 时可查询。');
        return json(response, 200, modelUsage.overview(Number(days)));
      }
      if (method === 'PUT' && route === '/api/settings/model-alerts') {
        if (openClawModels && !openClawModels.isDeepSeek()) throw fault(409, '请选择 DeepSeek 后保存余额提醒。');
        const { enabled, CNY, USD } = await readJSON(request);
        if (typeof enabled !== 'boolean' || [CNY, USD].some((value) =>
          !Number.isFinite(value) || value < 0 || value > 10_000 || Number(value.toFixed(2)) !== value)) {
          throw fault(400, '请输入 0 至 10,000 之间的余额阈值，最多两位小数。');
        }
        return json(response, 200, store.saveModelAlertSettings({ enabled, CNY, USD }, now()));
      }
      if (method === 'GET' && route === '/api/chat') {
        const before = parseConversationCursor(url.searchParams.get('before'));
        if (before === null) throw fault(400, '消息起始位置无效。');
        const timestamp = now();
        syncWechat(timestamp);
        return json(response, 200, { ...store.conversation(before), session: readChatSession(timestamp) });
      }
      const mediaId = /^\/api\/chat\/media\/(\d+)$/.exec(route)?.[1];
      if (method === 'GET' && mediaId && Number.isSafeInteger(Number(mediaId))) {
        const item = resolveConversationAttachment(store.conversationAttachment(Number(mediaId)), chatMediaRoot);
        if (!item) throw fault(404, '附件已过保存期限或暂不可用。');
        const name = encodeURIComponent(item.name.toWellFormed()).replace(/['()*]/g, (value) => '%' + value.charCodeAt(0).toString(16));
        response.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': item.size, 'Cache-Control': 'private, no-store',
          'Content-Disposition': (item.mime === 'application/octet-stream' ? 'attachment' : 'inline') + "; filename*=UTF-8''" + name });
        const stream = createReadStream(item.path);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        return stream.pipe(response);
      }
      if (method === 'GET' && route === '/api/state') return json(response, 200, {
        ...operationalStatus(),
        tasks: store.listTasks(), archivedTasks: store.listTasks({ archived: true }), inbox: store.inbox(),
        archivedInbox: store.inbox(true), badge: store.badge(), history: store.history(),
        vapidKey
      });
      if (method === 'POST' && route === '/api/tasks') {
        return json(response, 201, saveTask(await readJSON(request), null));
      }
      const taskId = /^\/api\/tasks\/([\da-f-]{36})$/.exec(route)?.[1];
      if (method === 'PATCH' && taskId) {
        return json(response, 200, saveTask(await readJSON(request), taskId));
      }
      if (method === 'POST' && route === '/api/inbox/read') {
        const { id } = await readJSON(request);
        return json(response, 200, updateInbox({ action: 'read', id }).badge);
      }
      if (method === 'POST' && route === '/api/inbox/organize') return json(response, 200, updateInbox(await readJSON(request)));
      if (method === 'PUT' && route === '/api/settings') {
        return json(response, 200, updateDaily(await readJSON(request)));
      }
      if (method === 'PUT' && route === '/api/settings/token-saving') {
        const { enabled } = await readJSON(request);
        if (typeof enabled !== 'boolean') throw fault(400, '请选择开启或关闭节省 Token。');
        store.saveTokenSaving(enabled);
        return json(response, 200, { enabled });
      }
      if (method === 'PUT' && route === '/api/settings/delivery') {
        return json(response, 200, updatePolicy(await readJSON(request)));
      }
      if (method === 'POST' && route === '/api/push/subscriptions') {
        if (!vapidKey) throw fault(503, '请先在服务器配置 Web Push 密钥。');
        const subscription = normalizeSubscription(await readJSON(request));
        if (!subscription) throw fault(400, '推送订阅无效或浏览器的推送服务暂未支持。');
        store.subscribe(subscription);
        return json(response, 201, { ok: true });
      }
      if (method === 'DELETE' && route === '/api/push/subscriptions') {
        const { endpoint } = await readJSON(request);
        if (typeof endpoint === 'string' && endpoint.length <= 2048) store.unsubscribe(endpoint);
        return json(response, 200, { ok: true });
      }
      if (method === 'POST' && route === '/api/push/test') {
        return json(response, 202, queueTest(false));
      }
      if (method === 'POST' && route === '/api/fallback/test') {
        return json(response, 202, queueTest(true));
      }
      throw fault(404, '接口不存在。');
    } catch (error) {
      if (!error.status) console.error('请求处理失败。', error.code ?? error.name);
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : '服务暂时异常。', ...error.details });
    }
  });
}

export function start() {
  const env = process.env;
  const port = Number(env.PORT || 3100);
  const host = env.HOST || '127.0.0.1';
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:' + port).origin;
  const password = env.APP_PASSWORD;
  const sessionSecret = env.SESSION_SECRET;
  const agentToken = env.AGENT_TOKEN;
  if (!password || password.length < 12 || !sessionSecret || sessionSecret.length < 32 ||
      (agentToken && agentToken.length < 32)) throw new Error('请设置 APP_PASSWORD（至少 12 字符）和 SESSION_SECRET（至少 32 字符）；AGENT_TOKEN 如启用也需至少 32 字符。');
  if (!origin.startsWith('https:') && (!['127.0.0.1', '::1', 'localhost'].includes(host) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(origin).hostname))) throw new Error('远程部署请配置 HTTPS APP_ORIGIN。');
  const keys = [env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY];
  if (keys.some(Boolean) && !keys.every(Boolean)) throw new Error('请完整配置 WEB Push 的三个 VAPID 字段。');
  const vapid = keys.every(Boolean) ? { subject: keys[0], publicKey: keys[1], privateKey: keys[2] } : undefined;
  if (env.WECHAT_TARGET && !/^[\w-]+@im\.wechat$/.test(env.WECHAT_TARGET)) throw new Error('WECHAT_TARGET 请填写自己的 iLink 用户 ID。');
  if (env.QQ_TARGET && !/^[\w-]{8,128}$/.test(env.QQ_TARGET)) throw new Error('QQ_TARGET 请填写自己的机器人私聊 OpenID。');
  if (process.platform !== 'win32') process.umask(0o077);
  const store = createStore(env.DATABASE_PATH || './data/reminder.sqlite');
  const syncWechat = createWechatArchive(env.OPENCLAW_STATE_DIR, env.WECHAT_ACCOUNT, env.WECHAT_TARGET, store);
  const readChatSession = createOpenClawSessionReader(env.OPENCLAW_STATE_DIR, env.WECHAT_ACCOUNT, env.WECHAT_TARGET);
  syncWechat(Date.now());
  const command = { bin: env.OPENCLAW_BIN || 'openclaw', entry: env.OPENCLAW_JS_ENTRY,
    viaGateway: env.OPENCLAW_SEND_VIA_GATEWAY === 'true' };
  const callGateway = command.viaGateway && createGatewayRPC(command);
  const openClawModels = createOpenClawModels({ call: callGateway, readSession: readChatSession,
    readConfig: () => readOpenClawConfig(env.OPENCLAW_STATE_DIR) });
  const modelUsage = createModelUsage({ store, call: callGateway, stateDir: env.OPENCLAW_STATE_DIR,
    enabled: openClawModels.isDeepSeek });
  const sendQQ = createQQSender({ ...command, target: env.QQ_TARGET, account: env.QQ_ACCOUNT });
  const wechatScope = wechatDeliveryScope(env.WECHAT_ACCOUNT, env.WECHAT_TARGET);
  const readWechatInbound = () => readBoundWechatInbound(env.OPENCLAW_STATE_DIR, env.WECHAT_ACCOUNT, env.WECHAT_TARGET);
  const readWechatObservation = () => readWechatWindow(env.OPENCLAW_STATE_DIR, env.WECHAT_ACCOUNT, env.WECHAT_TARGET);
  store.recoverDelivery(Date.now());
  const scheduler = createScheduler({
    store, wechatScope, readWechatInbound, readWechatWindow: readWechatObservation,
    sendWechat: createWechatSender({ ...command, target: env.WECHAT_TARGET, account: env.WECHAT_ACCOUNT,
      requireServerId: env.WECHAT_REQUIRE_SERVER_ID === 'true' }), sendQQ, sendPush: createPushSender(vapid)
  });
  const app = createApp({ store, scheduler, origin, password, sessionSecret, agentToken,
    vapidKey: vapid?.publicKey ?? null, wechatConfigured: Boolean(env.WECHAT_TARGET), qqConfigured: Boolean(sendQQ),
    syncWechat, readChatSession, modelUsage, openClawModels, wechatScope,
    readWechatInbound, readWechatObservation,
    chatMediaRoot: env.OPENCLAW_STATE_DIR && join(env.OPENCLAW_STATE_DIR, 'media', 'inbound', 'openclaw-weixin-quotes') });
  const tick = () => {
    syncWechat(Date.now());
    return scheduler.tick().catch(() => console.error('调度执行失败，将在下一轮继续。'));
  };
  const timer = setInterval(tick, 1500);
  timer.unref();
  const usageStart = setTimeout(modelUsage.refresh, 20_000);
  const usageTimer = setInterval(modelUsage.refresh, 60_000);
  usageStart.unref();
  usageTimer.unref();
  app.listen(port, host, () => {
    console.log('提醒工作台：' + origin);
    void tick();
  });
  function stop() {
    clearInterval(timer);
    clearTimeout(usageStart);
    clearInterval(usageTimer);
    app.close(async () => {
      await tick();
      await modelUsage.close();
      store.close();
    });
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) start();
