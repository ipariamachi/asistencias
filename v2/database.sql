-- Ejecutar una sola vez en un proyecto nuevo. Todas las escrituras pasan por la función de servidor.
create schema if not exists private;
create table public.settings (id boolean primary key default true check(id), company text not null default 'FULLCONTA', test_weekends boolean not null default false, drive_root text not null default '14_UBoVDqREAjKifsbcScW_2K3So0Kk8c', maintenance_at timestamptz);
insert into public.settings(id) values(true);
create table public.profiles (id uuid primary key references auth.users(id), name text not null check(length(name) between 2 and 120), code text unique, role text not null check(role in ('ADMIN','SUBADMIN','WORKER')), active boolean not null default true);
create unique index one_admin on public.profiles(role) where role='ADMIN';
create unique index one_subadmin on public.profiles(role) where role='SUBADMIN';
create table public.centers(id uuid primary key default gen_random_uuid(), name text unique not null check(length(name) between 2 and 100), token uuid unique not null default gen_random_uuid(), drive_folder text, active boolean not null default true);
insert into public.centers(name,drive_folder) values
('GRUPO TUMI','1zI8kOgHfePH1age4Xgot8Y1DBqd1gRV5'),('WATTSON','1ICDqjZRwvTwUwZSdj7DYzKLSK6IrTQWT'),('OF. CENTRAL JR CARAZ','1E7sfiIQKuybiJ-lMVK18VZlIzrZhQYIt'),('OF RAIMONDI','1oZz1qHKW-S90S7ddzgu547NcBrrTXQI9');
create table public.schedules(id uuid primary key default gen_random_uuid(), worker_id uuid not null references public.profiles(id), center_id uuid not null references public.centers(id), weekday int not null check(weekday between 1 and 5), shift text not null check(shift in ('MAÑANA','TARDE')), starts time not null, ends time not null, valid_from date not null default current_date, valid_until date, check(ends>starts), check(valid_until is null or valid_until>=valid_from), unique(worker_id,weekday,shift,valid_from));
create index schedules_center on public.schedules(center_id);
create table public.devices(id uuid primary key, worker_id uuid not null references public.profiles(id), marks int not null default 0, updated_at timestamptz not null default now());
create index devices_worker on public.devices(worker_id);
create table public.journeys(id uuid primary key default gen_random_uuid(), worker_id uuid not null references public.profiles(id), center_id uuid not null references public.centers(id), schedule_id uuid references public.schedules(id), work_date date not null, shift text not null, worker_name text not null, worker_code text, scheduled_start time not null, scheduled_end time not null, entry_at timestamptz not null, exit_at timestamptz, entry_device uuid not null, exit_device uuid, entry_agent text, exit_agent text, unique(worker_id,work_date,shift), check(exit_at is null or exit_at>=entry_at));
create index journeys_center_date on public.journeys(center_id,work_date);
create index journeys_schedule on public.journeys(schedule_id);
create table public.marks(id uuid primary key, journey_id uuid not null references public.journeys(id) on delete cascade, worker_id uuid not null references public.profiles(id), kind text not null check(kind in ('ENTRY','EXIT')), at timestamptz not null default now(), unique(journey_id,kind));
create index marks_worker on public.marks(worker_id);
create table public.photos(id uuid primary key references public.marks(id) on delete cascade, center_id uuid not null references public.centers(id), storage_path text, drive_file text, drive_url text, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '2 months', deleted_at timestamptz);
create index photos_center on public.photos(center_id);
create index photos_expiry on public.photos(expires_at) where deleted_at is null;
create table public.audit(id bigint generated always as identity primary key, actor uuid references public.profiles(id), action text not null, detail jsonb not null default '{}', at timestamptz not null default now());
create index audit_actor on public.audit(actor);
create index audit_at on public.audit(at);
create function private.is_admin() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.profiles where id=(select auth.uid()) and active and role in ('ADMIN','SUBADMIN')) $$;
revoke all on function private.is_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;
do $$ declare t text; begin foreach t in array array['settings','profiles','centers','schedules','devices','journeys','marks','photos','audit'] loop
execute format('alter table public.%I enable row level security',t);
execute format('revoke all on public.%I from anon, authenticated',t);
execute format('grant select on public.%I to authenticated',t);
execute format('grant all on public.%I to service_role',t);
execute format('create policy admin_read on public.%I for select to authenticated using ((select private.is_admin()))',t);
end loop; end $$;
create policy own_profile on public.profiles for select to authenticated using(id=(select auth.uid()));
grant usage,select on sequence public.audit_id_seq to service_role;
alter publication supabase_realtime add table public.journeys,public.audit;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('attendance','attendance',false,122880,array['image/jpeg']);

-- Solo service_role puede invocar esta transacción. La función Edge verifica el JWT y fija p_actor.
create function public.attendance_command(p_actor uuid,p_action text,p jsonb) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare u public.profiles; s public.schedules; c public.centers; d public.devices; j public.journeys; result jsonb; local_now timestamp := now() at time zone 'America/Lima'; day date := local_now::date; req uuid; dev uuid; target uuid;
begin
select * into u from profiles where id=p_actor and active;
if not found then raise exception 'Cuenta deshabilitada o sin perfil'; end if;
if p_action='mark' then
 if u.role<>'WORKER' then raise exception 'Solo trabajadores pueden marcar'; end if;
 req:=(p->>'request_id')::uuid; dev:=(p->>'device_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,0));
 select to_jsonb(m) into result from marks m where id=req and worker_id=p_actor;
 if result is not null then return result; end if;
 if extract(isodow from day)>5 and not (select test_weekends from settings) then raise exception 'Sábados y domingos bloqueados'; end if;
 select * into c from centers where token=(p->>'center_token')::uuid and active;
 if not found then raise exception 'QR no válido'; end if;
 select * into s from schedules where worker_id=p_actor and center_id=c.id and weekday=case when extract(isodow from day)>5 then 1 else extract(isodow from day)::int end and shift=p->>'shift' and valid_from<=day and (valid_until is null or valid_until>=day) order by valid_from desc limit 1;
 if not found then raise exception 'No tienes horario asignado para este centro y turno'; end if;
 perform pg_advisory_xact_lock(hashtextextended(dev::text,1));
 select * into d from devices where id=dev;
 if found and d.worker_id<>p_actor and d.marks>=3 and not coalesce((p->>'ack_change')::boolean,false) then
 insert into audit(actor,action,detail) values(p_actor,'INTENTO_CAMBIO_IDENTIDAD',jsonb_build_object('device',dev,'anterior',d.worker_id,'nuevo',p_actor));
 return jsonb_build_object('warning','Cambiar el trabajador de este teléfono puede incumplir las políticas de la empresa. El intento y el cambio se reportan a Administración.','requires_confirmation',true);
 end if;
 if d.worker_id is not null and d.worker_id<>p_actor then insert into audit(actor,action,detail) values(p_actor,'CAMBIO_IDENTIDAD',jsonb_build_object('device',dev,'anterior',d.worker_id,'nuevo',p_actor)); end if;
 select * into j from journeys where worker_id=p_actor and work_date=day and shift=p->>'shift';
 if p->>'kind'='ENTRY' then
  if j.id is not null then raise exception 'Ya existe ingreso para este turno'; end if;
  if exists(select 1 from journeys where worker_id=p_actor and exit_at is null) then raise exception 'Tienes un turno abierto. Solicita revisión al administrador'; end if;
  insert into journeys(worker_id,center_id,schedule_id,work_date,shift,worker_name,worker_code,scheduled_start,scheduled_end,entry_at,entry_device,entry_agent) values(p_actor,c.id,s.id,day,s.shift,u.name,u.code,s.starts,s.ends,now(),dev,left(p->>'agent',300)) returning * into j;
 elsif p->>'kind'='EXIT' then
  if j.id is null or j.exit_at is not null or j.center_id<>c.id then raise exception 'No hay ingreso abierto en este centro y turno'; end if;
  update journeys set exit_at=now(),exit_device=dev,exit_agent=left(p->>'agent',300) where id=j.id returning * into j;
 else raise exception 'Tipo de marcación no válido'; end if;
 insert into marks(id,journey_id,worker_id,kind) values(req,j.id,p_actor,p->>'kind');
 insert into photos(id,center_id,storage_path) values(req,c.id,p_actor::text||'/'||req::text||'.jpg');
 insert into devices(id,worker_id,marks) values(dev,p_actor,1) on conflict(id) do update set worker_id=p_actor,marks=case when devices.worker_id=p_actor then devices.marks+1 else 1 end,updated_at=now();
 return jsonb_build_object('journey',j.id,'at',now(),'kind',p->>'kind');
end if;
if u.role not in ('ADMIN','SUBADMIN') then raise exception 'Acceso administrativo requerido'; end if;
if p_action='schedule' then
 target:=(p->>'worker_id')::uuid;
 if not exists(select 1 from profiles where id=target and role='WORKER' and active) then raise exception 'Trabajador no válido'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target::text,2));
 if exists(select 1 from schedules where worker_id=target and weekday=(p->>'weekday')::int and (valid_until is null or valid_until>=(p->>'valid_from')::date) and (p->>'valid_until' is null or valid_from<=(p->>'valid_until')::date) and (shift=p->>'shift' or (starts<(p->>'ends')::time and ends>(p->>'starts')::time))) then raise exception 'El horario se cruza con una asignación existente. Elimina la anterior primero'; end if;
 insert into schedules(worker_id,center_id,weekday,shift,starts,ends,valid_from,valid_until) values(target,(p->>'center_id')::uuid,(p->>'weekday')::int,p->>'shift',(p->>'starts')::time,(p->>'ends')::time,(p->>'valid_from')::date,(p->>'valid_until')::date);
elsif p_action='delete_schedule' then
 update journeys set schedule_id=null where schedule_id=(p->>'id')::uuid;
 delete from schedules where id=(p->>'id')::uuid;
elsif p_action='center' then
 if u.role<>'ADMIN' then raise exception 'Solo administrador principal'; end if;
 perform pg_advisory_xact_lock(20261024);
 if (select count(*) from centers)>=6 then raise exception 'Máximo seis centros'; end if;
 insert into centers(name) values(trim(p->>'name'));
elsif p_action='profile' then
 if u.role<>'ADMIN' then raise exception 'Solo administrador principal'; end if;
 if p->>'role' not in ('WORKER','SUBADMIN') then raise exception 'Rol inválido'; end if;
 perform pg_advisory_xact_lock(20261025);
 if p->>'role'='WORKER' and (select count(*) from profiles where role='WORKER' and active)>=20 then raise exception 'Máximo 20 trabajadores activos'; end if;
 insert into profiles(id,name,code,role) values((p->>'id')::uuid,trim(p->>'name'),nullif(upper(trim(p->>'code')),''),p->>'role');
elsif p_action='weekends' then
 if u.role<>'ADMIN' then raise exception 'Solo administrador principal'; end if;
 update settings set test_weekends=(p->>'enabled')::boolean;
else raise exception 'Acción no permitida'; end if;
insert into audit(actor,action,detail) values(p_actor,p_action,p-'password');
return jsonb_build_object('ok',true);
end $$;
revoke all on function public.attendance_command(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.attendance_command(uuid,text,jsonb) to service_role;
