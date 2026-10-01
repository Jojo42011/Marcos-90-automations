// Print operational evidence only; omit message bodies, handles and credentials.
import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 try{
  const outer=JSON.parse(line), raw=outer.message||outer.data?.message||'';
  const start=raw.indexOf('{"marco":true');if(start<0)continue;
  const event=JSON.parse(raw.slice(start));
  if(!['inbound_accepted','pipeline_end','zernio_reply_send','zernio_inbound_failed','intent_gate'].includes(event.event))continue;
  const safe={};for(const key of ['ts','event','correlationId','platform','transport','outcome','success','status','message_chars','reply_chars','interested','reason'])if(event[key]!==undefined)safe[key]=event[key];
  if(event.error)safe.errorClass=/timeout|timed out/i.test(event.error)?'timeout':/fetch|network|connect/i.test(event.error)?'network':/48|window|limit/i.test(event.error)?'provider_limit':'other';
  console.log(JSON.stringify(safe));
 }catch{}
}
