const isUserTurn = (message) => message.role === 'user' && !message.runtimeContextCarrier;
const recentTurnLimit = 2;
export const tokenSavingPrompt = 'ROSETTE 本轮使用短上下文。';

function finalReply(message) {
  if (message?.role !== 'assistant' || ['error', 'aborted', 'toolUse'].includes(message.stopReason)) return;
  if (typeof message.content === 'string') return message.content.trim() ? message : undefined;
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (blocks.some((block) => block.type === 'toolCall')) return;
  const text = blocks.filter((block) => block.type === 'text');
  if (text.some((block) => block.text?.trim())) return { ...message, content: text };
}

export function recentReminderContext(messages) {
  const recent = [];
  let end = messages.length;
  let pending = end;

  for (let start = messages.length - 1; start >= 0 && recent.length < recentTurnLimit; start--) {
    const user = messages[start];
    if (!isUserTurn(user)) continue;
    const reply = finalReply(messages[end - 1]);
    if (end > start + 1 && reply) {
      recent.unshift([user, reply]);
    } else if (!recent.length) {
      pending = start;
    }
    end = start;
  }

  if (!recent.length) return messages;
  const system = messages.slice(0, pending).filter((message) => message.role === 'system');
  return [...system, ...recent.flat(), ...messages.slice(pending)];
}

export function createReminderContextEngine({ isEnabled, compact }) {
  return {
    info: {
      id: 'reminder-desk',
      name: 'ROSETTE 短上下文',
      ownsCompaction: false,
      transcriptSemantics: {
        currentTurnFence: 'before-current-turn-entry-v1',
        turnAdvancementIdempotency: 'atomic-idempotent-v1'
      }
    },
    async ingest() {
      return { ingested: false };
    },
    async commitTurn() {
      // OpenClaw owns the transcript. This stateless engine has no turn data to commit.
      return { status: 'committed' };
    },
    async assemble({ messages, availableTools }) {
      const enabled = availableTools?.has('reminder_tasks') && await isEnabled();
      return {
        messages: enabled ? recentReminderContext(messages) : messages,
        estimatedTokens: 0,
        ...(enabled ? { systemPromptAddition: tokenSavingPrompt } : {})
      };
    },
    compact
  };
}
