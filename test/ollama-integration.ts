// Opt-in: creates (and retains) small derived models on a disposable Ollama server.
import assert from 'node:assert/strict';
import { Ollama } from '../src/core.ts';
const url=process.env.TEST_OLLAMA_URL;
const source=process.env.TEST_OLLAMA_MODEL;
if(!url || !source) throw new Error('Set TEST_OLLAMA_URL and TEST_OLLAMA_MODEL to a disposable Ollama instance/model. This test creates retained variants.');
const api=new Ollama(url);
const digest=await api.digest(source);
const info=await api.info(source);
const artifacts:any[]=[];
for(const size of [4096,8192]) {
  const {entry,allocation}=await api.create(source,size);
  assert.equal(allocation.context_length,size);
  assert.equal(await api.digest(source),digest);
  const variant=await api.info(entry.variant);
  // Native create FROM must reference the same immutable weight blob.
  const from=(s:string)=>/^FROM\s+(.+)$/m.exec(s)?.[1];
  assert.ok(from(info.modelfile));assert.equal(from(variant.modelfile),from(info.modelfile));
  const response=await fetch(`${url}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:entry.variant,messages:[{role:'user',content:'Say hello.'}],max_tokens:8,stream:false})});
  assert.equal(response.status,200);const data:any=await response.json();assert.ok(data.choices?.length);
  assert.equal((await api.allocation(entry.variant))?.context_length,size);
  await api.call('/api/generate',{model:entry.variant,keep_alive:0,stream:false});
  const restored=await api.verify(entry);assert.equal(restored.context_length,size);
  artifacts.push({variant:entry.variant,tokens:size,size:allocation.size,size_vram:allocation.size_vram,sharedWeights:true,sourceDigest:digest});
}
console.log(JSON.stringify({server:url,source,results:artifacts},null,2));
