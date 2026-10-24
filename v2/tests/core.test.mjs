import test from 'node:test';
import assert from 'node:assert/strict';
import {limaDate,hours,photoLabel,reportRows} from '../core.js';
test('Fecha de Lima conserva el día anterior antes de 05:00 UTC',()=>{assert.equal(limaDate(new Date('2026-10-25T02:00:00Z')),'2026-10-24');});
test('Horas consolidadas y turno incompleto',()=>{assert.equal(hours({entry_at:'2026-10-23T13:00:00Z',exit_at:'2026-10-23T18:30:00Z'}),5.5);assert.equal(hours({entry_at:'2026-10-23T13:00:00Z'}),null);});
test('Foto vencida nunca aparece como enlace utilizable',()=>{assert.equal(photoLabel({expires_at:'2026-08-01T00:00:00Z',drive_url:'https://drive.google.com/file/d/test'},new Date('2026-10-01')),'Foto eliminada por retención');});
test('Una fila por turno conserva ingreso y salida y no inventa dispositivo',()=>{const rows=reportRows([{work_date:'2026-10-23',center_id:'a',worker_name:'Ana',shift:'MAÑANA',entry_at:'2026-10-23T13:00:00Z',exit_at:'2026-10-23T18:00:00Z',entry_device:'uno',exit_device:'dos',marks:[]}],[{id:'a',name:'TUMI'}],'FULLCONTA');assert.equal(rows.length,1);assert.equal(rows[0]['Horas trabajadas'],5);assert.equal(rows[0]['Dispositivo salida'],'dos');assert.equal(rows[0].Centro,'TUMI');});
