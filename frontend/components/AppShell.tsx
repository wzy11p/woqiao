'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CheckCircle2, ChevronLeft, ChevronRight, Clapperboard, Clock, Hexagon, Home, Loader2, Repeat2, Settings, Trash2, UserRound } from 'lucide-react';
import clsx from 'clsx';
import { useEffect, useState, type CSSProperties } from 'react';
import { clearTempCache, fetchPipelineTasks, fetchSandboxTasks, fetchSessions, type PipelineTask, type SandboxTask } from '@/lib/workflowApi';
import { APP_NAME } from '@/config/brand';
import BrandMark from '@/components/BrandMark';

const NAV_ITEMS = [
  { href: '/', label: APP_NAME, icon: Home },
  { href: '/sandbox', label: '临时工作台', icon: Hexagon },
  { href: '/pipelines/standard', label: '文艺短视频', icon: Clapperboard },
  { href: '/pipelines/action-transfer', label: '人物与动作', icon: Repeat2 },
  { href: '/pipelines/digital-human', label: '数字人口播', icon: UserRound },
];

const SETTINGS_ITEM = { href: '/settings', label: '设置', icon: Settings };

const PIPELINE_ROUTES: Record<string, { href: string; label: string }> = {
  standard: { href: '/pipelines/standard', label: '文艺短视频' },
  action_transfer: { href: '/pipelines/action-transfer', label: '动作迁移' },
  digital_human: { href: '/pipelines/digital-human', label: '数字人口播' },
};

const TASK_STATUS_STYLE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-500',
  running: 'bg-blue-50 text-blue-600',
  waiting: 'bg-amber-50 text-amber-600',
  completed: 'bg-green-50 text-green-600',
  failed: 'bg-red-50 text-red-600',
};

function statusText(status?: string) {
  if (status === 'pending') return '等待中';
  if (status === 'running') return '生成中';
  if (status === 'waiting') return '待确认';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return status || '未知';
}

function taskTitle(task: PipelineTask) {
  const input = task.input || {};
  const output = task.output || {};
  return output.title || input.title || input.goods_title || input.text || input.prompt_text || input.goods_text || task.task_id;
}

type RunningTaskItem = {
  id: string;
  href: string;
  title: string;
  scope: string;
  status: string;
  progress: number;
};

const WORKFLOW_STAGE_COUNT = 7;
const COMPLETED_TASK_DISMISS_KEY = 'xiaoyunque.dismissed-completed-tasks';
const SIDEBAR_OPEN_KEY = 'xiaoyunque.sidebar-open';

function projectTaskFromSession(session: any): RunningTaskItem | null {
  const statusMap = session.status || {};
  const values = Object.values(statusMap);
  if (!values.includes('running')) return null;
  const completed = values.filter(value => ['completed', 'session_completed'].includes(String(value))).length;
  const runningStage = Object.keys(statusMap).find(key => statusMap[key] === 'running');
  return {
    id: `project-${session.id}`,
    href: `/?session=${encodeURIComponent(session.id)}`,
    title: session.idea || session.id,
    scope: runningStage ? `主流程 · ${runningStage}` : '主流程',
    status: 'running',
    progress: Math.round((completed / WORKFLOW_STAGE_COUNT) * 100),
  };
}

function projectReviewTaskFromSession(session: any): RunningTaskItem | null {
  const statusMap = session.status || {};
  const waitingStage = Object.keys(statusMap).find(key => statusMap[key] === 'waiting');
  const completed = Object.values(statusMap).filter(value => ['completed', 'session_completed'].includes(String(value))).length;
  const allDone = completed >= WORKFLOW_STAGE_COUNT || statusMap.completed === 'completed';
  if (!waitingStage && !allDone) return null;
  const targetStage = waitingStage || Object.keys(statusMap).reverse().find(key => ['completed', 'session_completed'].includes(String(statusMap[key]))) || '';
  return {
    id: `project-review-${session.id}-${waitingStage || 'completed'}`,
    href: `/?session=${encodeURIComponent(session.id)}${targetStage ? `&stage=${encodeURIComponent(targetStage)}` : ''}`,
    title: session.idea || session.title || session.id,
    scope: waitingStage ? `主流程 · ${waitingStage}` : '主流程',
    status: waitingStage ? 'waiting' : 'completed',
    progress: waitingStage ? Math.round((completed / WORKFLOW_STAGE_COUNT) * 100) : 100,
  };
}

function pipelineTaskItem(task: PipelineTask): RunningTaskItem | null {
  const route = PIPELINE_ROUTES[task.pipeline];
  if (!route || !['pending', 'running'].includes(task.status)) return null;
  return {
    id: `pipeline-${task.task_id}`,
    href: `${route.href}?task=${encodeURIComponent(task.task_id)}`,
    title: String(taskTitle(task)),
    scope: route.label,
    status: task.status,
    progress: task.progress || 0,
  };
}

function pipelineCompletedTaskItem(task: PipelineTask): RunningTaskItem | null {
  const route = PIPELINE_ROUTES[task.pipeline];
  if (!route || task.status !== 'completed') return null;
  return {
    id: `pipeline-completed-${task.task_id}`,
    href: `${route.href}?task=${encodeURIComponent(task.task_id)}`,
    title: String(taskTitle(task)),
    scope: route.label,
    status: 'completed',
    progress: 100,
  };
}

const SANDBOX_TOOL_LABELS: Record<string, string> = {
  llm: 'LLM',
  vlm: 'VLM',
  t2i: '文生图',
  i2i: '图生图',
  video: '视频生成',
};

function sandboxTaskItem(task: SandboxTask): RunningTaskItem {
  const input = task.input || {};
  return {
    id: `sandbox-${task.id}`,
    href: `/sandbox?task=${encodeURIComponent(task.id)}`,
    title: input.prompt || input.reference_image || task.id,
    scope: `临时工作台 · ${SANDBOX_TOOL_LABELS[task.tool] || task.tool}`,
    status: task.status || 'running',
    progress: task.progress || 1,
  };
}

function loadDismissedCompletedTasks(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(COMPLETED_TASK_DISMISS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDismissedCompletedTasks(ids: Set<string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(COMPLETED_TASK_DISMISS_KEY, JSON.stringify(Array.from(ids)));
}

function loadSidebarOpen(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = window.localStorage.getItem(SIDEBAR_OPEN_KEY);
  return stored === null ? window.innerWidth >= 1104 : stored === 'true';
}

function saveSidebarOpen(open: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SIDEBAR_OPEN_KEY, open ? 'true' : 'false');
}

function TaskPanel({
  title,
  icon,
  loading,
  tasks,
  currentPath,
  emptyText,
  onTaskClick,
}: {
  title: string;
  icon: React.ReactNode;
  loading?: boolean;
  tasks: RunningTaskItem[];
  currentPath: string;
  emptyText: string;
  onTaskClick: (task: RunningTaskItem) => void;
}) {
  return (
    <section className="xyq-task-panel h-[20vh] min-h-32 border-t border-gray-100 p-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        {icon}
        <span className="text-xs font-medium text-gray-500">{title}</span>
        {loading && <Loader2 className="ml-auto h-3 w-3 animate-spin text-gray-300" />}
      </div>
      <div className="h-[calc(100%-26px)] overflow-y-auto pr-1">
        {tasks.length ? (
          <div className="space-y-1.5">
            {tasks.map(task => {
              const active = currentPath === task.href.split('?')[0];
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onTaskClick(task)}
                  className={clsx(
                    'xyq-task-item w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                    active ? 'border-blue-100 bg-blue-50/60' : 'border-gray-100 bg-white hover:border-blue-200 hover:bg-blue-50/40'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700">
                      {task.title.slice(0, 36)}
                    </span>
                    <span className={clsx('flex-shrink-0 rounded px-1.5 py-0.5 text-[10px]', TASK_STATUS_STYLE[task.status] || TASK_STATUS_STYLE.pending)}>
                      {statusText(task.status)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="truncate text-[10px] text-gray-400">{task.scope}</span>
                    <div className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${task.progress || 0}%` }} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-gray-100 px-2 text-center text-xs text-gray-300">
            {emptyText}
          </div>
        )}
      </div>
    </section>
  );
}

function SidebarTaskPanels({ currentPath }: { currentPath: string }) {
  const router = useRouter();
  const [runningTasks, setRunningTasks] = useState<RunningTaskItem[]>([]);
  const [completedTasks, setCompletedTasks] = useState<RunningTaskItem[]>([]);
  const [dismissedCompleted, setDismissedCompleted] = useState<Set<string>>(() => loadDismissedCompletedTasks());
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [pipelineRecords, sessions, sandboxRecords] = await Promise.all([
        fetchPipelineTasks(100).catch(() => []),
        fetchSessions().catch(() => []),
        fetchSandboxTasks().catch(() => []),
      ]);
      setRunningTasks([
        ...sandboxRecords.map(sandboxTaskItem),
        ...pipelineRecords.map(pipelineTaskItem).filter((task): task is RunningTaskItem => Boolean(task)),
        ...sessions.map(projectTaskFromSession).filter((task): task is RunningTaskItem => Boolean(task)),
      ]);
      setCompletedTasks([
        ...pipelineRecords.map(pipelineCompletedTaskItem).filter((task): task is RunningTaskItem => Boolean(task)),
        ...sessions.map(projectReviewTaskFromSession).filter((task): task is RunningTaskItem => Boolean(task)),
      ].filter(task => !dismissedCompleted.has(task.id)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {});
    const timer = window.setInterval(() => load().catch(() => {}), 3000);
    return () => window.clearInterval(timer);
  }, [dismissedCompleted]);

  const handleRunningClick = (task: RunningTaskItem) => {
    router.push(task.href);
  };

  const handleCompletedClick = (task: RunningTaskItem) => {
    const next = new Set(dismissedCompleted);
    next.add(task.id);
    saveDismissedCompletedTasks(next);
    setDismissedCompleted(next);
    setCompletedTasks(current => current.filter(item => item.id !== task.id));
    router.push(task.href);
  };

  return (
    <>
      <TaskPanel
        title="进行中任务"
        icon={<Clock className="h-3.5 w-3.5 text-gray-400" />}
        loading={loading}
        tasks={runningTasks}
        currentPath={currentPath}
        emptyText="还没有进行中的任务"
        onTaskClick={handleRunningClick}
      />
      <TaskPanel
        title="已完成/等待确认"
        icon={<CheckCircle2 className="h-3.5 w-3.5 text-gray-400" />}
        tasks={completedTasks}
        currentPath={currentPath}
        emptyText="还没有已完成或待确认的任务"
        onTaskClick={handleCompletedClick}
      />
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    setOpen(loadSidebarOpen());
  }, []);

  const setSidebarOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    saveSidebarOpen(nextOpen);
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    try {
      const result = await clearTempCache();
      window.alert(`缓存已清空，删除 ${result.deleted} 项，释放 ${Number(result.freed_mb || 0).toFixed(2)} MB。`);
      setSettingsMenuOpen(false);
    } catch (error: any) {
      window.alert(error?.message || '清空缓存失败');
    } finally {
      setClearingCache(false);
    }
  };

  return (
    <div
      className="xyq-shell min-h-screen bg-gray-50 text-gray-800"
      style={{ '--app-sidebar-width': open ? '15.5rem' : '0px' } as CSSProperties}
    >
      <aside
        aria-hidden={!open}
        inert={!open}
        className={clsx(
          'xyq-sidebar fixed inset-y-0 left-0 z-40 border-r border-gray-200 bg-white shadow-sm transition-all duration-300',
          !open && 'border-r-0'
        )}
        style={{ width: open ? 'var(--app-sidebar-width)' : '0px' }}
      >
        <div className={clsx('flex h-full flex-col overflow-hidden transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')}>
          <div className="xyq-sidebar-brand flex h-16 items-center px-4 border-b border-gray-100">
            <div className="flex items-center gap-2 min-w-0">
              <BrandMark />
              <span className="text-base font-semibold text-gray-900 truncate">{APP_NAME}</span>
            </div>
          </div>
          <nav className="xyq-sidebar-nav min-h-0 flex-1 overflow-y-auto p-3 space-y-1">
            {NAV_ITEMS.map(item => {
              const Icon = item.icon;
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    'xyq-sidebar-link flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
                  )}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <SidebarTaskPanels currentPath={pathname} />
          <div className="xyq-sidebar-footer relative border-t border-gray-100 p-3">
            {(() => {
              const Icon = SETTINGS_ITEM.icon;
              const active = pathname.startsWith(SETTINGS_ITEM.href);
              return (
                <>
                  {settingsMenuOpen && (
                    <div className="xyq-settings-menu absolute bottom-[62px] left-3 right-3 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
                      <button
                        type="button"
                        onClick={() => {
                          setSettingsMenuOpen(false);
                          router.push(SETTINGS_ITEM.href);
                        }}
                        className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-gray-600 hover:bg-blue-50 hover:text-blue-600"
                      >
                        <Settings className="h-4 w-4" />
                        修改配置
                      </button>
                      <button
                        type="button"
                        onClick={() => handleClearCache()}
                        disabled={clearingCache}
                        className="mt-1 flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {clearingCache ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        清空缓存
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setSettingsMenuOpen(value => !value)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                    active || settingsMenuOpen
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
                  )}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate">{SETTINGS_ITEM.label}</span>
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      </aside>

      {open && (
        <button
          onClick={() => setSidebarOpen(false)}
          className="xyq-sidebar-toggle fixed top-1/2 z-50 h-14 w-7 -translate-y-1/2 rounded-r-xl border border-l-0 border-gray-200 bg-white text-gray-400 shadow-sm hover:w-9 hover:text-gray-900 hover:border-gray-300 hover:bg-white flex items-center justify-center transition-all"
          style={{ left: 'calc(var(--app-sidebar-width) - 1px)' }}
          title="收起侧边栏"
          aria-label="收起侧边栏"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}

      {!open && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed left-0 top-1/2 z-50 h-14 w-7 -translate-y-1/2 rounded-r-xl border border-l-0 border-gray-200 bg-white text-gray-400 shadow-sm hover:w-9 hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50 flex items-center justify-center transition-all"
          title="打开侧边栏"
          aria-label="打开侧边栏"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}

      <main
        className="xyq-main min-h-screen min-w-0 overflow-x-hidden transition-[margin] duration-300"
        style={{ marginLeft: open ? 'var(--app-sidebar-width)' : '0px' }}
      >
        {children}
      </main>
    </div>
  );
}
