const dayMs = 86_400_000;
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const maxOccurrences = 512;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function dateStamp(day) {
  const stamp = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day) : NaN;
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== day) invalid('请提供有效的日期（YYYY-MM-DD）。');
  return stamp;
}

function dateSet(values) {
  if (!Array.isArray(values)) invalid('请用日期列表填写指定或跳过的日期。');
  return new Set(values.map(dateStamp));
}

export function expandSchedule(schedule) {
  if (!schedule || !Array.isArray(schedule.slots) || !schedule.slots.length) invalid('请提供日程时段。');
  const dates = dateSet(schedule.dates ?? []);
  const excluded = dateSet(schedule.excludeDates ?? []);
  if (schedule.range !== undefined) {
    const { from, through, on } = schedule.range ?? {};
    const start = dateStamp(from);
    const finish = dateStamp(through);
    if (start > finish || finish - start >= dayMs * 366) invalid('请选择不超过 366 天的有效日期范围。');
    if (on !== undefined && (!Array.isArray(on) || !on.length || on.some((day) => !weekdays.includes(day)))) {
      invalid('请填写有效的星期筛选。');
    }
    for (let date = start; date <= finish; date += dayMs) {
      if (!on || on.includes(weekdays[new Date(date).getUTCDay()])) dates.add(date);
    }
  } else if (!dates.size) {
    invalid('请提供指定日期或日期范围。');
  }
  for (const date of excluded) dates.delete(date);

  const slots = new Map();
  for (const slot of schedule.slots) {
    const { time, title, dual = false } = slot ?? {};
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid('请用北京时间 HH:mm 填写时段。');
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 180) invalid('待办标题请填写 1 至 180 字。');
    if (typeof dual !== 'boolean') invalid('同步投递应为 true 或 false。');
    const name = title.trim();
    const key = JSON.stringify([time, name]);
    if (slots.has(key) && slots.get(key).dual !== dual) invalid('相同事项和时段的投递方式需一致。');
    slots.set(key, { time, title: name, dual });
  }
  if (dates.size * slots.size > maxOccurrences) invalid('请把大批量日程拆为每批最多 512 条提醒。');
  const calendarDays = [...dates].sort((a, b) => a - b).map((date) => new Date(date).toISOString().slice(0, 10));
  const times = [...slots.values()].sort((a, b) => a.time.localeCompare(b.time));
  return calendarDays.flatMap((day) => times.map(({ time, title, dual }) => {
    const timeText = day + 'T' + time + ':00+08:00';
    return { title, dueAt: Date.parse(timeText), timeText, dual };
  }));
}
