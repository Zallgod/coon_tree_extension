"use strict";
const treeEl=document.getElementById("tree"),statsEl=document.getElementById("stats"),searchEl=document.getElementById("search"),searchX=document.getElementById("search-x"),ctxEl=document.getElementById("ctx"),renameBox=document.getElementById("rename-box"),iconUpload=document.getElementById("icon-upload"),bgUpload=document.getElementById("bg-upload"),importFile=document.getElementById("import-file"),toggleModeBtn=document.getElementById("btn-toggle-mode"),themeBtn=document.getElementById("btn-theme");
let port=null,currentTree=null,focusedWindowId=null,selectedNodeId=null,panelMode="popup",theme="dark",customBg=null;
let searchTerm="",clipData=null,dragSrcId=null,pendingIconNodeId=null;
const PRESETS=[{n:"Star",s:'<polygon points="8,1 10,6 16,6 11,10 13,15 8,12 3,15 5,10 0,6 6,6" fill="%23e0c050"/>'},{n:"Heart",s:'<path d="M8 14s-5.5-3.5-5.5-7A2.5 2.5 0 018 4.5 2.5 2.5 0 0113.5 7C13.5 10.5 8 14 8 14z" fill="%23e06070"/>'},{n:"Code",s:'<text x="8" y="12" text-anchor="middle" font-size="11" fill="%2350a0d0" font-family="monospace">&lt;/&gt;</text>'},{n:"Book",s:'<rect x="3" y="2" width="10" height="12" rx="1" fill="%235a7a40"/><line x1="8" y1="2" x2="8" y2="14" stroke="%23304020" stroke-width="1"/>'},{n:"Music",s:'<circle cx="5" cy="12" r="2" fill="%238070c0"/><circle cx="11" cy="10" r="2" fill="%238070c0"/><line x1="7" y1="12" x2="7" y2="3" stroke="%238070c0" stroke-width="1.5"/><line x1="13" y1="10" x2="13" y2="2" stroke="%238070c0" stroke-width="1.5"/>'},{n:"Work",s:'<rect x="3" y="5" width="10" height="8" rx="1" fill="%235a5040"/><rect x="5" y="2" width="6" height="4" rx="1" fill="none" stroke="%235a5040" stroke-width="1.5"/>'},{n:"Home",s:'<polygon points="8,1 1,8 3,8 3,15 6,15 6,10 10,10 10,15 13,15 13,8 15,8" fill="%23c09050"/>'},{n:"Game",s:'<rect x="2" y="5" width="12" height="8" rx="3" fill="%234a6090"/><circle cx="5" cy="9" r="1.5" fill="%23a0b0d0"/><circle cx="11" cy="9" r="1.5" fill="%23a0b0d0"/>'}];
const THEMES=[{id:"dark",c:"#1a1a2e"},{id:"midnight",c:"#0d1117"},{id:"forest",c:"#1a2e1a"},{id:"ocean",c:"#1a2030"},{id:"rose",c:"#2e1a2a"},{id:"ember",c:"#2a1a14"},{id:"arctic",c:"#1a2535"},{id:"violet",c:"#201a30"},{id:"copper",c:"#282018"},{id:"slate",c:"#222228"},{id:"sakura",c:"#2a1e28"},{id:"light",c:"#f5f5f0"}];
function presetUrl(p){return"data:image/svg+xml,"+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${p.s}</svg>`);}

function connect(){port=chrome.runtime.connect({name:"ct-panel"});port.onMessage.addListener(onMsg);port.onDisconnect.addListener(()=>setTimeout(connect,500));}
function onMsg(msg){
  if(msg.type==="full-tree"||msg.type==="tree-update"){currentTree=msg.tree;focusedWindowId=msg.focusedWindowId;selectedNodeId=msg.selectedNodeId;if(msg.panelMode)panelMode=msg.panelMode;if(msg.theme){theme=msg.theme;document.body.dataset.theme=theme;}if(msg.customBg!==undefined){customBg=msg.customBg;document.body.style.backgroundImage=customBg?`url(${customBg})`:"none";}updateToggleBtn();render();}
  else if(msg.type==="clipboard-data"){clipData=msg.data;navigator.clipboard.writeText(msg.data).catch(()=>{});}
  else if(msg.type==="urls-data"){navigator.clipboard.writeText(msg.urls).catch(()=>{});}
  else if(msg.type==="export-data"){
    const blob=new Blob([msg.data],{type:"application/json"});const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download="coontree-export-"+new Date().toISOString().slice(0,10)+".json";a.click();URL.revokeObjectURL(url);
  }
}
connect();
function send(a,d={}){if(port)port.postMessage({action:a,...d});}
function updateToggleBtn(){toggleModeBtn.textContent=panelMode==="popup"?"→Tab":"→Win";toggleModeBtn.title=panelMode==="popup"?"Switch Coon Tree to browser tab":"Switch Coon Tree to popup window";}

function findNodeInTree(root,id){const stk=[root];while(stk.length){const c=stk.pop();if(c.id===id)return c;if(c.children)for(let i=c.children.length-1;i>=0;i--)stk.push(c.children[i]);}return null;}
function findParentId(nid){const stk=[[currentTree,null]];while(stk.length){const[node,pid]=stk.pop();if(node.id===nid)return pid;if(node.children)for(let i=node.children.length-1;i>=0;i--)stk.push([node.children[i],node.id]);}return null;}

function render(){
  if(!currentTree)return;const scrollTop=treeEl.scrollTop;treeEl.innerHTML="";
  let tabC=0,winC=0,savedC=0;const sL=searchTerm.toLowerCase();
  const cstk=[currentTree];while(cstk.length){const n=cstk.pop();if(n.kind==="tab"&&n.state==="live")tabC++;if(n.kind==="branch"&&n.state==="live")winC++;if(n.state==="kept")savedC++;if(n.children)for(let i=n.children.length-1;i>=0;i--)cstk.push(n.children[i]);}

  function matches(n){if(!sL)return true;const t=(n.customTitle||n.title||"").toLowerCase(),u=(n.url||"").toLowerCase();if(t.includes(sL)||u.includes(sL))return true;return n.children?n.children.some(matches):false;}
  function directMatch(n){return sL&&((n.customTitle||n.title||"").toLowerCase().includes(sL)||(n.url||"").toLowerCase().includes(sL));}

  const renderStack=[];
  if(currentTree.children){for(let i=currentTree.children.length-1;i>=0;i--)renderStack.push([currentTree.children[i],0,[]]);}
  while(renderStack.length){
    const[n,depth,ac]=renderStack.pop();
    if(sL&&!matches(n))continue;
    const hasKids=n.children&&n.children.length>0;

    if(n.kind==="divider"){const row=mkRow(n,depth,ac);row.classList.add("t-sep","show-cb");row.appendChild(Object.assign(document.createElement("div"),{className:"sep-inner ss"+(n.separatorStyle||0)}));addCB(row,n);setupDrag(row,n);treeEl.appendChild(row);continue;}

    const row=mkRow(n,depth,ac);row.classList.add("t-"+n.kind);
    if(n.state==="live")row.classList.add("s-active");if(n.state==="kept")row.classList.add("s-saved");
    if(n.kind==="branch"&&n.focused&&n.state==="live")row.classList.add("focused");
    if(n.kind==="tab"&&n.active&&n.state==="live")row.classList.add("is-active");
    if(n.kind==="tab"&&n.pinned)row.classList.add("is-pinned");
    if(n.id===selectedNodeId)row.classList.add("selected");if(directMatch(n))row.classList.add("smatch");
    if(n.kind==="tab"||n.kind==="memo")row.classList.add("show-cb");

    if(hasKids){const a=document.createElement("span");a.className="toggle-arrow";a.textContent=n.collapsed&&!sL?"▶":"▼";row.appendChild(a);}
    if(n.customColor){const d=document.createElement("span");d.className="cdot";d.style.background=n.customColor;row.appendChild(d);}

    if(n.customIcon){const img=document.createElement("img");img.className="cicon";img.src=n.customIcon;row.appendChild(img);}
    else if(n.kind==="tab"){const img=document.createElement("img");img.className="favicon";img.src=getFav(n);img.onerror=()=>{img.src=svgI('<rect width="16" height="16" rx="3" fill="%232a2a4a"/>');};row.appendChild(img);}
    else if(n.kind==="branch"){const img=document.createElement("img");img.className="favicon";const c=n.state==="live"?(n.focused?"%236ad090":"%236a9ad0"):"%234a5060";img.src=svgI(`<rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="${c}" stroke-width="1.5"/><line x1="1" y1="5" x2="15" y2="5" stroke="${c}" stroke-width=".8"/>`);row.appendChild(img);}
    else if(n.kind==="group"){const img=document.createElement("img");img.className="favicon";img.src=n.customIcon||svgI('<rect x="1" y="4" width="14" height="10" rx="2" fill="%235a4030"/><rect x="1" y="2" width="7" height="4" rx="1" fill="%235a4030"/>');row.appendChild(img);}
    else if(n.kind==="memo"){row.appendChild(Object.assign(document.createElement("span"),{className:"note-i",textContent:"✎"}));}

    const title=document.createElement("span");title.className="title";title.textContent=getTitle(n);if(n.url)title.title=n.url;row.appendChild(title);
    if(n.kind==="branch"&&n.state==="kept"){const b=document.createElement("span");b.className="sbadge";b.textContent="saved"+(n.savedDate?" "+fmtRel(n.savedDate):"");row.appendChild(b);}
    if(hasKids&&n.collapsed&&!sL){const st=countKids(n),b=document.createElement("span");b.className="cbadge";const p=[];if(st.at>0)p.push(st.at+" tab"+(st.at!==1?"s":""));if(st.sv>0)p.push(st.sv+" saved");if(st.gr>0)p.push(st.gr+" grp"+(st.gr!==1?"s":""));if(!p.length)p.push(st.tot+" item"+(st.tot!==1?"s":""));b.textContent=p.join(", ");row.appendChild(b);}
    if(n.kind==="tab"||n.kind==="memo")addCB(row,n);

    row.addEventListener("click",e=>{e.stopPropagation();selectedNodeId=n.id;send("select-node",{nodeId:n.id});if(hasKids&&!sL)send("toggle-collapse",{nodeId:n.id});});
    row.addEventListener("dblclick",e=>{e.stopPropagation();if(n.kind==="tab"&&n.state==="live")send("activate-tab",{chromeId:n.chromeId,windowId:n.windowId});else if(n.state==="kept"&&n.kind==="branch")send("restore-window",{nodeId:n.id});else if(n.state==="kept"&&n.kind==="tab")send("restore-tab",{nodeId:n.id});else if(n.kind==="memo"||n.kind==="group")startRename(row,n);});
    row.addEventListener("contextmenu",e=>{e.preventDefault();showCtx(e,n);});
    setupDrag(row,n);treeEl.appendChild(row);
    if(hasKids&&(!n.collapsed||sL)){for(let i=n.children.length-1;i>=0;i--){renderStack.push([n.children[i],depth+1,[...ac,i<n.children.length-1]]);}}
  }
  treeEl.scrollTop=scrollTop;
  statsEl.textContent=`${winC} win · ${tabC} tab${tabC!==1?"s":""}`+(savedC>0?` · ${savedC} saved`:"");
}

function addCB(row,n){const cb=document.createElement("span");cb.className="cb";cb.textContent="×";cb.addEventListener("click",e=>{e.stopPropagation();if(n.kind==="tab"&&n.state==="live")send("close-tab",{chromeId:n.chromeId});else send("remove-node",{nodeId:n.id});});row.appendChild(cb);}
function mkRow(node,depth,ac){const row=document.createElement("div");row.className="nr";row.dataset.nid=node.id;row.draggable=true;for(let d=0;d<depth;d++){const g=document.createElement("span");g.className="guide";if(d<depth-1){if(ac[d])g.classList.add("vert");}else{if(ac[d])g.classList.add("cont-branch");else g.classList.add("branch");}row.appendChild(g);}return row;}
function getTitle(n){
  if(n.kind==="branch"){const c=(n.children||[]).filter(x=>x.kind==="tab").length;return(n.customTitle||"Coon Tree Branch")+" ("+c+")";}
  if(n.kind==="group")return n.customTitle||n.title||"Group";
  if(n.kind==="memo")return n.title||"(empty note)";
  if(n.kind==="tab")return n.customTitle||n.title||n.url||"(untitled)";return n.title||"";
}
function countKids(n){let at=0,sv=0,gr=0,tot=0;const stk=n.children?[...n.children]:[];while(stk.length){const c=stk.pop();tot++;if(c.kind==="tab"&&c.state==="live")at++;if(c.state==="kept")sv++;if(c.kind==="group")gr++;if(c.children)for(let i=c.children.length-1;i>=0;i--)stk.push(c.children[i]);}return{at,sv,gr,tot};}
function getFav(n){if(n.favIconUrl&&!n.favIconUrl.startsWith("chrome://"))return n.favIconUrl;if(n.url){try{return`chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(new URL(n.url).origin)}&size=16`;}catch(e){}}return svgI('<rect width="16" height="16" rx="3" fill="%232a2a4a"/>');}
function svgI(i){return"data:image/svg+xml,"+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${i}</svg>`);}
function fmtRel(ts){const d=Date.now()-ts,m=Math.floor(d/60000);if(m<1)return"just now";if(m<60)return m+"m";const h=Math.floor(m/60);if(h<24)return h+"h";const dy=Math.floor(h/24);if(dy<30)return dy+"d";return new Date(ts).toLocaleDateString();}

function showCtx(e,n){hideCtx();ctxEl.innerHTML="";const items=[];
  if(n.kind==="tab"&&n.state==="live"){items.push({i:"↗",l:"Open Tab",fn:()=>send("activate-tab",{chromeId:n.chromeId,windowId:n.windowId})});items.push({i:"💾",l:"Save Tab Copy",fn:()=>{const name=prompt("Save name (blank for date/time):","")||"";send("save-tab-copy",{nodeId:n.id,name});}});items.push({i:"✕",l:"Close Tab",fn:()=>send("close-tab",{chromeId:n.chromeId})});items.push("sep");}
  if(n.kind==="branch"&&n.state==="live"){items.push({i:"💾",l:"Save & Close",fn:()=>send("save-and-close-window",{chromeId:n.chromeId})});items.push({i:"✕",l:"Close",fn:()=>send("close-window",{chromeId:n.chromeId})});items.push("sep");}
  if(n.state==="kept"){if(n.kind==="branch")items.push({i:"↗",l:"Restore All Tabs",fn:()=>send("restore-window",{nodeId:n.id})});if(n.kind==="tab")items.push({i:"↗",l:"Open Tab",fn:()=>send("restore-tab",{nodeId:n.id})});items.push("sep");}
  items.push({i:"📋",l:"Copy URLs",fn:()=>send("copy-urls",{nodeId:n.id})});
  items.push({i:"⧉",l:"Copy Subtree",fn:()=>send("copy-node",{nodeId:n.id})});
  items.push({i:"⧉",l:"Duplicate",fn:()=>send("duplicate-node",{nodeId:n.id})});
  if(clipData&&n.children)items.push({i:"📌",l:"Paste Here",fn:()=>send("paste-node",{parentId:n.id,data:clipData})});
  items.push("sep");items.push("hdr:Insert");
  items.push({i:"📁",l:"New Group",fn:()=>{const t=prompt("Group name (blank for date/time):","");if(t!==null)send("add-group",{targetId:findParentId(n.id)||"root",title:t});}});
  items.push({i:"📝",l:"New Note",fn:()=>{const t=prompt("Note:","");if(t!==null)send("add-note",{targetId:findParentId(n.id)||"root",text:t});}});
  items.push({i:"―",l:"New Separator",fn:()=>send("add-separator",{targetId:findParentId(n.id)||"root"})});
  if(n.kind!=="divider"){items.push("sep");items.push({i:"✏️",l:"Rename (F2)",fn:()=>{hideCtx();const r=treeEl.querySelector(`[data-nid="${n.id}"]`);if(r)startRename(r,n);}});items.push("sep");items.push("hdr:Color");items.push("colors:"+n.id);items.push("sep");items.push("hdr:Custom Icon");items.push("icons:"+n.id);}
  if(n.kind==="group"||n.kind==="branch"){items.push("sep");items.push({i:"🗑",l:`Delete ${n.kind==="group"?"Group":"Branch"}`,fn:()=>{if(confirm(`Delete this ${n.kind} and all contents?`)){if(n.kind==="branch"&&n.state==="live"&&n.chromeId)send("close-window",{chromeId:n.chromeId});else send("remove-node",{nodeId:n.id});}}});}

  items.forEach(item=>{
    if(item==="sep"){ctxEl.appendChild(Object.assign(document.createElement("div"),{className:"csep"}));return;}
    if(typeof item==="string"&&item.startsWith("hdr:")){ctxEl.appendChild(Object.assign(document.createElement("div"),{className:"chdr",textContent:item.slice(4)}));return;}
    if(typeof item==="string"&&item.startsWith("colors:")){const nid=item.split(":")[1];const row=document.createElement("div");row.className="cpick";["#e06070","#e09050","#d0c050","#60c070","#50a0d0","#8070c0","#c070a0",null].forEach(color=>{const btn=document.createElement("div");if(color)btn.style.background=color;else btn.textContent="✕";btn.addEventListener("click",()=>{send("set-color",{nodeId:nid,color});hideCtx();});row.appendChild(btn);});ctxEl.appendChild(row);return;}
    if(typeof item==="string"&&item.startsWith("icons:")){const nid=item.split(":")[1];const row=document.createElement("div");row.className="ipick";PRESETS.forEach(p=>{const img=document.createElement("img");img.src=presetUrl(p);img.title=p.n;img.addEventListener("click",()=>{send("set-custom-icon",{nodeId:nid,iconData:presetUrl(p)});hideCtx();});row.appendChild(img);});const uBtn=document.createElement("div");uBtn.className="upload-btn";uBtn.textContent="📤";uBtn.title="Upload";uBtn.addEventListener("click",()=>{pendingIconNodeId=nid;iconUpload.click();hideCtx();});row.appendChild(uBtn);const clr=document.createElement("div");clr.className="upload-btn";clr.textContent="✕";clr.addEventListener("click",()=>{send("set-custom-icon",{nodeId:nid,iconData:null});hideCtx();});row.appendChild(clr);ctxEl.appendChild(row);return;}
    const el=document.createElement("div");el.className="ci";el.innerHTML=`<span class="cic">${item.i}</span>${item.l}`;el.addEventListener("click",()=>{item.fn();hideCtx();});ctxEl.appendChild(el);
  });
  ctxEl.style.left=e.clientX+"px";ctxEl.style.top=e.clientY+"px";ctxEl.classList.add("vis");
  requestAnimationFrame(()=>{const r=ctxEl.getBoundingClientRect();let l=parseFloat(ctxEl.style.left),t=parseFloat(ctxEl.style.top);if(l+r.width>innerWidth-4)l=innerWidth-r.width-4;if(l<4)l=4;if(t+r.height>innerHeight-4)t=innerHeight-r.height-4;if(t<4)t=4;ctxEl.style.left=l+"px";ctxEl.style.top=t+"px";ctxEl.style.maxHeight=(innerHeight-8)+"px";});
  setTimeout(()=>document.addEventListener("click",hideCtx,{once:true}),10);
}
function hideCtx(){ctxEl.classList.remove("vis");ctxEl.innerHTML="";}

function showThemePicker(e){hideCtx();ctxEl.innerHTML="";
  ctxEl.appendChild(Object.assign(document.createElement("div"),{className:"chdr",textContent:"Theme"}));
  const row=document.createElement("div");row.className="tpick";
  THEMES.forEach(t=>{const btn=document.createElement("div");btn.style.background=t.c;btn.title=t.id;if(t.id===theme)btn.classList.add("active");btn.addEventListener("click",()=>{theme=t.id;document.body.dataset.theme=theme;send("set-theme",{theme});hideCtx();});row.appendChild(btn);});ctxEl.appendChild(row);
  ctxEl.appendChild(Object.assign(document.createElement("div"),{className:"chdr",textContent:"Background Image"}));
  const bgRow=document.createElement("div");bgRow.className="cpick";
  const uploadBg=document.createElement("div");uploadBg.textContent="📤";uploadBg.title="Upload background";uploadBg.addEventListener("click",()=>{bgUpload.click();hideCtx();});bgRow.appendChild(uploadBg);
  const clearBg=document.createElement("div");clearBg.textContent="✕";clearBg.title="Clear background";clearBg.addEventListener("click",()=>{customBg=null;document.body.style.backgroundImage="none";send("set-custom-bg",{data:null});hideCtx();});bgRow.appendChild(clearBg);
  ctxEl.appendChild(bgRow);
  ctxEl.classList.add("vis");
  requestAnimationFrame(()=>{const r=ctxEl.getBoundingClientRect();let left=e.clientX-r.width/2;let top=e.clientY-r.height-4;if(left<4)left=4;if(left+r.width>innerWidth-4)left=innerWidth-r.width-4;if(top<4)top=e.clientY+4;ctxEl.style.left=left+"px";ctxEl.style.top=top+"px";});
  setTimeout(()=>document.addEventListener("click",hideCtx,{once:true}),10);
}

iconUpload.addEventListener("change",e=>{const file=e.target.files[0];if(!file||!pendingIconNodeId)return;const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const c=document.createElement("canvas");c.width=32;c.height=32;c.getContext("2d").drawImage(img,0,0,32,32);send("set-custom-icon",{nodeId:pendingIconNodeId,iconData:c.toDataURL("image/png")});pendingIconNodeId=null;};img.src=reader.result;};reader.readAsDataURL(file);iconUpload.value="";});
bgUpload.addEventListener("change",e=>{const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const c=document.createElement("canvas");const maxW=800;const scale=Math.min(1,maxW/img.width);c.width=img.width*scale;c.height=img.height*scale;c.getContext("2d").drawImage(img,0,0,c.width,c.height);customBg=c.toDataURL("image/jpeg",0.7);document.body.style.backgroundImage=`url(${customBg})`;send("set-custom-bg",{data:customBg});};img.src=reader.result;};reader.readAsDataURL(file);bgUpload.value="";});
importFile.addEventListener("change",e=>{const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{send("import-tree",{data:reader.result});};reader.readAsText(file);importFile.value="";});

function startRename(rowEl,n){const titleEl=rowEl.querySelector(".title");if(!titleEl)return;const r=titleEl.getBoundingClientRect();renameBox.style.display="block";renameBox.style.left=r.left+"px";renameBox.style.top=r.top+"px";renameBox.style.width=Math.max(r.width,120)+"px";renameBox.value=n.customTitle||n.title||"";renameBox.focus();renameBox.select();function commit(){renameBox.style.display="none";send("rename-node",{nodeId:n.id,newTitle:renameBox.value.trim()});renameBox.removeEventListener("blur",commit);renameBox.removeEventListener("keydown",onK);}function onK(e){if(e.key==="Enter"){e.preventDefault();commit();}if(e.key==="Escape"){renameBox.style.display="none";renameBox.removeEventListener("blur",commit);renameBox.removeEventListener("keydown",onK);}}renameBox.addEventListener("blur",commit);renameBox.addEventListener("keydown",onK);}

// Drag/Drop — dispatches slot-based actions, no TO compatibility
function setupDrag(row,n){
  row.addEventListener("dragstart",e=>{dragSrcId=n.id;e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",n.id);requestAnimationFrame(()=>row.classList.add("dragging"));});
  row.addEventListener("dragend",()=>{dragSrcId=null;row.classList.remove("dragging");clearDI();});
  row.addEventListener("dragover",e=>{e.preventDefault();e.dataTransfer.dropEffect="move";clearDI();const rect=row.getBoundingClientRect(),y=e.clientY-rect.top,h=rect.height;const isCont=(n.kind==="branch"||n.kind==="group");if(isCont){if(y<h*.25)row.classList.add("doa");else if(y>h*.75)row.classList.add("dob");else row.classList.add("doi");}else{if(y<h/2)row.classList.add("doa");else row.classList.add("dob");}});
  row.addEventListener("dragleave",()=>row.classList.remove("doa","dob","doi"));
  row.addEventListener("drop",e=>{
    e.preventDefault();clearDI();
    // External URL drop
    if(!dragSrcId){const text=e.dataTransfer.getData("text/plain");if(text&&text.includes("://")){send("paste-text",{parentId:n.id,text});return;}}
    if(!dragSrcId||dragSrcId===n.id)return;
    const rect=row.getBoundingClientRect(),y=e.clientY-rect.top,h=rect.height;
    const isCont=(n.kind==="branch"||n.kind==="group");
    let slot;
    if(isCont){if(y<h*.25)slot="before";else if(y>h*.75)slot="after";else slot="nest";}
    else{slot=y<h/2?"before":"after";}
    send("move-node",{sourceId:dragSrcId,targetId:n.id,slot});
  });
}
function clearDI(){treeEl.querySelectorAll(".doa,.dob,.doi").forEach(el=>el.classList.remove("doa","dob","doi"));}

// Paste — native format only
document.addEventListener("paste",e=>{if(document.activeElement===searchEl||document.activeElement===renameBox)return;const text=e.clipboardData.getData("text/plain");if(text)send("paste-text",{parentId:selectedNodeId||"root",text});});

document.addEventListener("keydown",e=>{
  if(document.activeElement===searchEl||document.activeElement===renameBox)return;
  const ctrl=e.ctrlKey||e.metaKey;
  if(ctrl&&e.key==="z"){e.preventDefault();send("undo");return;}
  if(ctrl&&e.key==="f"){e.preventDefault();searchEl.focus();return;}
  if(ctrl&&e.key==="c"&&selectedNodeId){e.preventDefault();send("copy-node",{nodeId:selectedNodeId});return;}
  if(ctrl&&e.key==="v"){return;}
  if(ctrl&&e.key==="d"&&selectedNodeId){e.preventDefault();send("duplicate-node",{nodeId:selectedNodeId});return;}
  if(ctrl&&e.key==="s"){e.preventDefault();send("save-selected",{nodeId:selectedNodeId});return;}
  if(e.key==="F2"&&selectedNodeId){e.preventDefault();const row=treeEl.querySelector(`[data-nid="${selectedNodeId}"]`);const nd=findNodeInTree(currentTree,selectedNodeId);if(row&&nd)startRename(row,nd);return;}
  if(e.key==="Delete"&&selectedNodeId){e.preventDefault();const nd=findNodeInTree(currentTree,selectedNodeId);if(!nd)return;if(nd.kind==="tab"&&nd.state==="live")send("close-tab",{chromeId:nd.chromeId});else if(nd.kind==="tab"||nd.kind==="memo"||nd.kind==="divider")send("remove-node",{nodeId:selectedNodeId});return;}
  if(e.key==="Enter"&&selectedNodeId){e.preventDefault();const nd=findNodeInTree(currentTree,selectedNodeId);if(!nd)return;if(nd.kind==="tab"&&nd.state==="live")send("activate-tab",{chromeId:nd.chromeId,windowId:nd.windowId});else if(nd.state==="kept"&&nd.kind==="branch")send("restore-window",{nodeId:nd.id});else if(nd.state==="kept"&&nd.kind==="tab")send("restore-tab",{nodeId:nd.id});return;}
  if(e.key==="Escape"){selectedNodeId=null;send("select-node",{nodeId:null});return;}
});

searchEl.addEventListener("input",()=>{searchTerm=searchEl.value;searchX.classList.toggle("vis",searchTerm.length>0);render();});
searchX.addEventListener("click",()=>{searchEl.value="";searchTerm="";searchX.classList.remove("vis");render();});
document.getElementById("btn-collapse").addEventListener("click",()=>send("collapse-all"));
document.getElementById("btn-expand").addEventListener("click",()=>send("expand-all"));
document.getElementById("btn-save").addEventListener("click",()=>send("save-selected",{nodeId:selectedNodeId}));
document.getElementById("btn-add-group").addEventListener("click",()=>{const t=prompt("Group name (blank for date/time):","");if(t!==null)send("add-group",{title:t});});
document.getElementById("btn-add-note").addEventListener("click",()=>{const t=prompt("Note:","");if(t!==null)send("add-note",{text:t});});
document.getElementById("btn-add-sep").addEventListener("click",()=>send("add-separator",{}));
toggleModeBtn.addEventListener("click",()=>send("toggle-panel-mode"));
themeBtn.addEventListener("click",e=>showThemePicker(e));
document.getElementById("btn-export").addEventListener("click",()=>send("export-tree"));
document.getElementById("btn-import").addEventListener("click",()=>importFile.click());
treeEl.addEventListener("click",e=>{if(e.target===treeEl){selectedNodeId=null;send("select-node",{nodeId:null});}});
