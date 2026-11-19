/* Floor study 02. Stage coordinates are projected floor coordinates;
   y is also the depth key. The camera never follows an actor. */
(async () => {
  const status = document.querySelector('#status');
  try {
    if (!window.PIXI) throw Error('PixiJS did not load. Check access to cdn.jsdelivr.net and reload.');
    const { Application, Graphics, Container } = PIXI;
    const app = new Application();
    await app.init({ width: 1000, height: 540, preference: 'webgl', antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1), backgroundColor: 0x171818 });
    document.querySelector('#view').append(app.canvas);
    const room = new Graphics(), shadows = new Graphics(), crowd = new Container();
    app.stage.addChild(room, shadows, crowd);
    const poly = (g, p, color, alpha=1) => g.poly(p).fill({color,alpha});
    const rect = (g,x,y,w,h,c) => g.rect(x,y,w,h).fill(c);
    const line = (g,p,color,width=1,alpha=1) => {
      g.moveTo(p[0],p[1]);
      for(let i=2;i<p.length;i+=2) g.lineTo(p[i],p[i+1]);
      g.stroke({color,width,alpha,cap:'round',join:'round'});
    };
    const disc = (g,x,y,r,c) => g.circle(x,y,r).fill(c);
    // Cast concrete, expansion joints and overhead steel.
    rect(room,165,0,670,218,0x303130);
    for(let x=175;x<835;x+=83) {
      rect(room,x,0,1,216,0x202221);
      for(let y=23;y<212;y+=72) disc(room,x+7,y,1,0x1c1e1d);
    }
    poly(room,[0,0,165,0,165,218,0,348],0x252625);
    poly(room,[835,0,1000,0,1000,348,835,218],0x222423);
    for (let i=0;i<3;i++) {
      const y=13+i*10;
      line(room,[0,y-18,165,y,835,y,1000,y-18],0x191a19,4);
    }
    poly(room,[0,348,165,218,835,218,1000,348,1000,540,0,540],0x41413d);
    for(let x=-820;x<=1850;x+=167) {
      line(room,[500+(x-500)*.34,218,x,540],0x363733);
    }
    for(const y of [240,277,336,425,531]) {
      const inset=Math.max(0,165-(y-218)*165/130);
      line(room,[inset,y,1000-inset,y],0x373834);
    }
    // Recessed access door, practical side strip and its spill.
    poly(room,[67,183,115,165,115,257,67,296],0x121414);
    line(room,[67,294,67,183,115,165],0x4f483b,2);
    line(room,[4,316,57,275],0xc39363,3);
    poly(room,[0,349,62,299,448,337,329,397],0xc09060,.09);
    poly(room,[0,351,58,306,337,337,207,355],0xd29d65,.055);
    // Two banks of driver cabinets bracket the raised concrete booth.
    for (const x of [246,301,642,697]) {
      rect(room,x-2,72,56,144,0x141615);
      for(let row=0;row<2;row++) {
        const y=74+row*70;
        rect(room,x,y,51,66,0x272927);
        rect(room,x+2,y+2,47,2,0x3a3a36);
        for(const [cy,r] of [[y+13,7],[y+42,19]]) {
          disc(room,x+25,cy,r,0x111312); disc(room,x+25,cy,r*.84,0x30322f);
          disc(room,x+25,cy,r*.65,0x232523); disc(room,x+25,cy,r*.28,0x171918);
        }
      }
    }
    rect(room,385,87,230,3,0x181a19);
    rect(room,391,88,67,1,0xab8059);
    disc(room,503,136,8,0x171918);
    poly(room,[489,149,511,146,523,165,478,165],0x1b1d1c);
    poly(room,[369,164,620,164,632,177,358,177],0x484842);
    rect(room,358,177,274,42,0x282a28);
    for(let x=364;x<631;x+=8) rect(room,x,179,2,37,0x1f211f);
    rect(room,364,177,139,1,0xb68a5e);
    rect(room,389,160,58,4,0x181a19); rect(room,465,161,92,4,0x191b19);

    const people=[];
    // Moving actors advance in whole steps; start/end are two-foot rests.
    function actor(x,y,id,{end=[x,y],start=0,steps=0,period=.42,mark=false}={}) {
      const g=new Graphics();
      crowd.addChild(g);
      people.push({x,y,id,end,start,steps,period,mark,g});
    }
    [[241,263],[403,249],[735,260],[816,316],[294,373],[598,367],[176,452],[748,466]]
      .forEach(([x,y],id)=>actor(x,y,id));
    actor(681,291,8,{end:[310,285],start:4,steps:30,period:.42});
    [[109,259,566,248,1],[94,271,518,259,2.35],[78,286,473,273,3.8]]
      .forEach(([x,y,ex,ey,start],i)=>actor(x,y,9+i,{end:[ex,ey],start,steps:36,period:.40,mark:true}));
    const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    function pose(a,t) {
      a.g.visible=!a.mark || t>=a.start;
      if(!a.g.visible) return;
      const step=clamp((t-a.start)/a.period,0,a.steps);
      const dx=(a.end[0]-a.x)/(a.steps||1), dy=(a.end[1]-a.y)/(a.steps||1);
      const x=a.x+dx*step,y=a.y+dy*step;
      const s=(.72+(y-218)*.0028)*(1+.045*Math.sin(a.id*9));
      const g=a.g.clear(); g.position.set(x,y); g.scale.set(s);
      const moving=step>0 && step<a.steps;
      const beat=t*(3.2+.13*(a.id%4))+a.id*2.4;
      const pulse=moving?Math.sin(step*Math.PI):Math.sin(beat);
      const hipX=(moving?1:3)*pulse, hipY=-30+1.8*pulse*pulse;
      const lean=hipX+Math.sin(beat*.5)*2;
      const body=a.mark?0x272724:0x1b1d1c, dark=0x141615;
      const rim=a.mark?0xe0ac75:0x888274;
      shadows.ellipse(x+5*s,y+1,15*s,2.6*s).fill({color:0x101210,alpha:.36});
      for(const side of [-1,1]) {
        // Alternating footfall stations in floor space, with the support
        // foot held exactly still until the other foot reaches the floor.
        const n=Math.floor(step), f=step-n, swing=n%2===(side===1?0:1);
        const from=clamp(n-1,0,a.steps), to=clamp(n+1,0,a.steps);
        const station=swing?from+(to-from)*f*f*(3-2*f):clamp(n,0,a.steps);
        const lift=moving&&swing?Math.sin(Math.PI*f)*4:0;
        const fx=(station-step)*dx/s+side*6, fy=(station-step)*dy/s-lift;
        const kx=(fx+hipX)*.5+side*(2+Math.abs(pulse)*1.5);
        line(g,[hipX+side*3,hipY,kx,-16+lift*.4,fx,fy-2],side<0?0x353632:dark,5.6);
        line(g,[fx-2,fy-1,fx+3,fy-1],dark,3);
      }
      const sy=hipY-21;
      const wide=8+a.id%3;
      poly(g,[lean-wide,sy+2,lean-4,sy-2,lean+wide,sy,hipX+7,hipY+3,hipX-7,hipY+3],body);
      line(g,[lean-wide,sy+3,lean-4,sy-2],rim,1.8);
      for(const side of [-1,1]) {
        const raised=!moving && (a.id+side+1)%3===0;
        const ex=lean+side*(wide+4+2*pulse),ey=sy+(raised?2:12);
        const hx=ex+side*(raised?2:3*pulse),hy=ey+(raised?-13:6)-side*pulse*4;
        line(g,[lean+side*wide,sy+3,ex,ey,hx,hy],side<0?0x515048:dark,4.4);
      }
      const headX=lean+Math.sin(beat*.75), headY=sy-9;
      g.ellipse(headX,headY,5.7,7.4).fill(body);
      if(a.id%3===1) disc(g,headX-4,headY-5,3.6,body);
      if(a.mark) line(g,[headX-5,headY-3,headX-2,headY-7,headX+2,headY-7],rim,1.6);
      if(a.id===9) line(g,[lean-6,sy,lean+4,hipY],0xbb926a,2.4);
      g.zIndex=y+a.id*.000001;
    }
    crowd.sortableChildren=true;
    const start=performance.now();
    const frame=()=>{ const t=(performance.now()-start)/1000; shadows.clear(); people.forEach(a=>pose(a,t)); };
    frame(); app.ticker.add(frame);
    status.hidden=true;
  } catch(error) {
    console.error(error);
    status.textContent=window.PIXI?'Room unavailable. Check that WebGL is enabled in Firefox, then reload.':error.message;
  }
})();
