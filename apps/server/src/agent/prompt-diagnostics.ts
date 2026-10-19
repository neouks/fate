import { createHash } from 'node:crypto';
export function textSize(text: string) {
  const bytes = Buffer.byteLength(text, 'utf8');
  return { utf8_bytes: bytes, chars: [...text].length, estimated_tokens: Math.ceil(bytes / 3), estimate_method: 'utf8_bytes_div_3_heuristic' };
}
/** No content or credentials are logged. Provider usage remains the authoritative token count. */
export function requestSize(payload: unknown) {
  const raw = JSON.stringify(payload) ?? '';
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return { ...textSize(raw), sha256: createHash('sha256').update(raw).digest('hex'),
    messages: textSize(JSON.stringify(body.messages ?? body.input ?? [])),
    tool_schemas: textSize(JSON.stringify(body.tools ?? [])) };
}
export function systemPromptSize(system: string, tools: unknown[]) {
  const skills = system.match(/<skills>[\s\S]*?<\/skills>/g)?.join('\n') ?? '';
  const cwd = system.match(/<cwd>[\s\S]*?<\/cwd>/g)?.join('\n') ?? '';
  const role = system.match(/<role>[\s\S]*?<\/role>/)?.[0] ?? '';
  const protocol = system.match(/<host_protocol>[\s\S]*?<\/host_protocol>/)?.[0] ?? '';
  const context = system.replace(role,'').replace(protocol,'').replace(skills,'').replace(cwd,'');
  return { role_body:{...textSize(role),source:'resolved_role'}, host_protocol:{...textSize(protocol),source:'host'},task_context:textSize(context),system: textSize(system), skill_index: textSize(skills), sdk_context: textSize(cwd), tool_schemas: textSize(JSON.stringify(tools)) };
}
