import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.argv[2];
if (!state) throw new Error('Pass the dedicated OpenClaw state directory.');

const projects = join(state, 'npm', 'projects');
const packages = readdirSync(projects, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(projects, entry.name, 'node_modules', '@tencent-weixin', 'openclaw-weixin'))
  .filter((directory) => existsSync(join(directory, 'package.json')));
if (packages.length !== 1) throw new Error('Expected one installed WeChat plugin.');

const [directory] = packages;
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
if (manifest.name !== '@tencent-weixin/openclaw-weixin' || manifest.version !== '2.4.10') {
  throw new Error('Review SenderId compatibility for this WeChat plugin version.');
}

function addProcessingHooks(source) {
  if (source.includes('feedback.bindRun(start.runId)')) return source;
  const starting = /^([ \t]*)logger\.debug\(`dispatchReplyFromConfig: starting /m;
  const options = /^([ \t]*)disableBlockStreaming: true,$/m;
  if (!starting.test(source) || !options.test(source)) throw new Error('Unexpected WeChat dispatch observer options.');
  return source.replace(starting, '$1feedback?.processing();\n$&').replace(options, `$1...(feedback ? {
                    onPreparedAgentRunStart: (start) => {
                        feedback.bindRun(start.runId);
                        if (replyOptions.onPreparedAgentRunStart) return replyOptions.onPreparedAgentRunStart(start);
                        return replyOptions.onAgentRunStart?.(start.runId, start.executionIdentityToken, start.options, start.transcriptStart);
                    },
                } : {}),
$&`);
}

function addResumeCommand(source) {
  if (source.includes('feedback?.matchesResume(full.item_list)')) return source;
  const routes = [...source.matchAll(/^([ \t]+)const route = deps\.channelRuntime\.routing\.resolveAgentRoute\(\{\r?$/gm)];
  if (routes.length !== 1) throw new Error('Unexpected WeChat route for the resume command.');
  const [route] = routes;
  const branch = `if (feedback?.matchesResume(full.item_list)) {
    await feedback.resume(() => {
        const resumeContext = getContextTokenFromMsgContext(ctx);
        if (resumeContext) setContextToken(deps.accountId, senderId, resumeContext);
    });
    return;
}`.split('\n').map((line) => route[1] + line).join('\n');
  return source.slice(0, route.index) + branch + '\n' + source.slice(route.index);
}

function addDeliveryOrigins(source) {
  if (source.includes('feedback?.deliveryOrigin(payload)')) return source;
  const start = source.indexOf('deliver: async (payload) => {');
  const end = source.indexOf('logger.debug(`dispatchReplyFromConfig: starting', start);
  if (start < 0 || end < 0) throw new Error('Unexpected WeChat reply delivery.');
  const direct = source.slice(0, start)
    .replace('await sendMessageWeixin({\n                    to: senderId, text,',
      'const sent = await sendMessageWeixin({\n                    to: senderId, text,')
    .replace('to: senderId, content: text, success: true, accountId: deps.accountId',
      'to: senderId, content: text, success: true, accountId: deps.accountId, contentOrigin: "program", serverMessageId: sent.serverMessageId')
    .replace('to: senderId, content: text, success: false, error: String(error), accountId: deps.accountId',
      'to: senderId, content: text, success: false, error: String(error), accountId: deps.accountId, contentOrigin: "program"');
  if (!direct.includes('serverMessageId: sent.serverMessageId') || !direct.includes('const sent = await sendMessageWeixin(')) {
    throw new Error('Unexpected WeChat program reply.');
  }
  const delivery = source.slice(start, end);
  const sends = /await (sendMessageWeixin|sendWeixinMediaFile)\(\{/g;
  const emits = /emitWeixinMessageSent\(\{([\s\S]*?)\}\);/g;
  if ([...delivery.matchAll(sends)].length !== 3 || [...delivery.matchAll(emits)].length !== 4) {
    throw new Error('Unexpected WeChat reply send and receipt paths.');
  }
  const patched = delivery
    .replace(/^([ \t]*)const rawText = payload.text/m, '$1let sent;\n$1const contentOrigin = feedback?.deliveryOrigin(payload);\n$&')
    .replace(sends, 'sent = await $1({')
    .replace(emits, (_full, fields) => {
      const metadata = fields.includes('success: true,') ? 'contentOrigin,\n$1serverMessageId: sent?.serverMessageId,' : 'contentOrigin,';
      return 'emitWeixinMessageSent({' + fields.replace(/^([ \t]*)runId,/m, '$&\n$1' + metadata) + '});';
    });
  return direct + patched + source.slice(end);
}

function patchSentHook(source) {
  if (source.includes('reminderContentOrigin')) return source;
  if (source.split('toPluginMessageSentEvent(canonical),').length !== 2) throw new Error('Unexpected WeChat sent hook.');
  return source.replace('  success: boolean;\n', '  success: boolean;\n  contentOrigin?: "program" | "ai";\n  serverMessageId?: string;\n')
    .replace(/^([ \t]*)fireAndForgetHook\(/m, '$1const event = toPluginMessageSentEvent(canonical);\n$&')
    .replace('toPluginMessageSentEvent(canonical),',
      '{ ...event, metadata: { ...event.metadata, reminderContentOrigin: params.contentOrigin, reminderServerMessageId: params.serverMessageId } },');
}

function patchTurn(source) {
  if (source.includes('from "./reminder-turn-feedback.mjs"')) return addProcessingHooks(source);
  function replace(before, after) {
    const [head, tail, extra] = source.split(before);
    if (tail === undefined || extra !== undefined) throw new Error('Unexpected WeChat 2.4.10 message dispatcher.');
    source = head + after + tail;
  }
  replace('import path from "node:path";', `import path from "node:path";
import { createWechatTurnFeedback, quoteContext, needsQuoteClarification } from "./reminder-turn-feedback.mjs";`);
  replace('const inboundMessageId = getWeixinMessageId(full);', `const inboundMessageId = getWeixinMessageId(full);
    const reference = full.item_list?.find((item) => item.ref_msg)?.ref_msg;
    const quote = quoteContext(ctx.ReplyToIsQuote, ctx.ReplyToBody, ctx.ReplyToQuoteText ?? reference?.partial_text);
    if (quote?.state === "available" && (!ctx.ReplyToBody || ctx.ReplyToBody === "[引用消息内容未缓存]")) {
        ctx.ReplyToBody = quote.body;
    }
    const feedback = !textBody.startsWith("/") && createWechatTurnFeedback({
        config: deps.config, accountId: deps.accountId, senderId, messageId: inboundMessageId,
        body: ctx.Body || "附件", contextToken: full.context_token, quote, warn: deps.errLog,
        send: async (text) => {
            try {
                await sendMessageWeixin({
                    to: senderId, text,
                    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken: full.context_token, accountId: deps.accountId, timeoutMs: 8000 },
                });
                emitWeixinMessageSent({ to: senderId, content: text, success: true, accountId: deps.accountId });
            } catch (error) {
                emitWeixinMessageSent({ to: senderId, content: text, success: false, error: String(error), accountId: deps.accountId });
                throw error;
            }
        },
    }) || undefined;
    try {
    if (feedback && needsQuoteClarification(ctx.Body, quote)) {
        // Preserve the original inbound message for the workbench and future quotes.
        await getQuoteStore()?.put({
            accountId: deps.accountId, conversationId: senderId, messageId: inboundMessageId,
            direction: "inbound", body: ctx.Body, createdAt: full.create_time_ms ?? Date.now(),
        }).catch(() => {});
        await feedback.clarify();
        return;
    }
    if (feedback && quote?.state === "missing") {
        ctx.ChannelPromptContext = [...(ctx.ChannelPromptContext ?? []),
            "当前消息携带引用，引用原文暂缺。若本条消息依赖该引用才能确定待办，请先请用户指明待办，等目标明确后再执行。"];
    }`);
  replace('const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];', `const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
            if (feedback && !mediaUrl && !text.trim()) return;
            feedback?.sending();`);
  for (const message of ['outbound: text sent to=', 'outbound: media sent OK to=', 'outbound: text sent OK to=']) {
    const log = 'logger.info(`' + message;
    replace(log, 'feedback?.accepted();\n                ' + log);
  }
  replace('deps.errLog(`weixin reply ${info.kind}: ${String(err)}`);', `deps.errLog(\`weixin reply \${info.kind}: \${String(err)}\`);
            if (feedback) {
                feedback.failed(err);
                return;
            }`);
  const trimmed = source.trimEnd();
  const ending = trimmed.endsWith('\n}') ? trimmed.length - 2 :
    source.lastIndexOf('\n}\n//# sourceMappingURL=process-message.js.map');
  if (ending < 0) throw new Error('Unexpected WeChat dispatcher ending.');
  return addProcessingHooks(source.slice(0, ending) + `
    } catch (error) {
        await feedback?.finish(error);
        throw error;
    } finally {
        await feedback?.finish();
    }\n}\n`);
}

// Use only the sender from the current iLink message. The adapter and the
// reminder tool each continue to enforce their own sender allowlists.
const mappings = [
  ['src/messaging/inbound.ts', [
    ['  From: string;\n  To: string;', '  From: string;\n  SenderId: string;\n  To: string;'],
    ['    From: from_user_id,\n    To: from_user_id,', '    From: from_user_id,\n    SenderId: from_user_id,\n    To: from_user_id,']
  ]],
  ['dist/src/messaging/inbound.js', [
    ['        From: from_user_id,\n        To: from_user_id,', '        From: from_user_id,\n        SenderId: from_user_id,\n        To: from_user_id,']
  ]]
];

const changes = mappings.map(([relative, replacements]) => {
  const path = join(directory, relative);
  const original = readFileSync(path, 'utf8');
  const patched = replacements.reduce((source, [before, after]) => {
    if (source.includes(after)) return source;
    const [head, tail, extra] = source.split(before);
    if (tail === undefined || extra !== undefined) throw new Error(`Unexpected WeChat plugin code in ${relative}.`);
    return head + after + tail;
  }, original);
  return { path, original, patched };
});

const helper = readFileSync(new URL('./weixin-turn-feedback.mjs', import.meta.url), 'utf8');
const resumeGate = readFileSync(new URL('../../src/wechat-resume.mjs', import.meta.url), 'utf8');
function patchSend(source) {
  if (source.includes('createWechatResumeSender(sendWeixinApi)')) return source;
  const target = 'import { sendMessage as sendMessageApi } from "../api/api.js";';
  const call = /(body: req,\s*\})\);/g;
  if (source.split(target).length !== 2 || [...source.matchAll(call)].length !== 3) {
    throw new Error('Unexpected WeChat 2.4.10 send-message calls.');
  }
  return source.replace(target, `import { sendMessage as sendWeixinApi } from "../api/api.js";
import { createWechatResumeSender } from "./reminder-wechat-resume.mjs";
const sendMessageApi = createWechatResumeSender(sendWeixinApi);`).replace(call, '$1, opts.accountId);');
}

for (const [relative, filename] of [
  ['src/messaging', 'process-message.ts'],
  ['dist/src/messaging', 'process-message.js']
]) {
  const dispatcher = join(directory, relative, filename);
  const original = readFileSync(dispatcher, 'utf8');
  const feedbackPath = join(directory, relative, 'reminder-turn-feedback.mjs');
  const gatePath = join(directory, relative, 'reminder-wechat-resume.mjs');
  const extension = relative.startsWith('dist') ? '.js' : '.ts';
  const senderPath = join(directory, relative, 'send' + extension);
  const originalSender = readFileSync(senderPath, 'utf8');
  const hookPath = join(directory, relative, 'outbound-hooks' + extension);
  const originalHook = readFileSync(hookPath, 'utf8');
  changes.push(
    { path: feedbackPath, original: existsSync(feedbackPath) ? readFileSync(feedbackPath, 'utf8') : null, patched: helper },
    { path: dispatcher, original, patched: addDeliveryOrigins(addResumeCommand(patchTurn(original))) },
    { path: gatePath, original: existsSync(gatePath) ? readFileSync(gatePath, 'utf8') : null, patched: resumeGate },
    { path: senderPath, original: originalSender, patched: patchSend(originalSender) },
    { path: hookPath, original: originalHook, patched: patchSentHook(originalHook) }
  );
}

for (const { path, original, patched } of changes) {
  if (original === patched) continue;
  const temporary = path + '.reminder-' + process.pid;
  writeFileSync(temporary, patched, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
console.log('WeChat 2.4.10 sender and reply feedback are ready.');
