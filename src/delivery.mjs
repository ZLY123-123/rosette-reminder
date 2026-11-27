import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import webPush from 'web-push';
import { wechatDeferredDetail } from './routing.mjs';
import { wechatQuietMs, wechatResumeObsolete, wechatResumeWaiting } from './wechat-resume.mjs';

const execute = promisify(execFile);

export function wechatDeliveryScope(account, recipient) {
  return recipient ? createHash('sha256').update(JSON.stringify([account ?? null, recipient])).digest('hex') : null;
}

function classifyChatSend(output, errorOutput = '', exitCode = 0, requireServerId = false) {
  const rejection = (value) => /\b(?:ret|errcode)\s*[:=]\s*(-\d+)\b/i.exec(value)?.[1];
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    const jsonStart = output.search(/^\{/m);
    if (jsonStart >= 0) {
      try { result = JSON.parse(output.slice(jsonStart).trim()); } catch {}
    }
  }
  const envelopes = [result, result?.payload, result?.result, result?.payload?.result, result?.payload?.result?.result,
    ...(Array.isArray(result?.payload?.results) ? result.payload.results : [])].filter(Boolean);
  const code = envelopes.flatMap((entry) => [entry.ret, entry.errcode]).find((value) => /^-?\d+$/.test(value) && Number(value) !== 0)
    ?? rejection(errorOutput + '\n' + output);
  if (code !== undefined) return { status: 'rejected', detail: `微信错误码 ${code}` };
  if (exitCode !== 0 || envelopes.some((item) => item.ok === false || item.success === false || item.dryRun === true ||
    (item.deliveryStatus && !['sent', 'accepted'].includes(item.deliveryStatus)) || item.outcome === 'not_sent')) {
    return { status: 'unknown', detail: '微信发送异常或超时，结果待确认' };
  }
  const serverId = envelopes.find((item) => item.serverMessageId || item.message_id);
  if (serverId) return { status: 'accepted' };
  if (!requireServerId && envelopes.some((item) => typeof item.messageId === 'string' && item.messageId.trim())) {
    return { status: 'accepted', detail: '插件受理，手机端待确认' };
  }
  return { status: 'unknown', detail: requireServerId ? '微信 CLI 缺少服务端消息编号' : '微信 CLI 缺少发送编号' };
}

export function classifyWechat(output, errorOutput, exitCode, requireServerId) {
  const diagnostic = (errorOutput ?? '') + '\n' + output;
  if (diagnostic.includes(wechatResumeObsolete)) return { status: 'cancelled' };
  if (diagnostic.includes(wechatResumeWaiting)) return { status: 'skipped', detail: wechatDeferredDetail };
  const result = classifyChatSend(output, errorOutput, exitCode, requireServerId);
  if (result.detail === '微信错误码 -2' && /\bprepare failed\b/i.test(diagnostic)) {
    return { status: 'rejected', detail: '微信拒收（-2 / prepare failed）', prepareFailed: true };
  }
  return result;
}

function createClawSender({ target, account, bin, entry, channel, classify, label, viaGateway }) {
  if (!target) return async () => ({ status: 'skipped', detail: label + '尚未配置' });
  return async ({ id, title, body }) => {
    if (!entry && process.platform === 'win32' && !bin.toLowerCase().endsWith('.exe')) {
      return { status: 'unknown', detail: 'Windows 请配置 OPENCLAW_JS_ENTRY 或 .exe 路径' };
    }
    const executable = entry ? process.execPath : bin;
    const message = title + '\n' + body;
    // The resident gateway owns the transcript. The standalone sender can leave its sequence stale.
    const command = viaGateway ? [
      'gateway', 'call', 'send', '--json', '--timeout', '12000', '--params',
      JSON.stringify({ channel, to: target, accountId: account || undefined, message, idempotencyKey: 'reminder:' + channel + ':' + id })
    ] : [
      'message', 'send', '--channel', channel, '--target', target,
      ...(account ? ['--account', account] : []), '--message', message, '--json'
    ];
    const args = entry ? [entry, ...command] : command;
    try {
      const { stdout, stderr } = await execute(executable, args, { timeout: 15_000, maxBuffer: 256_000, windowsHide: true });
      return classify(stdout, stderr);
    } catch (error) {
      return classify(error.stdout ?? '', error.stderr ?? '', error.code || 1);
    }
  };
}

export function createWechatSender(options) {
  return createClawSender({ ...options, channel: 'openclaw-weixin', label: '微信',
    classify: (stdout, stderr, code) => classifyWechat(stdout, stderr, code, options.requireServerId) });
}

export function classifyQQ(output, errorOutput = '', exitCode = 0) {
  const result = classifyChatSend(output, errorOutput, exitCode);
  if (result.status === 'accepted') return { status: 'accepted', detail: 'QQ 插件受理，手机端待确认' };
  return { status: result.status, detail: result.status === 'rejected' ? result.detail.replace('微信', 'QQ') :
    'QQ 发送未获确认；可检查权限、账号和 OpenID' };
}

export function createQQSender(options) {
  if (!options.target) return undefined;
  return createClawSender({ ...options, channel: 'qqbot', target: 'qqbot:c2c:' + options.target,
    label: 'QQ', classify: classifyQQ });
}

export function normalizeSubscription(input) {
  if (typeof input?.endpoint !== 'string' || input.endpoint.length > 2048) return null;
  let url;
  try { url = new URL(input.endpoint); } catch { return null; }
  const trustedHost = url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com') ||
    ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname);
  if (!trustedHost || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const { p256dh, auth } = input.keys ?? {};
  if (typeof p256dh !== 'string' || !/^[\w-]{87}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[\w-]{22}$/.test(auth)) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

export function createPushSender(vapidDetails) {
  return async (target, badge) => {
    if (!target.config) return 'expired';
    if (!vapidDetails) return 'failed';
    const payload = { id: target.job_id, title: target.title,
      body: Array.from(target.body).slice(0, 180).join(''), badge };
    try {
      await webPush.sendNotification(JSON.parse(target.config), JSON.stringify(payload),
        { vapidDetails, TTL: 1800, urgency: 'high', timeout: 7000 });
      return 'accepted';
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) return 'expired';
      if (!error.statusCode || error.statusCode === 429 || error.statusCode >= 500) return 'retry';
      return 'failed';
    }
  };
}

export function createScheduler({ store, sendWechat, sendQQ, sendPush, wechatScope,
  readWechatInbound = store.lastWechatInbound, readWechatWindow, now = Date.now }) {
  const running = new Map();
  const requested = new Set();
  const dispatchers = {
    wechat: () => dispatchChat('wechat', sendWechat, '微信'),
    qq: () => dispatchChat('qq', sendQQ, 'QQ'),
    push: dispatchPush
  };
  function obsoleteNotice(id, inboundAt) {
    return id.startsWith('wechat-resume:') && inboundAt &&
      id !== 'wechat-resume:' + wechatScope + ':' + inboundAt;
  }

  async function dispatchChat(channel, send, label) {
    for (let turn = 0; turn < 8; turn++) {
      const jobs = channel === 'wechat' ? store.claimWechatBatch() : [store.claimChannel(channel)].filter(Boolean);
      const [job] = jobs;
      if (!job) return;
      const delivery = jobs.length === 1 ? job : {
        id: job.id, title: `待办提醒 · ${jobs.length} 项`, body: jobs.map((item) => '• ' + item.body).join('\n')
      };
      const scope = channel === 'wechat' ? wechatScope : null;
      const lastInboundAt = scope ? readWechatInbound() : null;
      if (obsoleteNotice(job.id, lastInboundAt ?? (job.id.startsWith('wechat-resume:') ? readWechatInbound() : null))) {
        store.cancelWechatResume(job.id, now());
        continue;
      }
      let result;
      try {
        result = scope && store.isWechatDeferred(scope, lastInboundAt)
          ? { status: 'skipped', detail: wechatDeferredDetail }
          : send ? await send(delivery) : { status: 'skipped', detail: label + '尚未配置' };
      }
      catch { result = { status: 'unknown', detail: label + '发送异常' }; }
      const timestamp = now();
      if (result.status === 'cancelled' && job.id.startsWith('wechat-resume:')) {
        store.cancelWechatResume(job.id, timestamp);
        continue;
      }
      // Long silence corroborates the rejection. The platform's token lifetime can vary.
      const hold = scope && result.prepareFailed && lastInboundAt && timestamp - lastInboundAt >= wechatQuietMs &&
        Buffer.byteLength(delivery.title + '\n' + delivery.body) <= 1024 ? { scope, inboundAt: lastInboundAt } : undefined;
      store.finishBatch(channel, jobs, result, timestamp, hold);
      if (result.status !== 'skipped') store.recordConversation({
        id: 'job:' + channel + ':' + job.id, channel, direction: 'outbound', source: 'scheduler',
        state: result.status, body: delivery.title + '\n' + delivery.body, at: timestamp
      });
      kickOthers(channel);
    }
  }
  async function dispatchPush() {
    for (let turn = 0; turn < 8; turn++) {
      const target = store.nextPush(now());
      if (!target) return;
      if (target.job_id.startsWith('wechat-resume:') && obsoleteNotice(target.job_id, readWechatInbound())) {
        store.cancelWechatResume(target.job_id, now());
        continue;
      }
      let status;
      try { status = await sendPush(target, store.badge()); } catch { status = 'retry'; }
      store.finishPush(target, status, now());
      kickOthers('push');
    }
  }

  function kick(channel) {
    requested.add(channel);
    if (!running.has(channel)) {
      const work = Promise.resolve().then(async () => {
        try {
          while (requested.delete(channel)) await dispatchers[channel]();
        } finally {
          running.delete(channel);
        }
      });
      running.set(channel, work);
    }
    return running.get(channel);
  }

  function kickOthers(channel) {
    for (const name of Object.keys(dispatchers)) {
      if (name !== channel) void kick(name).catch(() => {});
    }
  }

  return {
    async tick() {
      const timestamp = now();
      store.scheduleDaily(timestamp);
      if (wechatScope && readWechatWindow) store.scheduleWechatResume(wechatScope, readWechatWindow(), timestamp);
      store.activateDue(timestamp);
      kickOthers();
      while (running.size) {
        const results = await Promise.allSettled([...running.values()]);
        const failure = results.find((item) => item.status === 'rejected');
        if (failure) throw failure.reason;
      }
    }
  };
}
