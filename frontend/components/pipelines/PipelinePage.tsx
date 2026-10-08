'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle,
  Clapperboard,
  Clock,
  Image as ImageIcon,
  Lightbulb,
  Loader2,
  Play,
  RefreshCw,
  Repeat2,
  Settings2,
  SlidersHorizontal,
  Upload,
  UserRound,
  Video,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import clsx from 'clsx';
import {
  fetchApiModels,
  fetchStandardTemplates,
  deletePipelineTask,
  fetchPipelineTask,
  fetchPipelineTasks,
  startActionTransferPipeline,
  startDigitalHumanPipeline,
  startStandardPipeline,
  subscribePipelineTask,
  uploadMedia,
  type PipelineTask,
  type PipelineTaskEvent,
  type ApiModelOption,
  type StandardTemplateOption,
} from '@/lib/workflowApi';
import { fetchModelGroupsByType, groupModelOptions } from '@/lib/modelRegistry';
import {
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type ProviderGroup,
} from '@/config/models';
import BrandHeader from '@/components/BrandHeader';

type PipelineId = 'standard' | 'action_transfer' | 'digital_human';

interface PipelinePageProps {
  pipeline: PipelineId;
  title: string;
  subtitle: string;
}

const STANDARD_STYLE_PRESETS = [
  {
    label: '印象油画',
    prompt:
      'Impressionist painting style, visible broken brushstrokes, pure colors juxtaposed. The scene is bathed in natural, fleeting light with a shimmering, grainy texture in the air. Soft, blurred outlines, emphasizing color contrast over precise lines. Slight oil paint canvas texture, warm and luminous tone.',
  },
  {
    label: '极简线条',
    prompt:
      'Minimalist black-and-white matchstick figure style illustration, clean lines, simple sketch style',
  },
  {
    label: '中国水墨',
    prompt:
      'Traditional Chinese ink wash painting style, visible xuan paper texture. Layered ink tones from deep black to pale gray, with dry brush strokes (feibai) and natural ink bleeding. Expressive and spontaneous brushwork, large negative space (liubai), interplay between solid and void. Wet and dry contrast, calligraphic rhythm in lines. Minimal color palette, a hint of light ochre or floral blue.',
  },
  {
    label: '写实',
    prompt:
      'Photorealistic cinematic style, 8K resolution, physically accurate. Natural or practical lighting with sharp shadow edges. Materials exhibit realistic specular reflection and roughness, subtle surface textures and imperfections visible. Natural depth of field (sharp foreground with blurred background or vice versa). Motion includes inertial easing, mimicking real human eye observation. No stylized filters, true-to-life color reproduction.',
  },
];

const DEFAULT_STANDARD_STYLE_CONTROL = STANDARD_STYLE_PRESETS[0].prompt;

const TEMPLATE_TEXT_DEFAULTS = {
  text: '心之所向，素履而往',
};

const TEMPLATE_FIELD_LABELS: Record<string, string> = {
  author: 'author',
  describe: 'describe',
  brand: 'brand',
  signature: 'signature',
  subtitle: 'subtitle',
};

const TTS_VOICE_GROUPS: ProviderGroup[] = [
  {
    provider: 'zh-cn',
    label: '普通话',
    models: [
      { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声' },
      { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声' },
      { id: 'zh-CN-YunjianNeural', label: '云健 · 男声', default: true },
      { id: 'zh-CN-YunxiNeural', label: '云希 · 男声' },
      { id: 'zh-CN-YunxiaNeural', label: '云夏 · 男声' },
      { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声' },
    ],
  },
  {
    provider: 'zh-cn-regional',
    label: '方言/地区普通话',
    models: [
      { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女声 · 东北官话' },
      { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女声 · 陕西中原官话' },
    ],
  },
  {
    provider: 'zh-hk',
    label: '香港中文/粤语',
    models: [
      { id: 'zh-HK-HiuGaaiNeural', label: '晓佳 · 女声 · 粤语' },
      { id: 'zh-HK-HiuMaanNeural', label: '晓曼 · 女声' },
      { id: 'zh-HK-WanLungNeural', label: '云龙 · 男声' },
    ],
  },
  {
    provider: 'zh-tw',
    label: '台湾中文',
    models: [
      { id: 'zh-TW-HsiaoChenNeural', label: '晓臻 · 女声' },
      { id: 'zh-TW-HsiaoYuNeural', label: '晓雨 · 女声' },
      { id: 'zh-TW-YunJheNeural', label: '云哲 · 男声' },
    ],
  },
];

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-500',
  running: 'bg-blue-50 text-blue-600',
  completed: 'bg-green-50 text-green-600',
  failed: 'bg-red-50 text-red-600',
};

const PIPELINE_TITLE_ICONS = {
  standard: Clapperboard,
  action_transfer: Repeat2,
  digital_human: UserRound,
};

function SelectField({
  label,
  value,
  onChange,
  groups,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  groups: ProviderGroup[];
}) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-300"
      >
        {groups.map(group => (
          <optgroup key={group.provider} label={group.label}>
            {group.models.map(model => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function groupApiModels(models: ApiModelOption[]): ProviderGroup[] {
  return groupModelOptions(models).map(group => ({
    ...group,
    models: group.models.map(model => {
      const source = models.find(item => item.id === model.id);
      return { ...model, default: Boolean(source?.api_contract_verified) };
    }),
  }));
}

function firstModelId(groups: ProviderGroup[], preferred?: string) {
  const models = groups.flatMap(group => group.models);
  if (preferred && models.some(model => model.id === preferred)) return preferred;
  return models.find(model => model.default)?.id || models[0]?.id || '';
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-medium text-gray-500">{label}{required ? ' *' : ''}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-300"
      />
    </label>
  );
}

function MediaUploadField({
  label,
  value,
  onChange,
  accept,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  accept: string;
  placeholder: string;
  required?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const result = await uploadMedia(file);
      setFilename(result.filename);
      onChange(result.file_path);
    } catch (e: any) {
      setError(e.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-medium text-gray-500">{label}{required ? ' *' : ''}</span>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => {
            setFilename('');
            onChange(e.target.value);
          }}
          placeholder={placeholder}
          className="h-10 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-300"
        />
        <div className="relative flex-shrink-0">
          <input
            type="file"
            accept={accept}
            onChange={e => handleUpload(e.target.files?.[0])}
            className="absolute inset-0 opacity-0 cursor-pointer"
            disabled={uploading}
          />
          <button
            type="button"
            className={clsx(
              'h-10 w-10 rounded-lg border flex items-center justify-center transition-colors',
              uploading
                ? 'border-gray-100 bg-gray-50 text-gray-300'
                : 'border-gray-200 bg-white text-gray-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600'
            )}
            title="上传媒体"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          </button>
        </div>
        {value && (
          <button
            type="button"
            onClick={() => {
              setFilename('');
              onChange('');
            }}
            className="h-10 w-10 rounded-lg border border-gray-200 bg-white text-gray-400 hover:bg-gray-50 hover:text-red-500 flex items-center justify-center flex-shrink-0"
            title="清除"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {(filename || error) && (
        <span className={clsx('text-[10px] truncate', error ? 'text-red-500' : 'text-gray-400')}>
          {error || filename}
        </span>
      )}
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-300"
      />
    </label>
  );
}

function assetHref(path?: string) {
  if (!path) return '';
  if (/^(https?:|data:|file:)/.test(path)) return path;
  const marker = '/code/';
  const idx = path.indexOf(marker);
  if (idx >= 0) return `/code/${path.slice(idx + marker.length)}`;
  return path;
}

function statusText(status?: string) {
  if (status === 'pending') return '等待中';
  if (status === 'running') return '生成中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return status || '未知';
}

function taskTitle(task: PipelineTask) {
  const input = task.input || {};
  const output = task.output || {};
  return output.title || input.title || input.goods_title || input.text || input.prompt_text || input.goods_text || task.task_id;
}

type PipelineArtifact = NonNullable<PipelineTask['artifacts']>[number];

function isFinalVideoArtifact(item: PipelineArtifact) {
  if (item.kind !== 'video') return false;
  const name = (item.name || '').toLowerCase();
  const path = (item.path || '').toLowerCase();
  return name === 'final' || path.endsWith('/final.mp4') || path.endsWith('\\final.mp4');
}

function FinalVideoResult({ item }: { item?: PipelineArtifact }) {
  return (
    <section className="mb-4 rounded-xl border border-blue-100 bg-blue-50/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Video className="w-4 h-4 text-blue-600" />
        <h3 className="text-sm font-semibold text-gray-800">最终视频</h3>
      </div>
      {item ? (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-black">
          <video src={assetHref(item.path)} controls className="w-full max-h-72 object-contain" />
        </div>
      ) : (
        <div className="h-36 rounded-lg border border-dashed border-blue-200 bg-white/60 flex items-center justify-center text-sm text-gray-400">
          最终视频生成后显示
        </div>
      )}
    </section>
  );
}

function TaskResult({ task }: { task: PipelineTask | null }) {
  const progress = Math.max(0, Math.min(100, task?.progress || 0));

  if (!task) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm h-full">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-700">任务状态</h2>
          </div>
          <span className="text-xs font-medium text-gray-400">0%</span>
        </div>
        <div className="mb-4 h-1.5 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full w-0 rounded-full bg-blue-500" />
        </div>
        <div className="h-48 rounded-xl border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center text-sm text-gray-400">
          等待启动
        </div>
      </div>
    );
  }

  const artifacts = task.artifacts || [];
  const finalVideoArtifact = artifacts.find(isFinalVideoArtifact);
  const mediaArtifacts = artifacts
    .map((item, index) => ({ ...item, orderIndex: index }))
    .filter(item => ['audio', 'image', 'video'].includes(item.kind))
    .filter(item => !isFinalVideoArtifact(item))
    .sort((a, b) => {
      const aTime = a.created_at ? Date.parse(a.created_at) : Number.NaN;
      const bTime = b.created_at ? Date.parse(b.created_at) : Number.NaN;
      if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return aTime - bTime;
      if (!Number.isNaN(aTime) && Number.isNaN(bTime)) return -1;
      if (Number.isNaN(aTime) && !Number.isNaN(bTime)) return 1;
      return a.orderIndex - b.orderIndex;
    });

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm h-full">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {task.status === 'running' ? (
            <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
          ) : task.status === 'completed' ? (
            <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
          ) : task.status === 'failed' ? (
            <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
          ) : (
            <Clock className="w-4 h-4 text-gray-400 flex-shrink-0" />
          )}
          <h2 className="text-sm font-semibold text-gray-700">任务状态</h2>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={clsx('px-2 py-1 rounded-full text-xs font-medium', STATUS_STYLE[task.status] || STATUS_STYLE.pending)}>
            {statusText(task.status)}
          </span>
          <span className="text-xs font-semibold text-gray-500">{progress}%</span>
        </div>
      </div>

      <div className="mb-4 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', task.status === 'failed' ? 'bg-red-500' : 'bg-blue-500')}
          style={{ width: `${progress}%` }}
        />
      </div>

      <FinalVideoResult item={finalVideoArtifact} />

      {mediaArtifacts.length > 0 ? (
        <div className="max-h-[28rem] overflow-y-auto pr-1">
          <div className="mb-2 flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-700">中间产物</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {mediaArtifacts.map((item, index) => (
              <div
                key={`${item.kind}-${item.name || index}-${item.path}`}
                className="h-44 rounded-xl border border-gray-200 bg-gray-50 overflow-hidden min-w-0"
              >
                <div className="h-8 px-3 border-b border-gray-200 bg-white flex items-center gap-2">
                  {item.kind === 'video' && <Video className="w-3.5 h-3.5 text-blue-500" />}
                  {item.kind === 'image' && <ImageIcon className="w-3.5 h-3.5 text-emerald-500" />}
                  {item.kind === 'audio' && <Volume2 className="w-3.5 h-3.5 text-amber-500" />}
                  <span className="text-xs font-medium text-gray-500 truncate">{item.name || item.kind}</span>
                </div>
                {item.kind === 'video' && (
                  <video src={assetHref(item.path)} controls className="w-full h-36 bg-black object-contain" />
                )}
                {item.kind === 'image' && (
                  <img src={assetHref(item.path)} alt={item.name || 'image'} className="w-full h-36 object-contain" />
                )}
                {item.kind === 'audio' && (
                  <div className="h-36 px-3 flex items-center">
                    <audio src={assetHref(item.path)} controls className="w-full" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="h-48 rounded-xl bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center text-sm text-gray-400">
          结果生成后显示
        </div>
      )}
    </div>
  );
}

function TemplatePreviewCard({
  template,
  selected,
  onClick,
}: {
  template: StandardTemplateOption;
  selected?: boolean;
  onClick?: () => void;
}) {
  const ratioClass = template.ratio === '16:9'
    ? 'aspect-[16/9] w-36'
    : template.ratio === '1:1'
      ? 'aspect-square w-28'
      : 'aspect-[9/16] w-24';
  const scale = template.ratio === '16:9'
    ? 0.075
    : template.ratio === '1:1'
      ? 0.105
      : 0.089;

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'group flex-shrink-0 rounded-lg border bg-white p-1.5 text-left transition-all',
        selected ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200 hover:border-blue-300 hover:shadow-sm'
      )}
      title={template.label}
    >
      <div className={clsx('relative overflow-hidden rounded-md bg-gray-100', ratioClass)}>
        <iframe
          src={template.preview_url}
          title={template.label}
          className="pointer-events-none absolute left-0 top-0 border-0 bg-white"
          style={{
            width: template.width,
            height: template.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
      <div className="mt-1 max-w-36 truncate text-[10px] font-medium text-gray-500 group-hover:text-blue-600">
        {template.label}
      </div>
    </button>
  );
}

function PipelineHistory({
  pipeline,
  activeTaskId,
  onSelect,
  onDeleted,
}: {
  pipeline: PipelineId;
  activeTaskId?: string;
  onSelect: (task: PipelineTask) => void;
  onDeleted?: (taskId: string) => void;
}) {
  const [tasks, setTasks] = useState<PipelineTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [manageMode, setManageMode] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const records = await fetchPipelineTasks(100);
      setTasks(records.filter(task => task.pipeline === pipeline));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => {});
  }, [pipeline]);

  if (!tasks.length) return null;

  const remove = async (taskId: string) => {
    setDeleting(taskId);
    try {
      await deletePipelineTask(taskId);
      setTasks(prev => prev.filter(task => task.task_id !== taskId));
      onDeleted?.(taskId);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="w-full max-w-6xl mx-auto px-6 pb-12">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="w-4 h-4 text-gray-400" />
        <h3 className="text-sm font-medium text-gray-600">历史记录</h3>
        <button
          onClick={() => setManageMode(value => !value)}
          className={clsx(
            'ml-auto px-2.5 h-8 rounded-lg text-xs font-medium transition-colors',
            manageMode ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
          )}
        >
          {manageMode ? '完成' : '管理'}
        </button>
        <button
          onClick={() => load().catch(() => {})}
          className="w-8 h-8 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 flex items-center justify-center"
          title="刷新历史"
        >
          <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tasks.map(task => (
          <div
            key={task.task_id}
            onClick={() => !manageMode && onSelect(task)}
            className={clsx(
              'group text-left p-4 bg-white rounded-xl border hover:border-blue-300 hover:shadow-sm transition-all',
              manageMode ? 'cursor-default' : 'cursor-pointer',
              activeTaskId === task.task_id ? 'border-blue-300 ring-2 ring-blue-50' : 'border-gray-200'
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-700 group-hover:text-blue-600 transition-colors truncate">
                  {String(taskTitle(task)).slice(0, 48)}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded', STATUS_STYLE[task.status] || STATUS_STYLE.pending)}>
                    {statusText(task.status)}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {task.created_at ? new Date(task.created_at).toLocaleString('zh-CN') : task.task_id}
                  </span>
                </div>
                <div className="mt-2 h-1 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${task.progress || 0}%` }} />
                </div>
              </div>
              {manageMode ? (
                <button
                  onClick={event => {
                    event.stopPropagation();
                    remove(task.task_id).catch(() => {});
                  }}
                  disabled={deleting === task.task_id}
                  className="w-8 h-8 rounded-lg text-red-500 bg-red-50 hover:bg-red-100 flex items-center justify-center flex-shrink-0"
                  title="删除任务"
                >
                  {deleting === task.task_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                </button>
              ) : (
                <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-blue-400 flex-shrink-0 mt-0.5" />
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function PipelinePage({ pipeline, title, subtitle }: PipelinePageProps) {
  const searchParams = useSearchParams();
  const TitleIcon = PIPELINE_TITLE_ICONS[pipeline];
  const [showSettings, setShowSettings] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [task, setTask] = useState<PipelineTask | null>(null);
  const [imageModelGroups, setImageModelGroups] = useState<ProviderGroup[]>([]);
  const [videoModelGroups, setVideoModelGroups] = useState<ProviderGroup[]>([]);
  const [llmModelGroups, setLlmModelGroups] = useState<ProviderGroup[]>([]);

  const [text, setText] = useState('');
  const [standardMode, setStandardMode] = useState<'inspiration' | 'copy'>('inspiration');
  const [standardVideoMode, setStandardVideoMode] = useState<'image_concat' | 'dynamic_video'>('image_concat');
  const [templateMode, setTemplateMode] = useState(false);
  const [templateMediaKind, setTemplateMediaKind] = useState<'image' | 'video'>('image');
  const [templates, setTemplates] = useState<StandardTemplateOption[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateFieldValues, setTemplateFieldValues] = useState<Record<string, string>>({});
  const [titleValue, setTitleValue] = useState('');
  const [standardSegmentCount, setStandardSegmentCount] = useState(6);
  const [enableSubtitles, setEnableSubtitles] = useState(false);
  const [subtitleRenderMode, setSubtitleRenderMode] = useState<'postprocess' | 'image_model'>('postprocess');
  const [promptText, setPromptText] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [videoPath, setVideoPath] = useState('');
  const [characterImage, setCharacterImage] = useState('');
  const [goodsImage, setGoodsImage] = useState('');
  const [goodsTitle, setGoodsTitle] = useState('');
  const [goodsText, setGoodsText] = useState('');

  const [llmModel, setLlmModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [videoModel, setVideoModel] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [videoResolution, setVideoResolution] = useState('720P');
  const [duration, setDuration] = useState(5);
  const [ttsVoice, setTtsVoice] = useState('zh-CN-YunjianNeural');
  const [ttsSpeed, setTtsSpeed] = useState(1);
  const [negativePrompt, setNegativePrompt] = useState(pipeline === 'standard' ? DEFAULT_STANDARD_STYLE_CONTROL : '');

  useEffect(() => {
    const imageAbility = pipeline === 'digital_human' ? 'reference_image' : 'text_to_image';
    const videoAbility = pipeline === 'standard'
      ? 'first_frame_i2v'
      : pipeline === 'action_transfer'
        ? 'action_transfer'
        : 'digital_human';

    if (pipeline === 'standard') {
      setNegativePrompt(current => current || DEFAULT_STANDARD_STYLE_CONTROL);
    }

    fetchApiModels({ mediaType: 'image', ability: imageAbility, verifiedOnly: true })
      .then(models => {
        const groups = groupApiModels(models);
        setImageModelGroups(groups);
        setImageModel(current => firstModelId(groups, current));
      })
      .catch(() => {});

    if (pipeline !== 'standard' || standardVideoMode === 'dynamic_video' || (templateMode && templateMediaKind === 'video')) {
      fetchApiModels({ mediaType: 'video', ability: videoAbility, verifiedOnly: true })
        .then(models => {
          const groups = groupApiModels(models);
          setVideoModelGroups(groups);
          setVideoModel(current => firstModelId(groups, current));
        })
        .catch(() => {});
    }
  }, [pipeline, standardVideoMode, templateMode, templateMediaKind]);

  useEffect(() => {
    let cancelled = false;
    fetchModelGroupsByType('llm')
      .then(groups => {
        if (cancelled) return;
        setLlmModelGroups(groups);
        setLlmModel(current => firstModelId(groups, current));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (pipeline !== 'standard') return;
    fetchStandardTemplates()
      .then(items => {
        setTemplates(items);
        setSelectedTemplateId(current => current || items.find(item => item.ratio === ratio)?.id || items[0]?.id || '');
      })
      .catch(() => {});
  }, [pipeline, ratio]);

  useEffect(() => {
    if (!templateMode) return;
    setEnableSubtitles(true);
    setStandardVideoMode('image_concat');
    setText(current => current || TEMPLATE_TEXT_DEFAULTS.text);
    setSelectedTemplateId(current => {
      if (current && templates.some(item => item.id === current && item.ratio === ratio)) return current;
      return templates.find(item => item.ratio === ratio)?.id || current;
    });
  }, [templateMode, ratio, templates]);

  const portraitTemplates = useMemo(
    () => templates.filter(item => item.size === '1080x1920'),
    [templates]
  );
  const ratioTemplates = useMemo(
    () => templates.filter(item => item.ratio === ratio),
    [templates, ratio]
  );
  const selectedTemplate = useMemo(
    () => templates.find(item => item.id === selectedTemplateId) || null,
    [templates, selectedTemplateId]
  );
  const templateVideoEnabled = templateMode && templateMediaKind === 'video';
  const selectedTemplateFields = useMemo(
    () => selectedTemplate?.fields || [],
    [selectedTemplate]
  );

  useEffect(() => {
    if (!templateMode || templateMediaKind !== 'video') return;
    if (selectedTemplate && !selectedTemplate.supports_video) {
      setTemplateMediaKind('image');
    }
  }, [templateMode, templateMediaKind, selectedTemplate]);

  useEffect(() => {
    if (!templateMode) return;
    if (!selectedTemplateFields.length) {
      setTemplateFieldValues({});
      return;
    }
    setTemplateFieldValues(current => {
      const next: Record<string, string> = {};
      for (const field of selectedTemplateFields) {
        next[field.key] = current[field.key] ?? field.default ?? '';
      }
      return next;
    });
  }, [templateMode, selectedTemplateFields]);

  const enterTemplateMode = () => {
    setTemplateMode(true);
    setEnableSubtitles(true);
    setStandardVideoMode('image_concat');
    setText(current => current || TEMPLATE_TEXT_DEFAULTS.text);
  };

  const canSubmit = useMemo(() => {
    if (pipeline === 'standard') {
      return text.trim().length > 0
        && (!templateMode || Boolean(selectedTemplate))
        && (!templateVideoEnabled || Boolean(selectedTemplate?.supports_video));
    }
    if (pipeline === 'action_transfer') return promptText.trim() && imagePath.trim() && videoPath.trim();
    return characterImage.trim() && goodsText.trim();
  }, [pipeline, text, templateMode, selectedTemplate, templateVideoEnabled, promptText, imagePath, videoPath, characterImage, goodsText]);

  useEffect(() => {
    if (!task || !['pending', 'running'].includes(task.status)) return;

    const refreshTask = async () => {
      const fresh = await fetchPipelineTask(task.task_id);
      setTask(fresh);
      if (!['pending', 'running'].includes(fresh.status)) {
        setRunning(false);
      }
    };

    const handleEvent = (event: PipelineTaskEvent) => {
      if (event.type === 'snapshot' || event.type === 'progress') {
        setTask(prev => prev && prev.task_id === event.task_id
          ? {
              ...prev,
              status: event.status || prev.status,
              progress: event.progress ?? prev.progress,
            }
          : prev
        );
        return;
      }

      if (event.type === 'artifact' || event.type === 'completed' || event.type === 'failed') {
        refreshTask().catch(() => setRunning(false));
      }
    };

    return subscribePipelineTask(
      task.task_id,
      handleEvent,
      () => {
        if (task.status === 'pending' || task.status === 'running') {
          setRunning(false);
        }
      },
    );
  }, [task?.task_id, task?.status]);

  useEffect(() => {
    const taskId = searchParams.get('task');
    if (!taskId || task?.task_id === taskId) return;
    fetchPipelineTask(taskId)
      .then(fresh => {
        if (fresh.pipeline === pipeline) {
          setTask(fresh);
          setRunning(['pending', 'running'].includes(fresh.status));
        }
      })
      .catch(() => {});
  }, [pipeline, searchParams, task?.task_id]);

  const submit = async () => {
    if (!canSubmit || running) return;
    setRunning(true);
    setError('');
    try {
      const submittedTitle = titleValue.trim();
      const common = {
        video_model: videoModel,
        video_ratio: ratio,
        video_resolution: videoResolution,
        duration,
        negative_prompt: negativePrompt || undefined,
      };
      const started = pipeline === 'standard'
        ? await startStandardPipeline({
            text,
            mode: standardMode,
            title: submittedTitle || undefined,
            llm_model: llmModel,
            image_model: imageModel,
            video_ratio: ratio,
            video_resolution: videoResolution,
            enable_subtitles: templateMode ? true : enableSubtitles,
            subtitle_render_mode: !templateMode && enableSubtitles ? subtitleRenderMode : undefined,
            subtitle_template: templateMode ? selectedTemplate?.id : undefined,
            subtitle_template_fields: templateMode ? templateFieldValues : undefined,
            template_media_kind: templateMode ? templateMediaKind : undefined,
            tts_voice: ttsVoice,
            tts_speed: ttsSpeed,
            style_control: negativePrompt || undefined,
            segment_count: standardMode === 'inspiration' ? standardSegmentCount : undefined,
            video_mode: templateMode ? 'image_concat' : standardVideoMode,
            video_model: templateVideoEnabled || (!templateMode && standardVideoMode === 'dynamic_video') ? videoModel : undefined,
            video_duration: templateVideoEnabled || (!templateMode && standardVideoMode === 'dynamic_video') ? duration : undefined,
          })
        : pipeline === 'action_transfer'
          ? await startActionTransferPipeline({
              prompt_text: promptText,
              image_path: imagePath,
              video_path: videoPath,
              ...common,
            })
          : await startDigitalHumanPipeline({
              mode: 'customize',
              character_image_path: characterImage,
              goods_image_path: goodsImage || undefined,
              goods_title: goodsTitle || undefined,
              goods_text: goodsText || undefined,
              llm_model: llmModel,
              image_model: imageModel,
              video_model: videoModel,
              video_ratio: ratio,
              video_resolution: videoResolution,
              tts_voice: ttsVoice,
              tts_speed: ttsSpeed,
              negative_prompt: negativePrompt || undefined,
            });
      const fresh = await fetchPipelineTask(started.task_id);
      setTask(fresh);
    } catch (e: any) {
      setError(e.message || '启动失败');
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50/50 overflow-y-auto">
      <BrandHeader />

      <div className="w-full max-w-6xl mx-auto px-6 pt-10 pb-8">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-3">
            <TitleIcon className="w-7 h-7 text-blue-500" />
            <h1 className="text-2xl font-bold text-gray-800">{title}</h1>
          </div>
          <p className="text-sm text-gray-500">{subtitle}</p>
        </div>

        {pipeline === 'standard' && (
          <section className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <button
                type="button"
                onClick={() => {
                  if (templateMode) setTemplateMode(false);
                  else enterTemplateMode();
                }}
                className={clsx(
                  'h-10 flex-shrink-0 rounded-xl px-4 text-sm font-medium transition-colors',
                  templateMode
                    ? 'bg-gray-900 text-white hover:bg-gray-800'
                    : 'bg-blue-500 text-white hover:bg-blue-600'
                )}
              >
                {templateMode ? '返回自定义生成模式' : '使用精品模版'}
              </button>
              <div className="min-w-0 flex-1 overflow-x-auto">
                <div className="flex gap-3 pb-1">
                  {portraitTemplates.length ? (
                    portraitTemplates.map(item => (
                      <TemplatePreviewCard
                        key={item.id}
                        template={item}
                        selected={templateMode && selectedTemplateId === item.id}
                        onClick={() => {
                          enterTemplateMode();
                          setRatio(item.ratio);
                          setSelectedTemplateId(item.id);
                        }}
                      />
                    ))
                  ) : (
                    <div className="flex h-28 min-w-0 flex-1 items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-xs text-gray-400">
                      暂无 1080x1920 模版
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)] gap-5 items-start">
          <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
            {pipeline === 'standard' && (
              <div className="space-y-4">
                {templateMode ? (
                  <div className="space-y-3">
                    <div className="grid h-10 max-w-sm grid-cols-3 rounded-lg bg-gray-100 p-1 text-sm">
                      {['9:16', '1:1', '16:9'].map(item => (
                        <button
                          key={item}
                          onClick={() => setRatio(item)}
                          className={clsx('rounded-md transition-colors', ratio === item ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500')}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <div className="mb-2 text-xs font-medium text-gray-500">选择模版</div>
                      <div className="overflow-x-auto">
                        <div className="flex gap-3 pb-1">
                          {ratioTemplates.length ? (
                            ratioTemplates.map(item => (
                              <TemplatePreviewCard
                                key={item.id}
                                template={item}
                                selected={selectedTemplateId === item.id}
                                onClick={() => setSelectedTemplateId(item.id)}
                              />
                            ))
                          ) : (
                            <div className="flex h-28 min-w-0 flex-1 items-center justify-center rounded-xl border border-dashed border-gray-200 bg-white text-xs text-gray-400">
                              当前比例暂无模版
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid h-10 max-w-sm grid-cols-2 rounded-lg bg-gray-100 p-1 text-sm">
                      {[
                        { id: 'image', label: '图片拼接', disabled: false },
                        { id: 'video', label: '动态视频', disabled: Boolean(selectedTemplate && !selectedTemplate.supports_video) },
                      ].map(item => (
                        <button
                          key={item.id}
                          type="button"
                          disabled={item.disabled}
                          title={item.disabled ? '当前模版不支持动态视频' : undefined}
                          onClick={() => setTemplateMediaKind(item.id as 'image' | 'video')}
                          className={clsx(
                            'rounded-md transition-colors',
                            templateMediaKind === item.id ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500',
                            item.disabled && 'cursor-not-allowed opacity-40'
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 h-10 rounded-lg bg-gray-100 p-1 text-sm max-w-sm">
                    {[
                      { id: 'image_concat', label: '图片拼接' },
                      { id: 'dynamic_video', label: '动态视频' },
                    ].map(item => (
                      <button
                        key={item.id}
                        onClick={() => setStandardVideoMode(item.id as 'image_concat' | 'dynamic_video')}
                        className={clsx('rounded-md transition-colors', standardVideoMode === item.id ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500')}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="rounded-xl border border-yellow-300 bg-yellow-100 px-4 py-3">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-yellow-900">
                    <Lightbulb className="w-3.5 h-3.5" />
                    <span>说明</span>
                  </div>
                  <p className="text-sm leading-6 text-yellow-950">
                    {templateMode
                      ? templateMediaKind === 'video'
                        ? '精品模版会先按模版媒体位生成图片，再调用视频模型生成动态媒体，最后逐帧渲染 HTML 模版并合成 TTS 音频。'
                        : '精品模版会按模版媒体位生成图片，再用 HTML 模版精确排版标题、字幕和自定义字段。'
                      : standardVideoMode === 'image_concat'
                      ? '图片拼接会为每个旁白片段生成一张图片，并配合 TTS 音频合成为静态图文短视频。等待时间主要取决于图片生成速度，通常生成每张图片需 10-20 秒。'
                      : '动态视频会先为每个旁白片段生成图片，再调用视频模型把图片扩展为动态片段，最后合成为完整短片。等待时间更长，通常生成每个视频片段需 1-2 分钟。'}
                  </p>
                </div>
                <div className="grid grid-cols-2 h-10 rounded-lg bg-gray-100 p-1 text-sm max-w-sm">
                  {[
                    { id: 'inspiration', label: '创作灵感' },
                    { id: 'copy', label: '完整文案' },
                  ].map(item => (
                    <button
                      key={item.id}
                      onClick={() => setStandardMode(item.id as 'inspiration' | 'copy')}
                      className={clsx('rounded-md transition-colors', standardMode === item.id ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500')}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder={standardMode === 'inspiration' ? '输入主题、观点或故事灵感，系统会先构思成完整旁白...' : '输入完整旁白文案，系统会按句号切分片段并直接进入 TTS...'}
                  className="w-full min-h-[150px] resize-none rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm text-gray-800 outline-none focus:border-blue-300"
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <TextInput label="标题" value={titleValue} onChange={setTitleValue} placeholder="可选，留空时由llm生成" />
                  {standardMode === 'inspiration' && (
                    <NumberField label="片段数量" value={standardSegmentCount} onChange={setStandardSegmentCount} min={1} max={20} />
                  )}
                </div>
                {templateMode && selectedTemplateFields.length > 0 && (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <div className="mb-3 text-xs font-medium text-gray-500">自定义字段</div>
                    <div className="space-y-2">
                      {selectedTemplateFields.map(field => (
                        <label key={field.key} className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2">
                          <span className="text-xs font-medium text-gray-500">{TEMPLATE_FIELD_LABELS[field.key] || field.key}</span>
                          <input
                            value={templateFieldValues[field.key] ?? field.default ?? ''}
                            onChange={event => {
                              const value = event.target.value;
                              setTemplateFieldValues(current => ({ ...current, [field.key]: value }));
                            }}
                            className="h-9 min-w-0 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none focus:border-blue-300"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {pipeline === 'action_transfer' && (
              <div className="space-y-4">
                <textarea
                  value={promptText}
                  onChange={e => setPromptText(e.target.value)}
                  placeholder="描述希望迁移到人物或角色上的动作效果..."
                  className="w-full min-h-[130px] resize-none rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm text-gray-800 outline-none focus:border-blue-300"
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <MediaUploadField label="参考图片" value={imagePath} onChange={setImagePath} accept="image/*" placeholder="/path/to/image.png" required />
                  <MediaUploadField label="动作视频" value={videoPath} onChange={setVideoPath} accept="video/*" placeholder="/path/to/video.mp4" required />
                </div>
              </div>
            )}

            {pipeline === 'digital_human' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <MediaUploadField label="人物图片" value={characterImage} onChange={setCharacterImage} accept="image/*" placeholder="/path/to/person.png" required />
                  <MediaUploadField label="商品图片" value={goodsImage} onChange={setGoodsImage} accept="image/*" placeholder="/path/to/product.png" />
                </div>
                <TextInput label="商品标题" value={goodsTitle} onChange={setGoodsTitle} placeholder="可选，留空时由llm生成" />
                <textarea
                  value={goodsText}
                  onChange={e => setGoodsText(e.target.value)}
                  placeholder="输入口播文案..."
                  className="w-full min-h-[130px] resize-none rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm text-gray-800 outline-none focus:border-blue-300"
                />
              </div>
            )}

            <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors',
                  showSettings ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                )}
              >
                <Settings2 className="w-3.5 h-3.5" />
                生成配置
              </button>
              {pipeline === 'standard' && (
                <>
                  <label className="flex items-center gap-2 h-9 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600">
                    <input
                      type="checkbox"
                      checked={templateMode || enableSubtitles}
                      onChange={e => setEnableSubtitles(e.target.checked)}
                      disabled={templateMode}
                      className="w-4 h-4 rounded border-gray-300"
                    />
                    添加标题和字幕
                  </label>
                  {!templateMode && enableSubtitles && (
                    <div className="grid h-9 grid-cols-2 rounded-lg bg-gray-100 p-1 text-xs">
                      {[
                        { id: 'postprocess', label: 'PIL 后期叠字' },
                        { id: 'image_model', label: '模型直接生成字幕' },
                      ].map(item => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setSubtitleRenderMode(item.id as 'postprocess' | 'image_model')}
                          className={clsx(
                            'rounded-md px-3 font-medium transition-colors',
                            subtitleRenderMode === item.id
                              ? 'bg-white text-blue-600 shadow-sm'
                              : 'text-gray-500 hover:text-gray-700'
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {error && <span className="text-xs text-red-500 truncate">{error}</span>}
              <button
                onClick={submit}
                disabled={!canSubmit || running}
                className={clsx(
                  'ml-auto flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-colors',
                  canSubmit && !running ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-sm' : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                )}
              >
                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                启动任务
              </button>
            </div>

            {showSettings && (
              <div className="mt-4 p-4 bg-gray-50 rounded-xl space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {(pipeline === 'digital_human' || pipeline === 'standard') && (
                    <SelectField label="LLM 模型" value={llmModel} onChange={setLlmModel} groups={llmModelGroups} />
                  )}
                  {pipeline !== 'action_transfer' && (
                    <SelectField label="图片模型" value={imageModel} onChange={setImageModel} groups={imageModelGroups} />
                  )}
                  {(pipeline !== 'standard' || standardVideoMode === 'dynamic_video' || templateVideoEnabled) && (
                    <SelectField label="视频模型" value={videoModel} onChange={setVideoModel} groups={videoModelGroups} />
                  )}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-gray-500">视频比例</span>
                    <select value={ratio} onChange={e => setRatio(e.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none">
                      {VIDEO_RATIOS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-gray-500">视频分辨率</span>
                    <select value={videoResolution} onChange={e => setVideoResolution(e.target.value)} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none">
                      {VIDEO_RESOLUTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  {(pipeline === 'action_transfer' || (pipeline === 'standard' && (standardVideoMode === 'dynamic_video' || templateVideoEnabled))) && (
                    <NumberField label="视频时长" value={duration} onChange={setDuration} min={1} max={10} />
                  )}
                  {pipeline !== 'action_transfer' && (
                    <>
                      <SelectField label="TTS 声音" value={ttsVoice} onChange={setTtsVoice} groups={TTS_VOICE_GROUPS} />
                      <NumberField label="TTS 速度" value={ttsSpeed} onChange={setTtsSpeed} min={0.5} max={2} />
                    </>
                  )}
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-gray-500">{pipeline === 'standard' ? '风格控制' : '负向提示词'}</span>
                  <textarea
                    value={negativePrompt}
                    onChange={e => setNegativePrompt(e.target.value)}
                    placeholder={pipeline === 'standard' ? '会作为所有图像提示词的前缀...' : '负向提示词...'}
                    className="w-full min-h-[70px] resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-blue-300"
                  />
                </label>
                {pipeline === 'standard' && (
                  <div className="flex flex-wrap gap-2">
                    {STANDARD_STYLE_PRESETS.map(preset => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setNegativePrompt(preset.prompt)}
                        className={clsx(
                          'h-8 rounded-lg border px-3 text-xs font-medium transition-colors',
                          negativePrompt === preset.prompt
                            ? 'border-blue-300 bg-blue-50 text-blue-600'
                            : 'border-gray-200 bg-white text-gray-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600'
                        )}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <TaskResult task={task} />
        </div>
      </div>

      <PipelineHistory
        pipeline={pipeline}
        activeTaskId={task?.task_id}
        onSelect={selected => setTask(selected)}
        onDeleted={taskId => {
          if (task?.task_id === taskId) setTask(null);
        }}
      />
    </div>
  );
}
