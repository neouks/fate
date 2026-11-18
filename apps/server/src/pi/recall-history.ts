import type {ContextEvent} from '@earendil-works/pi-coding-agent';

type Row = Record<string, unknown>;
const excerptFields = new Set(['content', 'payload_json', 'detail', 'evidence', 'report', 'snippet', 'summary']);

function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resultObject(content: {type: string; text?: string}[]): Row | undefined {
  if (content.length !== 1 || content[0]?.type !== 'text') return;
  try {
    const value: unknown = JSON.parse(content[0].text ?? '');
    if (object(value) && !value.error) return value;
  } catch { /* Preserve legacy non-JSON results. */ }
}

/** Excerpts use separate keys to distinguish them from original evidence.
 * References, read receipts, versions and pagination coordinates stay intact. */
function excerpt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(excerpt);
  if (!object(value) || value.error) return value;
  const out: Row = {};
  for (const [key, field] of Object.entries(value)) {
    const shortField = key === 'summary' || key === 'snippet';
    if (excerptFields.has(key) && typeof field === 'string' && field.length > (shortField ? 160 : 320)) {
      out[key + '_history_excerpt'] = Array.from(field).slice(0, shortField ? 120 : 160).join('');
    } else if (key === 'items' || key === 'node' || key === 'payload' || key === 'finding_detail') {
      out[key] = excerpt(field);
    } else {
      out[key] = field;
    }
  }
  return out;
}

function savedFact(input: unknown, receipt: unknown): unknown {
  if (!object(input) || !object(receipt) || receipt.error ||
      !Number.isSafeInteger(receipt.fact_id) || Number(receipt.fact_id) <= 0 ||
      receipt.ref !== `node:${receipt.fact_id}` || !Number.isSafeInteger(receipt.version)) return input;
  const out = {...input};
  for (const key of ['detail', 'evidence']) {
    if (typeof out[key] === 'string' && out[key].length > 320) {
      out[key] = `[历史调用正文已保存至 ${receipt.ref}，版本 ${receipt.version}；用 context_get 读取 /payload/${key}]`;
    }
  }
  return out;
}

/** Request-only projection rebuilt from the current branch after every restore.
 * Wait for two following assistant messages before shortening a tool result.
 * Persisted session entries and write receipts remain authoritative. */
export function projectRecallHistory(messages: ContextEvent['messages']): ContextEvent['messages'] {
  let followingTurns = 0;
  const oldResults = new Set<number>();
  const saved = new Map<string, Row>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'assistant') followingTurns++;
    if (message.role !== 'toolResult' || message.isError || followingTurns < 2) continue;
    if (!['record_fact', 'context_get', 'context_search'].includes(message.toolName)) continue;
    const receipt = resultObject(message.content);
    if (!receipt) continue;
    oldResults.add(i);
    if (message.toolName === 'record_fact') saved.set(message.toolCallId, receipt);
  }
  return messages.map((message, i) => {
    if (message.role === 'toolResult' && oldResults.has(i) && message.toolName !== 'record_fact') {
      const original = message.content[0]!;
      const text = JSON.stringify({...excerpt(resultObject(message.content)) as Row,
        history_note: '旧工具结果仅保留摘要；原文按引用、版本和字段用 context_get 读取。分页坐标对应原文。'});
      if (original.type !== 'text' || Buffer.byteLength(text) >= Buffer.byteLength(original.text)) return message;
      return {...message, content: [{type: 'text' as const, text}]};
    }
    if (message.role !== 'assistant' || !saved.size) return message;
    return {...message, content: message.content.map(block => {
      if (block.type !== 'toolCall' || block.name !== 'record_fact' || block.thoughtSignature) return block;
      const receipt = saved.get(block.id);
      if (!receipt || !object(block.arguments)) return block;
      const args = block.arguments;
      if (Array.isArray(args.facts)) {
        const results = receipt.results;
        if (!Array.isArray(results) || results.length !== args.facts.length) return block;
        return {...block, arguments: {...args, facts: args.facts.map((fact, index) => savedFact(fact, results[index]))} as typeof block.arguments};
      }
      return {...block, arguments: savedFact(args, receipt) as typeof block.arguments};
    })};
  });
}
