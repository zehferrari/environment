import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { activeChecklistProgress, checklistProgressSelect } from '@/lib/tasks/checklist-progress';

async function main() {
 const root=await mkdtemp(`${tmpdir()}/checklist-groups-`);
 process.env.DATABASE_URL=`file:${root}/test.db`;
 await promisify(execFile)('pnpm',['prisma','migrate','deploy'],{env:process.env});
 const {db}=await import('@/lib/db');
 const {createSubTaskItem,setSubTaskCompletion}=await import('@/lib/tasks/subtasks');
 const {createReviewFindingChecklist}=await import('@/lib/tasks/review-findings');
 try {
  const owner=await db.user.create({data:{username:'owner',email:'owner@example.test',kind:'human',isOwner:true}});
  const project=await db.project.create({data:{slug:'groups',name:'Groups'}});
  const task=await db.task.create({data:{projectId:project.id,title:'Grouped task',status:'In Progress'}});
  for(let i=0;i<7;i++)await createSubTaskItem({taskId:task.id,text:`Initial ${i}`,actorUserId:owner.id,completedAt:new Date()});
  const progress=async()=>activeChecklistProgress(await db.task.findUniqueOrThrow({where:{id:task.id},include:checklistProgressSelect}));
  assert.equal((await progress()).subtaskImplDone,7);assert.equal((await progress()).subtaskImplTotal,7);
  const round1=await db.reviewRun.create({data:{taskId:task.id,candidateSha:'a',repoTouched:false,validationOutcome:'valid',status:'changes_requested',createdAt:new Date('2026-09-21'),reviewedAt:new Date('2026-09-21')}});
  const findings=['Reconcile payment totals','Verify card matrix','Remove temporary symlink'].map(title=>({title,acceptanceCriteria:'Verify against the current candidate.',scopeReference:'Approved requirements'}));
  await db.$transaction(tx=>createReviewFindingChecklist(tx,{taskId:task.id,reviewRunId:round1.id,candidateSha:'a',reviewerId:owner.id,findings}));
  let counts=await progress();assert.equal(counts.subtaskImplTotal,3);assert.equal(counts.subtaskImplDone,0,'initial seven completed requirements do not inflate feedback progress');
  const correction=await db.subTask.findFirstOrThrow({where:{taskId:task.id,groupKey:`feedback:${round1.id}`,text:findings[0].title}});
  await setSubTaskCompletion({subTaskId:correction.id,completed:true,completionEvidence:'Regression passes.',actorUserId:owner.id});
  assert.equal((await progress()).subtaskImplDone,1);
  const repeat=await createSubTaskItem({taskId:task.id,text:findings[0].title,actorUserId:owner.id});
  assert.equal(repeat!.id,correction.id,'same name in same feedback group is idempotent');
  await db.task.update({where:{id:task.id},data:{status:'Review'}});
  const round2=await db.reviewRun.create({data:{taskId:task.id,candidateSha:'b',repoTouched:false,validationOutcome:'valid',createdAt:new Date('2026-09-22')}});
  const oldReview=await createSubTaskItem({taskId:task.id,text:'Verify card matrix',kind:'review',actorUserId:owner.id,completedAt:new Date()});
  assert.equal((await progress()).subtaskReviewTotal,1);assert.equal((await progress()).subtaskReviewDone,1);
  const round3=await db.reviewRun.create({data:{taskId:task.id,candidateSha:'c',repoTouched:false,validationOutcome:'valid',createdAt:new Date('2026-09-23')}});
  assert.equal((await progress()).subtaskReviewTotal,0,'new empty review never shows the earlier completed bar');
  const newReview=await createSubTaskItem({taskId:task.id,text:'Verify card matrix',kind:'review',actorUserId:owner.id});
  assert.notEqual(newReview!.id,oldReview!.id,'same review topic becomes new work in the next review round');
  assert.equal((await progress()).subtaskReviewTotal,1);assert.equal((await progress()).subtaskReviewDone,0);
  await db.$transaction(tx=>createReviewFindingChecklist(tx,{taskId:task.id,reviewRunId:round3.id,candidateSha:'c',reviewerId:owner.id,findings:[findings[0]]}));
  counts=await progress();assert.equal(counts.subtaskImplTotal,1);assert.equal(counts.subtaskImplDone,0,'new feedback remains open even if same title was completed earlier');
  const privateCounts=activeChecklistProgress(await db.task.findUniqueOrThrow({where:{id:task.id},include:checklistProgressSelect}),true);
  assert.ok(Object.values(privateCounts).every(value=>value===0),'customer-safe views still hide agent progress');
  assert.equal(await db.subTask.count({where:{taskId:task.id,groupKey:'initial',completedAt:{not:null}}}),7,'original history retained');
  console.log('PASS active checklist groups: 7 initial → 1/3 feedback, repeated titles, fresh review progress, empty rounds, privacy and retained history');
 } finally {await db.$disconnect();await rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
