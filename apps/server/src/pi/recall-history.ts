import type {ContextEvent} from '@earendil-works/pi-coding-agent';
import {HISTORY_EXCERPT_NOTE, HISTORY_INDEX_NOTE, HISTORY_OMITTED_NOTE} from '../evidence/history-placeholder.js';

type Row = Record<string, unknown>;
const excerptFields = new Set(['content', 'payload_json', 'detail', 'evidence', 'report', 'snippet', 'summary']);
// Unicode characters in serialized JSON, not model tokens. Native tools and
// write arguments/receipts are deliberately outside this platform read budget.
export const RETRIEVAL_BODY_CHARS = 24_000;
export const RETRIEVAL_INDEX_CHARS = 4_000;
const retrievalTools = new Set(['context_get', 'context_search', 'asset_get', 'asset_search', 'traffic_search', 'graph_overview',
  'read_tool_output', 'traffic_body', 'list_assets', 'list_untested_assets', 'list_findings', 'get_finding',
  'node_detail', 'search_worker_traces', 'get_worker_trace', 'expand_index', 'expand_digest']);
const omitted = JSON.stringify({history_omitted: true, read_from_original_call: true,
  history_note: HISTORY_OMITTED_NOTE});
const size = (text: string) => Array.from(text).length;
const indexFields = new Set(['ref', 'version', 'content_version', 'source_task_id', 'inherited', 'read_only',
  'field', 'offset', 'next_offset', 'next_cursor', 'next_item', 'read', 'read_options', 'read_receipt',
  'has_more', 'evidence_scope', 'node_id', 'asset_id', 'id', 'kind', 'state', 'view']);

function readIndex(value: Row): Row {
  const out: Row = {};
  for (const [key, field] of Object.entries(value)) {
    if (indexFields.has(key)) out[key] = field;
    else if (key === 'items' && Array.isArray(field)) out.items = field.filter(object).map(readIndex);
  }
  return out;
}

function hasError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasError);
  return object(value) && (Boolean(value.error) || Object.values(value).some(hasError));
}

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

/** Request-only projection rebuilt from the current branch after every restore.
 * Recent results get first claim on the shared budget. Older fields are also
 * excerpted after two assistant messages. Errors/unknown formats remain intact;
 * the body/index limits do not include those or the small omission markers.
 * Only platform read results are projected. Never synthesize write arguments:
 * models can copy those examples into new calls and persist dangling references.
 * PI owns assistant messages, compaction and all native tool history. */
export function projectRecallHistory(messages: ContextEvent['messages']): ContextEvent['messages'] {
  let followingTurns = 0;
  let bodyRemaining = RETRIEVAL_BODY_CHARS, indexRemaining = RETRIEVAL_INDEX_CHARS;
  const replacements = new Map<number, string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'assistant') followingTurns++;
    if (message.role !== 'toolResult' || message.isError || !retrievalTools.has(message.toolName)) continue;
    const receipt = resultObject(message.content);
    if (!receipt || hasError(receipt)) continue;
    const original = message.content[0]!;
    if (original.type !== 'text') continue;
    // Reapplying to a projected request must not turn an index into evidence or
    // consume the body allowance with a placeholder.
    if (receipt.history_omitted === true) {
      if (original.text !== omitted) indexRemaining = Math.max(0, indexRemaining - size(original.text));
      bodyRemaining = 0;
      continue;
    }
    let text = original.text;
    if (followingTurns >= 2) {
      const shortened = JSON.stringify({...excerpt(receipt) as Row,
        history_note: HISTORY_EXCERPT_NOTE});
      if (size(shortened) < size(text)) text = shortened;
    }
    if (size(text) <= bodyRemaining) bodyRemaining -= size(text);
    else {
      bodyRemaining = 0;
      const index = JSON.stringify({...readIndex(receipt), history_omitted: true, read_from_original_call: true,
        history_note: HISTORY_INDEX_NOTE});
      if (size(index) <= indexRemaining) { text = index; indexRemaining -= size(index); }
      else text = omitted;
    }
    if (text !== original.text) replacements.set(i, text);
  }
  return messages.map((message, i) => {
    const text = replacements.get(i);
    if (message.role === 'toolResult' && text !== undefined) {
      return {...message, content: [{type: 'text' as const, text}]};
    }
    return message;
  });
}
