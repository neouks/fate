/** Monotonic execution time. Human waiting suspends both deadline and closing alarms. */
export class ActiveClock {
 private elapsed=0;private started=performance.now();private paused=false;private closed=false;
 private alarms=new Set<{at:number;fn:()=>void;timer?:ReturnType<typeof setTimeout>}>();
 at(at:number,fn:()=>void){const alarm={at,fn};this.alarms.add(alarm);this.schedule();}
 pause(){if(this.paused||this.closed)return;this.elapsed+=performance.now()-this.started;this.paused=true;this.schedule();}
 resume(){if(!this.paused||this.closed)return;this.started=performance.now();this.paused=false;this.schedule();}
 close(){this.closed=true;this.schedule();this.alarms.clear();}
 private schedule(){for(const a of this.alarms){clearTimeout(a.timer);if(this.paused||this.closed)continue;
  a.timer=setTimeout(()=>{this.alarms.delete(a);a.fn();},Math.max(0,a.at-this.elapsed-(performance.now()-this.started)));}}
}
