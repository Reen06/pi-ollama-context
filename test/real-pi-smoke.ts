import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const {PI_BINARY,PI_OLLAMA_EXTENSION,TEST_OLLAMA_URL,TEST_OLLAMA_MODEL}=process.env;
if(!PI_BINARY||!PI_OLLAMA_EXTENSION||!TEST_OLLAMA_URL||!TEST_OLLAMA_MODEL)throw new Error('Set PI_BINARY, PI_OLLAMA_EXTENSION, TEST_OLLAMA_URL and TEST_OLLAMA_MODEL. Use a disposable server; variants are retained.');
const home=await mkdtemp(join(process.env.TEST_TMPDIR||tmpdir(),'pi-context-real-'));const dir=join(home,'.pi','agent');await mkdir(dir,{recursive:true});
const child=spawn(PI_BINARY,['--mode','rpc','--no-session','--no-extensions','--no-skills','--no-tools','--no-prompt-templates','--system-prompt','Reply briefly.','-e',resolve(PI_OLLAMA_EXTENSION),'-e',resolve('src/index.ts')],{cwd:home,env:{HOME:home,PATH:process.env.PATH,PI_CODING_AGENT_DIR:dir,OLLAMA_BASE_URL:TEST_OLLAMA_URL,PI_SKIP_VERSION_CHECK:'1'},stdio:['pipe','pipe','pipe']});
const events:any[]=[];const waiting=new Map<string,any>();let sequence=0;let stderr='';
child.stderr.on('data',x=>{stderr+=x;});
createInterface({input:child.stdout}).on('line',line=>{let e;try{e=JSON.parse(line);}catch{return;}events.push(e);if(e.type==='response'&&waiting.has(e.id)){const p=waiting.get(e.id);clearTimeout(p.timer);waiting.delete(e.id);p.resolve(e);}});
function cmd(type:string,args:any={}){const id=String(++sequence);return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timed out: ${type}; ${stderr}; ${JSON.stringify(events.slice(-5))}`)),190000);waiting.set(id,{resolve,timer});child.stdin.write(JSON.stringify({id,type,...args})+'\n');});}
try{
 await cmd('get_state');let ready=false;
 for(let i=0;i<100;i++){const a=await cmd('get_available_models');if(JSON.stringify(a).includes(TEST_OLLAMA_MODEL)){ready=true;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Discovery must find the installed model');
 assert.equal((await cmd('set_model',{provider:'ollama',modelId:TEST_OLLAMA_MODEL})).success,true);
 await cmd('prompt',{message:'/context 8192'});
 const state=await cmd('get_state');assert.equal(state.data.model.contextWindow,8192,JSON.stringify(events.slice(-8)));assert.equal(state.data.model.provider,'ollama-context',JSON.stringify(events.slice(-10)));
 await cmd('prompt',{message:'/ollama-refresh'});
 await cmd('prompt',{message:'Say hello.'});
 for(let i=0;i<1200&&!events.some(e=>e.type==='agent_end');i++)await new Promise(r=>setTimeout(r,100));
 const end=events.find(e=>e.type==='agent_end');assert.ok(end,JSON.stringify(events.slice(-10)));
 const answer=end.messages.filter((m:any)=>m.role==='assistant').at(-1);assert.equal(answer.stopReason,'stop',JSON.stringify(answer));
 const prefs=JSON.parse(await readFile(join(dir,'pi-ollama-context.json'),'utf8'));const saved:any=Object.values(prefs.entries)[0];
 const ps:any=await (await fetch(`${TEST_OLLAMA_URL}/api/ps`)).json();const allocation=ps.models.find((m:any)=>m.name===saved.variant);assert.equal(allocation.context_length,8192);
 console.log(JSON.stringify({pi:'1.3.0',discovery:'1.0.3',model:TEST_OLLAMA_MODEL,context:allocation.context_length,size_vram:allocation.size_vram,assistantStopReason:answer.stopReason,refreshPreserved:true},null,2));
}finally{for(const p of waiting.values())clearTimeout(p.timer);child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(home,{recursive:true,force:true});}
