/** Preserve the visible activity even when an older page extends the same card. */
export function preserveTranscriptPosition(viewport: HTMLElement | null): () => void {
  if (!viewport) return () => {};
  const bounds = viewport.getBoundingClientRect();
  const anchor = Array.from(viewport.querySelectorAll<HTMLElement>('[data-activity-id]'))
    .find(element => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
  if (!anchor) return () => {};
  const top = anchor.getBoundingClientRect().top;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const events = ['wheel', 'touchstart', 'keydown'] as const;
  for (const event of events) viewport.addEventListener(event, cancel, { passive: true });
  return () => requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const event of events) viewport.removeEventListener(event, cancel);
    if (!cancelled && viewport.isConnected && anchor.isConnected) {
      viewport.scrollTop += anchor.getBoundingClientRect().top - top;
    }
  }));
}
