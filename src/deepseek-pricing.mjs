import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';

const beijingOffset = 8 * 3_600_000;
// Off-peak fen per million tokens. Peak prices are double these rates.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const flash = { since: '2026-10-17', input: 100, cacheRead: 2, output: 400 };
const pro = { since: '2026-08-17', input: 450, cacheRead: 15, output: 1350 };
const tariffs = new Map([
  ['deepseek-flash', flash], ['deepseek-v4-flash', flash],
  ['deepseek-v4-flash-vision-exp', flash], ['deepseek-v4-pro', pro]
]);
// Published State Council holiday periods within the supported tariff dates.
const holidays = [
  ['2026-09-25', '2026-09-27'], ['2026-10-01', '2026-10-07'],
  ['2027-01-01', '2027-01-03'], ['2027-02-05', '2027-02-13'], ['2027-04-03', '2027-04-05'],
  ['2027-05-01', '2027-05-05'], ['2027-06-09', '2027-06-09'],
  ['2027-09-15', '2027-09-15'], ['2027-10-01', '2027-10-07']
];

function estimate(model, time, date, usage) {
  const price = tariffs.get(model);
  if (!price || date < price.since || !usage) return null;
  const { input, output, cacheRead, cacheWrite, totalTokens } = usage;
  if (![input, output, cacheRead, cacheWrite, totalTokens].every((count) => Number.isSafeInteger(count) && count >= 0) ||
      totalTokens !== input + output + cacheRead + cacheWrite || usage.cacheTelemetry?.state === 'unavailable') return null;
  const day = time.getUTCDay();
  const hour = time.getUTCHours();
  const peak = day >= 1 && day <= 5 && (hour >= 9 && hour < 12 || hour >= 14 && hour < 18) &&
    !holidays.some(([first, last]) => first <= date && date <= last);
  const fenPerMillion = (input + cacheWrite) * price.input + cacheRead * price.cacheRead + output * price.output;
  return fenPerMillion * (peak ? 2 : 1) / 100_000_000;
}

export function readDeepSeekSessionCosts(stateDir, agentId, sessionId, start, end) {
  const costs = new Map();
  if (!stateDir || typeof agentId !== 'string' || !/^[\w-]+$/.test(agentId)) return costs;
  const from = Date.parse(start + 'T00:00:00+08:00');
  const until = Date.parse(end + 'T00:00:00+08:00') + 86_400_000;
  let db;
  try {
    db = new DatabaseSync(join(stateDir, 'agents', agentId, 'agent', 'openclaw-agent.sqlite'), { readOnly: true, timeout: 500 });
    // Read usage metadata from the gateway's local transcript, including compressed messages.
    const rows = db.prepare(`SELECT event_json, event_zstd FROM transcript_events
      WHERE session_id = ? AND message_role = 'assistant' AND created_at >= ? AND created_at < ?`);
    for (const row of rows.iterate(sessionId, from, until)) {
      const event = JSON.parse(row.event_zstd ? zstdDecompressSync(row.event_zstd) : row.event_json);
      const message = event?.message;
      if (message?.provider !== 'deepseek' || !Number.isSafeInteger(message.timestamp)) continue;
      const time = new Date(message.timestamp + beijingOffset);
      if (!Number.isFinite(time.getTime())) continue;
      const date = time.toISOString().slice(0, 10);
      if (date < start || date > end) continue;
      const cost = estimate(message.model, time, date, message.usage);
      if (cost === null) continue;
      const key = `${date}/${message.model}`;
      if (!costs.has(key)) costs.set(key, { total: 0, tokens: 0, count: 0 });
      const item = costs.get(key);
      item.total += cost;
      item.tokens += message.usage.totalTokens;
      item.count++;
    }
  } catch {
    // The report keeps its token counts when per-call billing metadata is unavailable.
  } finally {
    db?.close();
  }
  return costs;
}
