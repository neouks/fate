import type { EvidenceContentPage } from "./types";
export type EvidenceText = { text: string; page: EvidenceContentPage; bytes: Uint8Array };
/** Pure reconstruction makes React retries safe and preserves split UTF-8 characters. */
export function appendEvidencePage(previous: EvidenceText | undefined, page: EvidenceContentPage): EvidenceText {
  const bytes =
    page.encoding === "base64"
      ? Uint8Array.from(atob(page.content), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(page.content);
  const joined = new Uint8Array((previous?.bytes.length ?? 0) + bytes.length);
  if (previous) joined.set(previous.bytes);
  joined.set(bytes, previous?.bytes.length ?? 0);
  return { page, bytes: joined, text: new TextDecoder().decode(joined, { stream: page.truncated }) };
}
