import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkFile, LIMIT, coneAt, NightClock, timeline} from '../src/music.ts';
const fixture=name=>JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}.json`,import.meta.url)));
const frame=[0xff,0xfb,0x90,0x64];
const file=(data,name='night.MP3')=>new File([Uint8Array.from(data)],name);

test('raw frame, tagged frame and v2.4 footer; no reads of tag payload or entire track',async()=>{
  for(const footer of [false,true]) {
    const f=file([73,68,51,4,0,footer?16:0,0,0,0,32,...Array(footer?42:32).fill(0),...frame]);
    const reads=[];
    await checkFile({name:f.name,size:LIMIT,slice(a,b){reads.push([a,b]);return f.slice(a,b);}});
    const off=footer?52:42;
    assert.deepEqual(reads,[[0,10],[off,off+4]]);
  }
  await checkFile(file(frame));
});
test('reject before admission: renamed WAV, bad headers, empty, too big, wrong extension',async()=>{
  for(const bytes of [[82,73,70,70,...frame],[],[73,68,51],[73,68,51,4,0,0,0,0,0,128],
    frame.slice(0,3),[255,235,144,100],[255,253,144,100],[255,251,252,100],[255,251,144,2]]) {
    await assert.rejects(checkFile(file(bytes)),/MPEG Layer III/);
  }
  await assert.rejects(checkFile({size:LIMIT+1,name:'night.mp3'}),/300,000,001 bytes/);
  await assert.rejects(checkFile(file(frame,'night.wav')),/300 MB/);
});
test('current media clock, silence, weak/strong bass, no extrapolation, ended',()=>{
  const pulse=timeline(fixture('pulse'));
  const approx=(a,b)=>assert.ok(Math.abs(a-b)<1e-9);
  approx(coneAt(pulse,3.04),.675);approx(coneAt(pulse,1.04),.075);
  for(const t of [0,.5,3.25,9])assert.equal(coneAt(pulse,t),0);
  assert.equal(coneAt(pulse,3,true),0);
  assert.equal(coneAt(timeline(fixture('silence')),1),0);
  for(const key of ['unsorted','atEnd','unscaled']) assert.throws(()=>timeline(fixture('invalid')[key]));
});
test('pending result does not advance paused crowd; resume joins current beat',()=>{
  const clock=new NightClock();
  assert.deepEqual(clock.sample(3),{pulse:0,crowdAge:-1});
  clock.result=timeline(fixture('pulse'));
  assert.equal(clock.joined,null);
  const resume=clock.sample(3.04);
  assert.equal(resume.crowdAge,0);
  assert.ok(Math.abs(resume.pulse-.675)<1e-9);
  assert.deepEqual(clock.sample(3.04),resume);
  assert.equal(clock.sample(4.04).crowdAge,1);
});
