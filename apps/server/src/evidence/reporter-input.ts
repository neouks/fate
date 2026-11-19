import {assembleReport} from './reproduction.js';

// Bound the serialized tool page, including escaped JSON, below the domain-tool
// output limit. Raw evidence remains intact and is read with next_offset.
export const REPORTER_PAGE_CHARACTERS = 4000;

export function reporterFindingInput(finding:Record<string,unknown>,evidence:unknown):string {
  const input={...finding};
  // Only omit an exact derived copy. Legacy or manually edited reports can
  // contain unique information and must remain available to the Reporter.
  if (finding.report_sections && typeof finding.report === 'string') {
    try {
      if (finding.report === assembleReport(finding)) {
        delete input.report;
        input.report_reused_from='report_sections + reproduction + evidence';
      }
    } catch {
      // Malformed historical structure must not prevent reading the original.
    }
  }
  // Bindings (including original headers) belong to the same paged document;
  // returning them outside the page repeats them on every continuation.
  return JSON.stringify({...input,traffic_evidence:evidence});
}
