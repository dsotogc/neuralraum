import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Jobs } from '../src/jobs.ts';
const fixture=name=>JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}.json`,import.meta.url)));
const wire=fixture('lifecycle');
const file=new File(['tiny'],'night.mp3');
const json=body=>Response.json(body);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function mock(t,route) {
  const calls=[],sent=[],timers=[];
  t.mock.method(globalThis,'fetch',async(url,opt={})=>{
    calls.push([opt.method||'GET',url]);return route(url,opt);
  });
  t.mock.method(globalThis,'setTimeout',(fn,ms)=>{assert.equal(ms,1000);timers.push(fn);return 0;});
  globalThis.XMLHttpRequest=class {
    upload={};
    open(method,url){this.method=method;this.url=url;}
    setRequestHeader(k,v){assert.equal(k,'Content-Type');assert.equal(v,'audio/mpeg');}
    send(body){assert.equal(body,file);sent.push(this);}
    abort(){this.onabort();this.onloadend();}
  };
  t.after(()=>delete globalThis.XMLHttpRequest);
  const events=[];
  const observer=Object.fromEntries(['upload','status','reconnect','ready','failed'].map(k=>[k,v=>events.push([k,v])]));
  return {calls,sent,timers,events,observer};
}
test('late POST gets deleted; old reservation never uploads or overwrites replacement',async t=>{
  const old=deferred(), jobs=new Jobs();
  const id=wire.public[0].id, newer={...wire.public[0],id:wire.workerCancel[0].id};
  let posts=0;
  const m=mock(t,(_,o)=>o.method==='POST'?(++posts===1?old.promise:json(newer)):json({}));
  const a=jobs.start(file,m.observer);
  const b=jobs.start(file,m.observer); await tick();
  old.resolve(json(wire.public[0]));await a;
  assert.deepEqual(m.sent.map(x=>x.url),[`/v1/jobs/${newer.id}/audio`]);
  assert.ok(m.calls.some(([method,url])=>method==='DELETE'&&url.endsWith(id)));
  assert.deepEqual(m.events,[]);
  jobs.cancel();await b;
});
test('poll during PUT; delayed failed snapshot cannot affect next attempt',async t=>{
  const delayed=deferred(),jobs=new Jobs();
  const m=mock(t,(_,o)=>o.method==='POST'?json(wire.public[0]):o.method==='DELETE'?json({}):delayed.promise);
  const first=jobs.start(file,m.observer);await tick();
  const inflight=m.timers.shift()();
  const next=jobs.start(file,m.observer); await tick();
  delayed.resolve(json(wire.failed));await inflight;
  assert.deepEqual(m.events,[]);
  jobs.cancel();await Promise.all([first,next]);
});
test('transient GET recovers, serves complete timeline once after success',async t=>{
  const jobs=new Jobs(), states=[...wire.public,fixture('pulse')];
  let gets=0;
  const m=mock(t,(_,o)=>o.method==='POST'?json(wire.public[0]):o.method==='DELETE'?json({}):
    ++gets===1?Promise.reject(Error('offline')):json(states.shift()));
  const task=jobs.start(file,m.observer);await tick();
  const x=m.sent[0];x.upload.onprogress({loaded:2});x.status=202;x.onload();x.onloadend();
  await task;
  for(let i=0;i<5;i++)await m.timers.shift()();
  await tick();
  assert.deepEqual(m.events.map(e=>e[0]),['upload','reconnect','status','status','status','status','ready']);
  assert.deepEqual(m.events.at(-1)[1],fixture('pulse'));
  assert.equal(m.timers.length,0);jobs.cancel();
});
test('failure reports server reason without result fetch; retry sends retained file under fresh ID',async t=>{
  const jobs=new Jobs(), first=wire.public[0].id, next=wire.workerCancel[0].id;
  let posts=0;
  const m=mock(t,(url,o)=>o.method==='POST'?json({...wire.public[0],id:++posts===1?first:next}):
    o.method==='DELETE'?json({}):json(wire.failed));
  const a=jobs.start(file,m.observer);await tick();
  await m.timers.shift()();await a;
  assert.deepEqual(m.events.at(-1),['failed',wire.failed.error.message]);
  assert.ok(!m.calls.some(([,url])=>url.endsWith('/result')));
  const b=jobs.start(file,m.observer);await tick();
  assert.deepEqual(m.sent.map(x=>x.url),[first,next].map(id=>`/v1/jobs/${id}/audio`));
  jobs.cancel();await b;
});
for(const when of ['queued','ready','before confirmation']){
  test(`lost PUT response ${when}: confirmed result wins without retirement`, async t=>{
    const jobs=new Jobs(),states=[wire.public[1],wire.public[3],fixture('pulse')];
    const m=mock(t,(_,o)=>o.method==='POST'?json(wire.public[0]):json(states.shift()));
    const task=jobs.start(file,m.observer);await tick();
    const lose=async()=>{m.sent[0].onerror();m.sent[0].onloadend();await task;};
    if(when==='before confirmation')await lose();
    await m.timers.shift()();
    if(when==='queued')await lose();
    await m.timers.shift()();await tick();
    if(when==='ready')await lose();
    assert.deepEqual(m.events.map(([e])=>e),['status','status','ready']);
    assert.deepEqual(m.events.at(-1)[1],fixture('pulse'));
    assert.ok(!m.calls.some(([method])=>method==='DELETE'));
    jobs.cancel();
  });
}
test('lost PUT without server acceptance fails after a fresh status read',async t=>{
  const jobs=new Jobs();
  const m=mock(t,()=>json(wire.public[0]));
  const task=jobs.start(file,m.observer);await tick();
  m.sent[0].onerror();m.sent[0].onloadend();await task;
  await m.timers.shift()();
  assert.deepEqual(m.events.at(-1),['failed','Upload interrupted.']);
  assert.ok(m.calls.some(([method])=>method==='DELETE'));
});
