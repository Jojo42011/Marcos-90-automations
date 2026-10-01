import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
const root=mkdtempSync(join(tmpdir(),'task-owner-recovery-'));
process.env.TENANT_DATA_ROOT=root;process.env.ACCOUNT_ISOLATION='true';
const require=createRequire(import.meta.url), tasks=require('../dist/src/core/sharedTasks.js');
const original={id:'retired-task',title:'Original task',assignedTo:'former-member',createdBy:'marco',column:'today',status:'done',checklist:[{id:'step',text:'Original step',done:true}],createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'};
const source=JSON.stringify({commandTasks:[original]});writeFileSync(join(root,'db.json'),source);
// Exercise the deployed upgrade path, where recovery already imported the row.
tasks.sharedTaskCreate(original);tasks.recoverSharedTasks();
const restored=tasks.sharedTaskList();assert.equal(restored.length,1);assert.equal(restored[0].assignedTo,'carlos');assert.equal(restored[0].createdBy,'marco');assert.equal(restored[0].status,'done');assert.equal(restored[0].checklist[0].done,true);assert.equal(restored[0].updatedAt,original.updatedAt);
assert.equal(tasks.recoverSharedTasks().reassigned,0);assert.equal(tasks.sharedTaskList().length,1);
tasks.sharedTaskDelete(original.id);tasks.recoverSharedTasks();assert.equal(tasks.sharedTaskList().length,0);
assert.equal(readFileSync(join(root,'db.json'),'utf8'),source);
console.log('Retired/unassigned tasks move to Carlos once, preserving completion, checklist, timestamps, source data and explicit deletion.');
