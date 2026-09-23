import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import TaskChecklist from '@/components/task-checklist';
import ToastProvider from '@/components/toast';
const finding = (id, round, date, title, status='open') => ({id, reviewRunId:round, requestedAt:date, subTaskId:status==='superseded'?null:id, title, status, acceptanceCriteria:'Verify this candidate with the regression check.', scopeReference:'Approved checkout requirements', candidateSha:'abc123456789', completionEvidence:status==='resolved'?'Regression passed':null, supersededReason:status==='superseded'?'Owner changed the requirement':null});
// Deliberately shuffled round/rank order. Superseded history has no checklist row.
const findings = [finding('b','round-2','2026-09-23T03:00:00Z','Reconcile paid totals'), finding('c','round-3','2026-09-23T04:00:00Z','Obsolete date check','superseded'),finding('a','round-1','2026-09-23T02:00:00Z','Reconcile paid totals'),finding('d','round-1','2026-09-23T02:00:00Z','Verify supported cards','resolved')];
const initial = [
 {id:'initial',text:'Original requirement',completedAt:'2026-09-23T01:00:00Z',kind:'implementation'},
 {id:'b',text:'Correction 7: Reconcile paid totals',completedAt:null,kind:'implementation'},
 {id:'a',text:'Correction 1: Reconcile paid totals',completedAt:null,kind:'implementation'},
 {id:'d',text:'Correction 2: Verify supported cards',completedAt:'2026-09-23T02:30:00Z',kind:'implementation'},
 {id:'review',text:'Final owner acceptance',completedAt:null,kind:'review'},
].map(item=>({...item,minutesSpent:null,reviewFinding:findings.find(f=>f.id===item.id) ?? null}));
function App(){
 const [items,setItems]=useState(initial);
 const [currentFindings,setFindings]=useState(findings);
 window.received ??= [];
 const toggle=async fd=>{const data=Object.fromEntries(fd);window.received.push(data);setItems(rows=>rows.map(row=>row.id===data.subTaskId?{...row,completedAt:data.completed==='1'?new Date().toISOString():null}:row));setFindings(rows=>rows.map(row=>row.subTaskId===data.subTaskId?{...row,status:'resolved',completionEvidence:data.completionEvidence}:row));};
 return <ToastProvider><TaskChecklist taskId="task" projectSlug="test" taskStatus="In Progress" items={items} findings={currentFindings} addAction={async()=>{}} removeAction={async()=>{}} toggleAction={toggle} reorderAction={async ids=>{window.lastOrder=ids;setItems(rows=>ids.map(id=>rows.find(row=>row.id===id)));}}/></ToastProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
