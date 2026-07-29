const canvas=document.querySelector('#field');
const ctx=canvas.getContext('2d',{alpha:false});
const ui={
  formula:document.querySelector('#formula-panel'),
  gallery:document.querySelector('#gallery-panel'),
  archive:document.querySelector('#archive'),
  cross:document.querySelector('#cross'),
  progress:document.querySelector('#generation-progress'),
  generationStatus:document.querySelector('#generation-status'),
  renderStatus:document.querySelector('#render-status'),
  storageStatus:document.querySelector('#storage-status')
};

const LEGACY_STORE_KEY='fractalier:clean-start:v2';
const DB_NAME='fractalier-player-data';
const DB_STATE='state';
const DB_HISTORY='population';
const MAX_PATHS=3200;
const REVEAL_TIME=2200;
const PREVIEW_TIME=1800;
const HISTORY_PAGE=48;
const MIX_OPTIONS=[.2,.35,.5,.65,.8];
const MUTATION_PROFILES=[
  {name:'stable',strength:.55,structural:.025},
  {name:'natural',strength:1,structural:.07},
  {name:'active',strength:1.45,structural:.15},
  {name:'volatile',strength:2,structural:.26}
];

let width=0,height=0,background;
let view={scale:1,offsetX:0,offsetY:0};
let database=null,storedHistoryIds=new Set(),historyVisible=HISTORY_PAGE;
let animationFrame=0,animationToken=0,previewAnimationFrame=0,previewToken=0,lastProgress=1,galleryOpen=false,toastTimer=0,isBusy=false;
let state=freshState();

function normalizeBreeding(value){
  const requested=Number(value?.mix);
  const requestedLevel=Number(value?.mutationLevel);
  const mix=MIX_OPTIONS.reduce((closest,option)=>Math.abs(option-requested)<Math.abs(closest-requested)?option:closest,.5);
  return{
    mix:Number.isFinite(requested)?mix:.5,
    mutationLevel:Number.isFinite(requestedLevel)?clamp(Math.round(requestedLevel),0,3):1
  };
}
function freshState(){return{version:7,history:[],nextId:1,current:null,selectedParents:[],breeding:normalizeBreeding({mix:.5,mutationLevel:1})}}
function baseGenome(){
  return{
    family:'arboreal',branches:2,angle:.52,scale:.68,depth:8,symmetry:1,anchors:1,anchorStart:.65,
    twist:0,bend:.055,turn:0,angleDrift:0,scaleDrift:0,alternation:0,closure:0,
    angleWave:0,angleFrequency:1.618,scaleWave:0,scaleFrequency:2.399963,phase:0,
    curvatureDrift:0,branchBias:0,facets:14,tipSides:0,tipScale:.28,
    figureSides:0,figureSpan:.5,figureScale:.22,figureEvery:2,figureSpin:0,
    curveMode:0,curveAmplitude:0,curveFrequency:1,
    rootLayout:0,rootSpread:Math.PI*2,rootSpacing:.12,
    rootLength:.235,lineWidth:1.75,hue:94,hueStep:8,saturation:72,lightness:70,growthOverlap:.42
  };
}
function normalizeGenome(genome){return{...baseGenome(),...(genome||{})}}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}
function randomFrom(seed,...values){
  let value=seed|0;
  for(const part of values)value=Math.imul(value^Math.floor(part*100003),2654435761);
  value^=value>>>16;
  return(value>>>0)/4294967296;
}
function randomSeed(){
  if(globalThis.crypto?.getRandomValues){const value=new Uint32Array(1);crypto.getRandomValues(value);return value[0]}
  return Math.floor(Math.random()*4294967295);
}
function pick(seed,salt,items){return items[Math.floor(randomFrom(seed,salt)*items.length)]}
function range(seed,salt,min,max){return min+randomFrom(seed,salt)*(max-min)}
function formulaId(id){return`F${String(id).padStart(3,'0')}`}
function familyName(family){
  return{
    arboreal:'Recursive bloom',
    radial:'Radial constellation',
    crystal:'Geometric crystal',
    spiral:'Spiral recursion',
    lattice:'Connected lattice',
    fan:'Angular fan',
    field:'Parallel field',
    bilateral:'Bilateral weave'
  }[family]||'Recursive structure';
}
function curveName(mode){return['linear','sine','cosine','tangent','harmonic'][Math.round(mode)]||'linear'}
function layoutName(mode){return['radial','fan','parallel','bilateral'][Math.round(mode)]||'radial'}
function mixName(mix){
  const a=Math.round(mix*100);
  return`${a}% A · ${100-a}% B`;
}
function classifyFamily(genome){
  if(genome.family)return genome.family;
  if(genome.rootLayout===1)return'fan';
  if(genome.rootLayout===2)return'field';
  if(genome.rootLayout===3)return'bilateral';
  if(genome.closure>.35)return'lattice';
  if(Math.abs(genome.turn)>.35||Math.abs(genome.twist)>.3)return'spiral';
  if(genome.symmetry>=6&&Math.abs(genome.bend)<.08)return'crystal';
  if(genome.symmetry>1)return'radial';
  return'arboreal';
}
function normalizeRecord(item){
  const genome=normalizeGenome(item?.genome);
  genome.family=classifyFamily(genome);
  return{
    id:Number(item?.id)||1,
    seed:Number(item?.seed)||Number(item?.id)||1,
    genome,
    thumbnail:item?.thumbnail||'',
    thumbnailVersion:item?.thumbnailVersion||0,
    createdAt:item?.createdAt||Date.now(),
    source:item?.source||'legacy',
    parents:item?.parents||[],
    inheritance:item?.inheritance||null,
    mutations:item?.mutations||[],
    breeding:item?.breeding?normalizeBreeding(item.breeding):null
  };
}

function openDatabase(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,2);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(DB_STATE))request.result.createObjectStore(DB_STATE);
      if(!request.result.objectStoreNames.contains(DB_HISTORY))request.result.createObjectStore(DB_HISTORY,{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function readStore(store,key){
  return new Promise((resolve,reject)=>{
    const objectStore=database.transaction(store,'readonly').objectStore(store);
    const request=key===undefined?objectStore.getAll():objectStore.get(key);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function hydrateState(){
  let legacy=null;
  try{legacy=JSON.parse(localStorage.getItem(LEGACY_STORE_KEY))}catch{}
  try{
    database=await openDatabase();
    const[saved,records]=await Promise.all([readStore(DB_STATE,'main'),readStore(DB_HISTORY)]);
    const source=saved||legacy;
    const rawHistory=records.length?records:(source?.history||source?.population||[]);
    const history=rawHistory.map(normalizeRecord).sort((a,b)=>a.id-b.id);
    const oldCurrent=source?.current;
    const currentHistoryRecord=oldCurrent?history.find(item=>item.id===Number(oldCurrent.id)):null;
    const current=oldCurrent?.genome?{
      id:Number(oldCurrent.id)||history.at(-1)?.id||1,
      seed:Number(oldCurrent.seed)||randomSeed(),
      genome:normalizeGenome(oldCurrent.genome),
      source:oldCurrent.source&&oldCurrent.source!=='restored'?oldCurrent.source:currentHistoryRecord?.source||'restored',
      parents:oldCurrent.parents||[],inheritance:oldCurrent.inheritance||null,mutations:oldCurrent.mutations||[],
      breeding:oldCurrent.breeding?normalizeBreeding(oldCurrent.breeding):currentHistoryRecord?.breeding||null
    }:history.length?{...history.at(-1),source:'restored'}:null;
    const nextId=Math.max(Number(source?.nextId||source?.nextOrganismId)||1,...history.map(item=>item.id+1),current?current.id+1:1);
    const selectedParents=(source?.selectedParents||[]).filter(id=>history.some(item=>item.id===id)).slice(0,2);
    const breeding=normalizeBreeding(source?.breeding);
    state={version:7,history,nextId,current,selectedParents,breeding};
    storedHistoryIds=new Set(records.map(item=>item.id));
    if(saved?.version!==7||(!records.length&&history.length))saveState();
  }catch(error){
    console.warn('IndexedDB is unavailable; using a temporary session',error);
    const history=(legacy?.population||[]).map(normalizeRecord);
    state={
      version:7,history,nextId:Math.max(1,...history.map(item=>item.id+1)),current:history.at(-1)||null,
      selectedParents:[],breeding:normalizeBreeding(legacy?.breeding)
    };
  }
}
function persistableCurrent(){
  if(!state.current)return null;
  const{id,seed,genome,source,parents,inheritance,mutations,breeding}=state.current;
  return{id,seed,genome,source,parents,inheritance,mutations,breeding};
}
function saveState(){
  if(!database){ui.storageStatus.textContent='storage unavailable';return}
  try{
    const transaction=database.transaction([DB_STATE,DB_HISTORY],'readwrite');
    transaction.objectStore(DB_STATE).put({
      version:7,nextId:state.nextId,current:persistableCurrent(),selectedParents:state.selectedParents,
      breeding:state.breeding,history:[]
    },'main');
    const historyStore=transaction.objectStore(DB_HISTORY);
    const additions=state.history.filter(item=>!storedHistoryIds.has(item.id));
    for(const item of additions)historyStore.put(item);
    transaction.oncomplete=()=>{
      for(const item of additions)storedHistoryIds.add(item.id);
      if(ui.storageStatus.textContent!=='persistent local storage')ui.storageStatus.textContent='saved in this browser';
    };
    transaction.onerror=()=>{ui.storageStatus.textContent='local save failed'};
  }catch(error){ui.storageStatus.textContent='local save failed';console.warn('Could not save the formula collection',error)}
}
async function refreshStorageStatus(){
  if(!database){ui.storageStatus.textContent='storage unavailable';return}
  try{
    const persistent=await navigator.storage?.persisted?.();
    ui.storageStatus.textContent=persistent?'persistent local storage':'saved in this browser';
  }catch{ui.storageStatus.textContent='saved in this browser'}
}
async function requestPersistentStorage(){
  if(!database||!navigator.storage?.persist)return;
  try{
    const persistent=await navigator.storage.persist();
    ui.storageStatus.textContent=persistent?'persistent local storage':'saved in this browser';
  }catch{ui.storageStatus.textContent='saved in this browser'}
}

function createGenome(seed){
  const family=pick(seed,1,['arboreal','radial','radial','crystal','spiral','lattice','fan','field','bilateral']);
  const g={...baseGenome(),family};
  g.hue=range(seed,2,28,330);
  g.hueStep=range(seed,3,-18,24);
  g.saturation=range(seed,4,62,84);
  g.lightness=range(seed,5,62,78);
  g.lineWidth=range(seed,6,1.25,2.25);
  g.rootLength=range(seed,7,.19,.29);
  g.growthOverlap=range(seed,8,.35,.72);
  g.phase=range(seed,9,0,Math.PI*2);

  if(family==='arboreal'){
    g.branches=pick(seed,10,[2,2,2,3]);g.symmetry=1;g.depth=g.branches===3?pick(seed,11,[5,6]):pick(seed,11,[7,8,9]);
    g.angle=range(seed,12,.34,.78);g.scale=range(seed,13,.61,.74);g.bend=range(seed,14,-.16,.16);
    g.twist=range(seed,15,-.055,.055);g.angleDrift=range(seed,16,-.035,.035);g.scaleDrift=range(seed,17,-.045,.045);
    g.angleWave=range(seed,18,.015,.105);g.scaleWave=range(seed,19,.008,.052);
    g.angleFrequency=range(seed,60,1.15,2.65);g.scaleFrequency=range(seed,61,1.4,3.1);
    g.curvatureDrift=range(seed,62,-.08,.08);g.branchBias=range(seed,63,-.055,.055);
    g.facets=pick(seed,64,[7,10,14,14]);
    g.figureSides=randomFrom(seed,94)<.2?pick(seed,95,[3,4,5]):0;
    g.figureSpan=range(seed,96,.22,.5);g.figureScale=range(seed,97,.12,.24);g.figureEvery=pick(seed,98,[2,3]);
    g.figureSpin=range(seed,99,-.22,.22);
    g.curveMode=pick(seed,120,[0,0,0,1,2]);g.curveAmplitude=g.curveMode?range(seed,121,.04,.16):0;
    g.curveFrequency=range(seed,122,.65,1.5);
  }else if(family==='radial'){
    g.branches=2;g.symmetry=pick(seed,20,[3,4,5,6,8]);g.depth=pick(seed,21,[5,6,7]);
    g.angle=range(seed,22,.24,.68);g.scale=range(seed,23,.56,.69);g.bend=range(seed,24,-.11,.11);
    g.twist=range(seed,25,-.12,.12);g.angleDrift=range(seed,26,-.025,.045);
    g.angleWave=range(seed,27,.035,.17);g.scaleWave=range(seed,28,.015,.09);
    g.angleFrequency=range(seed,65,.8,2.8);g.scaleFrequency=range(seed,66,1.1,3.4);
    g.curvatureDrift=range(seed,67,-.14,.14);g.branchBias=range(seed,68,-.09,.09);
    g.facets=pick(seed,69,[8,10,14,14]);
    g.figureSides=pick(seed,100,[0,0,3,4,5,6,8]);g.figureSpan=range(seed,101,.2,.62);
    g.figureScale=range(seed,102,.1,.24);g.figureEvery=pick(seed,103,[2,2,3]);g.figureSpin=range(seed,104,-.35,.35);
    g.curveMode=pick(seed,123,[0,0,1,2]);g.curveAmplitude=g.curveMode?range(seed,124,.04,.18):0;
    g.curveFrequency=range(seed,125,.75,1.8);
  }else if(family==='crystal'){
    g.branches=2;g.symmetry=pick(seed,30,[4,6,6,8]);g.depth=pick(seed,31,[5,6]);
    g.angle=pick(seed,32,[Math.PI/6,Math.PI/4,Math.PI/3]);g.scale=range(seed,33,.55,.66);
    g.bend=0;g.twist=pick(seed,34,[0,0,Math.PI/12,-Math.PI/12]);g.closure=range(seed,35,.08,.38);
    g.hueStep=range(seed,36,-8,12);
    g.angleWave=range(seed,37,0,.065);g.scaleWave=range(seed,38,0,.045);
    g.angleFrequency=pick(seed,70,[Math.PI/2,Math.PI*2/3,Math.PI]);g.scaleFrequency=pick(seed,71,[Math.PI/2,Math.PI]);
    g.facets=pick(seed,72,[3,4,6]);g.tipSides=randomFrom(seed,73)<.4?pick(seed,74,[3,4,6]):0;
    g.tipScale=range(seed,75,.22,.48);
    g.figureSides=pick(seed,105,[3,4,6,6,8]);g.figureSpan=pick(seed,106,[.25,.5,.5,.75,1]);
    g.figureScale=range(seed,107,.12,.28);g.figureEvery=pick(seed,108,[1,2]);g.figureSpin=pick(seed,109,[0,Math.PI/6,-Math.PI/6]);
    g.curveMode=pick(seed,126,[0,0,0,3]);g.curveAmplitude=g.curveMode?range(seed,127,.025,.1):0;
    g.curveFrequency=range(seed,128,.75,1.35);
  }else if(family==='spiral'){
    g.branches=pick(seed,40,[1,2,2]);g.symmetry=pick(seed,41,[3,4,5,6]);g.depth=g.branches===1?9:pick(seed,42,[5,6,7]);
    g.angle=range(seed,43,.25,.6);g.scale=range(seed,44,.61,.76);g.twist=range(seed,45,-.42,.42);
    g.turn=range(seed,46,.28,1.15)*(randomFrom(seed,47)<.5?-1:1);g.bend=range(seed,48,-.18,.18);
    g.alternation=range(seed,49,-.18,.18);
    g.angleWave=range(seed,76,.07,.25);g.scaleWave=range(seed,77,.025,.105);
    g.angleFrequency=range(seed,78,.7,2.35);g.scaleFrequency=range(seed,79,1.2,3.6);
    g.curvatureDrift=range(seed,80,.08,.3)*(randomFrom(seed,81)<.5?-1:1);
    g.branchBias=range(seed,82,-.16,.16);g.facets=pick(seed,83,[8,10,14]);
    g.figureSides=pick(seed,110,[0,0,3,5,6]);g.figureSpan=range(seed,111,.18,.48);
    g.figureScale=range(seed,112,.11,.25);g.figureEvery=pick(seed,113,[2,3]);g.figureSpin=range(seed,114,-.55,.55);
    g.curveMode=pick(seed,129,[1,1,2,4]);g.curveAmplitude=range(seed,130,.1,.32);
    g.curveFrequency=range(seed,131,.65,1.8);
  }else if(family==='lattice'){
    g.branches=pick(seed,50,[2,2,3]);g.symmetry=pick(seed,51,[3,4,5,6]);g.depth=g.branches===3?4:pick(seed,52,[5,6]);
    g.angle=range(seed,53,.36,.9);g.scale=range(seed,54,.52,.64);g.closure=range(seed,55,.48,.92);
    g.bend=range(seed,56,-.08,.08);g.twist=range(seed,57,-.1,.1);g.hueStep=range(seed,58,5,26);
    g.angleWave=range(seed,84,.015,.11);g.scaleWave=range(seed,85,.012,.07);
    g.angleFrequency=pick(seed,86,[Math.PI/2,Math.PI*2/3,Math.PI]);g.scaleFrequency=range(seed,87,1.1,3.2);
    g.curvatureDrift=range(seed,88,-.1,.1);g.branchBias=range(seed,89,-.075,.075);
    g.facets=pick(seed,90,[3,4,6,10]);g.tipSides=randomFrom(seed,91)<.28?pick(seed,92,[3,4,5,6]):0;
    g.tipScale=range(seed,93,.18,.4);
    g.figureSides=pick(seed,115,[3,4,4,6,8]);g.figureSpan=pick(seed,116,[.25,.5,.75,1]);
    g.figureScale=range(seed,117,.12,.3);g.figureEvery=pick(seed,118,[1,2,2]);g.figureSpin=range(seed,119,-.28,.28);
    g.curveMode=pick(seed,132,[0,0,1,3]);g.curveAmplitude=g.curveMode?range(seed,133,.03,.13):0;
    g.curveFrequency=range(seed,134,.75,1.5);
  }else if(family==='fan'){
    g.rootLayout=1;g.rootSpread=range(seed,140,.7,2.45);g.symmetry=pick(seed,141,[3,4,5,7]);
    g.branches=pick(seed,142,[1,2,2]);g.depth=g.branches===1?8:pick(seed,143,[5,6,7]);
    g.angle=range(seed,144,.26,.68);g.scale=range(seed,145,.59,.73);g.bend=range(seed,146,-.13,.13);
    g.twist=range(seed,147,-.12,.12);g.angleWave=range(seed,148,.04,.18);g.scaleWave=range(seed,149,.01,.08);
    g.angleFrequency=range(seed,150,.8,2.4);g.scaleFrequency=range(seed,151,1.1,3.2);
    g.branchBias=range(seed,152,-.12,.12);g.facets=pick(seed,153,[8,10,14]);
    g.figureSides=pick(seed,154,[0,0,3,4,5]);g.figureSpan=range(seed,155,.2,.55);
    g.figureScale=range(seed,156,.1,.22);g.figureEvery=pick(seed,157,[2,3]);
    g.curveMode=pick(seed,158,[0,1,1,2,4]);g.curveAmplitude=g.curveMode?range(seed,159,.05,.22):0;
    g.curveFrequency=range(seed,160,.7,1.9);
  }else if(family==='field'){
    g.rootLayout=2;g.rootSpread=range(seed,161,0,.36);g.rootSpacing=range(seed,162,.065,.15);
    g.symmetry=pick(seed,163,[3,4,5,6,8]);g.branches=pick(seed,164,[1,2,2]);g.depth=g.branches===1?8:pick(seed,165,[5,6]);
    g.angle=range(seed,166,.2,.58);g.scale=range(seed,167,.57,.71);g.bend=range(seed,168,-.1,.1);
    g.twist=range(seed,169,-.07,.07);g.angleWave=range(seed,170,.025,.13);g.scaleWave=range(seed,171,.01,.065);
    g.angleFrequency=range(seed,172,.8,2.2);g.scaleFrequency=range(seed,173,1.2,3);
    g.alternation=range(seed,174,-.12,.12);g.facets=pick(seed,175,[8,10,14]);
    g.figureSides=pick(seed,176,[0,0,3,4,6]);g.figureSpan=range(seed,177,.18,.5);
    g.figureScale=range(seed,178,.09,.2);g.figureEvery=pick(seed,179,[2,3]);
    g.curveMode=pick(seed,180,[0,0,1,2,3]);g.curveAmplitude=g.curveMode?range(seed,181,.035,.16):0;
    g.curveFrequency=range(seed,182,.7,1.7);
  }else{
    g.rootLayout=3;g.rootSpread=range(seed,183,0,.65);g.rootSpacing=range(seed,184,.055,.14);
    g.symmetry=pick(seed,185,[2,4,4,6]);g.branches=pick(seed,186,[1,2,2]);g.depth=g.branches===1?8:pick(seed,187,[5,6]);
    g.angle=range(seed,188,.25,.7);g.scale=range(seed,189,.57,.7);g.bend=range(seed,190,-.12,.12);
    g.twist=range(seed,191,-.1,.1);g.angleWave=range(seed,192,.035,.16);g.scaleWave=range(seed,193,.01,.07);
    g.angleFrequency=range(seed,194,.8,2.3);g.scaleFrequency=range(seed,195,1.1,3.1);
    g.alternation=range(seed,196,-.15,.15);g.closure=range(seed,197,0,.3);g.facets=pick(seed,198,[7,10,14]);
    g.figureSides=pick(seed,199,[0,3,4,6]);g.figureSpan=range(seed,200,.2,.58);
    g.figureScale=range(seed,201,.1,.22);g.figureEvery=pick(seed,202,[2,3]);
    g.curveMode=pick(seed,203,[0,1,2,4]);g.curveAmplitude=g.curveMode?range(seed,204,.05,.2):0;
    g.curveFrequency=range(seed,205,.7,1.8);
  }
  return g;
}
const mutationRules={
  branches:[1,1,4,true],angle:[.18,.12,1.45],scale:[.09,.45,.82],depth:[1,4,9,true],
  symmetry:[1,1,8,true],anchors:[1,1,2,true],anchorStart:[.16,.35,.92],twist:[.15,-.65,.65],
  bend:[.15,-.5,.5],turn:[.38,-1.5,1.5],angleDrift:[.06,-.16,.16],scaleDrift:[.06,-.14,.14],
  alternation:[.14,-.55,.55],closure:[.22,0,1],rootLength:[.045,.14,.34],lineWidth:[.35,.8,2.8],
  angleWave:[.12,0,.5],angleFrequency:[.65,.35,4.5],scaleWave:[.08,0,.24],scaleFrequency:[.65,.35,4.5],
  phase:[Math.PI/2,0,Math.PI*2],curvatureDrift:[.12,-.4,.4],branchBias:[.14,-.45,.45],facets:[2,3,18,true],
  tipSides:[1,0,8,true],tipScale:[.12,.08,.6],hue:[48,0,360],hueStep:[16,-30,30],
  figureSides:[1,0,10,true],figureSpan:[.18,.12,1],figureScale:[.12,.08,.55],
  figureEvery:[1,1,4,true],figureSpin:[.3,-1.2,1.2],
  curveMode:[1,0,4,true],curveAmplitude:[.14,0,.6],curveFrequency:[.5,.35,3.5],
  rootLayout:[1,0,3,true],rootSpread:[.45,0,Math.PI*2],rootSpacing:[.045,.04,.24],
  saturation:[12,48,92],lightness:[10,48,86],growthOverlap:[.16,.2,.85]
};
function mutationCountFor(level,roll){
  if(level===0)return roll<.92?0:1;
  if(level===1)return roll<.8?0:roll<.98?1:2;
  if(level===2)return roll<.55?0:roll<.9?1:2;
  return roll<.25?0:roll<.6?1:roll<.87?2:3;
}
function crossoverGenomes(parentA,parentB,seed,options={}){
  const a=normalizeGenome(parentA.genome),b=normalizeGenome(parentB.genome),child={},inherited={a:0,b:0};
  const keys=Object.keys(baseGenome()).filter(key=>key!=='family');
  const breeding=normalizeBreeding(options),profile=MUTATION_PROFILES[breeding.mutationLevel];
  const targetA=clamp(Math.round(keys.length*breeding.mix),1,keys.length-1);
  const fromAKeys=new Set(keys.map((key,index)=>({key,index,score:randomFrom(seed,200+index)}))
    .sort((left,right)=>left.score-right.score||left.index-right.index).slice(0,targetA).map(item=>item.key));
  for(const[index,key]of keys.entries()){
    const fromA=fromAKeys.has(key);
    child[key]=fromA?a[key]:b[key];inherited[fromA?'a':'b']++;
  }
  const mutations=[],mutationCount=mutationCountFor(breeding.mutationLevel,randomFrom(seed,280)),used=new Set();
  for(let index=0;index<mutationCount;index++){
    let choice=Math.floor(randomFrom(seed,281+index)*keys.length);
    while(used.has(choice)||!mutationRules[keys[choice]])choice=(choice+1)%keys.length;
    used.add(choice);
    const key=keys[choice],[amount,min,max,integer]=mutationRules[key];
    const direction=randomFrom(seed,300+index)<.5?-1:1;
    let value;
    if(key==='tipSides'||key==='figureSides'){
      const upper=key==='tipSides'?8:10;
      value=child[key]===0?3+Math.floor(randomFrom(seed,310+index)*(upper-2)):randomFrom(seed,320+index)<.18?0:child[key]+direction;
      if(value>0)value=clamp(Math.round(value),3,upper);
    }else if(key==='curveMode'){
      value=child[key]===0?1+Math.floor(randomFrom(seed,310+index)*4):randomFrom(seed,320+index)<.16?0:clamp(child[key]+direction,1,4);
    }else if(key==='rootLayout'){
      value=child[key]===0?1+Math.floor(randomFrom(seed,310+index)*3):randomFrom(seed,320+index)<.16?0:clamp(child[key]+direction,1,3);
    }else{
      const step=integer?Math.max(1,Math.round(amount*profile.strength)):amount*profile.strength;
      value=integer?child[key]+direction*step:child[key]+direction*step*(.45+randomFrom(seed,310+index)*.55);
    }
    if(integer)value=Math.round(value);
    child[key]=key==='phase'||key==='hue'?((value%max)+max)%max:clamp(value,min,max);
    if(key==='rootLayout'&&child.rootLayout>0){
      child.rootSpread=child.rootLayout===1?range(seed,325+index,.7,2.4):range(seed,325+index,0,.6);
      child.rootSpacing=range(seed,327+index,.06,.16);
    }
    mutations.push(key);
  }
  if(a.figureSides===0&&b.figureSides===0&&child.figureSides===0&&randomFrom(seed,330)<profile.structural*1.25){
    child.figureSides=3+Math.floor(randomFrom(seed,331)*6);
    child.figureSpan=pick(seed,332,[.25,.5,.75,1]);
    child.figureScale=range(seed,333,.12,.3);
    child.figureEvery=pick(seed,334,[1,2,2,3]);
    child.figureSpin=range(seed,335,-.45,.45);
    mutations.push('figureSides');
  }
  if(a.curveMode===0&&b.curveMode===0&&child.curveMode===0&&randomFrom(seed,340)<profile.structural){
    child.curveMode=1+Math.floor(randomFrom(seed,341)*4);
    child.curveAmplitude=range(seed,342,.06,.24);
    child.curveFrequency=range(seed,343,.6,2.2);
    mutations.push('curveMode');
  }
  if(a.rootLayout===0&&b.rootLayout===0&&child.rootLayout===0&&randomFrom(seed,350)<profile.structural){
    child.rootLayout=1+Math.floor(randomFrom(seed,351)*3);
    child.rootSpread=child.rootLayout===1?range(seed,352,.7,2.4):range(seed,352,0,.6);
    child.rootSpacing=range(seed,353,.06,.16);
    mutations.push('rootLayout');
  }
  child.family=classifyFamily({...child,family:null});
  return{genome:child,inherited,mutations,breeding};
}

function trigonometricWave(mode,phase){
  if(mode===1)return Math.cos(phase);
  if(mode===2)return Math.sin(phase);
  if(mode===3)return 2/Math.PI*Math.atan(Math.tan(phase));
  if(mode===4)return .68*Math.cos(phase)+.32*Math.cos(phase*2+Math.PI/3);
  return 0;
}
function traceCurve(x,y,direction,length,turn,bend,samples=14,curveMode=0,curveAmplitude=0,curveFrequency=1,curvePhase=0){
  const points=[[x,y]],step=length/samples;
  let px=x,py=y,lastDirection=direction;
  for(let index=1;index<=samples;index++){
    const t=(index-.5)/samples;
    const wavePhase=t*Math.PI*2*curveFrequency+curvePhase;
    lastDirection=direction+turn*t+bend*Math.sin(Math.PI*t)+curveAmplitude*trigonometricWave(curveMode,wavePhase);
    px+=Math.cos(lastDirection)*step;py+=Math.sin(lastDirection)*step;
    points.push([px,py]);
  }
  return{points,endX:px,endY:py,endDirection:lastDirection};
}
function traceGenomeCurve(node,g,facets){
  const samples=g.curveMode===0||g.curveAmplitude===0
    ?facets
    :clamp(Math.max(facets,Math.ceil(g.curveFrequency*8)),facets,24);
  const curvePhase=g.phase+node.depth*g.angleFrequency+node.root*Math.PI*2/Math.max(1,g.symmetry);
  return traceCurve(
    node.x,node.y,node.direction,node.length,node.turn,node.bend,samples,
    g.curveMode,g.curveAmplitude,g.curveFrequency,curvePhase
  );
}
function pointOnCurve(curve,position){
  const target=clamp(position,0,1)*(curve.points.length-1);
  const index=Math.min(curve.points.length-2,Math.floor(target)),part=target-index;
  const a=curve.points[index],b=curve.points[index+1];
  return{x:a[0]+(b[0]-a[0])*part,y:a[1]+(b[1]-a[1])*part,direction:Math.atan2(b[1]-a[1],b[0]-a[0])};
}
function branchOffsets(count,angle){
  if(count===1)return[0];
  return Array.from({length:count},(_,index)=>(index-(count-1)/2)*angle*(count===2?2:1));
}
function traceFigureSegment(curve,node,g){
  const sides=clamp(Math.round(g.figureSides),3,10);
  const edges=clamp(Math.round(sides*g.figureSpan),1,sides);
  const radius=Math.max(.003,node.length*g.figureScale);
  const start=curve.endDirection+Math.PI/2+g.phase*.2+node.depth*g.figureSpin;
  const centerX=curve.endX-Math.cos(start)*radius,centerY=curve.endY-Math.sin(start)*radius;
  return Array.from({length:edges+1},(_,index)=>{
    const theta=start+index*Math.PI*2/sides;
    return[centerX+Math.cos(theta)*radius,centerY+Math.sin(theta)*radius];
  });
}
function rootPlacement(g,root,count){
  const t=count===1?.5:root/(count-1),centered=t-.5,layout=Math.round(g.rootLayout);
  if(layout===1){
    return{x:0,y:.28,direction:-Math.PI/2+centered*g.rootSpread};
  }
  if(layout===2){
    return{
      x:centered*g.rootSpacing*(count-1),
      y:.3+Math.sin(t*Math.PI*2+g.phase)*g.rootSpacing*.12,
      direction:-Math.PI/2+centered*g.rootSpread
    };
  }
  if(layout===3){
    const upward=root%2===0,tilt=centered*g.rootSpread;
    return{
      x:centered*g.rootSpacing*(count-1),y:0,
      direction:(upward?-Math.PI/2:Math.PI/2)+(upward?tilt:-tilt)
    };
  }
  return count===1
    ?{x:0,y:.34,direction:-Math.PI/2}
    :{x:0,y:0,direction:-Math.PI/2+root*Math.PI*2/count};
}
function compileGeometry(genome){
  const g=normalizeGenome(genome),paths=[],queue=[];
  const facets=clamp(Math.round(g.facets),3,18),rootCount=clamp(Math.round(g.symmetry),1,8);
  for(let root=0;root<rootCount;root++){
    const placement=rootPlacement(g,root,rootCount);
    queue.push({...placement,length:g.rootLength,depth:0,root,turn:g.turn,bend:g.bend});
  }
  let cursor=0;
  while(cursor<queue.length&&paths.length<MAX_PATHS){
    const node=queue[cursor++],curve=traceGenomeCurve(node,g,facets);
    const generationGap=.71/(g.depth+1),stagger=((node.root*17+cursor*7)%13)/13*generationGap*.14;
    const birth=node.depth*generationGap+stagger,duration=generationGap*(1.65+g.growthOverlap);
    paths.push({
      points:curve.points,depth:node.depth,root:node.root,birth,duration,
      hue:(g.hue+node.depth*g.hueStep+node.root*360/Math.max(1,g.symmetry)+3600)%360,
      saturation:g.saturation,lightness:g.lightness,width:Math.max(.42,g.lineWidth*Math.pow(.84,node.depth))
    });
    const figureEvery=clamp(Math.round(g.figureEvery),1,4);
    if(g.figureSides>=3&&node.depth>0&&node.depth%figureEvery===0&&paths.length<MAX_PATHS){
      paths.push({
        points:traceFigureSegment(curve,node,g),depth:node.depth+.45,root:node.root,
        birth:birth+duration*.32,duration:duration*.72,
        hue:(g.hue+node.depth*g.hueStep+38+node.root*360/Math.max(1,g.symmetry)+3600)%360,
        saturation:g.saturation,lightness:clamp(g.lightness+7,0,92),
        width:Math.max(.38,g.lineWidth*Math.pow(.83,node.depth))
      });
    }
    const harmonicPhase=(node.depth+1)*g.scaleFrequency+g.phase+node.root*Math.PI*2/Math.max(1,g.symmetry);
    const effectiveScale=clamp(
      g.scale+g.scaleDrift*Math.sin((node.depth+1)*2.399963)+g.scaleWave*Math.cos(harmonicPhase),
      .38,.88
    );
    const terminal=node.depth>=g.depth||node.length*effectiveScale<.0035;
    if(terminal){
      const tipSides=Math.round(g.tipSides);
      if(tipSides>=3&&paths.length<MAX_PATHS){
        const radius=Math.max(.004,node.length*g.tipScale),rotation=curve.endDirection+Math.PI/2+g.phase*.25;
        const points=Array.from({length:tipSides+1},(_,index)=>{
          const theta=rotation+index*Math.PI*2/tipSides;
          return[curve.endX+Math.cos(theta)*radius,curve.endY+Math.sin(theta)*radius];
        });
        paths.push({
          points,depth:node.depth+1,root:node.root,birth:birth+duration*.56,duration:duration*.72,
          hue:(g.hue+(node.depth+1)*g.hueStep+72+3600)%360,saturation:g.saturation,
          lightness:clamp(g.lightness+8,0,92),width:Math.max(.38,g.lineWidth*Math.pow(.82,node.depth+1))
        });
      }
      continue;
    }
    const anchorPositions=g.anchors===1?[1]:Array.from({length:g.anchors},(_,index)=>g.anchorStart+(1-g.anchorStart)*index/(g.anchors-1));
    const angularPhase=node.depth*g.angleFrequency+g.phase+node.root*Math.PI*2/Math.max(1,g.symmetry);
    const effectiveAngle=clamp(g.angle+g.angleDrift*node.depth+g.angleWave*Math.sin(angularPhase),.08,1.65);
    const offsets=g.branches===1?[effectiveAngle*.55*Math.sin(angularPhase)]:branchOffsets(g.branches,effectiveAngle);
    for(const[anchorIndex,position]of anchorPositions.entries()){
      const anchor=pointOnCurve(curve,position),anchorScale=Math.pow(.86,g.anchors-1-anchorIndex);
      const children=[],alternating=g.alternation*((node.depth+anchorIndex)%2?-1:1);
      const bias=g.branchBias*Math.sin(angularPhase+anchorIndex*Math.PI/2);
      for(const offset of offsets){
        if(queue.length>=MAX_PATHS*2)break;
        const side=offset===0?1:Math.sign(offset);
        const child={
          x:anchor.x,y:anchor.y,direction:anchor.direction+offset+g.twist*(node.depth+1)+alternating+bias,
          length:node.length*effectiveScale*anchorScale,depth:node.depth+1,root:node.root,
          turn:(g.turn+g.curvatureDrift*(node.depth+1)/Math.max(1,g.depth))*side,bend:g.bend*side
        };
        children.push(child);queue.push(child);
      }
      if(g.closure>.05&&children.length>1&&paths.length<MAX_PATHS){
        const endpoints=children.map(child=>{
          const predicted=traceGenomeCurve(child,g,facets);
          return[predicted.endX,predicted.endY];
        });
        if(g.closure>.62&&endpoints.length>2)endpoints.push(endpoints[0]);
        paths.push({
          points:endpoints,depth:node.depth+1,root:node.root,birth:(node.depth+1)*generationGap+generationGap*.28,
          duration:generationGap*(1.3+g.growthOverlap),hue:(g.hue+(node.depth+1)*g.hueStep+42+3600)%360,
          saturation:g.saturation,lightness:clamp(g.lightness+6,0,92),
          width:Math.max(.4,g.lineWidth*Math.pow(.82,node.depth+1)*g.closure)
        });
      }
    }
  }
  return paths;
}
function geometryBounds(paths){
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const path of paths||[])for(const point of path.points){
    minX=Math.min(minX,point[0]);maxX=Math.max(maxX,point[0]);
    minY=Math.min(minY,point[1]);maxY=Math.max(maxY,point[1]);
  }
  return Number.isFinite(minX)?{minX,maxX,minY,maxY}:{minX:-.25,maxX:.25,minY:-.25,maxY:.25};
}
function pathProgress(path,progress){
  const raw=clamp((progress-path.birth)/path.duration,0,1);
  return raw<.5?2*raw*raw:1-Math.pow(-2*raw+2,2)/2;
}

function updateView(){
  const bounds=state.current?.bounds||geometryBounds(state.current?.paths);
  let left,right,top,bottom;
  if(width>=1180){
    left=386;right=galleryOpen?width-326:width-34;top=82;bottom=height-116;
  }else if(width>760){
    left=356;right=width-28;top=82;bottom=height-112;
  }else{
    left=22;right=width-22;top=Math.max(270,ui.formula.getBoundingClientRect().bottom+14);
    bottom=Math.min(height-112,document.querySelector('.action-bar').getBoundingClientRect().top-14);
  }
  if(right-left<160){left=22;right=width-22}
  if(bottom-top<150&&width>760){top=76;bottom=height-98}
  const worldWidth=Math.max(.08,bounds.maxX-bounds.minX),worldHeight=Math.max(.08,bounds.maxY-bounds.minY);
  const scale=Math.min((right-left)/worldWidth,(bottom-top)/worldHeight)*.88;
  view.scale=Math.min(scale,Math.min(width,height)*2.1);
  view.offsetX=(left+right)/2-(bounds.minX+bounds.maxX)/2*view.scale;
  view.offsetY=(top+bottom)/2-(bounds.minY+bounds.maxY)/2*view.scale;
}
function resize(){
  const ratio=Math.min(devicePixelRatio||1,1.25);
  width=innerWidth;height=innerHeight;
  canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
  ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
  background=ctx.createRadialGradient(width*.5,height*.5,0,width*.5,height*.5,Math.max(width,height)*.72);
  background.addColorStop(0,'#17382f');background.addColorStop(.52,'#0a1d18');background.addColorStop(1,'#050d0c');
  updateView();render(lastProgress);
}
function worldToScreen(x,y){return[x*view.scale+view.offsetX,y*view.scale+view.offsetY]}
function drawPartialPath(targetContext,path,local){
  const target=(path.points.length-1)*local,full=Math.floor(target),fraction=target-full;
  if(target<=0)return;
  targetContext.beginPath();
  const first=worldToScreen(path.points[0][0],path.points[0][1]);
  targetContext.moveTo(first[0],first[1]);
  for(let index=1;index<=full;index++){
    const point=worldToScreen(path.points[index][0],path.points[index][1]);
    targetContext.lineTo(point[0],point[1]);
  }
  if(full<path.points.length-1&&fraction>0){
    const a=path.points[full],b=path.points[full+1];
    const point=worldToScreen(a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction);
    targetContext.lineTo(point[0],point[1]);
  }
  targetContext.stroke();
}
function drawFractal(targetContext,progress){
  if(!state.current)return;
  targetContext.lineCap='round';targetContext.lineJoin='round';
  for(const path of state.current.paths){
    const local=pathProgress(path,progress);
    if(local<=0)continue;
    targetContext.globalAlpha=(.5+Math.min(.34,path.depth*.026))*(.82+local*.18);
    targetContext.lineWidth=path.width;
    targetContext.strokeStyle=`hsl(${path.hue} ${path.saturation}% ${path.lightness}%)`;
    drawPartialPath(targetContext,path,local);
  }
  targetContext.globalAlpha=1;
}
function render(progress=1){
  lastProgress=progress;
  ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
  const seed=state.current?.seed||7193;
  for(let index=0;index<30;index++){
    ctx.fillStyle=`rgba(215,255,225,${.035+randomFrom(seed,index,800)*.1})`;
    ctx.fillRect(randomFrom(seed,index,801)*width,randomFrom(seed,index,802)*height,1,1);
  }
  drawFractal(ctx,progress);
}
function createExportCanvas(includeBackground){
  if(includeBackground)return canvas;
  const transparent=document.createElement('canvas');
  transparent.width=canvas.width;transparent.height=canvas.height;
  const target=transparent.getContext('2d');
  target.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
  drawFractal(target,1);
  return transparent;
}
function downloadImage(includeBackground){
  if(!state.current)return;
  const link=document.createElement('a'),variant=includeBackground?'background':'transparent';
  link.download=`fractalier-${formulaId(state.current.id)}-${variant}.png`;
  link.href=createExportCanvas(includeBackground).toDataURL('image/png');
  link.click();closeExportMenu();
  showToast(`${variant==='background'?'Background':'Transparent'} PNG downloaded`);
}
function downloadBlob(blob,filename){
  const link=document.createElement('a'),url=URL.createObjectURL(blob);
  link.download=filename;link.href=url;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportFormula(){
  if(!state.current)return;
  const{id,seed,genome,parents,inheritance,mutations,breeding}=state.current;
  const payload={
    format:'fractalier-formula',version:1,id:formulaId(id),seed,
    equation:'F[n+1] = union_r L_layout(r) union_i(s[n] R(i alpha[n] + n tau) K(kappa[n] + gamma T(f t + phi)) A[i](F[n])) union Cq(E[n]) union Pm^lambda(E[n])',
    genome,parents:parents.map(formulaId),inheritance,mutations,breeding
  };
  downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`fractalier-${formulaId(id)}.json`);
  closeExportMenu();showToast('Formula JSON downloaded');
}
function sanitizeImportedGenome(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('The JSON root must be an object');
  if(payload.format&&payload.format!=='fractalier-formula')throw new Error('This is not a Fractalier formula');
  const candidate=payload.genome||payload;
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw new Error('The file does not contain a genome');
  const defaults=baseGenome(),genome={...defaults},keys=Object.keys(defaults).filter(key=>key!=='family');
  let recognized=0;
  for(const key of keys){
    if(typeof candidate[key]!=='number'||!Number.isFinite(candidate[key]))continue;
    recognized++;
    let value=candidate[key],rule=mutationRules[key];
    if(rule){
      const[,min,max,integer]=rule;
      if(integer)value=Math.round(value);
      value=clamp(value,min,max);
    }
    if((key==='tipSides'||key==='figureSides')&&value>0)value=clamp(Math.round(value),3,key==='tipSides'?8:10);
    genome[key]=value;
  }
  if(recognized<5)throw new Error('No recognizable Fractalier genome was found');
  genome.family=classifyFamily({...genome,family:null});
  return genome;
}
function importFormulaPayload(payload){
  const genome=sanitizeImportedGenome(payload);
  const importedSeed=Number(payload?.seed);
  const seed=Number.isFinite(importedSeed)?Math.abs(Math.trunc(importedSeed))>>>0:randomSeed();
  const id=state.nextId++;
  showFormula({id,seed,genome,source:'import',parents:[],inheritance:null,mutations:[]});
  showToast(`Imported as ${formulaId(id)}`);
  return id;
}
async function importFormulaFile(file){
  if(!file)return;
  if(file.size>256*1024)throw new Error('The formula file is too large');
  const payload=JSON.parse(await file.text());
  return importFormulaPayload(payload);
}
async function exportVideo(){
  if(!state.current||isBusy)return;
  closeExportMenu();
  if(!canvas.captureStream||typeof MediaRecorder==='undefined'){
    showToast('Video export is not supported by this browser');return;
  }
  const mimeType=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
    .find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType){showToast('WebM export is not supported by this browser');return}
  cancelAnimationFrame(animationFrame);animationToken++;
  const chunks=[],stream=canvas.captureStream(60);
  const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:8_000_000});
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};
  const stopped=new Promise((resolve,reject)=>{
    recorder.onstop=resolve;
    recorder.onerror=event=>reject(event.error||new Error('Video recording failed'));
  });
  try{
    setBusy(true);ui.generationStatus.textContent='recording';ui.renderStatus.textContent='encoding WebM animation…';
    render(0);ui.progress.style.width='0%';recorder.start();
    await new Promise(resolve=>{
      const start=performance.now();
      const frame=now=>{
        const linear=clamp((now-start)/REVEAL_TIME,0,1),progress=1-Math.pow(1-linear,2.4);
        render(progress);ui.progress.style.width=`${linear*100}%`;
        if(linear<1){animationFrame=requestAnimationFrame(frame);return}
        render(1);setTimeout(resolve,180);
      };
      animationFrame=requestAnimationFrame(frame);
    });
    recorder.stop();await stopped;
    downloadBlob(new Blob(chunks,{type:mimeType}),`fractalier-${formulaId(state.current.id)}-growth.webm`);
    showToast('Animated WebM downloaded');
  }catch(error){
    console.warn('Could not export the animation',error);showToast('Video export failed');
  }finally{
    for(const track of stream.getTracks())track.stop();
    render(1);ui.progress.style.width='100%';setBusy(false);
  }
}
function paintFormulaMiniature(target,paths,seed,progress=1){
  const canvasWidth=target.canvas.width,canvasHeight=target.canvas.height,bounds=geometryBounds(paths);
  target.setTransform(1,0,0,1,0,0);target.globalAlpha=1;
  const backdrop=target.createRadialGradient(canvasWidth/2,canvasHeight/2,0,canvasWidth/2,canvasHeight/2,Math.max(canvasWidth,canvasHeight)*.64);
  backdrop.addColorStop(0,'#17382f');backdrop.addColorStop(.58,'#0a1d18');backdrop.addColorStop(1,'#050d0c');
  target.fillStyle=backdrop;target.fillRect(0,0,canvasWidth,canvasHeight);
  for(let index=0;index<18;index++){
    target.fillStyle=`rgba(215,255,225,${.035+randomFrom(seed,index,880)*.1})`;
    target.fillRect(randomFrom(seed,index,881)*canvasWidth,randomFrom(seed,index,882)*canvasHeight,1,1);
  }
  const worldWidth=Math.max(.04,bounds.maxX-bounds.minX),worldHeight=Math.max(.04,bounds.maxY-bounds.minY);
  const scale=Math.min((canvasWidth-28)/worldWidth,(canvasHeight-28)/worldHeight);
  const offsetX=canvasWidth/2-(bounds.minX+bounds.maxX)/2*scale;
  const offsetY=canvasHeight/2-(bounds.minY+bounds.maxY)/2*scale;
  const point=([x,y])=>[x*scale+offsetX,y*scale+offsetY];
  target.lineCap='round';target.lineJoin='round';
  for(const path of paths){
    const local=pathProgress(path,progress);
    if(local<=0||path.points.length<2)continue;
    const targetPoint=(path.points.length-1)*local,full=Math.floor(targetPoint),fraction=targetPoint-full;
    const first=point(path.points[0]);target.beginPath();target.moveTo(first[0],first[1]);
    for(let index=1;index<=full;index++){const next=point(path.points[index]);target.lineTo(next[0],next[1])}
    if(full<path.points.length-1&&fraction>0){
      const a=path.points[full],b=path.points[full+1];
      const next=point([a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction]);
      target.lineTo(next[0],next[1]);
    }
    target.globalAlpha=(.58+Math.min(.28,path.depth*.025))*(.85+local*.15);
    target.lineWidth=Math.max(.38,path.width*.62);
    target.strokeStyle=`hsl(${path.hue} ${path.saturation}% ${path.lightness}%)`;target.stroke();
  }
  target.globalAlpha=1;
}
function renderFormulaThumbnail(genome,seed){
  const thumb=document.createElement('canvas');thumb.width=300;thumb.height=200;
  paintFormulaMiniature(thumb.getContext('2d'),compileGeometry(genome),seed,1);
  return thumb.toDataURL('image/webp',.76);
}
function storeHistoryRecord(record){
  if(!database)return;
  try{database.transaction(DB_HISTORY,'readwrite').objectStore(DB_HISTORY).put(record)}
  catch(error){console.warn('Could not update a collection thumbnail',error)}
}
function ensureThumbnail(record){
  if(record.thumbnail&&record.thumbnailVersion===4)return;
  record.thumbnail=renderFormulaThumbnail(record.genome,record.seed);
  record.thumbnailVersion=4;storeHistoryRecord(record);
}

function setBusy(busy){
  isBusy=busy;
  document.querySelector('#export-toggle').disabled=busy;
  ui.generationStatus.textContent=busy?'generating':'ready';
  ui.renderStatus.textContent=busy?'drawing recursive paths…':'idle · canvas at rest';
  updateSelectionUI();
}
function animateFormula(onComplete){
  cancelAnimationFrame(animationFrame);
  const token=++animationToken,start=performance.now();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,duration=reduced?120:REVEAL_TIME;
  setBusy(true);ui.progress.style.width='0%';
  const frame=now=>{
    if(token!==animationToken)return;
    const linear=clamp((now-start)/duration,0,1);
    const progress=1-Math.pow(1-linear,2.4);
    render(progress);ui.progress.style.width=`${linear*100}%`;
    if(linear<1){animationFrame=requestAnimationFrame(frame);return}
    render(1);setBusy(false);onComplete?.();
  };
  animationFrame=requestAnimationFrame(frame);
}
function runtimeFormula({id,seed,genome,source,parents=[],inheritance=null,mutations=[],breeding=null}){
  const normalized=normalizeGenome(genome),paths=compileGeometry(normalized);
  return{id,seed,genome:normalized,source,parents,inheritance,mutations,breeding,paths,bounds:geometryBounds(paths)};
}
function createFounderRecord(){
  const seed=randomSeed(),id=state.nextId++,genome=createGenome(seed);
  return{
    id,seed,genome,source:'founder',parents:[],inheritance:null,mutations:[],createdAt:Date.now(),
    thumbnail:renderFormulaThumbnail(genome,seed),thumbnailVersion:4
  };
}
function ensureInitialPopulation(){
  let initialized=false;
  if(state.current&&!state.history.some(item=>item.id===state.current.id)){
    const{id,seed,genome,source,parents=[],inheritance=null,mutations=[],breeding=null}=state.current;
    state.history.push({
      id,seed,genome:normalizeGenome(genome),source,parents,inheritance,mutations,breeding,createdAt:Date.now(),
      thumbnail:renderFormulaThumbnail(genome,seed),thumbnailVersion:4
    });
    initialized=true;
  }
  while(state.history.length<2){state.history.push(createFounderRecord());initialized=true}
  if(!state.current||initialized)state.current={...state.history.at(-1)};
  if(initialized)state.selectedParents=state.history.slice(-2).map(item=>item.id);
  if(initialized)saveState();
}
function addCurrentToHistory(){
  if(!state.current||state.history.some(item=>item.id===state.current.id))return;
  const{id,seed,genome,source,parents,inheritance,mutations,breeding}=state.current;
  state.history.push({
    id,seed,genome:{...genome},source,parents,inheritance,mutations,breeding,createdAt:Date.now(),
    thumbnail:renderFormulaThumbnail(genome,seed),thumbnailVersion:4
  });
  saveState();renderArchive();
}
function showFormula(entry,{selectAfter=true}={}){
  state.selectedParents=[];
  state.current=runtimeFormula(entry);
  updateView();updateFormulaUI();renderArchive();saveState();
  animateFormula(()=>{
    addCurrentToHistory();
    if(selectAfter)state.selectedParents=[state.current.id];
    saveState();renderArchive();
  });
}
function viewStoredFormula(item){
  if(isBusy)return;
  state.current=runtimeFormula(item);
  updateFormulaUI();renderArchive();saveState();
  closeGalleryOnSmallScreen();updateView();animateFormula();
}
function selectedRecords(){return state.selectedParents.map(id=>state.history.find(item=>item.id===id)).filter(Boolean)}
function crossSelected(){
  const selected=selectedRecords();if(selected.length!==2||isBusy)return;
  const seed=randomSeed(),id=state.nextId++;
  const result=crossoverGenomes(selected[0],selected[1],seed,state.breeding);
  showFormula({
    id,seed,genome:result.genome,source:'crossover',parents:[selected[0].id,selected[1].id],
    inheritance:result.inherited,mutations:result.mutations,breeding:result.breeding
  });
}
function toggleParent(id){
  if(isBusy)return;
  const selected=state.selectedParents,index=selected.indexOf(id);
  if(index>=0)selected.splice(index,1);
  else if(selected.length<2)selected.push(id);
  else{selected.shift();selected.push(id)}
  saveState();renderArchive();
  if(selected.length===2&&width<=760)setGallery(false);
}

const geneLabels={branches:'branches',angle:'angle',scale:'scale',depth:'recursion',symmetry:'root count',anchors:'anchors',
  anchorStart:'anchor position',twist:'twist',bend:'bend',turn:'turn',angleDrift:'angle drift',scaleDrift:'scale drift',
  alternation:'alternation',closure:'closure',angleWave:'angle resonance',angleFrequency:'angle frequency',
  scaleWave:'scale pulse',scaleFrequency:'scale frequency',phase:'harmonic phase',curvatureDrift:'curvature drift',
  branchBias:'branch bias',facets:'faceting',tipSides:'terminal polygon',tipScale:'terminal scale',
  figureSides:'figure order',figureSpan:'figure segment',figureScale:'figure scale',
  figureEvery:'figure interval',figureSpin:'figure rotation',
  curveMode:'trigonometric curve',curveAmplitude:'curve amplitude',curveFrequency:'curve frequency',
  rootLayout:'root layout',rootSpread:'root spread',rootSpacing:'root spacing',
  rootLength:'root length',lineWidth:'line width',hue:'color',hueStep:'color shift',
  saturation:'saturation',lightness:'lightness',growthOverlap:'growth overlap'};
function updateFormulaUI(){
  const c=state.current,g=c?.genome||baseGenome();
  document.querySelector('#formula-name').textContent=familyName(g.family);
  document.querySelector('#organism-id').textContent=c?formulaId(c.id):'F000';
  document.querySelector('#trait-branch').textContent=g.branches;
  document.querySelector('#trait-angle').textContent=`${Math.round(g.angle*180/Math.PI)}°`;
  document.querySelector('#trait-scale').textContent=g.scale.toFixed(2);
  document.querySelector('#trait-symmetry').textContent=g.symmetry;
  document.querySelector('#trait-depth').textContent=g.depth;
  document.querySelector('#trait-closure').textContent=g.closure.toFixed(2);
  document.querySelector('#trait-wave').textContent=`${Math.round(g.angleWave*180/Math.PI)}°`;
  document.querySelector('#trait-pulse').textContent=g.scaleWave.toFixed(2);
  document.querySelector('#trait-facets').textContent=g.facets;
  document.querySelector('#trait-figure').textContent=g.figureSides>=3
    ?`${Math.round(g.figureSpan*g.figureSides)}/${g.figureSides}-gon`
    :'none';
  document.querySelector('#trait-curve').textContent=g.curveMode
    ?`${curveName(g.curveMode)} ${g.curveFrequency.toFixed(1)}×`
    :'linear';
  document.querySelector('#trait-layout').textContent=layoutName(g.rootLayout);
  const lineage=document.querySelector('#lineage');
  if(c?.parents?.length===2){
    const inherited=c.inheritance?`${c.inheritance.a}/${c.inheritance.b} genes`:'mixed genes';
    const breeding=c.breeding
      ?` · ${mixName(c.breeding.mix)} · ${MUTATION_PROFILES[c.breeding.mutationLevel].name}`
      :'';
    const mutations=c.mutations?.length?` · mutation: ${c.mutations.map(key=>geneLabels[key]||key).join(', ')}`:' · no mutation';
    lineage.textContent=`${formulaId(c.parents[0])} × ${formulaId(c.parents[1])} · inherited ${inherited}${breeding}${mutations}`;
  }else if(c?.source==='import')lineage.textContent='imported formula · external genome';
  else lineage.textContent='founder formula · no parents';
  updateSelectionUI();
}
function updateSelectionUI(){
  const selected=selectedRecords();
  const slot=(selector,label,item)=>{
    document.querySelector(selector).innerHTML=`<b>${label}</b> ${item?`${formulaId(item.id)} · ${familyName(item.genome.family)}`:'choose a formula'}`;
  };
  slot('#parent-a','A',selected[0]);slot('#parent-b','B',selected[1]);
  ui.cross.disabled=isBusy||selected.length!==2;
  const crossLabel=ui.cross.querySelector('span');
  if(selected.length===2){
    crossLabel.textContent=`Cross ${formulaId(selected[0].id)} × ${formulaId(selected[1].id)}`;
    document.querySelector('#action-kicker').textContent=`${mixName(state.breeding.mix)} · ${MUTATION_PROFILES[state.breeding.mutationLevel].name} mutation`;
    document.querySelector('#action-title').textContent=`${familyName(selected[0].genome.family)} × ${familyName(selected[1].genome.family)}`;
  }else if(selected.length===1){
    crossLabel.textContent='Choose parent B';
    document.querySelector('#action-kicker').textContent=`parent A · ${formulaId(selected[0].id)}`;
    document.querySelector('#action-title').textContent='Choose one more formula from the Gallery';
  }else{
    crossLabel.textContent='Cross A × B';
    document.querySelector('#action-kicker').textContent='selective generation · choose A and B';
    document.querySelector('#action-title').textContent='Choose two parents from the Gallery';
  }
}
function syncBreedingUI(){
  document.querySelector('#gene-mix').value=String(state.breeding.mix);
  document.querySelector('#mutation-level').value=String(state.breeding.mutationLevel);
}
function hideArchivePreview(){
  previewToken++;cancelAnimationFrame(previewAnimationFrame);
  document.querySelector('#genome-preview').classList.add('hidden');
}
function showArchivePreview(item,card){
  if(matchMedia('(hover: none)').matches)return;
  const token=++previewToken;
  cancelAnimationFrame(previewAnimationFrame);
  const preview=document.querySelector('#genome-preview');
  const previewCanvas=document.querySelector('#preview-canvas'),paths=compileGeometry(item.genome);
  paintFormulaMiniature(previewCanvas.getContext('2d'),paths,item.seed,0);
  document.querySelector('#preview-id').textContent=formulaId(item.id);
  document.querySelector('#preview-meta').textContent=item.parents?.length===2
    ?`${formulaId(item.parents[0])} × ${formulaId(item.parents[1])} · ${familyName(item.genome.family)}`
    :`${familyName(item.genome.family)} · ${item.source==='import'?'imported':'founder'}`;
  preview.classList.remove('hidden');
  const panel=ui.gallery.getBoundingClientRect(),cardBox=card.getBoundingClientRect(),previewWidth=preview.offsetWidth;
  const left=panel.left-previewWidth-12>=12?panel.left-previewWidth-12:Math.min(innerWidth-previewWidth-12,panel.right+12);
  const top=clamp(cardBox.top+cardBox.height/2-preview.offsetHeight/2,72,innerHeight-preview.offsetHeight-38);
  preview.style.left=`${left}px`;preview.style.top=`${top}px`;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){
    paintFormulaMiniature(previewCanvas.getContext('2d'),paths,item.seed,1);return;
  }
  const start=performance.now();
  let lastPaint=0;
  const frame=now=>{
    if(token!==previewToken)return;
    const linear=clamp((now-start)/PREVIEW_TIME,0,1);
    if(now-lastPaint>=30||linear===1){
      paintFormulaMiniature(previewCanvas.getContext('2d'),paths,item.seed,1-Math.pow(1-linear,2.2));
      lastPaint=now;
    }
    if(linear<1)previewAnimationFrame=requestAnimationFrame(frame);
  };
  previewAnimationFrame=requestAnimationFrame(frame);
}
function renderArchive(){
  hideArchivePreview();ui.archive.replaceChildren();
  const items=[...state.history].sort((a,b)=>b.id-a.id);
  for(const item of items.slice(0,historyVisible)){
    ensureThumbnail(item);
    const card=document.createElement('article');
    if(item.id===state.current?.id)card.classList.add('current');
    const selectedIndex=state.selectedParents.indexOf(item.id);
    if(selectedIndex>=0)card.classList.add(selectedIndex===0?'selected-a':'selected-b');
    card.dataset.formulaId=item.id;card.tabIndex=0;card.setAttribute('role','button');
    card.setAttribute('aria-label',`View ${formulaId(item.id)}, ${familyName(item.genome.family)}`);
    card.addEventListener('click',()=>viewStoredFormula(item));
    card.addEventListener('keydown',event=>{
      if(event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();viewStoredFormula(item)}
    });
    card.addEventListener('mouseenter',()=>showArchivePreview(item,card));card.addEventListener('mouseleave',hideArchivePreview);
    card.addEventListener('focus',()=>showArchivePreview(item,card));card.addEventListener('blur',hideArchivePreview);
    const image=document.createElement('img');image.src=item.thumbnail;image.alt=`Fractal ${formulaId(item.id)}`;image.loading='lazy';
    const label=document.createElement('span');label.textContent=formulaId(item.id);
    const parentPick=document.createElement('button');parentPick.className='parent-pick';
    parentPick.textContent=selectedIndex>=0?(selectedIndex===0?'A':'B'):'+';
    parentPick.setAttribute('aria-label',selectedIndex>=0
      ?`Remove ${formulaId(item.id)} from parent ${selectedIndex===0?'A':'B'}`
      :`Select ${formulaId(item.id)} as a parent`);
    parentPick.title=selectedIndex>=0?'Remove parent':'Select for crossing';
    parentPick.addEventListener('click',event=>{event.stopPropagation();toggleParent(item.id)});
    card.append(image,label,parentPick);ui.archive.append(card);
  }
  const remaining=Math.max(0,items.length-historyVisible),loadMore=document.querySelector('#load-more');
  loadMore.classList.toggle('hidden',remaining===0);loadMore.textContent=`Show more · ${remaining}`;
  document.querySelector('#gallery-count').textContent=state.history.length;
  updateSelectionUI();
}
function setGallery(open){
  galleryOpen=open;
  ui.gallery.classList.toggle('open',open);ui.gallery.classList.toggle('closed',!open);
  document.querySelector('#gallery-toggle').setAttribute('aria-expanded',String(open));
  hideArchivePreview();updateView();render(lastProgress);
}
function closeGalleryOnSmallScreen(){if(width<1180)setGallery(false)}
function toggleGallery(){setGallery(!galleryOpen)}
function closeExportMenu(){
  document.querySelector('#export-menu').classList.add('hidden');
  document.querySelector('#export-toggle').setAttribute('aria-expanded','false');
}
function showToast(message){
  const toast=document.querySelector('#toast');clearTimeout(toastTimer);
  toast.textContent=message;toast.classList.remove('hidden');
  toastTimer=setTimeout(()=>toast.classList.add('hidden'),1800);
}

ui.cross.addEventListener('click',crossSelected);
document.querySelector('#gallery-toggle').addEventListener('click',toggleGallery);
document.querySelector('#gallery-close').addEventListener('click',()=>setGallery(false));
document.querySelector('#clear-parents').addEventListener('click',()=>{
  state.selectedParents=[];saveState();renderArchive();
});
document.querySelector('#load-more').addEventListener('click',()=>{historyVisible+=HISTORY_PAGE;renderArchive()});
document.querySelector('#export-toggle').addEventListener('click',event=>{
  event.stopPropagation();const menu=document.querySelector('#export-menu'),open=menu.classList.contains('hidden');
  menu.classList.toggle('hidden',!open);event.currentTarget.setAttribute('aria-expanded',String(open));
});
document.querySelector('#export-menu').addEventListener('click',event=>event.stopPropagation());
document.querySelector('#save-background').addEventListener('click',()=>downloadImage(true));
document.querySelector('#save-transparent').addEventListener('click',()=>downloadImage(false));
document.querySelector('#save-video').addEventListener('click',exportVideo);
document.querySelector('#save-formula').addEventListener('click',exportFormula);
document.querySelector('#import-formula').addEventListener('click',()=>{
  closeExportMenu();document.querySelector('#formula-file').click();
});
document.querySelector('#formula-file').addEventListener('change',async event=>{
  const input=event.currentTarget,file=input.files?.[0];
  try{await importFormulaFile(file)}
  catch(error){console.warn('Could not import the formula',error);showToast(error instanceof SyntaxError?'Invalid JSON file':error.message||'Formula import failed')}
  finally{input.value=''}
});
document.querySelector('#gene-mix').addEventListener('change',event=>{
  state.breeding=normalizeBreeding({...state.breeding,mix:Number(event.currentTarget.value)});
  saveState();updateSelectionUI();
});
document.querySelector('#mutation-level').addEventListener('change',event=>{
  state.breeding=normalizeBreeding({...state.breeding,mutationLevel:Number(event.currentTarget.value)});
  saveState();updateSelectionUI();
});
document.addEventListener('click',closeExportMenu);
document.addEventListener('pointerdown',requestPersistentStorage,{once:true,capture:true});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){closeExportMenu();hideArchivePreview();if(width<1180)setGallery(false);return}
  if(event.repeat||event.target.closest('button,input,select,textarea'))return;
  if(event.code==='Space'){event.preventDefault();if(!ui.cross.disabled)crossSelected()}
});
addEventListener('resize',()=>{
  const wasDesktop=width>=1180;resize();
  if(wasDesktop!==(width>=1180))setGallery(width>=1180);
});
addEventListener('beforeunload',saveState);

async function boot(){
  await hydrateState();
  syncBreedingUI();
  await refreshStorageStatus();
  ensureInitialPopulation();
  galleryOpen=innerWidth>=1180;
  ui.gallery.classList.toggle('closed',!galleryOpen);ui.gallery.classList.toggle('open',galleryOpen);
  document.querySelector('#gallery-toggle').setAttribute('aria-expanded',String(galleryOpen));
  if(state.current)state.current=runtimeFormula(state.current);
  resize();renderArchive();
  if(state.current){
    updateFormulaUI();updateView();
    animateFormula(()=>{
      addCurrentToHistory();
      if(!state.selectedParents.length)state.selectedParents=[state.current.id];
      saveState();renderArchive();
    });
  }
}
boot();
