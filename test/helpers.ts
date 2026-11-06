import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/index.ts';
import { canonical } from '../src/core.ts';

export async function fakeOllama() {
  const models = new Map<string, any>([['tiny:latest', {n: 2048, digest: 'sha256:base', maximum: 131072}], ['second:latest', {n: 4096, digest: 'sha256:second', maximum: 131072}]]);
  const loaded = new Map<string, any>();
  const calls: any[] = [];
  const state = {mismatch: false, offline: false, gpu: false, embeddings: false, unknown: false, streamCalls: 0};
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url?.replace(/^\/proxy/, '');
    calls.push({path, body, headers: req.headers});
    res.setHeader('Content-Type', 'application/json');
    const send = (obj: any) => res.end(JSON.stringify(obj));
    if (state.offline) {res.statusCode = 503; send({error: 'offline'}); return;}
    const name = body?.model && canonical(body.model);
    const m = models.get(name);
    if (path === '/api/tags') return send({models: [...models].map(([name, v]) => ({name, model: name, digest: v.digest, size: 100, modified_at: '2026-01-01T00:00:00Z', details:{family:'llama',format:'gguf',parameter_size:'135M',quantization_level:'Q4_0'}}))});
    if (path === '/api/version') return send({version: '0.40.5'});
    if (path === '/api/ps') return send({models: [...loaded.values()]});
    if (path === '/api/show' && m) return send({parameters: `num_ctx ${m.n}\ntemperature 0.8`, capabilities: [state.embeddings ? 'embedding' : 'completion'], model_info: state.unknown ? {} : {'llama.context_length':m.maximum}, details:{family:'llama',parameter_size:'135M',quantization_level:'Q4_0'}, template:'{{ .Prompt }}'});
    if (path === '/api/create') {
      const source = models.get(canonical(body.from));
      models.set(name, {...source, n: body.parameters.num_ctx, digest:`sha256:${name}`}); return send({status:'success'});
    }
    if (path === '/api/generate' && m) {
      loaded.set(name, {name, model:name, digest:m.digest, context_length:state.mismatch ? m.n / 2 : m.n, size:1000000,size_vram:state.gpu ? 700000 : 0}); return send({model:name,done:true,response:''});
    }
    if (path === '/v1/models') return send({object:'list',data:[...models.keys()].map(id=>({id,object:'model',owned_by:'ollama'}))});
    if (path === '/v1/chat/completions') {
      state.streamCalls++;
      res.setHeader('Content-Type','text/event-stream');
      res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'Hello'},finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:1,total_tokens:31}})}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode=404; send({error:'missing'});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const addr = server.address() as any;
  return {url:`http://127.0.0.1:${addr.port}`, models, loaded, calls, state, close:()=>new Promise<void>(r=>{server.close(()=>r()); server.closeAllConnections();})};
}
export async function harness(url: string, existingDir?: string) {
  const dir = existingDir ?? await mkdtemp(join(tmpdir(),'pi-context-test-'));
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=dir;
  const models = new Map<string,any>();
  const base=(id: string)=>({provider:'ollama',id,name:id,api:'openai-completions',baseUrl:`${url}/v1`,contextWindow:131072,maxTokens:16384,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
  for(const id of ['tiny:latest','second:latest']) models.set(`ollama/${id}`,base(id));
  const commands=new Map<string,any>(), hooks=new Map<string,any[]>(), virtual=new Map<string,any>();
  const notices:any[]=[], statuses:any[]=[], registrations:string[]=[];
  let choice: string | undefined, input: string | undefined;
  const ctx:any={model:base('tiny:latest'),hasUI:true,isIdle:()=>true,hasPendingMessages:()=>false,getSystemPrompt:()=>'',getContextUsage:()=>({tokens:20}),sessionManager:{getSessionId:()=>'test-session',getLeafId:()=>'test-leaf',buildSessionContext:()=>({messages:[]})},modelRegistry:{find:(p:string,id:string)=>models.get(`${p}/${id}`),getApiKeyAndHeaders:async()=>({ok:true,apiKey:'test-key'})},ui:{select:async()=>choice,input:async()=>input,notify:(text:string,level:string)=>notices.push({text,level}),setStatus:(...s:any[])=>statuses.push(s)}};
  const pi:any={registerCommand:(n:string,c:any)=>commands.set(n,c),on:(n:string,h:any)=>hooks.set(n,[...(hooks.get(n)??[]),h]),registerVirtualModel:(v:any)=>{virtual.set(v.id,v);models.set(`${v.provider}/${v.id}`,{...v,api:'pi-virtual'});},unregisterVirtualModel:(p:string,id:string)=>{models.delete(`${p}/${id}`);virtual.delete(id);},registerProvider:(p:string,c:any)=>{registrations.push(p);for(const m of c.models)models.set(`${p}/${m.id}`,{...m,provider:p});},setModel:async(m:any)=>{ctx.model=m;for(const h of hooks.get('model_select')??[])await h({},ctx);return true;}};
  try {await extension(pi);} finally {if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prior;}
  return {dir,ctx,pi,commands,hooks,virtual,notices,statuses,registrations,choose:(v?:string,i?:string)=>{choice=v;input=i;},run:(s:string)=>commands.get('context').handler(s,ctx),route:()=>virtual.get(ctx.model.id).route({messages:[],thinkingLevel:'off'},ctx),close:()=>existingDir?Promise.resolve():rm(dir,{recursive:true,force:true})};
}
