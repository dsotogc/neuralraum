import { Jobs } from './jobs.ts';
import { checkFile, IMMEDIATE, NightClock } from './music.ts';
type OpenRoom = typeof import('./room.ts').openRoom;

export function mountDesk(openRoom: OpenRoom, jobs = new Jobs()){
const el = (id:string) => document.getElementById(id)!;
const input = el('file') as HTMLInputElement;
const left = document.querySelector<HTMLElement>('.left')!, right = document.querySelector<HTMLElement>('.right')!;
type Room = Awaited<ReturnType<OpenRoom>>;
interface Night {
  file:File; audio:HTMLAudioElement; url:string; clock:NightClock;
  inside:boolean; playbackIntent:number; canEnter:boolean; djOnly:boolean; exitAt:number|null;
}
let night:Night|null=null, selection=0, room:Room|undefined, roomFailed=false;
let raf=0, idle:ReturnType<typeof setTimeout>|undefined, transfer=0;
const text=(id:string,s:string)=>{const node=el(id);if(node.textContent!==s)node.textContent=s;};
const show=(id:string,visible:boolean)=>{el(id).hidden=!visible;};
const message=(s:string)=>text('message',s);
const time=(s:number)=>Number.isFinite(s)?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`:'–:––';
function wake(){
  el('hud').classList.remove('quiet'); clearTimeout(idle);
  if(night?.inside && !night.audio.paused) idle=setTimeout(()=>el('hud').classList.add('quiet'),3000);
}
function dispose(){
  ++selection;
  if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});
  const old=night; night=null;
  jobs.cancel(); cancelAnimationFrame(raf); clearTimeout(idle);
  if(room){room.dispose();room=undefined;}
  roomFailed=false;
  if(old){
    old.audio.pause(); old.audio.removeAttribute('src'); old.audio.load();
    URL.revokeObjectURL(old.url); old.clock.result=null;
  }
  show('cover',true); show('club',false); show('panel',false); show('pick',true);
  el('coverPanel').append(el('panel')); input.value=''; message('');
}
function updateTime(n:Night){
  text('time',`${time(n.audio.currentTime)} / ${time(n.audio.duration)}`);
}
function paint(n:Night){
  if(!room || n!==night || !n.inside) return;
  const t=n.audio.currentTime, ended=n.exitAt!==null;
  const exit=ended ? Math.min(1,(performance.now()-n.exitAt!)/6000) : 0;
  const {pulse,crowdAge}=n.clock.sample(t,ended);
  room.frame(t,pulse,crowdAge,exit);
  const passage=Math.min(1,(t+exit*6)/1.7);
  left.hidden=right.hidden=passage===1;
  if(passage<1){
    left.style.transform=`translateX(${-101*passage}%)`;right.style.transform=`translateX(${101*passage}%)`;
  }
  updateTime(n);
  if((ended && exit<1) || !n.audio.paused){
    // Limit GPU submissions even on high-refresh displays. Never integrate frame deltas.
    const next=performance.now()+1000/30-1;
    const frame=(now:number)=>{if(now>=next)paint(n);else raf=requestAnimationFrame(frame);};
    raf=requestAnimationFrame(frame);
  }
}
function admission(n:Night){
  show('enter',!n.inside && (n.canEnter || roomFailed));
  (el('enter') as HTMLButtonElement).disabled=!room && !roomFailed;
  text('enter',roomFailed?'Retry room setup':!room?'Preparing hall…':n.djOnly?'Enter with DJ only →':'Enter hall →');
}
async function prepare(n:Night){
  roomFailed=false;admission(n);
  try {
    const ready=await openRoom(el('view'));
    if(n!==night){ready.dispose();return;}
    room=ready;
    room.frame(0,0,-1); // Compile and render the first frame while still on the poster.
  } catch {
    if(n!==night) return;
    room?.dispose();room=undefined;roomFailed=true;
    message('Could not prepare the hall. Check WebGL, then retry room setup.');
  }
  admission(n);
}
function currentIntent(n:Night,intent:number){
  return n===night && n.playbackIntent===intent && n.exitAt===null && !n.audio.ended;
}
async function enter(n:Night){
  if(n!==night || n.inside)return;
  if(roomFailed){message('');void prepare(n);return;}
  if(!room || !n.canEnter)return;
  const intent=++n.playbackIntent;
  n.inside=true;
  show('cover',false);show('club',true);admission(n);
  el('clubPanel').append(el('panel'));show('cancel',false);text('toggle','Pause');
  show('toggle',true);message('');
  try {
    // Synchronous gesture stack: no awaiting the renderer or analysis here.
    const started=n.audio.play();
    void document.documentElement?.requestFullscreen?.().catch(()=>{});
    if(n.exitAt===null)paint(n);
    await started;
    if(!currentIntent(n,intent))return;
    cancelAnimationFrame(raf);paint(n);wake();
  } catch {
    if(!currentIntent(n,intent))return;
    cancelAnimationFrame(raf);n.inside=false;
    if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});
    el('coverPanel').append(el('panel'));show('club',false);show('cover',true);show('cancel',true);admission(n);
    message('Could not play this MP3. Try entering again or choose another track.');
  }
}
function analyze(n:Night){
  transfer=0; show('retry',false); message('');
  n.canEnter=n.inside || n.file.size<=IMMEDIATE;
  n.djOnly=false;admission(n);
  text('upload','Reserving'); text('analysis','Waiting');
  let received=false;
  void jobs.start(n.file,{
    upload(f){transfer=Math.max(transfer,f);if(!received)text('upload',`${Math.floor(transfer*100)}% sent`);},
    status(s){
      if(['queued','analyzing','succeeded'].includes(s.state)){received=true;text('upload','Received');}
      if(s.state==='analyzing') text('analysis',s.analysis_fraction===null?'Analyzing':`${Math.floor(100*s.analysis_fraction)}%`);
      else if(s.state==='queued') text('analysis','Queued');
      else if(s.state==='succeeded') text('analysis','Reading result');
      else if(s.state==='uploading') text('analysis','Waiting');
    },
    reconnect(){text('analysis','Reconnecting…');},
    ready(t){
      n.clock.result=t;n.canEnter=true;text('analysis','Ready');admission(n);
    },
    failed(error){
      if(!received && transfer<1)text('upload',transfer?`${Math.floor(transfer*100)}% · stopped`:'Not completed');
      n.clock=new NightClock();
      n.canEnter=true;n.djOnly=true;text('analysis','Unavailable');admission(n);
      show('retry',true);if(n.exitAt===null)message(`${error} Local playback is available.`);wake();
    }
  });
}
input.onchange=async()=>{
  const file=input.files?.[0]; if(!file) return;
  dispose(); const gen=selection;
  try { await checkFile(file); }
  catch(e){if(gen===selection)message((e as Error).message);return;}
  if(gen!==selection) return;
  const url=URL.createObjectURL(file),audio=new Audio(url);
  audio.preload='metadata';
  const n:Night={file,url,audio,clock:new NightClock(),inside:false,playbackIntent:0,canEnter:file.size<=IMMEDIATE,djOnly:false,exitAt:null};
  night=n;
  audio.onended=()=>{
    if(n!==night)return;
    cancelAnimationFrame(raf);n.exitAt=performance.now();paint(n);
    show('toggle',false);message('Set complete. Select another track to start a new night.');wake();
  };
  audio.onpause=()=>{if(n===night && audio.paused && !audio.ended){cancelAnimationFrame(raf);text('toggle','Resume');wake();}};
  audio.onerror=()=>{if(n===night){message('This MP3 could not be played. Choose another track.');wake();}};
  show('panel',true); show('cancel',true); show('pick',false);
  text('filename',file.name);
  analyze(n);
  void prepare(n);
};
async function toggle(){
  const n=night;
  if(!n?.inside || n.audio.ended)return;
  // Invalidate pending play() before pause() can reject it with AbortError.
  const intent=++n.playbackIntent;
  if(!n.audio.paused){n.audio.pause();cancelAnimationFrame(raf);text('toggle','Resume');}
  else {
    try {
      await n.audio.play();
      if(!currentIntent(n,intent))return;
      text('toggle','Pause');cancelAnimationFrame(raf);paint(n);
    } catch {
      if(!currentIntent(n,intent))return;
      message('Playback could not resume.');
    }
  }
  wake();
}
el('pick').onclick=el('replace').onclick=()=>input.click();
el('enter').onclick=()=>{if(night)void enter(night);};
el('retry').onclick=()=>{if(night) analyze(night);};
el('cancel').onclick=el('leave').onclick=dispose;
el('toggle').onclick=toggle;
document.addEventListener('pointermove',wake);
document.addEventListener('keydown',e=>{
  wake();
  if(night?.inside && e.code==='Space' && !(e.target instanceof HTMLButtonElement)){
    e.preventDefault();if(!e.repeat)void toggle();
  }
});
window.addEventListener('pagehide',dispose);
}
