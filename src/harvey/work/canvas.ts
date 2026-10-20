/** Fixed, read-only DOM probe. No model-supplied JavaScript or application-state access. */
export function inspectTargetsInPage(nodeIds:string[]=[]) {
  const visible = (el: Element) => { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight; };
  const selector = (el: Element) => { const parts:string[]=[]; for(let n:Element|null=el;n&&n!==document.documentElement;n=n.parentElement){const siblings=n.parentElement?Array.from(n.parentElement.children).filter(s=>s.tagName===n!.tagName):[];parts.unshift(n.tagName.toLowerCase()+`:nth-of-type(${siblings.indexOf(n)+1})`);}return "html > "+parts.join(" > "); };
  const nodeSelector=".react-flow__node,.xy-flow__node,[data-node-id]";
  const elements=Array.from(document.querySelectorAll(nodeSelector+",.react-flow__handle,.xy-flow__handle,[data-handleid],[data-port-id],button,[role=button],canvas")).filter(visible).filter(el=>{const node=el.closest(nodeSelector);return !nodeIds.length||nodeIds.includes(node?.getAttribute("data-id")||node?.getAttribute("data-node-id")||"");});
  const targets=elements.slice(0,24).map((el,i)=>{const r=el.getBoundingClientRect(),node=el.closest(nodeSelector),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {
    id:"t"+i,selector:selector(el),label:(el.getAttribute("aria-label")||el.getAttribute("title")||el.textContent||"").trim().slice(0,180),
    nodeId:node?.getAttribute("data-id")||node?.getAttribute("data-node-id")||null,
    port:el.getAttribute("data-handleid")||el.getAttribute("data-port-id")||null,
    kind:el.matches(".react-flow__handle,.xy-flow__handle,[data-handleid],[data-port-id]")?"port":el.matches(nodeSelector)?"node":el.tagName.toLowerCase(),
    direction:el.classList.contains("source")?"output":el.classList.contains("target")?"input":null,
    rect:{x:r.x,y:r.y,width:r.width,height:r.height},unobstructed:!!hit&&(el===hit||el.contains(hit))};});
  const allEdges=Array.from(document.querySelectorAll(".react-flow__edge,.xy-flow__edge,[data-source][data-target]")).filter(el=>!nodeIds.length||nodeIds.includes(el.getAttribute("data-source")||"")||nodeIds.includes(el.getAttribute("data-target")||""));
  const edges=allEdges.slice(0,24).map(el=>({
    id:el.getAttribute("data-id")||el.id,label:el.getAttribute("aria-label"),source:el.getAttribute("data-source"),target:el.getAttribute("data-target"),sourcePort:el.getAttribute("data-sourcehandle"),targetPort:el.getAttribute("data-targethandle")
  }));
  return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},targets,edges,truncated:elements.length>24||allEdges.length>24,note:"DOM labels/ports/edges are observations, not proof of their meaning. If truncated, focus with nodeIds or pan/zoom to the relevant nodes. Null edge endpoints are unknown; inspect destination inputs. For pixel-only canvases use the screenshot and coordinate tools. Do not infer missing alpha is a blocking error."};
}

export type CanvasTarget = ReturnType<typeof inspectTargetsInPage>["targets"][number];
export type CanvasEdge = ReturnType<typeof inspectTargetsInPage>["edges"][number];
export type CanvasPortQuery = {nodeId?:string;port?:string;label?:string;direction?:string;kind?:string};
export function inspectCode(nodeIds:string[]=[]) { return `(${inspectTargetsInPage.toString()})(${JSON.stringify(nodeIds)})`; }
export function parseBrowserJson(result:any) {
  const raw=(result.content||[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");
  const block=raw.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1]?.trim();
  if(!block)throw new Error("Browser did not return structured geometry");
  return JSON.parse(block.replace(/^```(?:json)?\s*\n|\n```$/g,""));
}

/** Rematch a prior target by stable node/port identity (or label+direction) against a fresh inspect. */
export function rematchCanvasTarget(targets:CanvasTarget[], prior:Pick<CanvasTarget,"nodeId"|"port"|"label"|"direction"|"kind">):CanvasTarget|undefined {
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
  const needle=(prior.label||"").trim().toLowerCase();
  if(!needle)return undefined;
  const byLabel=targets.filter(t=>
    (t.label||"").toLowerCase().includes(needle)&&
    (prior.direction==null||t.direction===prior.direction)&&
    (prior.kind==null||t.kind===prior.kind||t.kind==="port"));
  return byLabel.length===1?byLabel[0]:undefined;
}

export function matchCanvasPort(targets:CanvasTarget[], query:CanvasPortQuery):{target?:CanvasTarget;error?:string} {
  if(!query||typeof query!=="object"||Array.isArray(query))return {error:"Port query must be an object with nodeId, port, label and/or direction"};
  const keys=["nodeId","port","label","direction","kind"] as const;
  for(const key of keys)if(query[key]!==undefined&&(typeof query[key]!=="string"||(query[key] as string).length>200))return {error:"Invalid "+key+" in port query"};
  if(!keys.some(key=>query[key]))return {error:"Port query needs nodeId, port, label or direction"};
  let candidates=targets.filter(t=>t.kind==="port"||query.kind==="node"||query.kind===t.kind);
  if(query.kind)candidates=candidates.filter(t=>t.kind===query.kind);
  if(query.nodeId)candidates=candidates.filter(t=>t.nodeId===query.nodeId);
  if(query.port)candidates=candidates.filter(t=>t.port===query.port);
  if(query.direction)candidates=candidates.filter(t=>t.direction===query.direction);
  if(query.label){
    const needle=query.label.trim().toLowerCase();
    candidates=candidates.filter(t=>(t.label||"").toLowerCase().includes(needle)||(t.nodeId||"").toLowerCase().includes(needle)||(t.port||"").toLowerCase().includes(needle));
  }
  if(!candidates.length)return {error:"No visible canvas port matched "+JSON.stringify(query)+". Pan/zoom or uncover nodes, then retry."};
  if(candidates.length>1)return {error:"Ambiguous canvas port for "+JSON.stringify(query)+"; "+candidates.length+" matches. Narrow with nodeId/port/direction."};
  return {target:candidates[0]};
}

export function edgeConnects(edges:CanvasEdge[], start:Pick<CanvasTarget,"nodeId"|"port">, end:Pick<CanvasTarget,"nodeId"|"port">):boolean {
  return edges.some(e=>
    e.source===start.nodeId&&e.target===end.nodeId&&
    (start.port==null||e.sourcePort===start.port||e.sourcePort==null)&&
    (end.port==null||e.targetPort===end.port||e.targetPort==null));
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
