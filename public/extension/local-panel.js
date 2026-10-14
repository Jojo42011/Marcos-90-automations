const localStopButton=document.getElementById('stopLocal');
function refreshLocalControl(){chrome.runtime.sendMessage({type:'harvey:local-status'},r=>{localStopButton.hidden=!r?.active;});}
localStopButton.onclick=()=>chrome.runtime.sendMessage({type:'harvey:local-stop'},refreshLocalControl);
refreshLocalControl();setInterval(refreshLocalControl,2000);
