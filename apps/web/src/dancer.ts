import { Container, MeshPlane, Texture } from 'pixi.js';

// Landmarks on each 192 × 256 atlas cell: pelvis, neck, crown;
// left/right shoulder–elbow–hand and hip–knee–ankle (screen-relative).
const marks=[
 [99,113,108,52,114,15,85,53,74,90,78,112,127,54,126,94,141,134,85,123,71,184,56,237,111,123,126,182,116,238],
 [101,135,97,65,89,28,78,68,64,103,52,135,116,58,144,42,126,12,86,141,49,181,49,223,114,144,138,184,124,238],
 [99,133,102,49,105,15,71,53,61,94,62,116,117,52,134,86,124,98,81,138,75,182,63,229,116,140,117,186,111,239],
 [106,112,111,58,110,27,91,61,77,92,59,128,127,63,124,102,125,138,87,125,69,173,50,236,115,125,137,173,132,239],
 [99,117,102,48,100,16,77,54,66,94,61,125,126,54,136,90,133,111,84,130,66,184,57,236,113,130,128,180,129,238],
 [96,127,97,47,101,17,73,55,62,89,69,108,121,57,125,98,138,136,81,137,58,179,47,227,115,134,131,180,120,237],
 [96,138,108,46,108,17,73,55,54,103,51,133,127,56,139,98,146,131,83,146,63,187,48,232,115,147,135,189,133,238],
 [104,124,105,63,99,36,83,73,61,103,37,132,116,65,146,39,120,13,90,136,61,183,40,237,116,136,129,185,140,237],
 [95,118,96,50,92,17,76,57,72,94,55,140,120,58,130,99,119,121,80,131,51,181,66,236,110,130,129,177,147,230],
];
const links=[[0,1],[1,2],[3,4],[4,5],[6,7],[7,8],[9,10],[10,11],[12,13],[13,14]];
const clamp=(x:number,a=0,b=1)=>Math.max(a,Math.min(b,x));
const tau=2*Math.PI;

export function rigDancer(root:Container,texture:Texture,id:number){
  const rest=marks[id%marks.length], q=new Float32Array(rest), cols=15,rows=21;
  const mesh=root.addChild(new MeshPlane({texture,verticesX:cols,verticesY:rows}));
  mesh.scale.set(62/192,82/256);mesh.position.set(-31,-252*82/256);
  const geometry=mesh.geometry, buf=geometry.getBuffer('aPosition'), xy=geometry.positions;
  // Private geometry per figure; the atlas is shared across all nights.
  mesh.once('destroyed',()=>geometry.destroy(true));
  const count=cols*rows, weights=new Float32Array(count*links.length);
  const bind=new Float32Array(count*2), matrix=new Float32Array(links.length*4);
  for(let j=0;j<count;j++){
    const x=192*(j%cols)/(cols-1),y=256*Math.floor(j/cols)/(rows-1);
    bind[j*2]=x;bind[j*2+1]=y;
    let total=0;
    links.forEach(([a,b],k)=>{
      const ax=rest[2*a],ay=rest[2*a+1],dx=rest[2*b]-ax,dy=rest[2*b+1]-ay;
      const t=clamp(((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy));
      const d=(x-ax-t*dx)**2+(y-ay-t*dy)**2;
      const w=1/(1+d/(k===0?210:70))**2.6;weights[j*10+k]=w;total+=w;
    });
    for(let k=0;k<10;k++)weights[j*10+k]/=total;
  }
  function rotateChain(a:number,b:number,angle:number){
    const dx=rest[2*b]-rest[2*a],dy=rest[2*b+1]-rest[2*a+1],c=Math.cos(angle),s=Math.sin(angle);
    q[2*b]=q[2*a]+dx*c-dy*s;q[2*b+1]=q[2*a+1]+dx*s+dy*c;
  }
  return (time:number,pulse:number,travel:number,strides:number,stepSize:number,depthStep:number,direction:number)=>{
    const phase=travel*strides, moving=Math.min(1,phase*3,(strides-phase)*3);
    const cycle=phase*tau, groove=time*(1.75+.14*(id%4))+id*2.2, sway=Math.sin(groove);
    const accent=(1-moving)*pulse, weight=Math.sin(cycle)*moving+sway*(1-moving);
    q[0]=rest[0]+weight*5;q[1]=rest[1]+moving*(2-2*Math.cos(cycle*2))+(1-moving)*(2+1.8*sway)+accent*6;
    q[2]=rest[2]+weight*3+Math.sin(groove-.32)*(1-moving)*3;
    q[3]=rest[3]+(q[1]-rest[1])*.75;
    rotateChain(1,2,.065*Math.sin(groove-.48)*(1-moving)+.025*weight);
    for(let side=0;side<2;side++){
      const sign=side?1:-1, hip=9+side*3,knee=hip+1,ankle=hip+2,sh=3+side*3;
      // In stance the horizontal foot offset cancels forward root travel.
      const u=(phase+side*.5)%1, swing=clamp((u-.5)*2);
      const foot=u<.5?.25-u:-.25+.5*swing-Math.sin(tau*swing)*.5/Math.PI;
      const lift=Math.sin(Math.PI*swing)*moving;
      q[2*hip]=rest[2*hip]+q[0]-rest[0];q[2*hip+1]=rest[2*hip+1]+q[1]-rest[1]+sign*weight;
      q[2*ankle]=rest[2*ankle]+foot*stepSize*direction*moving;
      q[2*ankle+1]=rest[2*ankle+1]+foot*depthStep*moving-lift*13;
      const ax=q[2*hip],ay=q[2*hip+1],dx=q[2*ankle]-ax,dy=q[2*ankle+1]-ay;
      const d=Math.max(.1,Math.hypot(dx,dy)),l1=Math.hypot(rest[2*knee]-rest[2*hip],rest[2*knee+1]-rest[2*hip+1]);
      const l2=Math.hypot(rest[2*ankle]-rest[2*knee],rest[2*ankle+1]-rest[2*knee+1]);
      const along=clamp((d*d+l1*l1-l2*l2)/(2*d),0,l1),bend=Math.sqrt(Math.max(0,l1*l1-along*along));
      const bendSign=Math.sign((rest[2*knee]-rest[2*hip])*(rest[2*ankle+1]-rest[2*hip+1])-(rest[2*knee+1]-rest[2*hip+1])*(rest[2*ankle]-rest[2*hip]))||sign;
      q[2*knee]=ax+(dx*along+dy*bend*bendSign)/d;q[2*knee+1]=ay+(dy*along-dx*bend*bendSign)/d;
      q[2*sh]=rest[2*sh]+q[2]-rest[2];q[2*sh+1]=rest[2*sh+1]+q[3]-rest[3]+sign*weight*2;
      const arm=sign*(moving*Math.cos(cycle)*.29+(1-moving)*(.16*Math.sin(groove+side*.65)+accent*.21));
      rotateChain(sh,sh+1,arm);rotateChain(sh+1,sh+2,arm+sign*(.14*Math.sin(groove-.45)+accent*.13));
    }
    links.forEach(([a,b],k)=>{
      const ax=rest[2*a],ay=rest[2*a+1],dx=rest[2*b]-ax,dy=rest[2*b+1]-ay;
      const ex=q[2*b]-q[2*a],ey=q[2*b+1]-q[2*a+1],den=dx*dx+dy*dy;
      const c=(dx*ex+dy*ey)/den,s=(dx*ey-dy*ex)/den;
      const l=k*4;matrix[l]=c;matrix[l+1]=s;matrix[l+2]=q[2*a]-c*ax+s*ay;matrix[l+3]=q[2*a+1]-s*ax-c*ay;
    });
    for(let j=0;j<count;j++){
      const x=bind[j*2],y=bind[j*2+1];let nx=0,ny=0;
      for(let k=0;k<10;k++){const w=weights[j*10+k],l=k*4,c=matrix[l],s=matrix[l+1];
        nx+=w*(c*x-s*y+matrix[l+2]);ny+=w*(s*x+c*y+matrix[l+3]);}
      xy[j*2]=nx;xy[j*2+1]=ny;
    }
    buf.update();
  };
}
