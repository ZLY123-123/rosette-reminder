const args = process.argv.slice(2);
if (args[0] === 'gateway') {
  if (args[1] !== 'call' || args[2] !== 'send' || !args.includes('--json') || args.includes('--token')) process.exit(43);
  const { channel, to, accountId, message, idempotencyKey } = JSON.parse(args[args.indexOf('--params') + 1]);
  if (message !== "提醒\n提交材料 & 文件名有空格" || idempotencyKey !== 'reminder:' + channel + ':job-1') process.exit(44);
  if (channel === 'openclaw-weixin' && to === 'OWNER@im.wechat' && accountId === 'weixin-account') {
    console.log(JSON.stringify({ messageId: 'wechat-client-123', channel }));
    process.exit(0);
  }
  if (channel === 'qqbot' && to === 'qqbot:c2c:OWNER_QQ' && accountId === undefined) {
    console.log(JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'sendMessage ret=-2 errmsg=prepare failed' } }));
    process.exit(1);
  }
  process.exit(45);
}
const channel = args[args.indexOf('--channel') + 1];
const target = args[args.indexOf('--target') + 1];
if (args[0] !== 'message' || args[1] !== 'send' || !args.includes('--json')) process.exit(41);
if (channel === 'openclaw-weixin' && target === 'OWNER@im.wechat') {
  console.error('sendMessage ret=-2 errmsg=prepare failed');
  process.exitCode = 1;
} else if (channel === 'qqbot' && target === 'qqbot:c2c:OWNER_QQ') {
  console.log(JSON.stringify({ action: 'send', channel, payload: { result: { messageId: 'qq-response-123' } } }));
} else {
  process.exitCode = 42;
}
