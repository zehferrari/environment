import { runRouteHandler } from './lib/next-route-harness';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function main() {
 const dir=mkdtempSync(path.join(tmpdir(),'wdt-planning-'));
 Object.assign(process.env,{DATABASE_URL:`file:${dir}/test.db`,AUTH_SECRET:'wdt-test',PM_TASK_RUNTIME_V2:'1',PM_ASYNC_DISPATCH:'1',PM_ASYNC_DISPATCH_INLINE_NUDGE:'0',PM_AGENT_CONFIG_ROOT:`${dir}/agents`});
 for(const slug of ['worker','reviewer']) { mkdirSync(`${dir}/agents/${slug}`,{recursive:true});writeFileSync(`${dir}/agents/${slug}/openclaw.json`,JSON.stringify({agents:{defaults:{model:{primary:'openai/test'}}}})); }
 await promisify(execFile)('pnpm',['prisma','migrate','deploy'],{env:process.env});
 const {db}=await import('@/lib/db');
 try {
  const {sendTaskWorkflowNotification}=await import('@/lib/agents/workflow/notifications/task');
  const {persistTaskReply}=await import('@/lib/agents/pm-channel/persist-task-reply');
  const {submitWorkflowCommand}=await import('@/lib/tasks/orchestrator');
  const {POST}=await import('@/app/api/agent/tasks/[taskId]/workflow/route');
  const {NextRequest}=await import('next/server');
  const owner=await db.user.create({data:{username:'owner',email:'owner@wdt.invalid',kind:'human',isOwner:true}});
  const project=await db.project.create({data:{name:'WDT fixture',slug:'wdt-test',onlyReportersCanApproveActionPlans:true}});
  const makeAgent=async(slug:string)=>{const agent=await db.agent.create({data:{slug,name:slug,role:'coding'}});return db.user.create({data:{username:slug,email:`${slug}@wdt.invalid`,kind:'agent',agentId:agent.id}});};
  const worker=await makeAgent('worker'), reviewer=await makeAgent('reviewer');
  const task=await db.task.create({data:{title:'PDF from available logs',projectId:project.id,reporterId:owner.id,actingManagerId:reviewer.id,assigneeId:worker.id,reviewAttachmentRequired:true}});
  const actor={id:owner.id,kind:'human' as const,username:owner.username};let serial=0;
  const notify=async(who:typeof worker,reason:'backlog_plan_requested'|'action_plan_review_requested')=>{
   const key=`wdt-${++serial}`;await sendTaskWorkflowNotification({taskId:task.id,targetUserId:who.id,actor,reason,body:'Perform current decision.',dedupeKey:key});
   const m=await db.agentChatMessage.findUniqueOrThrow({where:{workflowDedupeKey:key}});
   const run=await db.pmChannelRun.findFirstOrThrow({where:{messageId:m.id}});
   const job=await db.pmChannelJob.findUniqueOrThrow({where:{runId:run.id}});const payload=JSON.parse(job.payload);
   assert.ok(payload.taskRuntime,'PDF task must use compact runtime');assert.ok(payload.systemPrompt.length<12000);
   await db.pmChannelRun.update({where:{id:run.id},data:{status:'admitted'}});return {payload,run,job};
  };
  const post=async(turn:Awaited<ReturnType<typeof notify>>,action:string,body:Record<string,unknown>={})=>{
   const r=await runRouteHandler(()=>POST(new NextRequest(`http://localhost/api/agent/tasks/${task.id}/workflow`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,action,messageId:turn.payload.taskRuntime.messageId,token:turn.payload.taskRuntime.token})}),{params:Promise.resolve({taskId:task.id})}));return {status:r.status,body:await r.json()};
  };
  const plan={summary:'Short PDF, coverage limitations and hosting recommendation.',steps:[{id:'report',title:'Produce report',kind:'sequential',acceptanceCriteria:['Use available logs and attach PDF']}]};
  const first=await notify(worker,'backlog_plan_requested');let result=await post(first,'submit_plan',{actionPlan:plan});assert.equal(result.status,202,JSON.stringify(result));
  const review=await notify(reviewer,'action_plan_review_requested');assert.ok(review.payload.taskRuntime.actions.includes('accept_plan_review'));assert.ok(!review.payload.taskRuntime.actions.includes('approve_plan'));
  for(const text of ['Acceptable; no revisions needed.','Approval failed: not_authorized_for_plan. Do not resubmit.']) {const n=await db.agentChatMessage.count({where:{taskId:task.id}});await runRouteHandler(()=>persistTaskReply(review.payload.replyTarget,text));assert.equal(await db.agentChatMessage.count({where:{taskId:task.id}}),n+1,'prose must not wake implementer');}
  assert.equal((await post(review,'approve_plan')).status,403);
  result=await post(review,'accept_plan_review');assert.equal(result.status,202,JSON.stringify(result));
  let stored=await db.actionPlan.findUniqueOrThrow({where:{taskId:task.id}});assert.equal(stored.reviewedById,reviewer.id);assert.equal(stored.approvedOn,null);
  const same=await notify(worker,'backlog_plan_requested');result=await post(same,'submit_plan',{actionPlan:plan});assert.equal(result.status,202,JSON.stringify(result));
  stored=await db.actionPlan.findUniqueOrThrow({where:{taskId:task.id}});assert.equal(stored.version,1);assert.equal(stored.reviewedById,reviewer.id);
  const delegate=(who:typeof actor)=>submitWorkflowCommand({taskId:task.id,intent:'delegate_plan_approval',actor:who,source:'browser',expectedWorkflowVersion:0,workflowCycleId:null,idempotencyKey:`delegate-${who.id}`,payload:{actionPlanId:stored.id,actionPlanVersion:1}});
  const other=await db.user.create({data:{username:'other',email:'other@wdt.invalid',kind:'human'}});const refused=await delegate({...actor,id:other.id,username:other.username});assert.ok(!['accepted','replayed'].includes(refused.status));
  const delegation=await delegate(actor);assert.equal(delegation.status,'accepted',JSON.stringify(delegation));assert.equal((await delegate(actor)).status,'replayed');
  const delegatedTurn=await notify(reviewer,'action_plan_review_requested');assert.ok(delegatedTurn.payload.taskRuntime.actions.includes('approve_plan'));
  // Changing the revision revokes delegation and acceptance.
  const revision=await notify(worker,'backlog_plan_requested');result=await post(revision,'submit_plan',{actionPlan:{...plan,summary:plan.summary+' Include timezone.'}});assert.equal(result.status,202,JSON.stringify(result));
  stored=await db.actionPlan.findUniqueOrThrow({where:{taskId:task.id}});assert.equal(stored.version,2);assert.equal(stored.delegatedApproverId,null);assert.equal(stored.reviewedAt,null);
  result=await post(delegatedTurn,'approve_plan',{actionPlanId:stored.id,actionPlanVersion:1});assert.notEqual(result.status,202);
  const current=await db.task.findUniqueOrThrow({where:{id:task.id}});
  const redelegated=await submitWorkflowCommand({taskId:task.id,intent:'delegate_plan_approval',actor,source:'browser',expectedWorkflowVersion:current.workflowVersion,workflowCycleId:null,idempotencyKey:'delegate-revision-2',payload:{actionPlanId:stored.id,actionPlanVersion:2}});
  assert.equal(redelegated.status,'accepted',JSON.stringify(redelegated));
  const finalReview=await notify(reviewer,'action_plan_review_requested');
  result=await post(finalReview,'approve_plan',{actionPlanId:stored.id,actionPlanVersion:2});assert.equal(result.status,202,JSON.stringify(result));
  const approvalReplay=await post(finalReview,'approve_plan',{actionPlanId:stored.id,actionPlanVersion:2});assert.equal(approvalReplay.status,200,JSON.stringify(approvalReplay));
  assert.equal((await db.task.findUniqueOrThrow({where:{id:task.id}})).status,'To Do');
  const {applyPmChannelStreamCallback}=await import('@/lib/agents/pm-channel/stream-callback');
  const late=await applyPmChannelStreamCallback({payload:{version:1,target:finalReview.payload.replyTarget,event:'error',error:'Agent finished without posting a reply.'},transportMode:'http',rateLimit:false});
  assert.equal(late.status,200,JSON.stringify(late));
  assert.equal((await db.pmChannelRun.findUniqueOrThrow({where:{id:finalReview.run.id}})).status,'completed');
  assert.equal((await db.pmChannelStreamEvent.findFirstOrThrow({where:{runId:finalReview.run.id},orderBy:{seq:'desc'}})).kind,'done','a committed action must not show a failed turn in the UI');

  console.log('PASS attachment context, review prose, explicit acceptance, permission denial, revision delegation, replay and approval');
  const {loadWatchdogSnapshot}=await import('@/lib/agents/watchdog/run');const {detectWatchdogFindings,healthyExecutionState}=await import('@/lib/agents/watchdog/detectors');
  const failedTask=await db.task.create({data:{title:'Failed Backlog review',projectId:project.id,status:'Backlog',statusChangedAt:new Date(0)}});
  await db.pmChannelRun.create({data:{id:'failed-review',targetKey:'failed-review',kind:'task-chat',agentSlug:'reviewer',messageId:'failed-msg',taskId:failedTask.id,status:'failed',createdAt:new Date(Date.now()-3600000)}});
  const snapshot=await loadWatchdogSnapshot({projectId:project.id});assert.ok(detectWatchdogFindings(snapshot).some(f=>f.taskId===failedTask.id&&f.detectorId==='stalled_plan_review'));
  const record=snapshot.tasks.find(t=>t.id===failedTask.id)!;record.planReviewAccepted=true;assert.ok(!detectWatchdogFindings(snapshot).some(f=>f.taskId===failedTask.id&&f.detectorId==='stalled_plan_review'));assert.equal(healthyExecutionState(record,snapshot).reasonCode,'awaiting_plan_approval');
  console.log('PASS Backlog handoff failure and human-wait distinction');
  const {reserveExecutionLane}=await import('@/lib/agents/pm-channel/execution-lane');const {claimNextPmChannelJob,runPmChannelJob}=await import('@/lib/agents/pm-channel/jobs');
  await db.pmChannelJob.updateMany({data:{status:'complete'}});
  await db.pmChannelRun.updateMany({data:{status:'completed'}});
  await db.pmChannelRun.create({data:{id:'occupied',targetKey:'occupied',kind:'task-chat',agentSlug:'worker',messageId:'occupied-msg',taskId:failedTask.id,status:'admitted',admittedAt:new Date()}});
  assert.equal((await reserveExecutionLane({agentSlug:'worker',runId:'occupied',taskId:failedTask.id})).acquired,true);
  await db.agentChatMessage.create({data:{id:'capacity-msg',taskId:task.id,projectId:project.id,agentSlug:'worker',senderUserId:owner.id,body:'Resume'}});
  const {pmChannelRunTargetKey}=await import('@/lib/agents/pm-channel/bus');
  const payload={...first.payload,replyTarget:{...first.payload.replyTarget,messageId:'capacity-msg'}};
  await db.pmChannelRun.create({data:{id:'capacity',targetKey:pmChannelRunTargetKey(payload.replyTarget),kind:'task-chat',agentSlug:'worker',messageId:'capacity-msg',taskId:task.id,status:'queued'}});
  const capacity=await db.pmChannelJob.create({data:{runId:'capacity',agentSlug:'worker',kind:'task-chat',payload:JSON.stringify(payload),status:'queued',availableAt:new Date(0)}});
  for(let i=0;i<5;i++){await db.pmChannelJob.update({where:{id:capacity.id},data:{availableAt:new Date(0)}});const job=await claimNextPmChannelJob('test');assert.ok(job);assert.equal(job.id,capacity.id,JSON.stringify({id:job.id,runId:job.runId,capacity:capacity.id}));await runPmChannelJob(job);const s=await db.pmChannelJob.findUniqueOrThrow({where:{id:job.id}});assert.equal(s.status,'retryable',s.lastError??'');assert.equal(s.attemptCount,0);assert.equal(s.claimedAt,null);}
  console.log('PASS repeated capacity waits preserve retry budget and release claims');
  const {retryOrFailPmChannelJobForTurnFailure}=await import('@/lib/agents/pm-channel/jobs');
  for(const attemptCount of [1,4]) {
    await db.pmChannelRun.update({where:{id:'capacity'},data:{status:'admitted',settledByAction:null}});
    await db.pmChannelJob.update({where:{id:capacity.id},data:{status:'accepted',attemptCount}});
    const transaction=db.$transaction;
    // Deterministically commit the terminal action after the failure handler's
    // initial reads but before it opens its retry/exhaustion transaction.
    db.$transaction=(async(operation:unknown,options:unknown)=>{
      await db.pmChannelRun.update({where:{id:'capacity'},data:{status:'completed',settledByAction:'approve_plan'}});
      await db.pmChannelJob.update({where:{id:capacity.id},data:{status:'complete'}});
      return Reflect.apply(transaction,db,[operation,options]);
    }) as typeof db.$transaction;
    try { assert.equal(await retryOrFailPmChannelJobForTurnFailure({targetKey:pmChannelRunTargetKey(payload.replyTarget),error:'Agent finished without posting a reply.'}),'settled'); }
    finally { db.$transaction=transaction; }
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({where:{id:'capacity'}})).status,'completed');
    assert.equal((await db.pmChannelJob.findUniqueOrThrow({where:{id:capacity.id}})).status,'complete');
  }
  console.log('PASS terminal-action race cannot revive or fail a completed approval');
  const {recordPmChannelRunEvent}=await import('@/lib/agents/pm-channel/runs');
  await db.pmChannelRun.update({where:{id:'capacity'},data:{status:'admitted',settledByAction:null}});
  const findUnique=db.pmChannelRun.findUnique;
  db.pmChannelRun.findUnique=(async(args:{select?:{streamingAt?:boolean}})=>{
    const stale=await Reflect.apply(findUnique,db.pmChannelRun,[args]);
    if(args.select?.streamingAt) await db.pmChannelRun.update({where:{id:'capacity'},data:{status:'completed',settledByAction:'approve_plan'}});
    return stale;
  }) as unknown as typeof db.pmChannelRun.findUnique;
  try {await recordPmChannelRunEvent({target:payload.replyTarget,event:'partial'});}
  finally {db.pmChannelRun.findUnique=findUnique;}
  assert.equal((await db.pmChannelRun.findUniqueOrThrow({where:{id:'capacity'}})).status,'completed');
  console.log('PASS late stream frame cannot overwrite a concurrent terminal action');


 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
