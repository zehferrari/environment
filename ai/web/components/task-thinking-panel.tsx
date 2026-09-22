"use client";
import { useEffect, useRef, useState } from 'react';
import { useActiveTab } from '@/components/task-tabs';
import type { ThinkingTool } from '@/lib/tasks/thinking/projection';

type Run = { id: string; agentSlug: string; agentName: string; provider: string | null; model: string | null; status: string; createdAt: string; lastEventAt: string | null; lastAction: string | null; error: string | null;
  thinking: { progress: string; reasoning: string; tools: ThinkingTool[]; role: string; truncated: boolean; updatedAt: string } | null };
const activeStates = new Set(['queued', 'accepted', 'delivered', 'waiting_capacity', 'admitted', 'streaming']);
const labels: Record<string, string> = { queued: 'Queued', accepted: 'Accepted', delivered: 'Delivered', waiting_capacity: 'Waiting for capacity', admitted: 'Working', streaming: 'Working', completed: 'Turn completed', failed: 'Failed', timed_out: 'Timed out', cancelled: 'Cancelled', superseded: 'Replaced' };
const time = (value: string) => new Date(value).toLocaleString();

export default function TaskThinkingPanel({ taskId }: { taskId: string }) {
  const active = useActiveTab() === 'Thinking';
  const [runs, setRuns] = useState<Run[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [agent, setAgent] = useState('all');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [follow, setFollow] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  const historyLoaded = useRef(false);
  const olderAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    setRuns([]); setLoaded(false); setNextCursor(null); historyLoaded.current = false;
    return () => olderAbort.current?.abort();
  }, [taskId]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    async function refresh() {
      if (stopped) return;
      if (!document.hidden) {
        controller = new AbortController();
        try {
          const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/thinking`, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) {
            if (response.status === 401 || response.status === 404) { setRuns([]); stopped = true; }
            throw new Error(response.status === 401 ? 'Sign in to see task activity.' : response.status === 404 ? 'Task activity is not available to this account.' : 'Live updates disconnected. Retrying…');
          }
          const data = await response.json() as { runs: Run[]; nextCursor: string | null };
          if (stopped) return;
          setRuns(old => [...new Map([...old, ...data.runs].map(run => [run.id, run])).values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
          if (!historyLoaded.current) setNextCursor(data.nextCursor);
          setLoaded(true); setError('');
        } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : 'Could not load activity.'); }
      }
      if (!stopped) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [active, taskId]);
  useEffect(() => {
    if (active && follow && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [active, follow, runs, agent]);

  async function loadOlder() {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true); setFollow(false);
    olderAbort.current = new AbortController();
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/thinking?before=${encodeURIComponent(nextCursor)}`, { cache: 'no-store', signal: olderAbort.current.signal });
      if (!response.ok) throw new Error('Could not load earlier runs.');
      const data = await response.json() as { runs: Run[]; nextCursor: string | null };
      historyLoaded.current = true;
      setRuns(old => [...new Map([...data.runs, ...old].map(run => [run.id, run])).values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
      setNextCursor(data.nextCursor); setError('');
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError(e instanceof Error ? e.message : 'Could not load history.'); }
    finally { setLoadingOlder(false); }
  }
  const visible = runs.filter(run => agent === 'all' || run.agentSlug === agent).slice().reverse();
  const agents = [...new Map(runs.map(run => [run.agentSlug, run.agentName])).entries()];
  return <section className="space-y-3" aria-label="Task thinking">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-body font-semibold">Thinking</h2><p className="text-caption text-text-muted">Live progress, tool activity and available reasoning summaries. Completed turns remain here.</p></div>
      <label className="text-caption">Agent <select className="rounded border border-line bg-panel px-2 py-1" value={agent} onChange={e => setAgent(e.target.value)}><option value="all">All agents</option>{agents.map(([slug,name]) => <option key={slug} value={slug}>{name}</option>)}</select></label>
    </div>
    {error ? <p role="alert" className="text-caption text-crit">{error}</p> : null}
    {nextCursor ? <button type="button" className="text-caption underline" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Loading…' : 'Load earlier runs'}</button> : null}
    {!loaded && !error ? <p className="text-caption text-text-muted">Loading activity…</p> : null}
    {loaded && runs.length === 0 ? <p className="text-caption text-text-muted">No agent runs yet. Activity will appear when an agent works on this task.</p> : null}
    <div ref={feed} className="max-h-[65vh] space-y-3 overflow-y-auto rounded border border-line p-3" onScroll={() => { const el = feed.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}>
      {visible.map(run => <details key={run.id} open={activeStates.has(run.status)} className="rounded border border-line bg-panel p-3">
        <summary className="cursor-pointer text-caption"><strong>{run.agentName}</strong> · {labels[run.status] || run.status} · {time(run.createdAt)}{run.thinking?.role ? ` · ${run.thinking.role}` : ''}</summary>
        <div className="mt-3 space-y-3 text-caption">
          <p className="text-text-muted">{run.provider && run.model ? `${run.provider} / ${run.model}` : 'Model telemetry unavailable'} · Run {run.id.slice(0,8)}{run.lastEventAt ? ` · Last activity ${time(run.lastEventAt)}` : ''}</p>
          {run.error ? <p className="text-crit whitespace-pre-wrap">{run.error}</p> : null}
          {run.thinking?.progress ? <div><h3 className="font-semibold">Progress</h3><p className="whitespace-pre-wrap break-words">{run.thinking.progress}</p></div> : null}
          {run.thinking?.reasoning ? <details><summary className="cursor-pointer font-semibold">Published reasoning summary</summary><p className="mt-2 whitespace-pre-wrap break-words">{run.thinking.reasoning}</p></details> : <p className="text-text-muted">No reasoning summary was supplied for this turn.</p>}
          {run.thinking?.tools.length ? <details><summary className="cursor-pointer font-semibold">Tool activity ({run.thinking.tools.length})</summary><ol className="mt-2 space-y-1">{run.thinking.tools.map(tool => <li key={tool.id}>{time(tool.at)} · {tool.name} · {tool.status}</li>)}</ol></details> : null}
          {run.lastAction ? <p className="text-text-muted">Last workflow action: {run.lastAction.replaceAll('_', ' ')}</p> : null}
          {!run.thinking ? <p className="text-text-muted">Detailed activity was not recorded for this run.</p> : null}
          {run.thinking?.truncated ? <p className="text-text-muted">Showing the most recent activity within this run’s history limit.</p> : null}
        </div>
      </details>)}
    </div>
    <button type="button" className="text-caption underline" onClick={() => setFollow(value => !value)}>{follow ? 'Following live activity' : 'Resume following live activity'}</button>
  </section>;
}
