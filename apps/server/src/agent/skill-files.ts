import {lstatSync, realpathSync, existsSync} from 'node:fs';
import path from 'node:path';
import {loadSkillsFromDir, parseFrontmatter} from '@earendil-works/pi-coding-agent';

export function skillNameOK(name:string){return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)&&name!=='.'&&name!=='..';}

/** The configured root may itself be a deployment symlink; children must not escape it. */
export function skillFilePath(root:string,name:string,rel:string,allowRoot=false):string {
  if(!skillNameOK(name)||rel.includes('\0')||rel.includes('\\')||path.isAbsolute(rel))throw new Error('非法 Skill 路径');
  const base=path.resolve(root),dir=path.join(base,name),file=path.resolve(dir,rel);
  if(file!==dir&&!file.startsWith(dir+path.sep)||file===dir&&!allowRoot)throw new Error('Skill 路径越界');
  let current=base;
  for(const part of path.relative(base,file).split(path.sep)){
    current=path.join(current,part);
    try{const st=lstatSync(current);if(st.isSymbolicLink()||st.isFile()&&st.nlink>1)throw new Error('Skill 路径不能包含符号链接或硬链接');}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')break;throw error;}
  }
  return file;
}

export function parseSkillDocument(md:string){
  const {frontmatter,body}=parseFrontmatter<Record<string,unknown>>(md);
  if(!frontmatter||typeof frontmatter!=='object'||Array.isArray(frontmatter))throw new Error('Skill frontmatter 必须为对象');
  return {fm:frontmatter,body};
}
export function buildSkillDocument(fm:Record<string,unknown>,body:string){
  // JSON values are valid YAML, including colons, #, multiline strings, lists and booleans.
  return ['---',...Object.entries(fm).filter(([,v])=>v!==''&&v!==undefined).map(([k,v])=>`${JSON.stringify(k)}: ${JSON.stringify(v)}`),'---','',body,''].join('\n');
}

/** Bindings use directory identities, not arbitrary frontmatter aliases. */
export function loadBoundSkills(root:string,allowed:string[]=[]){
  const result:ReturnType<typeof loadSkillsFromDir>={skills:[],diagnostics:[]};
  for(const name of [...new Set(allowed)].sort()){
    try{
      const file=skillFilePath(root,name,'SKILL.md');
      if(!existsSync(file))throw new Error('缺少 SKILL.md');
      const loaded=loadSkillsFromDir({dir:path.dirname(file),source:'series'});
      result.diagnostics.push(...loaded.diagnostics);
      const skill=loaded.skills.find(s=>realpathSync(s.filePath)===realpathSync(file));
      if(!skill)continue;
      if(skill.name!==name)result.diagnostics.push({type:'warning',path:file,message:`Skill name 与目录不一致；按绑定目录 ${name} 加载`});
      result.skills.push({...skill,name});
    }catch(error){result.diagnostics.push({type:'warning',path:path.join(root,name,'SKILL.md'),message:error instanceof Error?error.message:String(error)});}
  }
  return result;
}
