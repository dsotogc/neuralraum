import test from 'node:test';
import assert from 'node:assert/strict';
import { Application, Container, Graphics, Texture } from 'pixi.js';
import { buildHall, openRoom } from '../src/room.ts';
const tex=Texture.WHITE;
const art={room:tex,pillar:tex,figures:Array(9).fill(tex),cone:tex,dj:tex};

for(const failure of ['buildHall','prepend']){
  test(`initialized application is destroyed if ${failure} throws`,async t=>{
    const fault=new Error(failure);
    let partial,initialized;
    t.mock.method(Application.prototype,'init',async function(){
      initialized=this;this.renderer={canvas:{}};
      if(failure==='buildHall'){
        const add=this.stage.addChild.bind(this.stage);
        this.stage.addChild=child=>{partial=add(child);throw fault;};
      }
    });
    const destroy=t.mock.method(Application.prototype,'destroy',function(view,resources){
      assert.equal(this,initialized);assert.equal(view.removeView,true);
      assert.equal(resources.children,true);assert.equal(resources.context,true);
      partial??=this.stage.children[0];this.stage.destroy(resources);
    });
    await assert.rejects(openRoom({prepend(){throw fault;}},async()=>art),e=>e===fault);
    assert.equal(destroy.mock.callCount(),1);assert.equal(partial.destroyed,true);
  });
}

test('bounded scene workload reuses actor and cone geometry across nights', t=>{
  const stage=new Container(),pose=buildHall(stage,art);
  function geometry(o, list=[]) {
    if(o instanceof Graphics)list.push(o.context);
    for(const child of o.children)geometry(child,list);
    return list;
  }
  const original=geometry(stage), versions=original.map(g=>g.instructions.length);
  const mib=()=>Math.round(process.memoryUsage.rss()/1048576);
  const samples=[mib()];
  try{
    for(let night=0;night<3;night++){
      for(let frame=0;frame<240;frame++){
        const time=frame/10;pose(time,frame%5===0?.9:0,time-2);
        if(frame%40===0)assert.ok(mib()<256 && mib()-samples[0]<64,'Stop: scene RSS guard');
      }
      samples.push(mib());
    }
    const after=geometry(stage);
    assert.equal(after.length,original.length);
    after.forEach((g,i)=>{assert.equal(g,original[i]);assert.equal(g.instructions.length,versions[i]);});
    t.diagnostic(`${after.length} stable contexts; Node RSS MiB (baseline + 3 nights): ${samples.join(' / ')}`);
  }finally{stage.destroy({children:true,context:true});}
});
