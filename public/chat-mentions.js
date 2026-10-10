(function(){
  'use strict';
  window.ChatMentions={init:function(input,currentChat){
    var selected=[],matches=[],index=0,start=-1,request=0;
    var menu=document.createElement('div');menu.hidden=true;menu.setAttribute('role','listbox');menu.setAttribute('aria-label','Send to a chat');menu.id='chat-mention-picker';
    menu.style.cssText='position:fixed;z-index:10000;max-height:300px;overflow:auto;padding:8px;border:1px solid #64748b;border-radius:14px;background:#202834;color:#f8fafc;box-shadow:0 8px 32px #0006;font:14px system-ui';document.body.appendChild(menu);
    input.setAttribute('aria-controls',menu.id);input.setAttribute('aria-expanded','false');
    function close(){menu.hidden=true;input.setAttribute('aria-expanded','false');}
    function choose(c){var label='@['+c.title+' · '+c.accountOwnerName+']';var end=input.selectionStart;input.setRangeText(label+' ',start,end,'end');if(!selected.some(function(x){return x.id===c.id;}))selected.push({id:c.id,label:label});close();input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}
    function paint(){menu.replaceChildren();var title=document.createElement('div');title.textContent='Send this message to a chat';title.style.cssText='padding:6px;color:#b8c6d8;font-size:12px';menu.appendChild(title);
      if(!matches.length){var empty=document.createElement('div');empty.textContent='No matching chats';empty.style.padding='10px';menu.appendChild(empty);}
      matches.forEach(function(c,i){var b=document.createElement('button');b.type='button';b.setAttribute('role','option');b.setAttribute('aria-selected',String(index===i));b.textContent=c.title+' · '+c.accountOwnerName+' · '+c.mode;b.style.cssText='display:block;width:100%;text-align:left;border:0;border-radius:8px;padding:10px;color:inherit;background:'+(index===i?'#3c4d64':'transparent');b.onmousedown=function(e){e.preventDefault();};b.onclick=function(){choose(c);};menu.appendChild(b);});
      var box=input.getBoundingClientRect();menu.style.left=Math.max(8,box.left)+'px';menu.style.bottom=(innerHeight-box.top+8)+'px';menu.style.width=Math.min(460,innerWidth-24)+'px';menu.hidden=false;input.setAttribute('aria-expanded','true');
    }
    input.addEventListener('input',async function(){var before=input.value.slice(0,input.selectionStart),m=before.match(/(?:^|\s)@([^@\[\]\n]*)$/);if(!m){request++;close();return;}start=before.lastIndexOf('@');var serial=++request;
      try{var r=await fetch('/api/account/chats');if(!r.ok)throw new Error();var data=await r.json();if(serial!==request)return;var q=m[1].toLowerCase();matches=data.chats.filter(function(c){return c.id!==currentChat()&&(c.title+' '+c.accountOwnerName).toLowerCase().includes(q);}).slice(0,30);index=0;paint();}catch(_){close();}
    });
    input.addEventListener('keydown',function(e){if(menu.hidden)return;
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}
      else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopImmediatePropagation();index=matches.length?(index+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length:0;paint();}
      else if(e.key==='Enter'){e.preventDefault();e.stopImmediatePropagation();if(matches[index])choose(matches[index]);}
    },true);
    document.addEventListener('click',function(e){if(!menu.contains(e.target)&&e.target!==input)close();});
    window.ChatMentions.take=function(text){var result=selected.filter(function(c){return text.includes(c.label);}).map(function(c){return c.id;});selected=[];close();return result;};
    window.ChatMentions.reset=function(){selected=[];close();};
  }};
})();
