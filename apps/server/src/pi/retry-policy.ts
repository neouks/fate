export function classifyModelError(error:string) {
  const status=Number(error.match(/(?:HTTP\s*|status(?:\s*code)?[\s:=]*|^)([45]\d\d)\b/i)?.[1]);
  const credential=/invalid.?api.?key|unauthori|insufficient|quota|credit|balance/i.test(error)||[401,402,403,404].includes(status);
  const permanent=credential||!!status&&status>=400&&status<500&&![408,409,429].includes(status)||/invalid.?request|invalid.?argument|unsupported.?parameter|context.?length|maximum context/i.test(error);
  const transient=!permanent && ([408,409,429].includes(status)||status>=500||/timeout|timed?\s*out|connection|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|overload|rate.?limit|stream.*(closed|interrupted|terminated)/i.test(error));
  return {credential,permanent,transient};
}
export function retryRule(local?:{attempts?:number;interval_ms?:number},global?:{attempts?:number;interval_ms?:number}) {
  const attempts=local?.attempts || global?.attempts || 3;
  const interval=local?.interval_ms || global?.interval_ms || 0;
  return {attempts:attempts<0?0:Math.min(20,attempts),delay:(retry:number)=>interval>0?Math.min(interval,3_600_000):Math.min(250*2**(retry-1),4000)};
}
