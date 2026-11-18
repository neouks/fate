export type ArchivedRead = {
  match:'distinct'|'page'|'identical';
  originalBytes:number;
  referenceBytes?:number;
  firstRound?:number;
  start?:number;
  end?:number;
};
export type ReadCounts = {items:number;pages:number;identical:number;netBytes:number};
export type FactEvent = {id:number;version:number;session:string;round:number;time:string;kind:'submit'|'read'|'search';comparison?:ArchivedRead};
type Size = {label:string;bytes:number};
export type AuditRound = {number:number; input:number|null;cacheRead:number|null;cacheWrite:number|null;total:number|null;delta:number|null; additions:Size[];largeOutputs:Size[];events:FactEvent[]};
export type AuditSession = {name:string;rounds:AuditRound[];warnings:string[]};
export type FactRow = {id:number;version:number;summary:string;worker:string;signature:string|null};
export type AuditMember = FactRow & {events:FactEvent[]};
export type FactAudit = {reads:Record<'read'|'search',ReadCounts>;rawCount:number;repeatCount:number;groups:AuditMember[][];sessions:AuditSession[]};
