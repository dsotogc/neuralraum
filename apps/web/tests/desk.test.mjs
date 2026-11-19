import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDesk } from '../src/desk.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function desk(t) {
  const nodes=new Map(),audio=[],rooms=[],frames=[],observers=[];
  const el=id=>{
    if(!nodes.has(id))nodes.set(id,{style:{},classList:{add(){},remove(){}},append(){},hidden:false,textContent:''});
    return nodes.get(id);
  };
  const env={
    document:{getElementById:el,querySelector:el,addEventListener(){}},
    window:{addEventListener(){}},requestAnimationFrame(fn){frames.push(fn);return frames.length;},
    cancelAnimationFrame(){}, Audio:class {
      currentTime=0;paused=true;ended=false;calls=0;started=deferred();
      constructor(){audio.push(this);}
      play(){assert.equal(el('cover').hidden,true,'cover gone when the gesture starts playback');
        this.calls++;this.paused=false;return this.started.promise;}
      pause(){this.paused=true;} load(){} removeAttribute(){}
      end(){this.ended=true;this.paused=true;this.onended();}
    }
  };
  t.after(()=>el('leave').onclick());
  for(const [k,v] of Object.entries(env)){
    const original=Object.getOwnPropertyDescriptor(globalThis,k);
    Object.defineProperty(globalThis,k,{value:v,configurable:true});
    t.after(()=>original?Object.defineProperty(globalThis,k,original):delete globalThis[k]);
  }
  mountDesk(()=>{
    const pending=deferred();
    const room={poses:[],disposed:0,frame(...args){this.poses.push(args);},dispose(){this.disposed++;}};
    rooms.push({pending,room});return pending.promise;
  },{cancel(){},start(_,observer){observers.push(observer);}});
  return {el,audio,rooms,frames,observers,async select(){
    el('file').files=[new File([Uint8Array.of(255,251,144,100)],'short.mp3')];
    await el('file').onchange();
  },async ready(i){rooms[i].pending.resolve(rooms[i].room);await tick();}};
}
test('delayed renderer never consumes the track; short audio ends in the hall before play resolves',async t=>{
  const d=desk(t);await d.select();const a=d.audio[0];
  assert.equal(d.el('enter').disabled,true);
  d.el('enter').onclick();assert.equal(a.calls,0);
  await d.ready(0);
  assert.equal(a.calls,0);assert.equal(d.el('enter').disabled,false);
  d.el('enter').onclick();assert.equal(a.calls,1,'play is synchronous with Enter');
  a.currentTime=.04;a.end();a.started.resolve();await tick();
  assert.equal(d.el('toggle').hidden,true);
  assert.match(d.el('message').textContent,/Set complete/);
  assert.equal(d.el('club').hidden,false);
});
test('replacement/cancel dispose late renderers; WebGL retry requires a fresh playback gesture',async t=>{
  const d=desk(t);
  await d.select();await d.select();
  await d.ready(0);assert.equal(d.rooms[0].room.disposed,1);
  assert.equal(d.el('enter').disabled,true);
  d.rooms[1].pending.reject(Error('WebGL'));await tick();
  assert.match(d.el('enter').textContent,/Retry room/);
  d.el('enter').onclick();await d.ready(2);
  assert.equal(d.audio[1].calls,0);
  await d.select();assert.equal(d.rooms[2].room.disposed,1);
  d.el('cancel').onclick();await d.ready(3);
  assert.equal(d.rooms[3].room.disposed,1);
  assert.equal(d.el('cover').hidden,false);
  assert.ok(d.audio.every(a=>!a.calls));
});
for(const order of ['abort before resume','abort after resume']){
  test(`pause while first play is pending: ${order}`,async t=>{
    const d=desk(t);await d.select();await d.ready(0);
    const a=d.audio[0],initial=a.started;
    d.el('enter').onclick();a.currentTime=.2;
    await d.el('toggle').onclick();
    const abort=async()=>{initial.reject(new DOMException('Paused','AbortError'));await tick();};
    if(order==='abort before resume')await abort();
    assert.equal(d.el('club').hidden,false);
    assert.equal(d.el('toggle').textContent,'Resume');
    a.started=deferred();
    const resume=d.el('toggle').onclick();a.started.resolve();await resume;
    if(order==='abort after resume')await abort();
    a.onpause(); // Delayed native pause event from the earlier intent.
    assert.equal(d.el('toggle').textContent,'Pause');
    assert.equal(d.el('cover').hidden,true);
    assert.equal(d.el('message').textContent,'');
    assert.equal(a.paused,false);assert.equal(a.currentTime,.2);
  });
}
test('late resume rejection cannot change replacement playback',async t=>{
  const d=desk(t);await d.select();await d.ready(0);
  const old=d.audio[0];d.el('enter').onclick();old.started.resolve();await tick();
  await d.el('toggle').onclick();old.started=deferred();
  const resume=d.el('toggle').onclick();
  await d.select();await d.ready(1);d.el('enter').onclick();d.audio[1].started.resolve();await tick();
  old.started.reject(new DOMException('Replaced','AbortError'));await resume;
  assert.equal(d.el('message').textContent,'');assert.equal(d.el('cover').hidden,true);
  assert.equal(d.el('toggle').textContent,'Pause');assert.equal(d.audio[1].paused,false);
});
test('current first play failure still returns to the poster',async t=>{
  const d=desk(t);await d.select();await d.ready(0);
  d.el('enter').onclick();d.audio[0].started.reject(new Error('Playback denied'));await tick();
  assert.equal(d.el('cover').hidden,false);assert.match(d.el('message').textContent,/Could not play/);
});
test('a real analysis failure clears adopted pulse and arrival time while playback continues',async t=>{
  const d=desk(t);await d.select();await d.ready(0);
  const a=d.audio[0],observer=d.observers[0];
  observer.ready({version:1,duration_s:5,beats:[{time_s:2,low_energy:1}]});
  d.el('enter').onclick();a.started.resolve();await tick();
  const frame=()=>d.frames.at(-1)(performance.now()+100);
  a.currentTime=2;frame();assert.deepEqual(d.rooms[0].room.poses.at(-1).slice(1,3),[1,2]);
  observer.failed('Analysis failed');frame();
  assert.deepEqual(d.rooms[0].room.poses.at(-1).slice(1,3),[0,-1]);
  assert.equal(a.paused,false);assert.equal(d.el('retry').hidden,false);
});
