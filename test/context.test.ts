import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRESETS, Store, Ollama, assertFits, endpoint, parseContext, describeAllocation } from '../src/core.ts';
import { fakeOllama, harness } from './helpers.ts';

async function setup(t:any) {const server=await fakeOllama();const h=await harness(server.url);t.after(async()=>{await h.close();await server.close();});return {server,h};}
test('parses integers and k suffixes; rejects invalid/risky sizes',()=>{
  for(const [s,n] of [['8192',8192],['16k',16384],[' 8K ',8192],['512',512]] as const) assert.equal(parseContext(s),n);
  for(const s of ['0','-1','1.5k','Infinity','8192 extra','2e4','511','1048577','9007199254740993'])assert.throws(()=>parseContext(s));
});
test('endpoint preserves proxy and rejects credential-bearing/unrecognized URLs',()=>{
  assert.equal(endpoint('https://example.test/proxy/v1/'),'https://example.test/proxy');
  for(const s of ['ftp://x/v1','http://user:password@x/v1','https://x/v1?key=x','http://x/api'])assert.throws(()=>endpoint(s));
});
test('interactive preset and custom selection allocate actual context',async t=>{
  const {server,h}=await setup(t);h.choose(PRESETS[1]);await h.run('');
  assert.equal(h.ctx.model.contextWindow,8192);assert.equal(server.loaded.values().next().value.context_length,8192);
  h.choose(PRESETS[5],'16k');await h.run('');assert.equal(h.ctx.model.contextWindow,16384);
  assert.ok(h.notices.some(n=>n.text.includes('Persistent: yes')));
});
test('cancel leaves original untouched and creates nothing',async t=>{const {server,h}=await setup(t);await h.run('');assert.equal(h.ctx.model.provider,'ollama');assert.equal(server.models.size,2);});
test('persists, restores across restart, handles switching and does not replace discovery provider',async t=>{
  const {server,h}=await setup(t);await h.run('8192');const first=h.ctx.model.id;
  await h.pi.setModel(h.ctx.modelRegistry.find('ollama','second:latest'));await h.run('16k');
  await h.pi.setModel(h.ctx.modelRegistry.find('ollama','tiny:latest'));assert.equal(h.ctx.model.id,first);
  const next=await harness(server.url,h.dir);for(const fn of next.hooks.get('session_start')??[])await fn({},next.ctx);
  assert.equal(next.ctx.model.contextWindow,8192);assert.ok(h.registrations.every(p=>p==='ollama-context'));
  const raw=await readFile(join(h.dir,'pi-ollama-context.json'),'utf8');assert.ok(!raw.includes('test-key'));assert.equal((await stat(join(h.dir,'pi-ollama-context.json'))).mode & 0o777,0o600);
});
test('verification mismatch does not change selection or save success',async t=>{const {server,h}=await setup(t);server.state.mismatch=true;await h.run('8k');assert.equal(h.ctx.model.provider,'ollama');assert.equal(h.notices.at(-1).level,'error');assert.match(h.notices.at(-1).text,/Not applied/);assert.equal((await new Store(join(h.dir,'pi-ollama-context.json')).read()).entries && Object.keys((await new Store(join(h.dir,'pi-ollama-context.json')).read()).entries).length,0);});
test('API offline yields useful error, no fallback or state mutation',async t=>{const {server,h}=await setup(t);server.state.offline=true;await h.run('8k');assert.equal(h.ctx.model.provider,'ollama');assert.match(h.notices.at(-1).text,/no fallback server/);});
test('unreachable server rejects with recovery guidance',async()=>{await assert.rejects(new Ollama('http://127.0.0.1:1').digest('tiny'),/Check the selected server/);});
test('embedding-only, excessive context and unknown maximum rejected',async t=>{const {server,h}=await setup(t);server.state.embeddings=true;await h.run('8k');assert.match(h.notices.at(-1).text,/embedding/);server.state.embeddings=false;await h.run('256k');assert.match(h.notices.at(-1).text,/maximum/);server.state.unknown=true;await h.run('8k');assert.match(h.notices.at(-1).text,/refusing to guess/);assert.equal(server.models.size,2);});
test('unsafe history reduction refuses before create; active turn refuses',async t=>{const {server,h}=await setup(t);h.ctx.sessionManager.buildSessionContext=()=>({messages:[{role:'user',content:'x'.repeat(10000)}]});await h.run('4k');assert.match(h.notices.at(-1).text,/Nothing was truncated/);assert.equal(server.models.size,2);h.ctx.isIdle=()=>false;await h.run('16k');assert.match(h.notices.at(-1).text,/current turn/);});
test('every route verifies allocation; unload reloads, drift fails closed',async t=>{const {server,h}=await setup(t);await h.run('8k');server.loaded.clear();await h.route();assert.equal(server.loaded.size,1);server.loaded.clear();server.state.mismatch=true;await assert.rejects(h.route(),/Not applied/);});
test('original digest changes fail closed; repeating command creates fresh variant',async t=>{const {server,h}=await setup(t);await h.run('8k');server.models.get('tiny:latest').digest='new-original';await assert.rejects(h.route(),/original model changed/);await h.run('8k');await h.route();assert.equal(h.notices.at(-1).level,'info');});
test('reset retains variants and original; refuses populated session',async t=>{const {server,h}=await setup(t);await h.run('8k');h.ctx.sessionManager.buildSessionContext=()=>({messages:[{role:'user',content:'hello'}]});await h.run('reset');assert.match(h.notices.at(-1).text,/Use \/new/);h.ctx.sessionManager.buildSessionContext=()=>({messages:[]});await h.run('reset');assert.equal(h.ctx.model.provider,'ollama');assert.equal(h.ctx.model.contextWindow,2048);assert.equal(server.models.size,3);assert.ok(!server.calls.some(c=>c.path==='/api/delete'));});
test('CPU and partial GPU status use actual numbers, never claim fully GPU loaded',async t=>{const {server,h}=await setup(t);await h.run('8k');assert.ok(h.notices.some(n=>/CPU allocation/.test(n.text)));server.loaded.clear();server.state.gpu=true;await h.run('8k');assert.ok(h.notices.some(n=>/not proof of full GPU/.test(n.text)));assert.match(describeAllocation(),/unknown/);});
test('route rejects oversized or unbounded multimodal inputs',()=>{assert.throws(()=>assertFits([{content:'x'.repeat(9000)}],4096));assert.throws(()=>assertFits([{type:'image',data:'x'}],8192),/image\/audio/);});
test('corrupt settings never overwritten',async t=>{const {h}=await setup(t);await writeFile(join(h.dir,'pi-ollama-context.json'),'bad');await h.run('8k');assert.equal(h.notices.at(-1).level,'error');assert.equal(await readFile(join(h.dir,'pi-ollama-context.json'),'utf8'),'bad');});
test('proxy/auth preserved on native APIs; no redirects',async t=>{const {server}=await setup(t);const api=new Ollama(`${server.url}/proxy`,{Authorization:'Bearer proxy-key'});await api.create('tiny:latest',8192);assert.equal(server.calls.at(-1).headers.authorization,'Bearer proxy-key');});
test('cross-session reset/change invalidates stale router',async t=>{const {h}=await setup(t);await h.run('8k');const s=new Store(join(h.dir,'pi-ollama-context.json'));const state=await s.read();await s.update(Object.keys(state.entries)[0]);await assert.rejects(h.route(),/another session/);});
test('threshold compaction respects small context; manual never cancelled',async t=>{const {h}=await setup(t);await h.run('8k');const hook=h.hooks.get('session_before_compact')[0];assert.deepEqual(await hook({reason:'threshold'},h.ctx),{cancel:true});assert.equal(await hook({reason:'manual'},h.ctx),undefined);h.ctx.getContextUsage=()=>({tokens:8000});assert.equal(await hook({reason:'threshold'},h.ctx),undefined);});
test('registry object refresh with same model/session does not cancel setup',async t=>{
  const {h}=await setup(t);let model=h.ctx.model;Object.defineProperty(h.ctx,'model',{get:()=>({...model}),set:v=>{model=v;},configurable:true});
  await h.run('8k');assert.equal(h.ctx.model.provider,'ollama-context');assert.equal(h.notices.at(-1).level,'info');
});
test('Pi 1.5 conversation projection API is supported',async t=>{const {h}=await setup(t);delete h.ctx.sessionManager.buildSessionContext;h.ctx.sessionManager.buildSessionProjection=()=>({messages:[]});await h.run('8k');assert.equal(h.ctx.model.contextWindow,8192);});
test('show is read-only and invalid custom input never creates a variant',async t=>{const {server,h}=await setup(t);await h.run('show');assert.match(h.notices.at(-1).text,/unknown/);h.choose(PRESETS[5],'1.5k');await h.run('');assert.equal(h.notices.at(-1).level,'error');assert.equal(server.models.size,2);assert.ok(!server.calls.some(c=>c.path==='/api/generate'));});
test('different endpoint refuses saved routing',async t=>{const {h}=await setup(t);await h.run('8k');h.ctx.modelRegistry.find('ollama','tiny:latest').baseUrl='http://127.0.0.1:12345/v1';await assert.rejects(h.route(),/endpoint changed/);});
test('settings lock rejects concurrent writers without modifying existing file',async t=>{const {h}=await setup(t);await h.run('8k');const path=join(h.dir,'pi-ollama-context.json');const before=await readFile(path,'utf8');await writeFile(`${path}.lock`,'');await assert.rejects(new Store(path).update('unused'),/locked/);assert.equal(await readFile(path,'utf8'),before);});
test('cloud and non-Ollama selections rejected without mutation',async t=>{const {h}=await setup(t);h.ctx.model.provider='openai';await h.run('8k');assert.match(h.notices.at(-1).text,/local Ollama/);const api=new Ollama('http://unused',{},async()=>new Response(JSON.stringify({capabilities:['completion'],remote_model:'cloud-model'})) as any);await assert.rejects(api.info('cloud-model:cloud'),/Cloud models/);});
test('loads saved default without num_ctx request override',async t=>{const {server,h}=await setup(t);await h.run('8k');const load=server.calls.find(c=>c.path==='/api/generate');assert.equal(load.body.options,undefined);assert.equal(server.models.get('tiny:latest').n,2048);});
test('Ollama can reuse an identical manifest under another loaded alias',async t=>{const {server,h}=await setup(t);await h.run('8k');const entry=Object.values((await new Store(join(h.dir,'pi-ollama-context.json')).read()).entries)[0];const allocation=server.loaded.get(entry.variant);server.loaded.clear();server.loaded.set('another-name:latest',{...allocation,name:'another-name:latest',model:'another-name:latest'});await h.route();await h.run('show');assert.match(h.notices.at(-1).text,/Effective: 8192/);});
