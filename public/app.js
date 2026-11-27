const byId = (id) => document.getElementById(id);
const taskForm = byId('task-form');
const settingsForm = byId('settings-form');
const policyForm = byId('policy-form');
const modelAlertForm = byId('model-alert-form');
const modelSelectionForm = byId('model-selection');
const tokenSavingSwitch = byId('token-saving');
const viewNames = { home: '概览', tasks: '待办', chat: '对话', alerts: '提醒', settings: '设置' };
const onMobile = matchMedia('(max-width: 780px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const channelLabels = { wechat: '微信', qq: 'QQ', push: '手机通知' };
const channelKeys = Object.keys(channelLabels);
const presets = {
  default: { levels: [['wechat'], ['qq', 'push']], fallback: 'unaccepted' },
  sequence: { levels: [['wechat'], ['qq'], ['push']], fallback: 'rejected' },
  parallel: { levels: [channelKeys], fallback: 'unaccepted' }
};
const shanghai = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});
const repeatNames = { daily: '每天', weekly: '每周' };
const statuses = { accepted: '已受理', rejected: '拒收', unknown: '待确认', failed: '发送失败', pending: '等待发送',
  sending: '发送中', inbox_only: '已存网页', skipped: '未使用', partial: '部分受理' };
const replyStages = {
  received: '网关已收到', processing: '处理中', sending: '发送回复中', accepted: '回复已受理',
  acknowledged: '已发异常回执', clarified: '已发追问', rejected: '微信拒收', unknown: '结果待核对', finished: '处理结束'
};
const stepStates = { running: '进行中', done: '已完成', failed: '异常' };
const chatTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
let state, editing, subscribed = false, registration, filter = 'all', refreshId = 0;
let activeView = 'home';
let showArchivedInbox = false;
let chatMessages = [], chatCursor = null, chatLoaded = false, chatRefreshing = false, chatRefreshId = 0;
let modelRefreshId = 0, modelRefreshAt = 0, modelRefreshing = false, modelAlertsLoaded = false;
let modelSelection, optionsRefreshId = 0, optionsRefreshAt = 0, optionsRefreshing = false, modelSaving = false;
let tokenSavingRevision = 0;
const expandedChatProcessing = new Set();
const tokenNumber = new Intl.NumberFormat('zh-CN');
const tokenText = (value) => Number.isFinite(value) ? tokenNumber.format(value) : '—';
const currencyText = (value, currency, maximumFractionDigits = 6) => {
  if (!Number.isFinite(value)) return '—';
  if (!['CNY', 'USD'].includes(currency)) return tokenText(value) + ' ' + currency;
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits }).format(value);
};
const local = (time) => shanghai.format(time);

function el(tag, value = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function message(text, error = false) {
  const notice = byId('notice');
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = !text;
}

async function api(path, method = 'GET', body) {
  const response = await fetch('./api/' + path, {
    method, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

function action(label, callback) {
  const button = el('button', label, 'quiet');
  button.type = 'button';
  button.addEventListener('click', () => void run(callback, button));
  return button;
}

async function run(callback, button) {
  if (button?.getAttribute('aria-busy') === 'true') return;
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  try {
    await callback();
  } catch (error) {
    message(error.message || '操作失败，请稍后再试。', true);
  } finally {
    button?.removeAttribute('aria-busy');
    if (button?.isConnected && button !== byId('push-toggle') && button !== byId('push-test')) button.disabled = false;
    if (button === byId('push-toggle') || button === byId('push-test')) renderNotificationStatus();
  }
}

function animateListChange(id) {
  const list = byId(id);
  if (reducedMotion.matches || !list.animate) return;
  list.getAnimations().find((animation) => animation.id === 'list-change')?.cancel();
  const motion = getComputedStyle(list);
  list.animate([{ opacity: 0.8 }, { opacity: 1 }], {
    id: 'list-change', duration: parseFloat(motion.getPropertyValue('--motion-fast')),
    easing: motion.getPropertyValue('--motion-ease').trim()
  });
}

function clearEditor() {
  editing = undefined;
  taskForm.reset();
  byId('task-save').textContent = '添加待办';
  byId('editor-heading').textContent = '添加待办';
  byId('cancel-edit').hidden = true;
  syncRepeatField();
}

function syncRepeatField() {
  const fields = taskForm.elements;
  byId('repeat-until').hidden = fields.repeat.value === 'once';
  fields.repeatUntil.min = fields.due.value.slice(0, 10);
}

function editTask(task) {
  editing = task;
  taskForm.elements.title.value = task.title;
  taskForm.elements.due.value = task.dueAt ? local(task.dueAt).replace(' ', 'T') : '';
  taskForm.elements.repeat.value = task.repeat;
  taskForm.elements.repeatUntil.value = task.repeatUntil ?? '';
  taskForm.elements.dual.checked = Boolean(task.dual);
  byId('task-save').textContent = '保存修改';
  byId('editor-heading').textContent = '编辑待办';
  byId('task-editor').open = true;
  byId('cancel-edit').hidden = false;
  syncRepeatField();
  taskForm.elements.title.focus();
}

function renderTasks() {
  const now = Date.now();
  const today = local(now).slice(0, 10);
  const pending = state.tasks.filter((task) => !task.completed);
  byId('pending-total').textContent = pending.length + ' 项待办';
  let groups;
  if (filter === 'archived') groups = [['已归档', state.archivedTasks ?? []]];
  else if (filter === 'done') groups = [['已完成', state.tasks.filter((task) => task.completed)]];
  else {
    groups = [
      ['已到期', pending.filter((task) => task.dueAt !== null && task.dueAt <= now)],
      ['今天', pending.filter((task) => task.dueAt > now && local(task.dueAt).startsWith(today))],
      ['接下来', pending.filter((task) => task.dueAt > now && !local(task.dueAt).startsWith(today))],
      ['待安排', pending.filter((task) => task.dueAt === null && !task.repeatUntil)],
      ['周期已结束', pending.filter((task) => task.dueAt === null && task.repeatUntil)]
    ];
    if (filter === 'today') groups = groups.slice(0, 2);
  }
  const list = byId('tasks');
  list.replaceChildren();
  for (const [label, tasks] of groups) {
    if (!tasks.length) continue;
    list.append(el('h3', label, 'group-label'));
    for (const task of tasks) {
      const row = el('div', '', 'row' + (task.completed ? ' done' : ''));
      const taskInfo = el('div');
      const description = [task.dueAt ? local(task.dueAt) : task.repeatUntil ? '周期已结束' : '待安排', repeatNames[task.repeat],
        task.repeatUntil ? '至 ' + task.repeatUntil : '',
        task.dual ? '手机通知提前' : ''].filter(Boolean).join(' · ');
      taskInfo.append(el('strong', task.title), el('p', description, 'hint'));
      const actions = el('div', '', 'actions');
      const changeTask = async (change) => {
        await api('tasks/' + task.id, 'PATCH', change);
        if (editing?.id === task.id) clearEditor();
        await refresh();
      };
      if (task.archivedAt !== null && task.archivedAt !== undefined) actions.append(action('恢复', () => changeTask({ archived: false })));
      else actions.append(action('编辑', () => editTask(task)),
        action(task.completed ? '恢复' : '完成', () => changeTask({ completed: !task.completed })),
        action('归档', () => changeTask({ archived: true })));
      row.append(taskInfo, actions);
      list.append(row);
    }
  }
  if (!list.childElementCount) list.append(el('p', '这一栏暂时空着。', 'empty'));
}

function renderInbox() {
  byId('unread').textContent = state.badge.count;
  byId('nav-unread').textContent = state.badge.count > 99 ? '99+' : state.badge.count;
  byId('nav-unread').hidden = state.badge.count === 0;
  byId('read-all').disabled = state.badge.count === 0 || showArchivedInbox;
  byId('inbox-clear').hidden = showArchivedInbox;
  byId('inbox-clear').disabled = state.inbox.length === 0;
  byId('inbox-restore-latest').hidden = !showArchivedInbox || !state.archivedInbox?.length;
  byId('inbox-archive-view').setAttribute('aria-pressed', String(showArchivedInbox));
  byId('inbox-archive-view').textContent = showArchivedInbox ? '返回收件箱' : '查看归档';
  const list = byId('inbox');
  list.replaceChildren();
  for (const item of (showArchivedInbox ? state.archivedInbox ?? [] : state.inbox)) {
    const row = el('article', '', 'row' + (item.read ? ' read' : ''));
    row.id = 'item-' + item.id;
    const content = el('div');
    content.append(el('strong', item.title), el('p', item.body), el('p', local(item.createdAt), 'hint'));
    row.append(content);
    if (showArchivedInbox) row.append(action('恢复', () => organizeInbox('restore', item.id)));
    else {
      const actions = el('div', '', 'actions');
      actions.append(action(item.read ? '未读' : '已读', () => organizeInbox(item.read ? 'unread' : 'read', item.id)),
        action('归档', () => organizeInbox('archive', item.id)));
      row.append(actions);
    }
    list.append(row);
  }
  if (!list.childElementCount) list.append(el('p', showArchivedInbox ? '提醒归档为空。' : '网页收件箱暂时空着。', 'empty'));
}

async function organizeInbox(action, id) {
  const result = await api('inbox/organize', 'POST', { action, id });
  await refresh();
  if (action === 'restore') message('已恢复 ' + result.changed + ' 条提醒。');
  else if (action === 'archive') message('已归档 ' + result.changed + ' 条提醒，可随时恢复。');
}

function renderOverview() {
  const pending = state.tasks.filter((task) => !task.completed);
  const now = Date.now();
  const today = local(now).slice(0, 10);
  const next = pending.find((task) => task.dueAt && task.dueAt > now);
  byId('next-title').textContent = next?.title ?? '暂无已安排的提醒';
  byId('next-time').textContent = next ? local(next.dueAt) + ' · 北京时间' : '';
  const preview = (id, items, empty) => {
    const list = byId(id);
    list.classList.toggle('is-empty', items.length === 0);
    list.replaceChildren(...(items.length ? items.slice(0, 3).map(([title, detail]) => {
      const row = el('div', '', 'row');
      const info = el('div');
      info.append(el('strong', title), el('p', detail, 'hint'));
      row.append(info);
      return row;
    }) : [el('p', empty, 'empty')]));
  };
  preview('today-preview', pending.filter((task) => task.dueAt !== null && local(task.dueAt).startsWith(today))
    .map((task) => [task.title, local(task.dueAt).slice(11)]), '今天的待办暂时空着。');
  preview('inbox-preview', state.inbox.map((item) => [item.title, item.read ? local(item.createdAt) : '未读 · ' + local(item.createdAt)]),
    '网页收件箱暂时空着。');
  const activity = state.wechatActivity;
  preview('chat-preview', state.wechatConfigured ? [['微信已绑定', activity?.lastInboundAt
    ? '最近入站 ' + local(activity.lastInboundAt) : '等待第一条消息']] : [], '等待绑定微信。');
}

function viewFromLocation() {
  if (location.hash === '#mailbox' || location.hash.startsWith('#notice=') || location.hash === '#delivery-log') return 'alerts';
  if (location.hash === '#tasks' || location.hash === '#agenda') return 'tasks';
  if (location.hash === '#notifications' || location.pathname.endsWith('/settings')) return 'settings';
  return location.pathname.endsWith('/chat') ? 'chat' : 'home';
}

function showView({ scroll = false } = {}) {
  activeView = viewFromLocation();
  byId('view-title').textContent = state ? activeView === 'chat' ? 'OpenClaw 对话' : viewNames[activeView] : '提醒工作台';
  document.title = state ? viewNames[activeView] + ' · ROSETTE' : 'ROSETTE · 提醒工作台';
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== activeView;
  for (const link of byId('navigation').querySelectorAll('a')) {
    if (link.dataset.view === activeView) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (activeView === 'settings') {
    if (location.hash === '#notifications') {
      const settings = byId('settings-scroll');
      settings.scrollTop += byId('notifications').getBoundingClientRect().top - settings.getBoundingClientRect().top;
    } else if (scroll) byId('settings-scroll').scrollTop = 0;
  }
}

function renderChatSession(session) {
  const add = (id, value) => { byId(id).textContent = value ?? '—'; };
  const format = new Intl.NumberFormat('zh-CN');
  add('session-label', session?.label ? '微信私聊 · ' + session.label : '微信私聊');
  add('session-model', session?.model);
  add('session-last-active', session?.lastInteractionAt ? local(session.lastInteractionAt) : null);
  byId('session-details').hidden = !session;
  if (!session) {
    byId('session-details').open = false;
    return;
  }
  add('session-agent', session.agentId);
  add('session-key', session.sessionKey);
  add('session-id', session.sessionId);
  add('session-started', session.startedAt ? local(session.startedAt) : null);
  add('session-model-source', { session: '会话设定', default: '代理默认', last_used: '最近运行' }[session.modelSource]);
  byId('session-last-used-row').hidden = !session.lastUsed || session.lastUsed === session.model;
  add('session-last-used', session.lastUsed);
  add('session-tokens', session.contextTokens
    ? (session.lastContextTokens ? format.format(session.lastContextTokens) : '—') + ' / ' + format.format(session.contextTokens)
    : null);
}

function deliveryTone(status) {
  if (status === 'rejected' || status === 'failed') return 'failure';
  if (status === 'unknown' || status === 'partial') return 'uncertain';
  return '';
}

function chatOrigin(origin) {
  const labels = { program: '程序发送', ai: 'AI 生成', mixed: 'AI 生成 · 含程序补报' };
  const badge = el('span', labels[origin] ?? '来源未记录', 'chat-origin');
  badge.dataset.origin = origin ?? 'unknown';
  return badge;
}

function renderChatReminder(item, stamp) {
  const states = [['wechat', item.wechat], ['qq', item.qq], ['push', item.push]];
  const tones = states.map(([, result]) => deliveryTone(result));
  const card = el('article', '', 'chat-reminder');
  card.dataset.tone = tones.includes('failure') ? 'failure' : tones.includes('uncertain') ? 'uncertain' : '';
  const heading = el('div', '', 'chat-reminder-heading');
  const time = el('time', stamp.slice(11));
  time.dateTime = new Date(item.at).toISOString();
  const headingTitle = el('span', '', 'chat-reminder-heading-title');
  headingTitle.append(el('strong', item.title), chatOrigin('program'));
  heading.append(headingTitle, time);
  const channels = el('div', '', 'chat-reminder-channels');
  for (const [channel, result] of states) {
    if (!result) continue;
    const pill = el('span', channelLabels[channel] + ' · ' + (statuses[result] ?? result), 'chat-result');
    pill.dataset.tone = deliveryTone(result);
    channels.append(pill);
  }
  if (item.inbox && item.push !== 'inbox_only') channels.append(el('span', '已存网页收件箱', 'chat-result'));
  card.append(heading, el('p', item.body, 'chat-reminder-text'), channels);
  for (const detail of [item.detail, item.qqDetail]) {
    if (detail) card.append(el('p', detail, 'chat-reminder-note'));
  }
  return card;
}

function compareChatItems(a, b) {
  if (a.at !== b.at) return a.at - b.at;
  if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id;
  if (typeof a.id === 'number') return -1;
  if (typeof b.id === 'number') return 1;
  return a.id < b.id ? -1 : Number(a.id !== b.id);
}

function renderChatProcessing(item) {
  const detail = el('details', '', 'chat-processing');
  const stage = replyStages[item.replyStage] ?? item.replyStage;
  const events = item.replySteps ?? [];
  const modelCalls = events.filter((entry) => entry.details?.kind === 'model' || entry.label.startsWith('模型请求 · ')).length;
  const summary = el('summary', '处理详情 · ' + stage + (modelCalls ? ' · ' + modelCalls + ' 次模型请求' : ''));
  summary.dataset.tone = deliveryTone(item.replyStage);
  detail.append(summary);
  detail.open = expandedChatProcessing.has(item.id);
  detail.ontoggle = () => {
    if (detail.open) expandedChatProcessing.add(item.id);
    else expandedChatProcessing.delete(item.id);
  };

  const steps = el('ol', '', 'chat-processing-steps');
  function step(label, result, at, duration, tone) {
    const row = el('li', '', 'chat-processing-step');
    row.append(el('span', label, 'chat-step-label'));
    const stamp = at ? chatTime.format(at) : '';
    const metadata = [stamp, result, duration].filter(Boolean).join(' · ');
    row.append(el('small', metadata, 'chat-step-result'));
    if (tone) row.dataset.tone = tone;
    steps.append(row);
  }
  step('OpenClaw 网关收到微信消息', '已收到', item.replyReceivedAt ?? item.at);
  if (item.quoteState) {
    step('核对引用', item.quoteState === 'available' ? '已读取正文' : '原文暂缺');
  }
  for (const event of events) {
    const elapsed = event.details?.durationMs ?? (event.updatedAt - event.at);
    const duration = event.state !== 'running' && elapsed >= 0
      ? (elapsed < 1000 ? elapsed + ' ms' : (elapsed / 1000).toFixed(1) + ' 秒') : '';
    const usage = event.details?.usage;
    const error = { timeout: '超时', aborted: '已取消', connection_closed: '连接关闭', connection_reset: '连接重置',
      terminated: '请求中断', rate_limit: '限流', auth: '认证异常' }[event.details?.errorCategory];
    const usageSummary = usage ? [['total', '总计'], ['input', '直接输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入']]
      .filter(([key]) => Number.isFinite(usage[key])).map(([key, name]) => name + ' ' + tokenText(usage[key])).join(' · ') : '';
    step(event.label, usageSummary ? usageSummary + ' Token' : error ?? stepStates[event.state],
      event.at, usageSummary ? '' : duration, event.state === 'failed' ? 'failure' : '');
  }
  if (item.replyFinishedAt) step('回复结果', stage, item.replyFinishedAt, '', deliveryTone(item.replyStage));
  if (item.inbox) step('保存到网页收件箱', '已保存');
  for (const [channel, result] of [['qq', item.qq], ['push', item.push]]) {
    if (result && !['skipped', 'inbox_only'].includes(result)) {
      step(channelLabels[channel] + '备用投递', statuses[result] ?? result, null, '', deliveryTone(result));
    }
  }
  detail.append(steps);
  return detail;
}

function renderChat({ older = false } = {}) {
  const list = byId('chat-messages');
  const scroller = byId('chat-scroll');
  const previousHeight = scroller.scrollHeight;
  const previousTop = scroller.scrollTop;
  const wasAtBottom = previousHeight - previousTop - scroller.clientHeight < 235;
  let date;
  const items = [];
  for (const item of chatMessages) {
    const stamp = local(item.at);
    const day = stamp.slice(0, 10);
    if (day !== date) {
      date = day;
      items.push(el('p', day, 'chat-day'));
    }
    if (item.kind === 'reminder') {
      items.push(renderChatReminder(item, stamp));
      continue;
    }
    const row = el('article', '', 'chat-message ' + item.direction);
    const label = item.direction === 'inbound' ? '我' : 'OpenClaw';
    const meta = [channelLabels[item.channel] || '会话', label, stamp.slice(11),
      item.direction === 'outbound' ? (statuses[item.state] || '') : ''].filter(Boolean);
    if (item.direction === 'outbound') row.dataset.tone = deliveryTone(item.state);
    const metadata = el('p', meta.join(' · '), 'chat-meta');
    if (item.direction === 'outbound') metadata.append(chatOrigin(item.contentOrigin));
    if (item.direction === 'inbound' && item.replySteps?.some(({ state, details }) =>
      state === 'done' && details?.kind === 'context' && details.mode === 'token-saving')) {
      metadata.append(el('span', '节省 Token', 'chat-origin chat-context'));
    }
    row.append(metadata);
    const bubble = el('div', item.body, 'chat-bubble');
    if (item.quoteState) {
      const quote = el('blockquote', item.quoteBody || '引用原文暂缺，请在微信查看。', 'chat-quote');
      bubble.append(quote);
    }
    if (item.hasMedia) {
      const url = './api/chat/media/' + item.id;
      if (/^image\/(?:jpeg|png|gif|webp)$/.test(item.mediaMime)) {
        const image = el('img', '', 'chat-image');
        image.loading = 'lazy';
        image.alt = item.mediaName || '微信图片';
        image.src = url;
        image.onerror = () => { image.hidden = true; };
        bubble.append(image);
      }
      const link = el('a', item.mediaName || '打开附件', 'chat-media');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      bubble.append(link);
    }
    row.append(bubble);
    if (item.replyStage) row.append(renderChatProcessing(item));
    items.push(row);
  }
  byId('chat-older').hidden = !chatCursor;
  list.replaceChildren(...(items.length ? items : [el('p', '在已绑定的微信聊天窗发一条消息，即可在这里查看。', 'empty')]));
  if (older) scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
  else if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
}

async function refreshChat({ older = false } = {}) {
  if (!state || activeView !== 'chat' || chatRefreshing || (older && !chatCursor)) return;
  const generation = ++chatRefreshId;
  chatRefreshing = true;
  try {
    const data = await api('chat' + (older ? '?before=' + encodeURIComponent(chatCursor) : ''));
    if (!state || generation !== chatRefreshId || activeView !== 'chat') return;
    renderChatSession(data.session);
    const previous = chatMessages;
    const first = data.messages[0];
    const retained = older ? previous : first ? previous.filter((item) => compareChatItems(item, first) < 0) : [];
    chatMessages = [...new Map([...retained, ...data.messages].map((item) => [item.id, item])).values()]
      .sort(compareChatItems);
    if (older || !chatLoaded || !retained.length) chatCursor = data.before;
    chatLoaded = true;
    if (older || JSON.stringify(previous) !== JSON.stringify(chatMessages) || !byId('chat-messages').childElementCount) {
      renderChat({ older });
    }
  } finally {
    chatRefreshing = false;
  }
}

function renderHistory() {
  const list = byId('history');
  list.replaceChildren();
  for (const item of state.history) {
    const row = el('div', '', 'row');
    const content = el('div');
    const channels = [
      '微信 ' + (statuses[item.wechat] ?? item.wechat),
      'QQ ' + (statuses[item.qq] ?? item.qq),
      'PWA ' + (statuses[item.push] ?? item.push)
    ];
    content.append(el('strong', item.title), el('p', channels.join(' · ')));
    if (item.preview) content.append(el('p', item.preview, 'hint'));
    const details = [item.detail, item.qqDetail].filter(Boolean);
    if (details.length) content.append(el('p', details.join('；'), 'hint'));
    row.append(content, el('time', local(item.dueAt), 'hint'));
    list.append(row);
  }
  if (!list.childElementCount) list.append(el('p', '到点触发后，投递结果会出现在这里。', 'empty'));
}

function renderNotificationStatus() {
  const supported = Boolean(registration && window.PushManager && window.Notification);
  const label = !state?.vapidKey ? '服务端待配置' : !supported ? '请从主屏幕打开' :
    Notification.permission === 'denied' ? '通知已关闭' : subscribed ? '本机已订阅' : '本机待订阅';
  byId('push-status').textContent = label;
  byId('push-toggle').textContent = subscribed ? '关闭本机通知' : '在本机启用';
  byId('push-toggle').disabled = !state?.vapidKey || !supported || Notification.permission === 'denied';
  byId('push-test').disabled = !state?.vapidKey || !state?.subscriptions;
  byId('fallback-test').hidden = !state?.qqConfigured;
}

function silenceDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '等待入站';
  const minutes = Math.floor(milliseconds / 60_000);
  return minutes < 60 ? minutes + ' 分钟'
    : Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分钟';
}

async function updateBadge() {
  if (!state?.badge) return;
  if (registration?.active) registration.active.postMessage({ type: 'badge', badge: state.badge });
  else if (state.badge.count > 0) await navigator.setAppBadge?.(state.badge.count).catch(() => {});
  else await navigator.clearAppBadge?.().catch(() => {});
}

function readPolicyForm() {
  const levels = [1, 2, 3].map((rank) => channelKeys.filter((channel) => Number(policyForm.elements[channel].value) === rank));
  return { levels: levels.filter((level) => level.length), fallback: policyForm.elements.fallback.value };
}

function policyLabel(policy) {
  return policy.levels.map((level) => level.map((channel) => channelLabels[channel]).join(' + ')).join(' → ');
}

function renderPolicyPreview() {
  byId('policy-preview').textContent = policyLabel(readPolicyForm()) || '请选择至少一个渠道。';
}

function fillPolicy(policy) {
  for (const channel of channelKeys) {
    policyForm.elements[channel].value = String(policy.levels.findIndex((level) => level.includes(channel)) + 1);
  }
  policyForm.elements.fallback.value = policy.fallback;
  renderPolicyPreview();
}

function modelMetric(list, label, value, detail) {
  const row = el('div');
  const data = el('dd', value);
  if (detail) data.append(el('small', detail, 'hint'));
  row.append(el('dt', label), data);
  list.append(row);
}

function fillModelAlerts(alerts) {
  modelAlertForm.elements.enabled.checked = alerts.enabled;
  modelAlertForm.elements.CNY.value = alerts.CNY;
  modelAlertForm.elements.USD.value = alerts.USD;
  modelAlertForm.querySelector('button').disabled = false;
  byId('model-alert-status').textContent = alerts.enabled ? '已开启' : '已关闭';
  modelAlertsLoaded = true;
}

const providerLabels = { deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini',
  'google-vertex': 'Google Vertex AI', 'google-gemini-cli': 'Google Gemini CLI', 'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter', xai: 'xAI', minimax: 'MiniMax', 'minimax-portal': 'MiniMax OAuth', ollama: 'Ollama',
  'ollama-cloud': 'Ollama Cloud', lmstudio: 'LM Studio', nvidia: 'NVIDIA', qwen: 'Qwen', moonshot: 'Moonshot' };
const providerLabel = (id) => Object.hasOwn(providerLabels, id) ? providerLabels[id] : id;
const modelProvider = (id) => id.split('/', 1)[0].toLowerCase();

function updateModelApply() {
  const select = modelSelectionForm.elements.model;
  const apply = byId('model-apply');
  apply.disabled = modelSelectionForm.hidden || modelSaving || select.disabled || !select.value ||
    (!modelSelection?.pinned && select.value === modelSelection?.current);
  if (modelSaving) apply.setAttribute('aria-busy', 'true');
  else apply.removeAttribute('aria-busy');
}

function fillModelChoices(preferred = '') {
  const { provider, model: select } = modelSelectionForm.elements;
  const choices = modelSelection.choices.filter(({ id }) => modelProvider(id) === provider.value);
  select.replaceChildren();
  for (const { id, name } of choices) {
    const option = el('option', name);
    option.value = id;
    select.append(option);
  }
  const selected = [preferred, modelSelection.current, modelSelection.configuredModel]
    .find((id) => choices.some((choice) => choice.id === id));
  select.value = selected ?? choices.find((choice) => choice.recommended)?.id ?? choices[0]?.id ?? '';
  select.disabled = modelSaving || !choices.length;
  updateModelApply();
}

function renderModelSelection(model, { preserve = true, target } = {}) {
  const { provider, model: select } = modelSelectionForm.elements;
  const draft = target ?? (preserve && modelSelection?.current === model.current ? select.value : '');
  modelSelection = model;
  const providers = [...model.providers].sort((a, b) => providerLabel(a.id).localeCompare(providerLabel(b.id), 'zh-CN'));
  const preferred = model.choices.some((choice) => choice.id === draft) ? modelProvider(draft) : model.provider;
  byId('model-provider-choice').hidden = providers.length < 2;
  modelSelectionForm.hidden = !model.choices.some((choice) => choice.id !== model.current || model.pinned);
  provider.replaceChildren();
  for (const { id } of providers) {
    const option = el('option', providerLabel(id));
    option.value = id;
    provider.append(option);
  }
  provider.value = providers.some(({ id }) => id === preferred) ? preferred : providers[0]?.id ?? '';
  provider.disabled = modelSaving || !providers.length;
  fillModelChoices(draft);
  const modelName = model.choices.find((choice) => choice.id === model.current)?.name ?? model.current;
  const parts = model.provider ? ['当前供应商 ' + providerLabel(model.provider), '当前模型 ' + modelName]
    : ['等待 OpenClaw 接入供应商'];
  if (model.sessionPending) parts.push('模型已保存，微信会话待同步，可再次应用');
  else if (model.pinned) parts.push('当前微信会话使用单独的模型设置');
  if (model.status === 'unavailable') parts.push('可用模型暂未同步');
  byId('model-selection-status').textContent = parts.join(' · ');
  byId('deepseek-usage').hidden = model.provider !== 'deepseek';
  if (model.provider !== 'deepseek') {
    modelRefreshId++;
    modelRefreshAt = 0;
    modelRefreshing = false;
    modelAlertsLoaded = false;
  }
}

async function refreshModelOptions({ force = false } = {}) {
  if (!state || activeView !== 'settings' || modelSaving ||
      (!force && (optionsRefreshing || Date.now() - optionsRefreshAt < 60_000))) return;
  const id = ++optionsRefreshId;
  optionsRefreshing = true;
  try {
    const models = await api('openclaw/models' + (force ? '?refresh=true' : ''));
    if (id !== optionsRefreshId) return;
    renderModelSelection(models);
    optionsRefreshAt = Date.now();
    if (models.provider === 'deepseek') await refreshModelUsage({ force });
  } finally {
    if (id === optionsRefreshId) optionsRefreshing = false;
  }
}

function renderModelUsage({ balance, usage, alerts }) {
  if (!modelAlertsLoaded) fillModelAlerts(alerts);
  const ready = balance.status === 'ready';
  const balanceStatus = byId('model-balance-status');
  const low = ready && balance.accounts.some((account) => account.low);
  balanceStatus.textContent = { stale: '最近一次查询', unavailable: '暂不可用' }[balance.status]
    ?? (balance.available === false ? '余额不足' : low ? '余额偏低' : '可用');
  balanceStatus.dataset.tone = low ? 'failure' : '';
  const balances = byId('model-balances');
  balances.replaceChildren();
  for (const account of balance.accounts) {
    const detail = Number.isFinite(account.granted) && Number.isFinite(account.toppedUp)
      ? '赠送 ' + currencyText(account.granted, account.currency, 2) + ' · 充值 ' + currencyText(account.toppedUp, account.currency, 2)
      : '';
    modelMetric(balances, account.currency, currencyText(account.total, account.currency, 2), detail);
  }
  byId('model-balance-updated').textContent = balance.updatedAt
    ? '查询于 ' + local(balance.updatedAt) + ' · 同一 DeepSeek 账户下的应用共享余额'
    : '余额查询暂不可用，可稍后刷新。';

  const kpis = byId('model-kpis');
  kpis.replaceChildren();
  const { totals } = usage;
  const hasStats = Boolean(usage.updatedAt && usage.daily.some((day) => day.totalTokens !== null));
  const cacheTokens = totals.cacheRead + totals.cacheWrite;
  modelMetric(kpis, '总 Token', hasStats ? tokenText(totals.totalTokens) : '—');
  modelMetric(kpis, '直接输入 / 输出', hasStats ? tokenText(totals.input) + ' / ' + tokenText(totals.output) : '—');
  modelMetric(kpis, '缓存 Token', hasStats ? tokenText(cacheTokens) : '—',
    hasStats ? '读取 ' + tokenText(totals.cacheRead) + ' · 写入 ' + tokenText(totals.cacheWrite) : '');
  modelMetric(kpis, 'DeepSeek 估算费用 · 人民币', hasStats ? currencyText(usage.costCny, 'CNY') : '—');
  const partial = usage.daily.some((day) => day.totalTokens === null);
  byId('model-report-status').textContent = hasStats
    ? [usage.status === 'stale' ? '显示上次同步的统计' : '同步于 ' + local(usage.updatedAt),
      partial ? '所选范围部分日期待统计' : '北京时间',
      usage.partialCost ? '部分用量待计价' : '按 DeepSeek 官方人民币单价估算'].join(' · ')
    : '所选范围的用量统计暂不可用。';

  const trend = byId('model-trend');
  trend.hidden = !hasStats || usage.daily.length < 2;
  const bars = byId('model-bars');
  bars.replaceChildren();
  const maximum = Math.max(1, ...usage.daily.map((item) => item.totalTokens ?? 0));
  for (const { date, totalTokens } of usage.daily) {
    const bar = el('li');
    const description = date + ' · ' + (totalTokens === null ? '待统计' : tokenText(totalTokens) + ' Token');
    bar.title = description;
    bar.setAttribute('aria-label', description);
    const fill = el('span');
    if (totalTokens === null) bar.dataset.missing = 'true';
    else fill.style.height = Math.max(2, (totalTokens / maximum) * 100) + '%';
    bar.append(fill);
    bars.append(bar);
  }
  byId('model-axis').replaceChildren(el('span', usage.range.startDate.slice(5)), el('span', usage.range.endDate.slice(5)));

  byId('model-breakdown').hidden = !usage.models.length && !usage.channels.length;
  const models = byId('model-by-model');
  const channels = byId('model-by-channel');
  models.replaceChildren();
  channels.replaceChildren();
  for (const item of usage.models) modelMetric(models, item.provider + '/' + item.model, tokenText(item.totalTokens) + ' Token',
    Number.isFinite(item.costCny) ? currencyText(item.costCny, 'CNY') + (item.partialCost ? ' · 当前可估算部分' : ' · 估算')
      : item.partialCost ? '费用待计价' : '');
  const names = { wechat: '微信', 'openclaw-weixin': '微信', qqbot: 'QQ', webchat: '网页对话', other: '其他' };
  for (const item of usage.channels) modelMetric(channels, names[item.channel] ?? item.channel, tokenText(item.totalTokens) + ' Token');
}

async function refreshModelUsage({ force = false, changed = false } = {}) {
  if (!state || activeView !== 'settings' || modelSelection?.provider !== 'deepseek' ||
      (!force && !changed && (modelRefreshing || Date.now() - modelRefreshAt < 60_000))) return;
  const id = ++modelRefreshId;
  modelRefreshing = true;
  try {
    const data = await api('model-usage?days=' + byId('model-days').value + (force ? '&refresh=true' : ''));
    if (id !== modelRefreshId) return;
    renderModelUsage(data);
    modelRefreshAt = Date.now();
  } catch {
    if (id !== modelRefreshId) return;
    byId('model-report-status').textContent = '同步失败，请稍后刷新。';
  } finally {
    if (id === modelRefreshId) modelRefreshing = false;
  }
}

async function refresh({ fillSettings = false } = {}) {
  const request = ++refreshId;
  const modeRevision = tokenSavingRevision;
  let fresh;
  try {
    fresh = await api('state');
  } catch (error) {
    if (request !== refreshId) return;
    if (error.status !== 401) throw error;
    state = undefined;
    modelSelection = undefined;
    optionsRefreshId++;
    optionsRefreshAt = 0;
    optionsRefreshing = false;
    byId('deepseek-usage').hidden = true;
    byId('model-selection-status').textContent = '';
    modelSelectionForm.hidden = true;
    const { provider, model } = modelSelectionForm.elements;
    provider.replaceChildren();
    provider.disabled = true;
    model.replaceChildren(el('option', '查询中'));
    model.disabled = true;
    updateModelApply();
    modelRefreshId++;
    modelRefreshAt = 0;
    modelRefreshing = false;
    modelAlertsLoaded = false;
    byId('model-balances').replaceChildren();
    byId('model-kpis').replaceChildren();
    byId('model-by-model').replaceChildren();
    byId('model-by-channel').replaceChildren();
    byId('model-trend').hidden = true;
    byId('model-breakdown').hidden = true;
    byId('model-balance-status').textContent = '查询中';
    byId('model-balance-updated').textContent = '';
    byId('model-report-status').textContent = '正在查询用量…';
    modelAlertForm.querySelector('button').disabled = true;
    chatRefreshId++;
    chatMessages = [];
    chatCursor = null;
    chatLoaded = false;
    byId('chat-messages').replaceChildren();
    renderChatSession(null);
    byId('login-card').hidden = false;
    byId('workspace').hidden = true;
    byId('navigation').hidden = true;
    byId('rail-footer').hidden = true;
    byId('logout').hidden = true;
    showView();
    return;
  }
  if (request !== refreshId) return;
  if (!state || fillSettings) {
    settingsForm.elements.daily.value = fresh.settings.daily ?? '';
    settingsForm.elements.dual.checked = Boolean(fresh.settings.dual);
    fillPolicy(fresh.settings.policy);
  }
  if (state && (tokenSavingSwitch.disabled || modeRevision !== tokenSavingRevision)) {
    fresh.settings.tokenSaving = state.settings.tokenSaving;
  } else {
    tokenSavingSwitch.checked = fresh.settings.tokenSaving === true;
  }
  if (!state) tokenSavingSwitch.disabled = false;
  state = fresh;
  byId('login-card').hidden = true;
  byId('workspace').hidden = false;
  byId('navigation').hidden = false;
  byId('rail-footer').hidden = false;
  byId('logout').hidden = false;
  const date = local(Date.now()).slice(0, 10);
  byId('today-label').textContent = date + ' · 北京时间';
  byId('rail-connection').textContent = fresh.wechatConfigured ? '微信已绑定' : '微信待绑定';
  showView();
  const status = byId('channel-status');
  status.hidden = false;
  status.replaceChildren(
    el('span', policyLabel(state.settings.policy), 'pill'),
    el('span', 'PWA · ' + (state.subscriptions ? state.subscriptions + ' 个设备' : '待授权'), 'pill')
  );
  renderTasks();
  renderInbox();
  renderHistory();
  renderOverview();
  renderNotificationStatus();
  byId('policy-wechat-status').textContent = state.wechatConfigured ? '已配置收件人' : '待配置收件人';
  byId('policy-qq-status').textContent = state.qqConfigured ? '已配置收件人' : '待配置收件人';
  byId('policy-push-status').textContent = state.subscriptions ? state.subscriptions + ' 个已授权设备' : '待设备授权';
  const activity = state.wechatActivity;
  byId('wechat-inbound').textContent = activity?.lastInboundAt ? local(activity.lastInboundAt) : '等待入站';
  byId('wechat-silence').textContent = silenceDuration(activity?.silentForMs);
  byId('wechat-last-outbound').textContent = activity?.lastOutboundAt ? local(activity.lastOutboundAt) : '等待投递';
  byId('wechat-outbound').textContent = activity ? activity.accepted + ' 条' : '—';
  byId('wechat-deferred').hidden = !activity?.deferred;
  await updateBadge();
  await openNotification();
  if (activeView === 'chat') await refreshChat();
  if (activeView === 'settings') void run(refreshModelOptions);
}

async function openNotification() {
  if (!state || !location.hash.startsWith('#notice=')) return;
  let id;
  try { id = decodeURIComponent(location.hash.slice(8)); } catch { return; }
  const item = state.inbox.find((notification) => notification.id === id);
  showArchivedInbox = !item && Boolean(state.archivedInbox?.some((notification) => notification.id === id));
  renderInbox();
  history.replaceState(null, '', location.pathname + '#mailbox');
  showView();
  if (item && !item.read) {
    await api('inbox/read', 'POST', { id });
    await refresh();
  }
  const list = byId('inbox');
  const row = byId('item-' + id);
  list.scrollTop = row ? list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top
    - (list.clientHeight - row.offsetHeight) / 2 : 0;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  byId('theme-label').textContent = theme === 'dark' ? '白天' : '夜间';
  byId('theme').setAttribute('aria-pressed', String(theme === 'dark'));
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#291a23' : '#f4d7da';
}

function decodeKey(key) {
  const base64 = (key + '='.repeat((4 - key.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

byId('today-label').textContent = local(Date.now()).slice(0, 10) + ' · 北京时间';
byId('task-editor').open = !onMobile.matches;
onMobile.addEventListener('change', () => { byId('task-editor').open = !onMobile.matches || Boolean(editing); });
taskForm.elements.repeat.addEventListener('change', syncRepeatField);
taskForm.elements.due.addEventListener('change', syncRepeatField);
for (const link of document.querySelectorAll('a[data-view]')) {
  link.addEventListener('click', (event) => {
    if (!state || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    message('');
    if (location.href !== link.href) history.pushState(null, '', link.href);
    showView({ scroll: true });
    if (link.id === 'add-shortcut') {
      byId('task-editor').open = true;
      taskForm.elements.title.focus();
    }
    if (activeView === 'chat') void run(refreshChat);
    if (activeView === 'settings') void run(refreshModelOptions);
  });
}
byId('chat-refresh').onclick = (event) => void run(refreshChat, event.currentTarget);
byId('chat-older').onclick = (event) => void run(() => refreshChat({ older: true }), event.currentTarget);
byId('model-options-refresh').onclick = (event) => void run(() => refreshModelOptions({ force: true }), event.currentTarget);
tokenSavingSwitch.onchange = () => {
  const enabled = tokenSavingSwitch.checked;
  void run(async () => {
    try {
      const result = await api('settings/token-saving', 'PUT', { enabled });
      tokenSavingRevision++;
      if (state) state.settings.tokenSaving = result.enabled;
      tokenSavingSwitch.checked = result.enabled;
      message(result.enabled ? '节省 Token 已开启，下一轮对话生效。' : '节省 Token 已关闭，下一轮恢复常规上下文。');
    } catch (error) {
      tokenSavingSwitch.checked = state?.settings.tokenSaving === true;
      throw error;
    }
  }, tokenSavingSwitch);
};
modelSelectionForm.elements.provider.onchange = () => fillModelChoices();
modelSelectionForm.elements.model.onchange = updateModelApply;
modelSelectionForm.onsubmit = (event) => {
  event.preventDefault();
  if (byId('model-apply').disabled) return;
  void run(async () => {
    const { provider, model: select } = modelSelectionForm.elements;
    const model = select.value;
    modelSaving = true;
    provider.disabled = true;
    select.disabled = true;
    updateModelApply();
    optionsRefreshId++;
    optionsRefreshing = false;
    try {
      const result = await api('openclaw/models', 'PUT', { model });
      renderModelSelection(result, { preserve: false, target: result.current !== model ? model : undefined });
      optionsRefreshAt = Date.now();
      if (result.sessionPending) message('模型已保存，微信会话待同步。', true);
      else if (result.current === model) message('已应用 ' + (result.choices.find((choice) => choice.id === model)?.name ?? model) + '。');
      else message('已提交模型设置，网关状态待同步。');
      if (result.provider === 'deepseek') void refreshModelUsage({ changed: true });
    } catch (error) {
      optionsRefreshAt = 0;
      throw error;
    } finally {
      modelSaving = false;
      provider.disabled = !modelSelection?.providers.length;
      select.disabled = !select.options.length;
      updateModelApply();
    }
  });
};
byId('model-days').onchange = () => void refreshModelUsage({ changed: true });
modelAlertForm.onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    const elements = modelAlertForm.elements;
    fillModelAlerts(await api('settings/model-alerts', 'PUT', {
      enabled: elements.enabled.checked, CNY: elements.CNY.valueAsNumber, USD: elements.USD.valueAsNumber
    }));
    message('低余额提醒设置已保存。');
    await refreshModelUsage({ changed: true });
  }, modelAlertForm.querySelector('button'));
};
for (const channel of channelKeys) {
  for (const [value, label] of [[0, '关闭'], [1, '第一级'], [2, '第二级'], [3, '第三级']]) {
    const option = el('option', label);
    option.value = value;
    policyForm.elements[channel].append(option);
  }
}
policyForm.addEventListener('change', renderPolicyPreview);
for (const button of policyForm.querySelectorAll('[data-preset]')) {
  button.onclick = () => fillPolicy(presets[button.dataset.preset]);
}
policyForm.onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    const policy = readPolicyForm();
    if (!policy.levels.length) throw new Error('请选择至少一个渠道。');
    await api('settings/delivery', 'PUT', policy);
    await refresh({ fillSettings: true });
    message('投递设置已保存。');
  }, event.submitter);
};
setTheme(localStorage.getItem('reminder-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
let themeTransition;
byId('theme').onclick = () => {
  const current = localStorage.getItem('reminder-theme') ?? document.documentElement.dataset.theme;
  const theme = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('reminder-theme', theme);
  if (reducedMotion.matches || !document.startViewTransition || themeTransition) {
    themeTransition?.skipTransition();
    setTheme(theme);
    return;
  }
  themeTransition = document.startViewTransition(() => {
    if (localStorage.getItem('reminder-theme') === theme) setTheme(theme);
  });
  themeTransition.ready.catch(() => {});
  themeTransition.finished.then(clearTransition, clearTransition);
};
function clearTransition() {
  themeTransition = undefined;
}
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) themeTransition?.skipTransition();
});

byId('login-form').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void run(async () => {
    await api('login', 'POST', { password: form.elements.password.value });
    form.reset();
    message('');
    await refresh();
  }, event.submitter);
};
byId('logout').onclick = (event) => void run(async () => {
  await api('logout', 'POST');
  clearEditor();
  message('');
  await refresh();
}, event.currentTarget);
taskForm.onsubmit = (event) => {
  event.preventDefault();
  const form = taskForm.elements;
  const input = { title: form.title.value, repeat: form.repeat.value, dual: form.dual.checked };
  const previous = editing?.dueAt ? local(editing.dueAt).replace(' ', 'T') : '';
  if (!editing || form.due.value !== previous) input.dueAt = form.due.value ? form.due.value + '+08:00' : null;
  const until = form.repeat.value === 'once' ? null : form.repeatUntil.value || null;
  if (!editing || until !== editing.repeatUntil) input.repeatUntil = until;
  void run(async () => {
    if (editing) await api('tasks/' + editing.id, 'PATCH', input);
    else await api('tasks', 'POST', input);
    clearEditor();
    message('待办已保存。');
    await refresh();
  }, event.submitter);
};
byId('cancel-edit').onclick = clearEditor;
for (const button of document.querySelectorAll('[data-filter]')) {
  button.onclick = () => {
    if (filter === button.dataset.filter) return;
    filter = button.dataset.filter;
    for (const option of document.querySelectorAll('[data-filter]')) option.setAttribute('aria-pressed', String(option === button));
    renderTasks();
    animateListChange('tasks');
  };
}
byId('read-all').onclick = (event) => void run(async () => {
  await api('inbox/read', 'POST', { id: 'all' });
  await refresh();
}, event.currentTarget);
byId('inbox-archive-view').onclick = () => {
  showArchivedInbox = !showArchivedInbox;
  renderInbox();
  animateListChange('inbox');
};
byId('inbox-clear').onclick = (event) => void run(() => organizeInbox('archive', 'all'), event.currentTarget);
byId('inbox-restore-latest').onclick = (event) => void run(() => organizeInbox('restore', 'latest'), event.currentTarget);
settingsForm.onsubmit = (event) => {
  event.preventDefault();
  void run(async () => {
    await api('settings', 'PUT', { daily: settingsForm.elements.daily.value || null, dual: settingsForm.elements.dual.checked });
    message('日报设置已保存。');
    await refresh({ fillSettings: true });
  }, event.submitter);
};
byId('push-toggle').onclick = (event) => void run(async () => {
  if (!subscribed && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') {
    throw new Error('请在系统设置中允许通知。');
  }
  const deviceSubscription = await registration.pushManager.getSubscription();
  if (deviceSubscription && subscribed) {
    await api('push/subscriptions', 'DELETE', { endpoint: deviceSubscription.endpoint });
    await deviceSubscription.unsubscribe();
    subscribed = false;
    message('本机手机通知已关闭。');
  } else {
    const value = deviceSubscription ?? await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: decodeKey(state.vapidKey)
    });
    await api('push/subscriptions', 'POST', value.toJSON());
    subscribed = true;
    message('本机已启用通知，可以发送一条测试。');
  }
  await refresh();
}, event.currentTarget);
byId('push-test').onclick = (event) => void run(async () => {
  await api('push/test', 'POST', {});
  message('测试已排队。请查看锁屏通知、主屏幕角标和投递记录。');
  await refresh();
}, event.currentTarget);
byId('fallback-test').onclick = (event) => void run(async () => {
  await api('fallback/test', 'POST', {});
  message('已模拟微信拒收；请查看 QQ、手机通知和投递记录。');
  await refresh();
}, event.currentTarget);

function locationChanged() {
  showView();
  if (activeView === 'settings') void run(refreshModelOptions);
  void run(async () => {
    await openNotification();
    if (activeView === 'chat') await refreshChat();
  });
}
window.addEventListener('hashchange', locationChanged);
window.addEventListener('popstate', locationChanged);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void run(refresh);
});
setInterval(() => { if (state && !document.hidden) void run(refresh); }, 10_000);
setInterval(() => { if (state && activeView === 'chat' && !document.hidden) void run(refreshChat); }, 3000);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(async (ready) => {
    registration = ready;
    subscribed = Boolean(await registration.pushManager?.getSubscription());
    renderNotificationStatus();
    await updateBadge();
  }).catch(() => {});
}
void run(refresh);
