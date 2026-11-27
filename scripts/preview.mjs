import { randomBytes } from 'node:crypto';

const port = Number(process.env.PORT || 3176);
const password = randomBytes(12).toString('base64url');
Object.assign(process.env, {
  PORT: String(port), HOST: '127.0.0.1', APP_ORIGIN: 'http://localhost:' + port,
  DATABASE_PATH: ':memory:', APP_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('base64url'),
  WECHAT_TARGET: '', QQ_TARGET: '', AGENT_TOKEN: '', VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: ''
});
const { start } = await import('../src/server.mjs');
start();
console.log('仅本机预览，数据保存在内存中。本次口令：' + password);
