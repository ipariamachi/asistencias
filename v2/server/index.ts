import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import jpeg from 'npm:jpeg-js@0.4.4';

const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default;
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (value, status=200) => new Response(JSON.stringify(value), {status,headers});
const checked = ({data,error}) => { if(error) throw new Error(error.message); return data; };
const uuid = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

Deno.serve(async req => {
 if(req.method==='OPTIONS') return new Response('',{headers});
 if(req.method!=='POST') return reply({error:'Usa POST'},405);
 try {
  const body = await req.text();
  if(body.length>200000) return reply({error:'Solicitud demasiado grande'},413);
  const p=JSON.parse(body), action=p.action;
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
  const {data:auth,error}=await db.auth.getUser(token);
  if(error||!auth.user) return reply({error:'Inicia sesión nuevamente'},401);
  const user=checked(await db.from('profiles').select('*').eq('id',auth.user.id).eq('active',true).single());
  const admin=['ADMIN','SUBADMIN'].includes(user.role);
  const command = (name,data) => db.rpc('attendance_command',{p_actor:user.id,p_action:name,p:data}).then(checked);
  if(action==='context') {
   let center=null;
   if(uuid(p.center_token)) center=checked(await db.from('centers').select('id,name').eq('token',p.center_token).eq('active',true).maybeSingle());
   const settings=checked(await db.from('settings').select('company,test_weekends,maintenance_at').single());
   return reply({user,center,settings});
  }
  if(action==='mark') {
   if(user.role!=='WORKER') return reply({error:'Cuenta de trabajador requerida'},403);
   if(!uuid(p.request_id)||!uuid(p.device_id)||!uuid(p.center_token)) throw new Error('Identificadores no válidos');
   const old=checked(await db.from('marks').select('id,at,kind').eq('id',p.request_id).eq('worker_id',user.id).maybeSingle());
   if(old) return reply(old);
   // Reducir ráfagas por usuario, incluso con identificadores diferentes.
   const recent=checked(await db.from('marks').select('id').eq('worker_id',user.id).gte('at',new Date(Date.now()-10000).toISOString()));
   if(recent.length) return reply({error:'Espera diez segundos antes de otra marcación'},429);
   if(typeof p.photo!=='string'||p.photo.length>170000) throw new Error('Foto no válida');
   const bytes=Uint8Array.from(atob(p.photo),c=>c.charCodeAt(0));
   const decoded=jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:1,maxMemoryUsageInMB:32});
   if(decoded.width!==640||decoded.height!==640) throw new Error('La foto debe medir 640 × 640');
   let encoded;
   for(const quality of [65,55,45,35]) { encoded=jpeg.encode(decoded,quality).data; if(encoded.length<=122880) break; }
   if(encoded.length>122880) throw new Error('Foto demasiado pesada. Intenta con otro fondo');
   const path=`${user.id}/${p.request_id}.jpg`;
   const upload=await db.storage.from('attendance').upload(path,encoded,{contentType:'image/jpeg',upsert:false});
   if(upload.error && !/already exists|duplicate/i.test(upload.error.message)) throw new Error('No se pudo guardar la foto');
   // Si falla la transacción, se conserva temporalmente el objeto para reintento con el mismo ID.
   // El mantenimiento elimina objetos huérfanos mayores a 24 horas.
   return reply(await command('mark',p));
  }
  if(!admin) return reply({error:'Acceso administrativo requerido'},403);
  if(action==='dashboard') {
   const tables=['centers','profiles','schedules','settings'];
   const out={};
   for(const table of tables) out[table]=checked(await db.from(table).select('*'));
   // Rangos obligatorios y paginación: no truncar reportes silenciosamente a 1.000 filas.
   const from=p.from,to=p.to;
   if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to) throw new Error('Rango de fechas inválido');
   out.journeys=[];
   for(let offset=0;;offset+=500) {
    const rows=checked(await db.from('journeys').select('*,marks(id,kind,photos(drive_url,deleted_at,expires_at))').gte('work_date',from).lte('work_date',to).order('entry_at',{ascending:false}).order('id').range(offset,offset+499));
    out.journeys.push(...rows); if(rows.length<500)break;
   }
   out.audit=checked(await db.from('audit').select('*').order('at',{ascending:false}).limit(100));
   return reply(out);
  }
  if(action==='photo') {
   if(!uuid(p.id)) throw new Error('Foto inválida');
   const photo=checked(await db.from('photos').select('*').eq('id',p.id).single());
   if(photo.deleted_at||new Date(photo.expires_at)<=new Date()) throw new Error('Foto eliminada por retención');
   if(photo.drive_url) return reply({url:photo.drive_url});
   if(!photo.storage_path) throw new Error('Foto no disponible');
   return reply({url:checked(await db.storage.from('attendance').createSignedUrl(photo.storage_path,60)).signedUrl});
  }
  if(action==='create_user') {
   if(user.role!=='ADMIN') return reply({error:'Solo administrador principal'},403);
   if(!['WORKER','SUBADMIN'].includes(p.role)||typeof p.name!=='string'||p.name.trim().length<2) throw new Error('Datos de usuario inválidos');
   if(typeof p.password!=='string'||p.password.length<12) throw new Error('Usa una contraseña de al menos 12 caracteres');
   const code=String(p.code||'').toUpperCase();
   if(p.role==='WORKER'&&!/^[A-Z0-9-]{3,20}$/.test(code)) throw new Error('Código: 3 a 20 letras, números o guiones');
   const email=p.role==='WORKER'?`${code.toLowerCase()}@workers.fullconta.invalid`:p.email;
   const created=checked(await db.auth.admin.createUser({email,password:p.password,email_confirm:true}));
   try { await command('profile',{id:created.user.id,name:p.name,code:p.role==='WORKER'?code:null,role:p.role}); }
   catch(e) { await db.auth.admin.deleteUser(created.user.id); throw e; }
   return reply({ok:true,code,email});
  }
  if(['schedule','delete_schedule','center','weekends'].includes(action)) return reply(await command(action,p));
  return reply({error:'Acción desconocida'},400);
 } catch(e) { return reply({error:e.message||'No se pudo completar la operación'},400); }
});
