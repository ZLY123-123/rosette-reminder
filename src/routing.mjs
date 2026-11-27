export const channels = ['wechat', 'qq', 'push'];
export const defaultPolicy = { levels: [['wechat'], ['qq', 'push']], fallback: 'unaccepted' };
export const wechatDeferredDetail = '微信会话待刷新，本次已跳过微信。收到新消息后恢复尝试。';

export function validPolicy(policy) {
  if (!['unaccepted', 'rejected'].includes(policy?.fallback) || !Array.isArray(policy.levels) ||
    policy.levels.length < 1 || policy.levels.length > channels.length ||
    policy.levels.some((level) => !Array.isArray(level) || !level.length)) return false;
  const selected = policy.levels.flat();
  return selected.every((channel) => channels.includes(channel)) && new Set(selected).size === selected.length;
}

export function jobPolicy(policy, dual) {
  const earlyPush = Boolean(dual && policy.levels.slice(1).some((level) => level.includes('push')));
  return {
    ...policy,
    levels: earlyPush ? policy.levels.map((level) => level.filter((channel) => channel !== 'push')).filter((level) => level.length) : policy.levels,
    earlyPush
  };
}

export function wasAccepted(status) {
  return status === 'accepted' || status === 'partial';
}

export function shouldDescend(statuses, fallback) {
  if (statuses.some(wasAccepted)) return false;
  return fallback === 'unaccepted' || statuses.some((status) => status === 'rejected' || status === 'failed') ||
    statuses.every((status) => status === 'skipped' || status === 'inbox_only');
}
