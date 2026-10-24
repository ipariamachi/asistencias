/** FULLCONTA: instalar como Apps Script independiente bajo la cuenta dueña de Drive.
 * Propiedades del script: SUPABASE_URL, SUPABASE_SERVICE_KEY, DRIVE_ROOT_ID.
 * Nunca copiar la clave de servicio al HTML ni a GitHub.
 */
function cfg_(){var p=PropertiesService.getScriptProperties();var c={url:p.getProperty('SUPABASE_URL'),key:p.getProperty('SUPABASE_SERVICE_KEY'),root:p.getProperty('DRIVE_ROOT_ID')};if(!c.url||!c.key||!c.root)throw new Error('Faltan propiedades del script');return c;}
function fetch_(path,method,body){var c=cfg_();var headers={apikey:c.key};if(c.key.indexOf('eyJ')===0)headers.Authorization='Bearer '+c.key;var options={method:method||'get',headers:headers,muteHttpExceptions:true};if(body!==undefined){options.contentType='application/json';options.payload=JSON.stringify(body);}var r=UrlFetchApp.fetch(c.url+path,options);if(r.getResponseCode()<200||r.getResponseCode()>=300)throw new Error('Supabase HTTP '+r.getResponseCode()+': '+r.getContentText().slice(0,200));return r;}
function json_(path,method,body){var text=fetch_(path,method,body).getContentText();return text?JSON.parse(text):null;}
function patch_(table,id,body){json_('/rest/v1/'+table+'?id=eq.'+encodeURIComponent(id),'patch',body);}
function root_(){return DriveApp.getFolderById(cfg_().root);}
function belongs_(folder){var parents=folder.getParents();while(parents.hasNext())if(parents.next().getId()===cfg_().root)return true;return false;}
function folder_(center){if(center.drive_folder){var existing=DriveApp.getFolderById(center.drive_folder);if(!belongs_(existing))throw new Error('Carpeta fuera de la raíz autorizada');return existing;}var root=root_(),found=root.getFoldersByName(center.name);var folder=found.hasNext()?found.next():root.createFolder(center.name);patch_('centers',center.id,{drive_folder:folder.getId()});center.drive_folder=folder.getId();return folder;}

function instalarAutomatizacion(){
 cfg_();root_();
 ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='sincronizarYLimpiar')ScriptApp.deleteTrigger(t);});
 ScriptApp.newTrigger('sincronizarYLimpiar').timeBased().everyHours(1).create();
 sincronizarYLimpiar();
}

function sincronizarYLimpiar(){
 var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
 var deadline=Date.now()+240000;
 try{
  var centers=json_('/rest/v1/centers?select=*');var map={};
  centers.forEach(function(c){map[c.id]=folder_(c);});
  var now=new Date().toISOString();
  // Borrado definitivo: únicamente archivos identificados en la base y dentro de nuestras subcarpetas.
  var expired=json_('/rest/v1/photos?deleted_at=is.null&expires_at=lte.'+encodeURIComponent(now)+'&order=expires_at.asc&limit=100');
  for(var p of expired){
   if(Date.now()>deadline)return;
   if(p.drive_file)deleteDrive_(p.drive_file,map[p.center_id].getId());
   if(p.storage_path)removeStorage_(p.storage_path);
   patch_('photos',p.id,{drive_file:null,drive_url:null,storage_path:null,deleted_at:new Date().toISOString()});
  }
  var pending=json_('/rest/v1/photos?deleted_at=is.null&storage_path=not.is.null&expires_at=gt.'+encodeURIComponent(now)+'&order=created_at.asc&limit=100');
  for(var p of pending){
   if(Date.now()>deadline)return;
   if(!p.drive_file){
    var folder=map[p.center_id],filename=p.id+'.jpg',files=folder.getFilesByName(filename);
    var file=files.hasNext()?files.next():folder.createFile(fetch_('/storage/v1/object/attendance/'+p.storage_path).getBlob().setName(filename));
    patch_('photos',p.id,{drive_file:file.getId(),drive_url:file.getUrl()});
   }
   removeStorage_(p.storage_path);
   patch_('photos',p.id,{storage_path:null});
  }
  removeOrphans_(deadline);
  if(Date.now()>deadline)return;
  json_('/rest/v1/rpc/attendance_retention','post',{});
 }finally{lock.releaseLock();}
}

function removeStorage_(path){json_('/storage/v1/object/attendance','delete',{prefixes:[path]});}
function deleteDrive_(id,expectedParent){
 var base='https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id);
 var options={headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
 var meta=UrlFetchApp.fetch(base+'?fields=id,parents',options);
 if(meta.getResponseCode()===404)return;
 if(meta.getResponseCode()!==200)throw new Error('No se pudo verificar la foto Drive');
 var parents=JSON.parse(meta.getContentText()).parents||[];
 if(parents.indexOf(expectedParent)<0)throw new Error('Foto fuera de carpeta autorizada: no se borra');
 options.method='delete';var r=UrlFetchApp.fetch(base,options);
 if(r.getResponseCode()!==204&&r.getResponseCode()!==404)throw new Error('No se pudo borrar definitivamente la foto');
}

function removeOrphans_(deadline){
 var roots=json_('/storage/v1/object/list/attendance','post',{prefix:'',limit:100,offset:0});
 for(var folder of roots){
  if(Date.now()>deadline)return;
  if(folder.id)continue;
  var offset=0;
  while(true){
   var files=json_('/storage/v1/object/list/attendance','post',{prefix:folder.name,limit:100,offset:offset,sortBy:{column:'name',order:'asc'}});
   for(var file of files){
    if(Date.now()>deadline)return;
    if(!file.id||Date.now()-new Date(file.created_at).getTime()<86400000)continue;
    var path=folder.name+'/'+file.name;
    var found=json_('/rest/v1/photos?select=id&storage_path=eq.'+encodeURIComponent(path));
    if(!found.length)removeStorage_(path);
   }
   if(files.length<100)break;
   offset+=100;
  }
 }
}
