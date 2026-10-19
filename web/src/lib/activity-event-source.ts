/** Native EventSource retries connection loss, but stops after proxy 502/503
 * responses. Reopen those closed streams from the caller's durable cursor. */
export function openActivityStream(
  url: () => string,
  attach: (source: EventSource) => void,
  connection: (connected: boolean) => void,
) {
  let stopped = false;
  let source: EventSource;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  const connect = () => {
    if (stopped) return;
    source = new EventSource(url());
    const current = source;
    attach(current);
    current.addEventListener('open', () => {
      if (!stopped && current === source) { delay = 500; connection(true); }
    });
    current.addEventListener('error', () => {
      if (stopped || current !== source) return;
      connection(false);
      if (current.readyState !== EventSource.CLOSED || timer) return;
      current.close();
      timer = setTimeout(() => { timer = undefined; connect(); }, delay);
      delay = Math.min(1000, delay * 2);
    });
  };
  connect();
  return { close() { stopped = true; clearTimeout(timer); source?.close(); } };
}
