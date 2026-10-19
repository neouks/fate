/** HTTP-only adapter for providers configured without streaming. pi still owns
 * parsing, tools, turns and persistence; a completed response is exposed to its
 * native parser as one finite SSE response, without making a second request. */
export function nonStreamingFetch(fetcher: typeof fetch, api: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return fetcher(request);
    const payload = await request.clone().json() as Record<string, unknown>;
    if (payload.stream !== true) return fetcher(request);
    payload.stream = false;
    delete payload.stream_options;
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const response = await fetcher(new Request(request, { headers, body: JSON.stringify(payload) }));
    if (!response.ok || response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const data = await response.json() as Record<string, any>;
    const events: Record<string, unknown>[] = [];
    if (data.error) throw new Error(`Model response error: ${JSON.stringify(data.error)}`);
    if (api === 'openai-completions') {
      if (!Array.isArray(data.choices) || !data.choices.length) throw new Error('Non-stream response has no choices');
      for (const choice of data.choices) {
        if (!choice.message || !choice.finish_reason) throw new Error('Incomplete non-stream completion');
        const delta = { ...choice.message };
        if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((tool: object, index: number) => ({ ...tool, index }));
        events.push({ ...data, object: 'chat.completion.chunk', choices: [{ ...choice, message: undefined, delta }] });
      }
    } else if (api === 'anthropic-messages') {
      if (!Array.isArray(data.content) || !data.stop_reason) throw new Error('Incomplete non-stream message');
      events.push({ type: 'message_start', message: { ...data, content: [], stop_reason: null, stop_sequence: null } });
      data.content.forEach((block: Record<string, unknown>, index: number) => {
        events.push({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block });
        if (block.type === 'tool_use') events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
        events.push({ type: 'content_block_stop', index });
      });
      events.push({ type: 'message_delta', delta: { stop_reason: data.stop_reason, stop_sequence: data.stop_sequence, stop_details: data.stop_details }, usage: data.usage });
      events.push({ type: 'message_stop' });
    } else {
      if (!Array.isArray(data.output) || !['completed', 'incomplete', 'failed'].includes(data.status)) throw new Error('Incomplete non-stream response');
      events.push({ type: 'response.created', response: data });
      data.output.forEach((item: unknown, output_index: number) => {
        events.push({ type: 'response.output_item.added', output_index, item });
        events.push({ type: 'response.output_item.done', output_index, item });
      });
      events.push({ type: `response.${data.status}`, response: data });
    }
    const body = events.map(event => `${typeof event.type === 'string' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (api === 'openai-completions' ? 'data: [DONE]\n\n' : '');
    const outputHeaders = new Headers(response.headers);
    for (const key of ['content-length', 'content-encoding']) outputHeaders.delete(key);
    outputHeaders.set('content-type', 'text/event-stream');
    return new Response(body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
  };
}
