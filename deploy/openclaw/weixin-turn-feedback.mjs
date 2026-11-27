import { createHash } from 'node:crypto';

const activeRuns = globalThis[Symbol.for('reminder-desk:wechat-runs')] ??= new Map();

export const emptyReplyText = '收到这条消息。当前回复暂缺，请在 ROSETTE 工作台核对处理结果后再决定是否重试。';
export const failedReplyText = '收到这条消息。处理时遇到异常，请先在 ROSETTE 工作台核对结果，再决定是否重试。';
export const quoteClarification = '收到。引用原文暂缺，请告诉我具体是哪件待办，我再处理。';
export const resumeReplyText = '微信通道已恢复。';
const wechatTextItem = 1;

export function needsQuoteClarification(body, quote) {
  return quote?.state === 'missing' &&
    /^(?:已完成|完成了|完成|标记完成|做完了|改时间|改期|取消提醒|取消|删除|归档|再提醒我)[。！!.]*$/u.test(body.trim());
}

export function quoteContext(quoted, body, excerpt) {
  if (!quoted) return undefined;
  const text = [excerpt, body].find((value) => typeof value === 'string' && value.trim() &&
    !/^\[引用(?:消息内容未缓存|的.+已过期[:：\]])/.test(value.trim()));
  return text ? { state: 'available', body: text.trim().slice(0, 2000) } : { state: 'missing' };
}

export function createWechatTurnFeedback({
  config, accountId, senderId, messageId, body, contextToken, quote, send, warn,
  token = process.env.REMINDER_AGENT_TOKEN,
  fetcher = fetch
}) {
  const binding = config?.plugins?.entries?.['reminder-desk']?.config;
  const owner = binding?.wechatSender?.replace(/^(?:openclaw-weixin:|weixin:)/, '');
  if (!senderId || senderId !== owner || (binding.wechatAccount && binding.wechatAccount !== accountId) ||
      typeof messageId !== 'string' || !messageId || messageId.length > 150 || !token || token.length < 32) return;
  const id = createHash('sha256').update(JSON.stringify([accountId, senderId, messageId])).digest('hex');
  // The token stays on the dedicated gateway's loopback workbench connection.
  async function report(data) {
    try {
      const response = await fetcher('http://127.0.0.1:3100/api/agent/wechat-turn', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...data }),
        redirect: 'error',
        signal: AbortSignal.timeout(4000)
      });
      if (response.ok) return await response.json();
    } catch {}
    warn('ROSETTE 微信反馈同步暂缓。');
  }

  const started = report({
    action: 'start',
    body: body.slice(0, 500),
    quote: quote?.state === 'available' ? { ...quote, body: quote.body.slice(0, 1800) } : quote
  });
  let attempted = false;
  let delivered;
  let settled = false;
  let processing = false;
  let modelOutput = false;
  let failure = 'unknown';
  const attempt = async (text) => {
    try {
      await send(text);
      return 'accepted';
    } catch (error) {
      return /\b(?:ret|errcode)\s*[:=]\s*-\d+\b/i.test(String(error)) ? 'rejected' : 'unknown';
    }
  };
  function publish(data) {
    void started.then((receipt) => {
      if (receipt?.created) return report(data);
    });
  }
  function recordStep(key, label, state, details) {
    publish({ action: 'step', step: { key, label, state, details, at: Date.now() } });
  }
  const runTrace = { recordStep, expiresAt: 0, noteModelOutput() { modelOutput = true; } };
  function sending() {
    if (attempted) return;
    attempted = true;
    publish({ action: 'sending' });
    recordStep('wechat', '发送微信回复', 'running');
  }
  return {
    deliveryOrigin(payload) {
      if (payload.isError || payload.isStatusNotice || payload.isFallbackNotice || payload.isCompactionNotice) return 'program';
      return modelOutput ? 'ai' : undefined;
    },
    matchesResume(items) {
      if (quote || !Array.isArray(items) || items.length !== 1) return false;
      const [item] = items;
      const text = item?.text_item?.text;
      return item?.type === wechatTextItem && !item.ref_msg && typeof text === 'string' && text.trim() === '继续';
    },
    async resume(updateContext) {
      const receipt = await started;
      if (receipt?.created === false) return;
      recordStep('resume', '继续指令 · 系统直接回复', 'done');
      if (!contextToken) return;
      updateContext();
      sending();
      failure = await attempt(resumeReplyText);
      if (failure === 'accepted') delivered = 'accepted';
    },
    processing() {
      processing = true;
      publish({ action: 'processing' });
      recordStep('gateway', 'OpenClaw 网关处理', 'running');
    },
    bindRun(runId) {
      if (typeof runId !== 'string' || !runId) return;
      const now = Date.now();
      for (const [key, trace] of activeRuns) if (trace.expiresAt <= now) activeRuns.delete(key);
      if (activeRuns.size >= 256) activeRuns.delete(activeRuns.keys().next().value);
      runTrace.expiresAt = now + 600_000;
      activeRuns.set(runId, runTrace);
    },
    sending,
    accepted() { delivered = 'accepted'; },
    failed(error) {
      if (/\b(?:ret|errcode)\s*[:=]\s*-\d+\b/i.test(String(error))) failure = 'rejected';
    },
    async clarify() {
      sending();
      const receipt = await started;
      if (contextToken && receipt?.created !== false) {
        failure = await attempt(quoteClarification);
        if (failure === 'accepted') delivered = 'clarified';
      }
    },
    async finish(error) {
      if (settled) return;
      settled = true;
      runTrace.expiresAt = Date.now() + 15_000;
      const receipt = await started;
      if (receipt?.created === false && !delivered) return;
      if (processing) recordStep('gateway', 'OpenClaw 网关处理', error ? 'failed' : 'done');
      if (!delivered && !attempted && contextToken) {
        recordStep('fallback', error ? '生成异常回执' : '生成空回复回执', 'done');
        sending();
        failure = await attempt(error ? failedReplyText : emptyReplyText);
        if (failure === 'accepted') delivered = 'acknowledged';
      }
      if (attempted) recordStep('wechat', '发送微信回复', delivered ? 'done' : 'failed');
      const outcome = delivered ?? failure;
      if (!(await report({ action: 'finish', outcome })) && !delivered) {
        warn('微信回复暂缺，ROSETTE 工作台反馈待恢复。');
      }
    }
  };
}
