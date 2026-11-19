/** A JSON document offset and an embedded string offset are different spaces.
 * Never interpret one as the other or fabricate a field read receipt. */
export type ReadCoordinate={ref:string;view:string;field:string;version?:number;cursor?:string;unit:'unicode_codepoints';format:'text'|'json'};
export class ReadSelectionRequired extends Error {
 readonly code:string='READ_SELECTION_REQUIRED';
 constructor(message:string,readonly read_options:Record<string,unknown>[]){super(message);}
}
export class ReadVersionChanged extends ReadSelectionRequired {
 override readonly code='READ_VERSION_CHANGED';
 constructor(requested:number,readonly current_version:number,retry:Record<string,unknown>){
  super(`请求版本 ${requested} 与当前版本 ${current_version} 不一致；请从 offset=0 重新读取，不能沿用旧版本偏移。`,[retry]);
 }
}
const escape=(key:string)=>key.replace(/~/g,'~0').replace(/\//g,'~1');
export function fieldReadOptions(data:unknown,base:{ref:string;view:string;version?:number}){
 const fields:string[]=[];let inspected=0;
 const visit=(value:unknown,prefix:string,depth:number)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||depth>2)return;
  for(const key in value){
   if(!Object.hasOwn(value,key))continue;
   if(++inspected>64||fields.length>=24)return;
   const child=(value as Record<string,unknown>)[key];
   const field=`${prefix}/${escape(key)}`;
   if(typeof child==='string')fields.push(field);
   else if(child&&typeof child==='object'&&!Array.isArray(child))visit(child,field,depth+1);
  }
 };
 visit(data,'',0);
 const preferred=['/payload/evidence','/finding_detail/evidence','/finding_detail/report','/payload/detail','/content','/detail','/output','/payload/summary','/summary'];
 const rank=(f:string)=>preferred.includes(f)?preferred.indexOf(f):preferred.length;
 fields.sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b));
 return [...new Set(fields)].slice(0,8).map(field=>({...base,field,offset:0}));
}
