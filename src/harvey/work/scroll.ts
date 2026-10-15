/** Fixed DOM operations: expose rendered scroll regions, never application internals. */
export async function scrollInPage(input:{action:string;target?:string;deltaY?:number;deltaX?:number}) {
  const visible=(e:Element)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=="hidden";};
  const selector=(el:Element):string=>{
    if(el===document.scrollingElement)return "html";
    const parts:string[]=[];
    for(let e:Element|null=el;e&&e!==document.documentElement;e=e.parentElement){
      if(e.id){parts.unshift('#'+CSS.escape(e.id));break;}
      const siblings=Array.from(e.parentElement?.children||[]).filter(s=>s.tagName===e!.tagName);
      parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(e)+1)+')');
    }
    return parts.join(' > ');
  };
  const metrics=(e:Element)=>({top:e.scrollTop,left:e.scrollLeft,height:e.clientHeight,width:e.clientWidth,scrollHeight:e.scrollHeight,scrollWidth:e.scrollWidth});
  if(input.action==='inspect'){
    const regions=Array.from(document.querySelectorAll('*')).filter(e=>visible(e)&&(e===document.scrollingElement||/auto|scroll/.test(getComputedStyle(e).overflowY+' '+getComputedStyle(e).overflowX))&&(e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2));
    return {url:location.origin+location.pathname,regions:regions.slice(0,20).map(e=>({target:selector(e),role:e.getAttribute('role'),label:e.getAttribute('aria-label'),...metrics(e),preview:(e as HTMLElement).innerText?.trim().slice(0,160)})),truncated:regions.length>20,note:'Choose the region containing the requested rows. Scroll it, then read fresh rows. Scroll position alone never proves complete coverage.'};
  }
  const matches=input.target?Array.from(document.querySelectorAll(input.target)): [document.scrollingElement].filter(Boolean) as Element[];
  if(matches.length!==1||!visible(matches[0]!))return {error:'Scroll target is missing, hidden or ambiguous. Inspect scroll regions again.',actionCompleted:false};
  let el=matches[0]!;
  // A table is often inside the actual scrolling viewport.
  while(el!==document.scrollingElement&&!(el.scrollHeight>el.clientHeight+2||el.scrollWidth>el.clientWidth+2)){
    if(!el.parentElement)break;el=el.parentElement;
  }
  const before=metrics(el);
  el.scrollBy({top:input.deltaY??600,left:input.deltaX??0,behavior:'instant' as ScrollBehavior});
  await new Promise(resolve=>setTimeout(resolve,250));
  const after=metrics(el);
  return {url:location.origin+location.pathname,target:selector(el),before,after,moved:before.top!==after.top||before.left!==after.left,note:'Read a fresh table or snapshot now; newly loaded rows may still be pending. No movement means a boundary or wrong region, not proof of no data.'};
}
export const scrollCode=(input:{action:string;target?:string;deltaY?:number;deltaX?:number})=>`() => (${scrollInPage.toString()})(${JSON.stringify(input)})`;
