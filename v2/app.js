import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import QRCode from 'https://esm.sh/qrcode@1.5.4';
import {CONFIG} from './config.js';
import {limaDate,time,hours,reportRows} from './core.js';
const $=id=>document.getElementById(id);
const sb=createClient(CONFIG.supabaseUrl,CONFIG.publishableKey);
const centerToken=new URLSearchParams(location.search).get('centro');
let ctx, data, stream, photo='', requestId='', channel, refreshTimer, loading=false;
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
const safe=fn=>async e=>{e?.preventDefault();try{await fn(e);}catch(err){status(err.message,true);}};
function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function link(text,href){const a=node('a',text,'button');a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;}
async function api(action,p={}){const {data:{session}}=await sb.auth.getSession();if(!session)throw new Error('Debes iniciar sesión');const response=await fetch(`${CONFIG.supabaseUrl}/functions/v1/${CONFIG.functionName}`,{method:'POST',headers:{'Content-Type':'application/json',apikey:CONFIG.publishableKey,Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({...p,action})});const value=await response.json();if(!response.ok||value.error)throw new Error(value.error||'Error de conexión');return value;}
function stopCamera(){stream?.getTracks().forEach(t=>t.stop());stream=null;}
async function boot(){
 const {data:{session}}=await sb.auth.getSession();
 $('loginPanel').hidden=!!session;$('logout').hidden=!session;
 if(!session){$('connection').textContent='Sin sesión';return;}
 ctx=await api('context',{center_token:centerToken});
 $('testBanner').hidden=!ctx.settings.test_weekends;
 if(ctx.user.role==='WORKER'){
  $('workerPanel').hidden=false;$('workerName').textContent=ctx.user.name;$('workerCode').textContent=`Código ${ctx.user.code}`;
  $('workerCenter').textContent=ctx.center?.name||'ESCANEA EL QR DE TU CENTRO';
  $('cameraStart').disabled=!ctx.center;$('connection').textContent='Sesión activa';
 }else{
  $('adminPanel').hidden=false;$('adminName').textContent=`${ctx.user.name} · ${ctx.user.role==='ADMIN'?'Administrador principal':'Subadministrador'}`;
  document.querySelectorAll('.adminOnly').forEach(n=>n.hidden=ctx.user.role!=='ADMIN');
  await refresh();
  channel=sb.channel('attendance-admin').on('postgres_changes',{event:'*',schema:'public',table:'journeys'},scheduleRefresh).on('postgres_changes',{event:'INSERT',schema:'public',table:'audit'},scheduleRefresh).subscribe(state=>{$('connection').textContent=state==='SUBSCRIBED'?'● En vivo':'Reconectando…';});
  // Recupera eventos perdidos y cambios de configuración sin depender exclusivamente del canal.
  refreshTimer=setInterval(()=>{if(!document.hidden)refresh().catch(e=>status(e.message,true));},60000);
 }
}
function scheduleRefresh(){clearTimeout(scheduleRefresh.timer);scheduleRefresh.timer=setTimeout(()=>refresh().catch(e=>status(e.message,true)),500);}
$('loginForm').onsubmit=safe(async()=>{const raw=$('loginId').value.trim();const email=$('loginType').value==='worker'?`${raw.toLowerCase()}@workers.fullconta.invalid`:raw;const {error}=await sb.auth.signInWithPassword({email,password:$('loginPass').value});if(error)throw new Error('Acceso incorrecto. Revisa tu código/correo y contraseña');$('loginPass').value='';await boot();status('Sesión iniciada');});
$('logout').onclick=safe(async()=>{stopCamera();clearInterval(refreshTimer);if(channel)await sb.removeChannel(channel);await sb.auth.signOut();location.reload();});
$('passwordForm').onsubmit=safe(async()=>{const {error}=await sb.auth.updateUser({password:$('newPassword').value});if(error)throw error;$('passwordPanel').hidden=true;status('Contraseña guardada. Ya puedes ingresar con tu correo.');});
$('cameraStart').onclick=safe(async()=>{stopCamera();photo='';$('mark').disabled=true;$('preview').hidden=true;$('video').hidden=false;stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:640}},audio:false});$('video').srcObject=stream;await $('video').play();$('capture').disabled=false;});
$('capture').onclick=safe(async()=>{const v=$('video');if(!v.videoWidth||!stream)throw new Error('Activa la cámara y espera la imagen');const canvas=document.createElement('canvas');canvas.width=canvas.height=640;const size=Math.min(v.videoWidth,v.videoHeight);canvas.getContext('2d').drawImage(v,(v.videoWidth-size)/2,(v.videoHeight-size)/2,size,size,0,0,640,640);let image;for(const q of [.65,.55,.45,.35]){image=canvas.toDataURL('image/jpeg',q);if(image.length<160000)break;}if(image.length>=160000)throw new Error('Foto demasiado pesada; prueba con un fondo más sencillo');photo=image.split(',')[1];requestId=crypto.randomUUID();$('preview').src=image;$('preview').hidden=false;$('video').hidden=true;$('capture').disabled=true;$('mark').disabled=false;stopCamera();});
$('mark').onclick=safe(async()=>{
 if(!photo||!ctx.center)throw new Error('Escanea tu centro y toma una foto');
 $('mark').disabled=true;
 try {
  let device=localStorage.getItem('fc-device');if(!device){device=crypto.randomUUID();localStorage.setItem('fc-device',device);}
  const payload={center_token:centerToken,shift:$('shift').value,kind:$('kind').value,photo,request_id:requestId,device_id:device,agent:navigator.userAgent};
  let result=await api('mark',payload);
  if(result.requires_confirmation){if(!confirm(result.warning))return;result=await api('mark',{...payload,ack_change:true});}
  photo='';requestId='';$('preview').hidden=true;$('video').hidden=false;
  status(`${result.kind==='ENTRY'?'Ingreso':'Salida'} registrado a las ${time(result.at)}. Puedes cerrar la página.`);
 }finally{$('mark').disabled=!photo;}
});
function options(id,items,placeholder){const select=$(id),old=select.value;select.replaceChildren();if(placeholder){const opt=node('option',placeholder);opt.value='';select.append(opt);}for(const item of items){const opt=node('option',item.name);opt.value=item.id;select.append(opt);}if([...select.options].some(o=>o.value===old))select.value=old;}
async function refresh(){if(loading)return;loading=true;try{data=await api('dashboard',{from:$('from').value,to:$('to').value});options('filterCenter',data.centers,'Todos los centros');options('scheduleCenter',data.centers);options('scheduleWorker',data.profiles.filter(p=>p.role==='WORKER'));$('testBanner').hidden=!data.settings[0].test_weekends;$('weekends').checked=data.settings[0].test_weekends;renderRows();await renderCenters();renderPeople();renderSchedules();renderAudit();}finally{loading=false;}}
function selectedRows(){return data.journeys.filter(r=>!$('filterCenter').value||r.center_id===$('filterCenter').value);}
function renderRows(){const rows=selectedRows();$('total').textContent=rows.length;$('completed').textContent=rows.filter(r=>r.exit_at).length;$('open').textContent=rows.filter(r=>!r.exit_at).length;$('alerts').textContent=data.audit.filter(a=>a.action.includes('IDENTIDAD')).length;const body=$('rows');body.replaceChildren();for(const r of rows){const tr=node('tr');for(const val of [r.work_date,data.centers.find(c=>c.id===r.center_id)?.name,r.worker_name,r.shift,time(r.entry_at),time(r.exit_at)||'—',hours(r)??'En curso'])tr.append(node('td',val));const td=node('td');for(const m of r.marks||[]){const button=node('button',m.kind==='ENTRY'?'Ingreso':'Salida');button.onclick=safe(async()=>{const p=await api('photo',{id:m.id});window.open(p.url,'_blank','noopener,noreferrer');});td.append(button);}tr.append(td);body.append(tr);}if(!rows.length){const tr=node('tr'),td=node('td','No hay registros para el rango elegido.');td.colSpan=8;tr.append(td);body.append(tr);}}
async function renderCenters(){const container=$('centers');container.replaceChildren();$('centerCount').textContent=`${data.centers.length} de 6 centros`;$('centerForm').querySelector('button').disabled=data.centers.length>=6;for(const c of data.centers){const box=node('article',undefined,'center');box.append(node('h3',c.name));const url=new URL('./',location.href);url.searchParams.set('centro',c.token);const img=node('img');img.alt=`QR de ${c.name}`;img.src=await QRCode.toDataURL(url.href,{width:300,margin:2,errorCorrectionLevel:'M'});box.append(img,link('Abrir marcación',url.href));const download=link('Descargar QR',img.src);download.download=`QR-${c.name}.png`;box.append(download);if(c.drive_folder)box.append(link('Carpeta de fotos',`https://drive.google.com/drive/folders/${c.drive_folder}`));else box.append(node('p','Carpeta pendiente de sincronización'));container.append(box);}}
function renderPeople(){const list=$('people');list.replaceChildren();for(const p of data.profiles)list.append(node('p',`${p.code||p.role} · ${p.name}`));}
function renderSchedules(){const wrap=$('schedules');wrap.replaceChildren();const table=node('table');const head=node('tr');['Trabajador','Día','Centro','Turno','Horario','Vigencia',''].forEach(v=>head.append(node('th',v)));table.append(head);for(const s of data.schedules){const tr=node('tr');[data.profiles.find(p=>p.id===s.worker_id)?.name,['','Lunes','Martes','Miércoles','Jueves','Viernes'][s.weekday],data.centers.find(c=>c.id===s.center_id)?.name,s.shift,`${s.starts} – ${s.ends}`,`${s.valid_from} / ${s.valid_until||'sin fin'}`].forEach(v=>tr.append(node('td',v)));const td=node('td'),button=node('button','Eliminar');button.onclick=safe(async()=>{if(!confirm('¿Eliminar esta asignación? Los registros existentes se conservan.'))return;await api('delete_schedule',{id:s.id});await refresh();});td.append(button);tr.append(td);table.append(tr);}wrap.append(table);}
function renderAudit(){const maintenance=data.settings[0].maintenance_at;$('maintenance').textContent=maintenance?`Último mantenimiento: ${new Date(maintenance).toLocaleString('es-PE',{timeZone:'America/Lima'})}`:'Automatización de Drive pendiente de activar. Las fotos están privadas en Supabase.';const container=$('audit');container.replaceChildren();data.audit.slice(0,30).forEach(a=>container.append(node('p',`${new Date(a.at).toLocaleString('es-PE',{timeZone:'America/Lima'})} · ${a.action} · ${JSON.stringify(a.detail)}`)));}
$('refresh').onclick=safe(refresh);$('filterCenter').onchange=renderRows;$('from').onchange=safe(refresh);$('to').onchange=safe(refresh);
$('export').onclick=safe(async()=>{const id=$('filterCenter').value;if(!id)throw new Error('Selecciona un centro para descargar su reporte separado');if(!window.XLSX)throw new Error('La herramienta Excel todavía no cargó. Reintenta');const rows=reportRows(selectedRows(),data.centers,CONFIG.company);if(!rows.length)throw new Error('No hay filas en este rango');const sheet=XLSX.utils.json_to_sheet(rows);sheet['!cols']=Object.keys(rows[0]).map(k=>({wch:k.includes('Foto')?45:22}));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,sheet,'Asistencias');const center=data.centers.find(c=>c.id===id).name;XLSX.writeFile(wb,`${center}_${$('from').value}_${$('to').value}.xlsx`);});
$('centerForm').onsubmit=safe(async()=>{await api('center',{name:$('centerName').value});$('centerName').value='';await refresh();status('Centro creado. Su carpeta aparecerá cuando ejecute la sincronización de Drive.');});
$('userForm').onsubmit=safe(async()=>{await api('create_user',{name:$('userName').value,role:$('userRole').value,code:$('userCode').value,email:$('userEmail').value,password:$('userPassword').value});$('userForm').reset();await refresh();status('Acceso creado. Entrega al usuario su código/correo y contraseña.');});
$('scheduleForm').onsubmit=safe(async()=>{await api('schedule',{worker_id:$('scheduleWorker').value,center_id:$('scheduleCenter').value,weekday:Number($('weekday').value),shift:$('scheduleShift').value,starts:$('starts').value,ends:$('ends').value,valid_from:$('validFrom').value,valid_until:$('validUntil').value||null});await refresh();status('Horario guardado');});
$('weekends').onchange=safe(async()=>{try{await api('weekends',{enabled:$('weekends').checked});await refresh();status('Configuración actualizada');}catch(e){$('weekends').checked=!$('weekends').checked;throw e;}});
const today=limaDate();$('from').value=today;$('to').value=today;$('validFrom').value=today;
const invitation=/type=(invite|recovery)/.test(location.hash);if(invitation)$('passwordPanel').hidden=false;
sb.auth.onAuthStateChange(event=>{if(event==='PASSWORD_RECOVERY')$('passwordPanel').hidden=false;});
window.addEventListener('pagehide',stopCamera);
boot().catch(e=>status(e.message,true));
