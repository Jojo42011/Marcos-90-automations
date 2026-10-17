/** Fixed DOM-only table reader: no hidden application state or model-authored code. */
export function readTableInPage(input:{target?:string;offset?:number}) {
  const visible=(el:Element)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=="hidden";};
  const roots=Array.from(document.querySelectorAll(input.target||'table,[role="grid"],[role="table"]')).filter(visible);
  if(!roots.length&&!input.target){
    const cards=Array.from(document.querySelectorAll('article,[role="listitem"]')).filter(visible);
    if(cards.length){
      const offset=input.offset||0,rows:any[]=[];let size=0,truncated=false;
      for(const card of cards.slice(offset,offset+24)){
        const links=Array.from(card.querySelectorAll('a[href]')).slice(0,8).map(e=>({text:(e.textContent||'').trim(),title:e.getAttribute('title')||e.querySelector('img')?.getAttribute('alt')||null,href:(e as HTMLAnchorElement).href}));
        const text=((card as HTMLElement).innerText||'').trim();
        const row={id:card.getAttribute('data-id')||links[0]?.href||null,cells:[text.slice(0,1200)],links,truncated:text.length>1200};
        const n=JSON.stringify(row).length;if(size+n>9000){if(!rows.length)return {error:'This rendered card exceeds the read limit; inspect a smaller region or its detail page',offset,renderedRowCount:cards.length};break;}rows.push(row);size+=n;truncated ||= row.truncated;
      }
      return {url:location.origin+location.pathname,layout:'cards',headers:['text'],rows,offset,nextOffset:offset+rows.length<cards.length?offset+rows.length:null,renderedRowCount:cards.length,truncated,coverage:'Currently rendered article/list cards only. Link titles/alt text are literal DOM attributes. Check pagination and requested order/count; no hidden application data was accessed.'};
    }
  }
  if(roots.length!==1)return {error:roots.length?"More than one table; use a unique observed selector":"No rendered table at this target; inspect a semantic snapshot or the relevant tab",tableCount:roots.length};
  const root=roots[0]!;
  if(!root.matches('table,[role="grid"],[role="table"]'))return {error:"Target must be an observed table or grid"};
  const headers=Array.from(root.querySelectorAll('th,[role="columnheader"]')).map(e=>(e.textContent||'').trim().slice(0,200));
  const all=Array.from(root.querySelectorAll('tr,[role="row"]')).filter(visible).filter(r=>r.querySelector('td,[role="cell"],[role="gridcell"]'));
  const offset=input.offset||0,rows:any[]=[];let size=0,truncated=false;
  for(const row of all.slice(offset,offset+24)){
    const raw=Array.from(row.querySelectorAll('td,[role="cell"],[role="gridcell"]')).map(e=>(e as HTMLElement).innerText?.trim()||e.textContent?.trim()||'');
    const links=Array.from(row.querySelectorAll('a[href]')).slice(0,8).map(e=>({text:(e.textContent||'').trim().slice(0,100),href:(e as HTMLAnchorElement).href}));
    const clipped=raw.length>30||raw.some(v=>v.length>600);
    const item={id:row.getAttribute('data-id')||row.getAttribute('data-row-key')||links[0]?.href||null,cells:raw.slice(0,30).map(v=>v.slice(0,600)),links,truncated:clipped};
    const n=JSON.stringify(item).length;if(size+n>9000){if(!rows.length)return {error:"This rendered row exceeds the read limit. Inspect a smaller region or open its profile; retrying the same offset cannot advance.",offset,renderedRowCount:all.length};truncated=true;break;}rows.push(item);size+=n;truncated ||= clipped;
  }
  let scroll:Element|null=root;
  while(scroll&&!(scroll.scrollHeight>scroll.clientHeight+2&&/auto|scroll/.test(getComputedStyle(scroll).overflowY)))scroll=scroll.parentElement;
  return {url:location.origin+location.pathname,headers,rows,offset,nextOffset:offset+rows.length<all.length?offset+rows.length:null,renderedRowCount:all.length,totalFromAria:root.getAttribute('aria-rowcount'),truncated,
    scroll:scroll?{top:scroll.scrollTop,clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight}:null,
    coverage:"Only currently rendered DOM rows. A null nextOffset is NOT proof the dataset is complete. Read the status filter and total, navigate actual pagination or scroll the table, then inspect fresh rows. Null IDs need a stable profile identifier before saving."};
}
export function tableCode(input:{target?:string;offset?:number}) {return `() => (${readTableInPage.toString()})(${JSON.stringify(input)})`;}
