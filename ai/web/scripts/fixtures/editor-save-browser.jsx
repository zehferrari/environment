import React, { useState } from 'react';
import DescriptionField from '@/components/description-field.tsx';
import { createRoot } from 'react-dom/client';
import Save from '@/components/work-item-save-form.tsx';
import { hasDirtyEditors } from '@/lib/client/editor-state.ts';
window.isDirty = hasDirtyEditors;
window.refreshes = 0;
function Editor({ kind }) { const id = kind + 'Main-' + kind; const [source, setSource] = useState('original description'); window['refreshDescription' + kind] = setSource; return <section id={kind}><Save formId={id} itemId={kind} kind={kind}/><input form={id} name={kind + 'Id'} value={kind} readOnly/><input form={id} name="projectSlug" value="fixture" readOnly/><input form={id} name="title" defaultValue={kind + ' original'}/><DescriptionField formId={id} rows={3} defaultValue={source} previewHtml={source} readOnlyPreview/><select form={id} name="status" defaultValue="Backlog"><option>Backlog</option><option>To Do</option></select><input form={id} name="statusRevision" type="hidden" value="revision" readOnly/><input form={id} name="assigneeId" type="checkbox" value="one" defaultChecked/><input form={id} name="assigneeId" type="checkbox" value="two" defaultChecked/></section>; }
;
createRoot(document.getElementById('root')).render(<><Editor kind="task"/><Editor kind="epic"/><a href="/elsewhere">Leave</a></>);
