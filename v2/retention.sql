-- La tarea de Google llama esta función después de borrar físicamente las fotos vencidas.
create function public.attendance_retention() returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 delete from journeys j where j.entry_at < now()-interval '4 months'
 and not exists(select 1 from marks m join photos p on p.id=m.id where m.journey_id=j.id and (p.deleted_at is null or p.storage_path is not null or p.drive_file is not null));
 delete from audit where at < now()-interval '4 months';
 update settings set maintenance_at=now();
end $$;
revoke all on function public.attendance_retention() from public,anon,authenticated;
grant execute on function public.attendance_retention() to service_role;
