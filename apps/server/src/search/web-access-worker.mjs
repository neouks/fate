// Each native extension instance runs in its own worker. Upstream config/module
// caches, proxy hooks and result maps never leak into other platform sessions.
import { parentPort, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
writeFileSync(`${workerData.configDir}/web-search.json`, JSON.stringify(workerData.config), { mode: 0o600 });
const { default: extension } = await import('pi-web-access/dist/index.js');
const tools = new Map(), handlers = new Map();
let branch = [], currentID, controller, running;
const context = {
  hasUI: false, cwd: workerData.configDir,
  sessionManager: { getBranch: () => branch },
  modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined, getApiKey: async () => undefined },
  ui: { notify() {}, setWidget() {} },
};
const emit = async (type, event = {}) => {
  for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
};
extension({
  registerTool: tool => tools.set(tool.name, tool),
  on(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
  registerCommand() {}, registerShortcut() {},
  appendEntry(customType, data) {
    branch.push({ type: 'custom', customType, data });
    parentPort.postMessage({ type: 'entry', id: currentID, customType, data });
  },
  sendMessage() { throw new Error('Background web messages are disabled in the platform host'); },
  exec() { throw new Error('Interactive web commands are disabled in the platform host'); },
});
await emit('session_start');
parentPort.postMessage({ type: 'ready', tools: [...tools.values()].map(({ name, label, description, parameters }) => JSON.parse(JSON.stringify({ name, label, description, parameters }))) });
parentPort.on('message', async message => {
  if (message.type === 'abort') {
    controller?.abort();
    await running?.catch(() => {});
    await emit('session_shutdown', { reason: 'quit' });
    parentPort.close();
    return;
  }
  if (message.type !== 'call') return;
  running = (async () => {
  currentID = message.id;
  controller = new AbortController();
  branch = message.entries;
  // Restore native custom entries into this generation's private upstream map.
  await emit('session_tree');
  try {
    const tool = tools.get(message.name);
    if (!tool) throw new Error('Unknown web tool');
    const args = tool.prepareArguments ? tool.prepareArguments(message.args) : message.args;
    const result = await tool.execute(message.id, args, controller.signal,
      update => parentPort.postMessage({ type: 'update', id: message.id, update }), context);
    parentPort.postMessage({ type: 'result', id: message.id, result });
  } catch {
    // Provider diagnostics may contain credentials. The host returns a bounded,
    // redacted tool error rather than forwarding exception stacks/configuration.
    parentPort.postMessage({ type: 'result', id: message.id, result: { isError: true, content: [{ type: 'text', text: '网页工具执行失败，请检查供应商凭证、代理和网络配置。' }], details: {} } });
  }
  })();
  await running;
});
