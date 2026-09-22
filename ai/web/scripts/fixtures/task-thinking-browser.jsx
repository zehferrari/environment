import React from 'react';
import { createRoot } from 'react-dom/client';
import { TabsProvider, TabsNav, TabPanel } from '@/components/task-tabs';
import TaskThinkingPanel from '@/components/task-thinking-panel';
createRoot(document.getElementById('root')).render(<TabsProvider defaultTab="Description"><TabsNav tabs={['Description','Thinking']}/><TabPanel name="Description"><textarea defaultValue="Unsaved description"/></TabPanel><TabPanel name="Thinking"><TaskThinkingPanel taskId="fixture"/></TabPanel></TabsProvider>);
