export const limaDate = (value=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
export const time = value => value ? new Intl.DateTimeFormat('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)) : '';
export const hours = row => row.exit_at ? Math.round((new Date(row.exit_at)-new Date(row.entry_at))/36000)/100 : null;
export function photoLabel(photo,now=new Date()) { if(!photo) return 'Sin foto'; if(photo.deleted_at||new Date(photo.expires_at)<=now)return 'Foto eliminada por retención';return photo.drive_url||'Pendiente de transferencia a Drive'; }
export function reportRows(rows,centers,company) { return rows.map(r=>{
 const photo=kind=>r.marks?.find(m=>m.kind===kind)?.photos;
 const entry=Array.isArray(photo('ENTRY'))?photo('ENTRY')[0]:photo('ENTRY');
 const exit=Array.isArray(photo('EXIT'))?photo('EXIT')[0]:photo('EXIT');
 return {Empresa:company,Centro:centers.find(c=>c.id===r.center_id)?.name||'',Fecha:r.work_date,Código:r.worker_code,Trabajador:r.worker_name,Turno:r.shift,'Ingreso programado':r.scheduled_start,'Salida programada':r.scheduled_end,Ingreso:time(r.entry_at),Salida:time(r.exit_at),'Horas trabajadas':hours(r),'Estado':r.exit_at?'Completo':'Sin salida','Dispositivo ingreso':r.entry_device,'Dispositivo salida':r.exit_device||'','Navegador ingreso':r.entry_agent,'Navegador salida':r.exit_agent||'','Foto ingreso':photoLabel(entry),'Foto salida':photoLabel(exit)};
 }); }
