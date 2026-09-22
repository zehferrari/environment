import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function main() {
 const dir=mkdtempSync(path.join(tmpdir(),'wdt-config-'));
 Object.assign(process.env,{DATABASE_URL:`file:${dir}/test.db`,AUTH_SECRET:'test',PM_ASYNC_DISPATCH:'1',PM_ASYNC_DISPATCH_INLINE_NUDGE:'0',PM_AGENT_CONFIG_ROOT:`${dir}/agents`});
 for(const slug of ['manager','worker']) {mkdirSync(`${dir}/agents/${slug}`,{recursive:true});writeFileSync(`${dir}/agents/${slug}/openclaw.json`,JSON.stringify({agents:{defaults:{model:{primary:'openai/test'}}}}));}
 await promisify(execFile)('pnpm',['prisma','migrate','deploy'],{env:process.env});
 const {db}=await import('@/lib/db');
 try {
  const {submitWorkflowCommand}=await import('@/lib/tasks/orchestrator');
  const {recoverGitIdentityBlockers,recoverGitIdentityBlockers:recover}=await import('@/lib/tasks/git-identity-recovery');
  const {resumeGitIdentityProcedures:resume}=await import('@/lib/tasks/orchestrator/procedure-runner');
  const {GIT_IDENTITY_ERROR,isGitIdentityBlocker}=await import('@/lib/tasks/git-identity');
  const {resolveGitIdentity}=await import('@/lib/settings/system');
  const {classifyBlockerFailure}=await import('@/lib/tasks/formal-blocker');
  const {ensureTaskCodeWorktree}=await import('@/lib/tasks/worktree-claim');
  const owner=await db.user.create({data:{username:'owner',email:'owner@test.invalid',kind:'human',isOwner:true}});
  const agentUser=async(slug:string)=>{const agent=await db.agent.create({data:{slug,name:slug,role:'coding'}});return db.user.create({data:{username:slug,email:`${slug}@test.invalid`,kind:'agent',agentId:agent.id}});};
  const manager=await agentUser('manager'),worker=await agentUser('worker');
  const project=await db.project.create({data:{name:'WDT config',slug:'wdt-config',repositoryPath:'/does-not-exist',workMode:'repository'}});
  const task=await db.task.create({data:{title:'Configured task',projectId:project.id,status:'To Do',reporterId:owner.id,assigneeId:worker.id,approvedOn:new Date(),branchName:'wdt-test'}});
  const actor={id:worker.id,kind:'agent' as const,username:worker.username,role:'assignee' as const,codingCapability:true};
  for(let i=0;i<3;i++) {
   const result=await submitWorkflowCommand({taskId:task.id,intent:'start_implementation',actor,expectedWorkflowVersion:task.workflowVersion,workflowCycleId:null,idempotencyKey:`start-${i}`,source:'agent_tool',payload:{}});
   assert.equal('domainCode' in result&&result.domainCode,'git_identity_incomplete',JSON.stringify(result));
  }
  await assert.rejects(ensureTaskCodeWorktree(task.id),/git_identity_incomplete/);
  assert.equal(await db.taskProcedureRun.count(),0);assert.equal(await db.workflowOutbox.count(),0);
  const cycle=await db.taskWorkflowCycle.create({data:{taskId:task.id,sequence:1,openedWorkflowVersion:task.workflowVersion,status:'implementing',workflowEngine:'orchestrator_v2'}});
  await db.task.update({where:{id:task.id},data:{status:'In Progress',activeWorkflowCycleId:cycle.id}});
  for(let i=0;i<3;i++) {
   const result=await submitWorkflowCommand({taskId:task.id,intent:'submit_for_review',actor,expectedWorkflowVersion:task.workflowVersion,workflowCycleId:cycle.id,idempotencyKey:`review-${i}`,source:'agent_tool',payload:{candidateSha:null,baseSha:null,comment:'Ready',repoTouched:true}});
   assert.equal('domainCode' in result&&result.domainCode,'git_identity_incomplete',JSON.stringify(result));
  }
  assert.equal(await db.taskProcedureRun.count(),0);
  console.log('PASS repeated start/submission refusals enqueue no repository work');
  const report={blockedOn:'external_service' as const,requestedActor:'owner',requestedAction:'Set PM defaultGitUserName and defaultGitUserEmail',evidence:GIT_IDENTITY_ERROR,diagnosticsAttempted:['Read PM identity resolver source','Queried PM settings: name and email are null'],resumeCondition:'PM effective Git identity complete',reporterCanResolve:true};
  assert.equal(classifyBlockerFailure(report,{assigneeIdentifiers:['worker']}).outcome,'accept');
  assert.equal(isGitIdentityBlocker({...report,evidence:'Browser navigation blocked by policy'}),false);
  await db.task.update({where:{id:task.id},data:{alertReporter:true}});
  await db.activityLog.create({data:{projectId:project.id,taskId:task.id,kind:'task.blocker',payload:JSON.stringify({commentId:'blocker-1',blockerReport:report})}});
  assert.equal(await recover(),0);
  const workspace=await db.workspace.create({data:{name:'Workspace',slug:'workspace',defaultGitUserName:'Workspace Author'}});
  await db.workspaceProject.create({data:{workspaceId:workspace.id,projectId:project.id}});
  assert.equal(await recover(),0,'partial identity cannot recover');
  await db.systemSettings.create({data:{id:'system',defaultGitUserEmail:'author@test.invalid'}});
  assert.deepEqual(await resolveGitIdentity(project),{name:'Workspace Author',email:'author@test.invalid'});
  assert.equal(await recover(),1);assert.equal(await recover(),0);assert.equal(await db.workflowOutbox.count(),1);
  assert.equal((await db.task.findUniqueOrThrow({where:{id:task.id}})).alertReporter,true,'worker must verify/clear blocker');
  await db.activityLog.create({data:{projectId:project.id,taskId:task.id,kind:'task.blocker',payload:JSON.stringify({commentId:'browser-blocker',blockerReport:{...report,evidence:'Browser navigation blocked by policy'}})}});
  assert.equal(await recoverGitIdentityBlockers(),0,'newer unrelated blocker must remain untouched');
  console.log('PASS inherited repair, one durable wake, and unrelated blocker isolation');
  const procedure=await db.taskProcedureRun.create({data:{taskId:task.id,workflowCycleId:cycle.id,triggerTransitionId:'test',type:'submit_candidate_for_review',status:'operational_error'}});
  const step=await db.taskProcedureStep.create({data:{procedureRunId:procedure.id,name:'run_validation',ordinal:2,status:'terminal_error',lastError:GIT_IDENTITY_ERROR,attempts:1}});
  assert.equal(await resume(),0,'unrelated blocker must prevent procedure recovery');
  await db.activityLog.create({data:{projectId:project.id,taskId:task.id,kind:'task.blocker.cleared',payload:'{}'}});
  assert.equal(await resume(),1);assert.equal(await resume(),0);
  assert.equal((await db.taskProcedureStep.findUniqueOrThrow({where:{id:step.id}})).status,'pending');
  await db.taskProcedureRun.update({where:{id:procedure.id},data:{status:'operational_error'}});
  await db.taskProcedureStep.update({where:{id:step.id},data:{status:'terminal_error',lastError:GIT_IDENTITY_ERROR}});
  await db.task.update({where:{id:task.id},data:{activeWorkflowCycleId:null}});
  assert.equal(await resume(),0,'old cycle must never resume');
  console.log('PASS configuration procedure recovery rejects stale cycles');
  const epic=await db.epic.create({data:{projectId:project.id,title:'Approved Epic',actingManagerId:manager.id,reporterId:owner.id}});
  const {sendEpicWorkflowNotification}=await import('@/lib/agents/workflow/notifications/epic');
  const notified=await sendEpicWorkflowNotification({epicId:epic.id,targetAgentSlug:'manager',actor:{id:owner.id,kind:'human'},reason:'action_plan_approved',body:'PM assigned @worker. @manager coordinate the queue.'});
  assert.equal(notified.ok,true);
  const runs=await db.pmChannelRun.findMany({where:{epicId:epic.id},select:{id:true,agentSlug:true}});
  assert.deepEqual(runs.map(run=>run.agentSlug),['manager']);
  const job=await db.pmChannelJob.findUniqueOrThrow({where:{runId:runs[0].id}});
  assert.match(JSON.parse(job.payload).systemPrompt,/create_tasks/,'manager retains task creation capability');
  assert.ok(!readFileSync('app/(app)/projects/[slug]/epics/[epicId]/page.tsx','utf8').includes('sendAgentChatMessage'));
  console.log('PASS manager-only approval despite worker mentions');
 } finally {await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
