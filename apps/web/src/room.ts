/// <reference types="vite/client" />
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { rigDancer } from './dancer.ts';

type Plates = { room:Texture; pillar:Texture; figures:Texture[]; cone:Texture; dj:Texture };
const crop=(atlas:Texture,x:number,y:number,w:number,h:number)=>
  new Texture({source:atlas.source,frame:new Rectangle(x,y,w,h)});
let cached:Promise<Plates>|undefined;
function loadPlates():Promise<Plates>{
  return cached??=Promise.all(['room','pillar','figures'].map(name=>
    Assets.load<Texture>(`${import.meta.env.BASE_URL}art/hall-01/${name}.webp`)
  )).then(([room,pillar,atlas])=>({
    room,pillar,figures:Array.from({length:9},(_,i)=>crop(atlas,(i%5)*192,Math.floor(i/5)*256,192,256)),
    cone:crop(atlas,128,540,128,128),dj:crop(atlas,0,540,91,70)
  })).catch(error=>{cached=undefined;throw error;});
}
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const smooth=(x:number)=>x*x*(3-2*x);
const positions=[[541,351],[490,357],[443,368],[305,342],[340,390],[415,340],
  [686,347],[808,389],[602,412],[299,454],[212,492],[746,481]];

export function buildHall(stage:Container,art:Plates){
  function sprite(parent:Container,texture:Texture,x:number,y:number,w:number,h:number,ax=0,ay=0){
    const s=parent.addChild(new Sprite(texture));s.anchor.set(ax,ay);s.position.set(x,y);s.width=w;s.height=h;return s;
  }
  sprite(stage,art.room,0,0,1000,540);
  const cones=[301,360,709,768].map(x=>sprite(stage,art.cone,x,256,42,40,.5,.5));
  const dj=sprite(stage,art.dj,534.5,239,47,35,.5,1);
  const floor=stage.addChild(new Container());floor.sortableChildren=true;
  sprite(floor,art.pillar,130,72,66,333).zIndex=405;
  const actors=positions.map(([x,y],i)=>{
    const root=floor.addChild(new Container());
    const shadow=root.addChild(new Graphics());
    shadow.ellipse(8,0,22,3.1).fill({color:0x100c0b,alpha:.4});shadow.rotation=-.12;
    const pose=rigDancer(root,art.figures[i%9],i);
    const strides=Math.max(3,Math.round((x-57)/36));
    return {root,pose,x,y,strides,start:.5+Math.floor(i/3)*4.2+(i%3)*.75};
  });
  return (time:number,pulse:number,age:number,exit=0)=>{
    cones.forEach(s=>{s.width=42*(1+.14*pulse);s.height=40*(1+.14*pulse);});
    dj.rotation=Math.sin(time*1.8)*.025;
    actors.forEach(({root,pose,x,y,strides,start},i)=>{
      const leave=clamp(exit*1.4-i%3*.14);
      root.visible=age>start && leave<1;if(!root.visible)return;
      const walk=clamp((age-start)/(4+(x-65)/105));
      const p=smooth(walk)*(1-smooth(leave));
      const depth=334+(y-334)*p;
      root.position.set(57+(x-57)*p,depth);root.zIndex=depth+i*.0001;
      root.scale.set(.62+(depth-318)*.0033);
      const dir=leave>0?-1:1;
      pose(time,pulse,dir>0?p:1-p,strides,(x-57)/strides/root.scale.x*192/62,
        dir*(y-334)/strides/root.scale.y*256/82,dir);
    });
  };
}
export async function openRoom(host:HTMLElement,getArt=loadPlates) {
  const art=await getArt(),app=new Application();
  await app.init({width:1000,height:563,resolution:Math.min(1.6,globalThis.devicePixelRatio||1),
    antialias:true,preference:'webgl',backgroundColor:0x18130f,autoStart:false,sharedTicker:false});
  // Textures belong to the shared asset cache, not to an individual night.
  const dispose=()=>app.destroy({removeView:true},{children:true,context:true,texture:false,textureSource:false});
  try{
    app.stage.scale.y=563/540;
    const pose=buildHall(app.stage,art);host.prepend(app.canvas);
    return {frame(time:number,pulse:number,age:number,exit=0){pose(time,pulse,age,exit);app.render();},dispose};
  }catch(error){dispose();throw error;}
}
