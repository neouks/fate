import type {Activity} from './types';

/** Use only the already-loaded content. Opening a process must not fetch every body. */
export function processPreview(steps: Pick<Activity,'kind'|'detail'|'summary'>[]): string {
 const thinking=steps.filter(step=>step.kind==='thinking');
 const selected=thinking.length?thinking:steps;
 // Cap work for long loaded bodies; CSS, rather than storage, clips the visible line.
 const preview=selected.map(step=>(step.detail?.trim()?step.detail:step.summary).slice(0,500).trim())
  .filter(Boolean).join(' ').replace(/\s+/gu,' ').trim();
 return preview||(thinking.length?'未记录推理内容':'未记录正文内容');
}
