/** Fixed, read-only DOM probe. No model-supplied JavaScript or application-state access. */
export function inspectTargetsInPage(nodeIds:string[]=[]) {
  const visible = (el: Element) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight; };
  const selector = (el: Element) => { const parts:string[]=[]; for(let n:Element|null=el;n&&n!==document.documentElement;n=n.parentElement){const siblings=n.parentElement?Array.from(n.parentElement.children).filter(s=>s.tagName===n!.tagName):[];parts.unshift(n.tagName.toLowerCase()+`:nth-of-type(${siblings.indexOf(n)+1})`);}return "html > "+parts.join(" > "); };
  const nodeSelector=".react-flow__node,.xy-flow__node,[data-node-id]";
  const isPort=(el:Element)=>el.matches(".react-flow__handle,.xy-flow__handle,[data-handleid],[data-port-id],.port");
  const nodeLabel=(node:Element|null)=>{
    if(!node)return "";
    const clone=node.cloneNode(true) as Element;
    clone.querySelectorAll(".react-flow__handle,.xy-flow__handle,[data-handleid],[data-port-id],.port").forEach(h=>h.remove());
    return (clone.getAttribute("aria-label")||clone.getAttribute("data-label")||clone.textContent||"").replace(/\s+/g," ").trim().slice(0,120);
  };
  const portDirection=(el:Element,node:Element|null):"input"|"output"|null=>{
    const cls=[...el.classList].join(" ").toLowerCase();
    if(/\bsource\b/.test(cls)||cls.includes("handle-right")||cls.includes("handle-bottom"))return "output";
    if(/\btarget\b/.test(cls)||cls.includes("handle-left")||cls.includes("handle-top"))return "input";
    const pos=(el.getAttribute("data-handlepos")||el.getAttribute("data-position")||"").toLowerCase();
    if(pos==="right"||pos==="bottom")return "output";
    if(pos==="left"||pos==="top")return "input";
    if(!node)return null;
    const nr=node.getBoundingClientRect(),pr=el.getBoundingClientRect(),cx=pr.x+pr.width/2,cy=pr.y+pr.height/2,ncx=nr.x+nr.width/2,ncy=nr.y+nr.height/2;
    const dx=cx-ncx,dy=cy-ncy;
    if(Math.abs(dx)>=Math.abs(dy))return dx>=0?"output":"input";
    return dy>=0?"input":"output";
  };
  const all=Array.from(document.querySelectorAll(nodeSelector+",.react-flow__handle,.xy-flow__handle,[data-handleid],[data-port-id],button,[role=button],canvas")).filter(visible).filter(el=>{const node=el.closest(nodeSelector);return !nodeIds.length||nodeIds.includes(node?.getAttribute("data-id")||node?.getAttribute("data-node-id")||"");});
  // Prefer ports so unlabeled Compositor handles are not truncated behind buttons/nodes.
  const ranked=[...all.filter(isPort),...all.filter(el=>!isPort(el)&&el.matches(nodeSelector)),...all.filter(el=>!isPort(el)&&!el.matches(nodeSelector))];
  const limit=nodeIds.length?48:32;
  const raw=ranked.slice(0,limit).map((el,i)=>{
    const r=el.getBoundingClientRect(),node=el.closest(nodeSelector),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    const kind=isPort(el)?"port":el.matches(nodeSelector)?"node":el.tagName.toLowerCase();
    return {
      id:"t"+i,selector:selector(el),label:(el.getAttribute("aria-label")||el.getAttribute("title")||(kind==="port"?"":el.textContent)||"").trim().slice(0,180),
      nodeId:node?.getAttribute("data-id")||node?.getAttribute("data-node-id")||null,
      nodeLabel:nodeLabel(node),
      port:el.getAttribute("data-handleid")||el.getAttribute("data-port-id")||null,
      kind,direction:kind==="port"?portDirection(el,node):null,
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},unobstructed:!!hit&&(el===hit||el.contains(hit))};
  });
  const byNode=new Map<string,typeof raw>();
  for(const t of raw){
    if(t.kind!=="port"||!t.nodeId||!t.direction)continue;
    const key=t.nodeId+"|"+t.direction;
    if(!byNode.has(key))byNode.set(key,[]);
    byNode.get(key)!.push(t);
  }
  for(const group of byNode.values()){
    group.sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    group.forEach((t,index)=>{ (t as any).slot=index; (t as any).slotCount=group.length; (t as any).slotName=group.length===1?"only":index===0?"top":index===group.length-1?"bottom":"middle"; });
  }
  const allEdges=Array.from(document.querySelectorAll(".react-flow__edge,.xy-flow__edge,[data-source][data-target]")).filter(el=>!nodeIds.length||nodeIds.includes(el.getAttribute("data-source")||"")||nodeIds.includes(el.getAttribute("data-target")||""));
  const edges=allEdges.slice(0,24).map(el=>({
    id:el.getAttribute("data-id")||el.id,label:el.getAttribute("aria-label"),source:el.getAttribute("data-source"),target:el.getAttribute("data-target"),sourcePort:el.getAttribute("data-sourcehandle"),targetPort:el.getAttribute("data-targethandle")
  }));
  return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},targets:raw,edges,truncated:ranked.length>limit||allEdges.length>24,note:"DOM labels/ports/edges are observations, not proof of their meaning. Ports include nodeLabel, inferred direction, and slot/slotName (top/middle/bottom) when a node has multiple inputs/outputs. If truncated, focus with nodeIds. For unlabeled Beeble Compositor inputs use nodeLabel+direction+slot/role. Null edge endpoints are unknown; inspect destination inputs."};
}

export type CanvasTarget = ReturnType<typeof inspectTargetsInPage>["targets"][number] & {slot?:number;slotCount?:number;slotName?:string};
export type CanvasEdge = ReturnType<typeof inspectTargetsInPage>["edges"][number];
export type CanvasPortQuery = {nodeId?:string;port?:string;label?:string;direction?:string;kind?:string;slot?:string|number;role?:string};
export function inspectCode(nodeIds:string[]=[]) { return `(${inspectTargetsInPage.toString()})(${JSON.stringify(nodeIds)})`; }
export function parseBrowserJson(result:any) {
  const raw=(result.content||[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
  const block=raw.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1]?.trim();
  if(!block)throw new Error("Browser did not return structured geometry");
  return JSON.parse(block.replace(/^```(?:json)?\s*\n|\n```$/g,""));
}

/** Rematch a prior target by stable node/port identity (or label+direction) against a fresh inspect. */
export function rematchCanvasTarget(targets:CanvasTarget[], prior:Pick<CanvasTarget,"nodeId"|"port"|"label"|"direction"|"kind"|"slot"|"slotName"|"nodeLabel">):CanvasTarget|undefined {
  const byIdentity=targets.filter(t=>
    (prior.nodeId==null||t.nodeId===prior.nodeId)&&
    (prior.port==null||t.port===prior.port)&&
    (prior.kind==null||t.kind===prior.kind)&&
    (prior.direction==null||t.direction===prior.direction));
  if(byIdentity.length===1)return byIdentity[0];
  if(prior.nodeId!=null&&prior.port!=null){
    const ports=byIdentity.filter(t=>t.kind==="port");
    if(ports.length===1)return ports[0];
  }
  if(prior.nodeId!=null&&prior.slot!=null){
    const bySlot=targets.filter(t=>t.kind==="port"&&t.nodeId===prior.nodeId&&t.direction===prior.direction&&t.slot===prior.slot);
    if(bySlot.length===1)return bySlot[0];
  }
  const needle=(prior.label||prior.nodeLabel||"").trim().toLowerCase();
  if(!needle)return undefined;
  const byLabel=targets.filter(t=>
    ((t.label||"").toLowerCase().includes(needle)||(t.nodeLabel||"").toLowerCase().includes(needle))&&
    (prior.direction==null||t.direction===prior.direction)&&
    (prior.kind==null||t.kind===prior.kind||t.kind==="port"));
  return byLabel.length===1?byLabel[0]:undefined;
}

function roleToSlot(role:string,direction?:string):{slotName?:string;direction?:string;labelHints:string[]} {
  const r=role.trim().toLowerCase();
  if(/foreground|cutout|person|alpha|matte|fg/.test(r))return {slotName:direction==="output"?"only":"top",direction:direction||(/output|source/.test(r)?"output":"input"),labelHints:["foreground","alpha","cutout","matte","person"]};
  if(/background|house|bg|plate|floor/.test(r))return {slotName:"bottom",direction:direction||"input",labelHints:["background","house","bg"]};
  if(/middle|mid|second/.test(r))return {slotName:"middle",direction:direction||"input",labelHints:[]};
  return {labelHints:[r]};
}

function parseSlot(slot:string|number|undefined):{index?:number;name?:string} {
  if(slot===undefined||slot===null)return {};
  if(typeof slot==="number"&&Number.isInteger(slot)&&slot>=0&&slot<8)return {index:slot};
  const s=String(slot).trim().toLowerCase();
  if(/^\d+$/.test(s))return {index:Number(s)};
  if(["top","first","0","fg","foreground"].includes(s))return {name:s==="fg"||s==="foreground"?"top":s==="first"||s==="0"?"top":"top"};
  if(["middle","mid","second","1","center"].includes(s))return {name:"middle"};
  if(["bottom","last","2","bg","background","third"].includes(s))return {name:"bottom"};
  if(s==="only")return {name:"only"};
  return {};
}

export function matchCanvasPort(targets:CanvasTarget[], query:CanvasPortQuery):{target?:CanvasTarget;error?:string;available?:any[]} {
  if(!query||typeof query!=="object"||Array.isArray(query))return {error:"Port query must be an object with nodeId, port, label, role, slot and/or direction"};
  const keys=["nodeId","port","label","direction","kind","role"] as const;
  for(const key of keys)if(query[key]!==undefined&&(typeof query[key]!=="string"||(query[key] as string).length>200))return {error:"Invalid "+key+" in port query"};
  if(query.slot!==undefined&&typeof query.slot!=="string"&&typeof query.slot!=="number")return {error:"Invalid slot in port query"};
  if(!keys.some(key=>query[key])&&query.slot===undefined)return {error:"Port query needs nodeId, port, label, role, slot or direction"};

  const role=query.role?roleToSlot(query.role,query.direction):null;
  const direction=query.direction||role?.direction;
  const slotInfo=parseSlot(query.slot??(role?.slotName||undefined));
  const labelHints=[query.label,...(role?.labelHints||[])].filter((x):x is string=>!!x).map(s=>s.trim().toLowerCase());

  let candidates=targets.filter(t=>t.kind==="port"||query.kind==="node"||query.kind===t.kind);
  if(query.kind)candidates=candidates.filter(t=>t.kind===query.kind);
  if(query.nodeId)candidates=candidates.filter(t=>t.nodeId===query.nodeId);
  if(direction)candidates=candidates.filter(t=>!t.direction||t.direction===direction);

  // Prefer exact port ids, but fall back when Beeble uses opaque/wrong guessed ids.
  let portFiltered=candidates;
  if(query.port){
    const exact=candidates.filter(t=>t.port===query.port);
    if(exact.length)portFiltered=exact;
  }

  let labelFiltered=portFiltered;
  if(labelHints.length){
    const scored=portFiltered.filter(t=>labelHints.some(needle=>(t.label||"").toLowerCase().includes(needle)||(t.nodeLabel||"").toLowerCase().includes(needle)||(t.port||"").toLowerCase().includes(needle)||(t.nodeId||"").toLowerCase().includes(needle)));
    if(scored.length)labelFiltered=scored;
    else if(!query.nodeId&&query.label){
      // Label may name the node (Compositor) while ports themselves are blank.
      const byNode=portFiltered.filter(t=>(t.nodeLabel||"").toLowerCase().includes(query.label!.trim().toLowerCase()));
      if(byNode.length)labelFiltered=byNode;
    }
  }

  let slotFiltered=labelFiltered;
  if(slotInfo.index!==undefined)slotFiltered=labelFiltered.filter(t=>t.slot===slotInfo.index);
  else if(slotInfo.name){
    if(slotInfo.name==="middle")slotFiltered=labelFiltered.filter(t=>t.slotName==="middle"||(typeof t.slot==="number"&&typeof t.slotCount==="number"&&t.slot>0&&t.slot<t.slotCount-1));
    else slotFiltered=labelFiltered.filter(t=>t.slotName===slotInfo.name||(slotInfo.name==="top"&&t.slot===0)||(slotInfo.name==="bottom"&&typeof t.slotCount==="number"&&t.slot===t.slotCount-1));
  }

  // If slot/role narrowed to nothing but we have unlabeled ports on the node, use positional ports.
  if(!slotFiltered.length&&(query.role||query.slot!==undefined)&&query.nodeId){
    const positional=targets.filter(t=>t.kind==="port"&&t.nodeId===query.nodeId&&(!direction||!t.direction||t.direction===direction)).sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    if(slotInfo.index!==undefined&&positional[slotInfo.index])slotFiltered=[positional[slotInfo.index]];
    else if(slotInfo.name==="top"&&positional[0])slotFiltered=[positional[0]];
    else if(slotInfo.name==="bottom"&&positional.length)slotFiltered=[positional[positional.length-1]];
    else if(slotInfo.name==="middle"&&positional.length>=3)slotFiltered=[positional[Math.floor(positional.length/2)]];
    else if(slotInfo.name==="only"&&positional.length===1)slotFiltered=positional;
  }

  const available=()=>{
    const focus=query.nodeId||labelHints[0];
    return targets.filter(t=>t.kind==="port"&&(!focus||t.nodeId===query.nodeId||(t.nodeLabel||"").toLowerCase().includes(String(focus).toLowerCase()))).map(t=>({nodeId:t.nodeId,nodeLabel:t.nodeLabel,port:t.port,direction:t.direction,slot:t.slot,slotName:t.slotName,label:t.label,unobstructed:t.unobstructed}));
  };

  if(!slotFiltered.length)return {error:"No visible canvas port matched "+JSON.stringify(query)+". Pan/zoom or uncover nodes, then retry with nodeLabel/role/slot (top|middle|bottom).",available:available()};
  if(slotFiltered.length>1){
    // Unlabeled multi-input: guessed/missing port ids still need slot/role — do not pick arbitrarily.
    if(!query.slot&&!query.role&&slotFiltered.every(t=>!(t.label||"").trim()))
      return {error:"Ambiguous unlabeled ports for "+JSON.stringify(query)+". Use role (foreground|background) or slot (top|middle|bottom).",available:available()};
    return {error:"Ambiguous canvas port for "+JSON.stringify(query)+"; "+slotFiltered.length+" matches. Narrow with nodeId/port/direction/slot/role.",available:available()};
  }
  return {target:slotFiltered[0]};
}

export function edgeConnects(edges:CanvasEdge[], start:Pick<CanvasTarget,"nodeId"|"port">, end:Pick<CanvasTarget,"nodeId"|"port">):boolean {
  const portOk=(expected:string|null|undefined,actual:string|null|undefined)=>expected==null||expected===''||actual==null||actual===''||actual===expected;
  return edges.some(e=>e.source===start.nodeId&&e.target===end.nodeId&&portOk(start.port,e.sourcePort)&&portOk(end.port,e.targetPort));
}

/** Resolve nodeIds to focus inspect on, from connect_ports queries. */
export function focusNodeIds(targets:CanvasTarget[], start:CanvasPortQuery, end:CanvasPortQuery, explicit?:string[]):string[] {
  const ids=new Set<string>((explicit||[]).filter(Boolean));
  for(const q of [start,end]){
    if(q.nodeId)ids.add(q.nodeId);
    const needle=(q.label||q.role||"").trim().toLowerCase();
    if(!needle)continue;
    for(const t of targets)if(t.nodeId&&((t.nodeLabel||"").toLowerCase().includes(needle)||(t.label||"").toLowerCase().includes(needle)||(t.nodeId||"").toLowerCase().includes(needle)))ids.add(t.nodeId);
  }
  return [...ids].slice(0,4);
}

/** Atomic mouse gesture with intermediate events and unconditional release. Data only enters as JSON. */
export function dragCode(start:{x:number;y:number},end:{x:number;y:number},targets?:CanvasTarget[]) {
  for(const p of [start,end])if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0)throw new Error("Invalid drag coordinates");
  return `async (page) => {
    const start=${JSON.stringify(start)},end=${JSON.stringify(end)},targets=${JSON.stringify(targets||[])};
    const check=await page.evaluate(({start,end,targets})=>{
      for(const p of [start,end])if(p.x>=innerWidth||p.y>=innerHeight)return 'Coordinates outside current viewport';
      for(const t of targets){const els=document.querySelectorAll(t.selector);if(els.length!==1)return 'Target no longer unique';const el=els[0],r=el.getBoundingClientRect(),node=el.closest('.react-flow__node,.xy-flow__node,[data-node-id]');if((node?.getAttribute('data-id')||node?.getAttribute('data-node-id')||null)!==t.nodeId||(el.getAttribute('data-handleid')||el.getAttribute('data-port-id')||null)!==t.port)return 'Target identity changed; inspect again';if(['x','y','width','height'].some(k=>Math.abs(r[k]-t.rect[k])>2))return 'Target moved; inspect again';const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!hit||!(hit===el||el.contains(hit)))return 'Target is obscured; uncover it before dragging';}return null;
    },{start,end,targets});
    if(check)return {error:check,notExecuted:true};
    try {await page.mouse.move(start.x,start.y);await page.mouse.down();await page.waitForTimeout(100);await page.mouse.move(end.x,end.y,{steps:24});await page.waitForTimeout(150);}
    finally {await page.mouse.up();}
    return {gestureCompleted:true,connectionVerified:false,note:'Inspect the destination input and graph; gesture success alone does not prove a connection.'};
  }`;
}
