// Runs the REAL Pi binary and REAL pi-ollama extension, with a mock Ollama HTTP server.
// Both artifacts must already be installed/reviewed; this script never downloads dependencies.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { fakeOllama } from './helpers.ts';
const binary=process.env.PI_BINARY, discovery=process.env.PI_OLLAMA_EXTENSION;
if(!binary || !discovery) throw new Error('Set PI_BINARY and PI_OLLAMA_EXTENSION to reviewed Pi 1.3+ and pi-ollama extensions/index.ts.');
const server=await fakeOllama();
const home=await mkdtemp(join(process.env.TEST_TMPDIR || tmpdir(),'pi-context-rpc-'));
const agent=join(home,'.pi','agent');await mkdir(agent,{recursive:true});
await writeFile(join(agent,'settings.json'),JSON.stringify({packages:[],compaction:{enabled:true},retry:{enabled:false},modelCatalog:{autoRefresh:false}}));
let child:any;
async function start(reverse=false) {
  const extensions=[resolve('src/index.ts'),resolve(discovery!)];if(reverse)extensions.reverse();
  child=spawn(binary!,['--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-tools','--system-prompt','Reply briefly.',...extensions.flatMap(e=>['-e',e])],{cwd:home,env:{PATH:process.env.PATH,HOME:home,PI_CODING_AGENT_DIR:agent,OLLAMA_BASE_URL:server.url,OLLAMA_API_KEY:'test-key',PI_SKIP_VERSION_CHECK:'1',NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
  const events:any[]=[];let stderr='';const waiters=new Map<string,any>();let seq=0;
  child.stderr.on('data',(b:any)=>{stderr+=b.toString();});
  createInterface({input:child.stdout}).on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return;}events.push(event);
    if(event.type==='response' && waiters.has(event.id)){const w=waiters.get(event.id);clearTimeout(w.timer);waiters.delete(event.id);w.resolve(event);}
    if(event.type==='extension_ui_request' && event.method==='select') child.stdin.write(JSON.stringify({type:'extension_ui_response',id:event.id,value:event.options[1]})+'\n');
  });
  async function cmd(type:string,rest:any={}) {const id=String(++seq);return await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(new Error(`Timeout ${type}; stderr=${stderr}; events=${JSON.stringify(events.slice(-8))}`));},20000);waiters.set(id,{resolve,timer});child.stdin.write(JSON.stringify({id,type,...rest})+'\n');});}
  await cmd('get_state');
  let available:any;for(let i=0;i<30;i++){available=await cmd('get_available_models');if(JSON.stringify(available).includes('tiny:latest'))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(JSON.stringify(available).includes('tiny:latest'),`Discovery failed: ${stderr} ${JSON.stringify(events)}`);
  return {cmd,events,stderr:()=>stderr,stop:async()=>{const p=child;const closed=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await closed;}};
}
try {
  for(const reverse of [false,true]) {
    const p=await start(reverse);
    assert.equal((await p.cmd('set_model',{provider:'ollama',modelId:'tiny:latest'})).success,true);
    await p.cmd('prompt',{message:'/context'});
    let state=await p.cmd('get_state');
    assert.equal(state.data.model.contextWindow,8192,JSON.stringify(p.events.slice(-10)));
    assert.equal(state.data.model.provider,'ollama-context');
    await p.cmd('prompt',{message:'/ollama-refresh'});
    await p.cmd('prompt',{message:'/ollama-info'});
    state=await p.cmd('get_state');assert.equal(state.data.model.contextWindow,8192);
    const count=server.state.streamCalls;
    await p.cmd('prompt',{message:'Say hello.'});
    for(let i=0;i<100 && !p.events.some(e=>e.type==='agent_end');i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(server.state.streamCalls,count+1,`No inference: ${JSON.stringify(p.events.slice(-20))}`);
    const sent=server.calls.filter(c=>c.path==='/v1/chat/completions').at(-1);
    assert.ok(sent.body.model.includes('-ctx8k-'));assert.equal(sent.headers.authorization,'Bearer test-key');
    assert.equal((await p.cmd('get_state')).data.model.contextWindow,8192);
    await p.cmd('set_model',{provider:'ollama',modelId:'second:latest'});
    await p.cmd('prompt',{message:'/context 16k'});
    assert.equal((await p.cmd('get_state')).data.model.contextWindow,16384);
    await p.cmd('set_model',{provider:'ollama',modelId:'tiny:latest'});
    assert.equal((await p.cmd('get_state')).data.model.contextWindow,8192);
    // A failed verification must end the turn without sending ANY inference request.
    server.loaded.clear();server.state.mismatch=true;const before=server.state.streamCalls;
    const eventStart=p.events.length;await p.cmd('prompt',{message:'Test failure.'});
    for(let i=0;i<100 && !p.events.slice(eventStart).some(e=>e.type==='agent_end');i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(server.state.streamCalls,before);
    assert.ok(JSON.stringify(p.events.slice(eventStart)).includes('Not applied'));
    server.state.mismatch=false;
    await p.stop();
    console.log(`PASS: real Pi + pi-ollama, ${reverse?'discovery first':'context first'}, UI, actual request target/auth, refresh, switching, persistence, fail-closed routing`);
  }
} finally {child?.kill('SIGTERM');await server.close();await rm(home,{recursive:true,force:true});}
