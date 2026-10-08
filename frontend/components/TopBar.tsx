'use client';

import React, { useState, useRef, useEffect } from 'react';
import { CheckCircle, Circle, Loader, Edit3, AlertCircle, Square, Zap, Settings2, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { APP_NAME } from '@/config/brand';
import BrandMark from '@/components/BrandMark';
import {
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  VIDEO_GENERATION_MODES,
  type ProviderGroup,
  type VideoGenerationMode,
} from '@/config/models';
import { fetchModelGroupsByType, fetchVideoModelGroupsByAbility } from '@/lib/modelRegistry';

export type StageStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'error' | 'stopped';

export const STAGES = [
  { id: 'script_generation', name: '剧本生成', shortName: '剧本' },
  { id: 'character_design', name: '角色设计', shortName: '角色' },
  { id: 'storyboard', name: '分镜设计', shortName: '分镜' },
  { id: 'reference_generation', name: '参考图', shortName: '参考图' },
  { id: 'video_generation', name: '视频生成', shortName: '视频' },
  { id: 'post_production', name: '后期剪辑', shortName: '后期' },
] as const;

export type StageId = typeof STAGES[number]['id'];

export interface ModelConfig {
  llm_model: string;
  vlm_model: string;
  image_t2i_model: string;
  image_it2i_model: string;
  video_model: string;
  video_first_frame_model: string;
  video_start_end_model: string;
  video_reference_model: string;
  video_generation_mode: VideoGenerationMode;
  video_ratio: string;
  video_resolution: string;
  enable_concurrency: boolean;
}

interface TopBarProps {
  /** null = 首页 */
  activeStage: string | null;
  stageStatuses: Record<string, StageStatus>;
  onStageClick: (stageId: string) => void;
  onHomeClick: () => void;
  /** 是否处于工作流中（有 sessionId） */
  hasSession: boolean;
  /** 是否正在执行 */
  isRunning: boolean;
  /** 停止执行 */
  onStop: () => void;
  /** 代理模式（自动执行全流程） */
  autoMode: boolean;
  onAutoModeChange: (auto: boolean) => void;
  /** 当前模型配置 */
  modelConfig?: ModelConfig;
  /** 模型配置变更 */
  onModelConfigChange?: (config: ModelConfig) => void;
  /** 项目状态（如 running, waiting, completed, stopped, idle, error 等） */
  projectStatus?: string;
}

/* ─── 带 Provider 分组的 <select> ─── */
function ProviderSelect({
  value,
  providers,
  onChange,
}: {
  value: string;
  providers: ProviderGroup[];
  onChange: (val: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-700 outline-none w-full"
    >
      {providers.map(pg => (
        <optgroup key={pg.provider} label={pg.label}>
          {pg.models.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/* ─── 模型选择下拉面板 ─── */
function ModelSelector({
  config,
  onChange,
}: {
  config: ModelConfig;
  onChange: (config: ModelConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [llmProviders, setLlmProviders] = useState<ProviderGroup[]>([]);
  const [vlmProviders, setVlmProviders] = useState<ProviderGroup[]>([]);
  const [t2iProviders, setT2iProviders] = useState<ProviderGroup[]>([]);
  const [i2iProviders, setI2iProviders] = useState<ProviderGroup[]>([]);
  const [firstFrameVideoProviders, setFirstFrameVideoProviders] = useState<ProviderGroup[]>([]);
  const [startEndVideoProviders, setStartEndVideoProviders] = useState<ProviderGroup[]>([]);
  const [referenceVideoProviders, setReferenceVideoProviders] = useState<ProviderGroup[]>([]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    fetchModelGroupsByType('llm')
      .then(groups => { if (!cancelled) setLlmProviders(groups); })
      .catch(() => {});
    fetchModelGroupsByType('vlm')
      .then(groups => { if (!cancelled) setVlmProviders(groups); })
      .catch(() => {});
    fetchModelGroupsByType('t2i')
      .then(groups => { if (!cancelled) setT2iProviders(groups); })
      .catch(() => {});
    fetchModelGroupsByType('i2i')
      .then(groups => { if (!cancelled) setI2iProviders(groups); })
      .catch(() => {});
    fetchVideoModelGroupsByAbility('first_frame_i2v')
      .then(groups => { if (!cancelled) setFirstFrameVideoProviders(groups); })
      .catch(() => {});
    fetchVideoModelGroupsByAbility('start_end_frame_i2v')
      .then(groups => { if (!cancelled) setStartEndVideoProviders(groups); })
      .catch(() => {});
    fetchVideoModelGroupsByAbility('reference_to_video')
      .then(groups => { if (!cancelled) setReferenceVideoProviders(groups); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const update = (key: keyof ModelConfig, val: string | boolean) => {
    onChange({ ...config, [key]: val });
  };

  const activeVideoModel =
    config.video_generation_mode === 'start_end_frame'
      ? config.video_start_end_model
      : config.video_generation_mode === 'reference'
        ? config.video_reference_model
        : config.video_first_frame_model;
  const activeVideoProviders =
    config.video_generation_mode === 'start_end_frame'
      ? startEndVideoProviders
      : config.video_generation_mode === 'reference'
        ? referenceVideoProviders
        : firstFrameVideoProviders;
  const activeVideoLabel = VIDEO_GENERATION_MODES.find(item => item.id === config.video_generation_mode)?.label || '首帧生视频';

  const updateVideoMode = (mode: VideoGenerationMode) => {
    const nextModel =
      mode === 'start_end_frame'
        ? config.video_start_end_model
        : mode === 'reference'
          ? config.video_reference_model
          : config.video_first_frame_model;
    onChange({ ...config, video_generation_mode: mode, video_model: nextModel });
  };

  const updateActiveVideoModel = (model: string) => {
    if (config.video_generation_mode === 'start_end_frame') {
      onChange({ ...config, video_start_end_model: model, video_model: model });
    } else if (config.video_generation_mode === 'reference') {
      onChange({ ...config, video_reference_model: model, video_model: model });
    } else {
      onChange({ ...config, video_first_frame_model: model, video_model: model });
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
          open
            ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
            : 'text-gray-500 hover:bg-gray-50'
        )}
        title="生成配置"
      >
        <Settings2 className="w-3.5 h-3.5" />
        <span>生成配置</span>
        <ChevronDown className={clsx('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-xl shadow-lg border border-gray-200 p-3 z-50 space-y-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">LLM 模型</span>
            <ProviderSelect value={config.llm_model} providers={llmProviders} onChange={v => update('llm_model', v)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">VLM 评估模型</span>
            <ProviderSelect value={config.vlm_model} providers={vlmProviders} onChange={v => update('vlm_model', v)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">文生图</span>
            <ProviderSelect value={config.image_t2i_model} providers={t2iProviders} onChange={v => update('image_t2i_model', v)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">图生图</span>
            <ProviderSelect value={config.image_it2i_model} providers={i2iProviders} onChange={v => update('image_it2i_model', v)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">视频生成方式</span>
            <select
              value={config.video_generation_mode}
              onChange={e => updateVideoMode(e.target.value as VideoGenerationMode)}
              className="bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-700 outline-none w-full"
            >
              {VIDEO_GENERATION_MODES.map(item => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">{activeVideoLabel}模型</span>
            <ProviderSelect value={activeVideoModel} providers={activeVideoProviders} onChange={updateActiveVideoModel} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">视频比例</span>
            <div className="flex gap-0.5">
              {VIDEO_RATIOS.map(r => (
                <button
                  key={r.id}
                  onClick={() => update('video_ratio', r.id)}
                  className={`flex flex-col items-center gap-0.5 p-1 rounded border transition-all ${
                    config.video_ratio === r.id
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  title={r.label}
                >
                  <div
                    className="bg-gray-600 rounded-sm"
                    style={{
                      width: r.ratio === '16:9' ? '16px' :
                             r.ratio === '9:16' ? '9px' :
                             r.ratio === '1:1' ? '12px' :
                             r.ratio === '4:3' ? '14px' :
                             r.ratio === '3:4' ? '10px' :
                             '18px',
                      height: r.ratio === '16:9' ? '9px' :
                             r.ratio === '9:16' ? '16px' :
                             r.ratio === '1:1' ? '12px' :
                             r.ratio === '4:3' ? '10px' :
                             r.ratio === '3:4' ? '14px' :
                             '7px',
                    }}
                  />
                  <span className="text-[8px] text-gray-500">{r.label}</span>
                </button>
              ))}
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-gray-400 font-medium">视频分辨率</span>
            <select
              value={config.video_resolution}
              onChange={e => update('video_resolution', e.target.value)}
              className="bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-700 outline-none w-full"
            >
              {VIDEO_RESOLUTIONS.map(item => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!config.enable_concurrency}
              onChange={e => update('enable_concurrency', e.target.checked)}
              className="w-3.5 h-3.5 rounded border-gray-300 text-blue-500 focus:ring-blue-500/30"
            />
            <span className="text-gray-500">并发生成</span>
          </label>
        </div>
      )}
    </div>
  );
}

export default function TopBar({
  activeStage,
  stageStatuses,
  onStageClick,
  onHomeClick,
  hasSession,
  isRunning,
  onStop,
  autoMode,
  onAutoModeChange,
  modelConfig,
  onModelConfigChange,
  projectStatus,
}: TopBarProps) {
  const getStageIcon = (status: StageStatus, isActive: boolean) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'running':
        return <Loader className="w-4 h-4 text-blue-500 animate-spin" />;
      case 'waiting':
        return <Edit3 className="w-4 h-4 text-amber-500" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      default:
        return (
          <Circle
            className={clsx('w-4 h-4', isActive ? 'text-blue-400' : 'text-gray-300')}
          />
        );
    }
  };

  return (
    <>
    <header
      className={clsx(
        'xyq-topbar fixed top-0 right-0 left-[var(--app-sidebar-width)] z-30 h-14 bg-white border-b border-gray-200 flex items-center px-4 min-w-0 transition-[left] duration-300',
        !hasSession && 'xyq-topbar-home'
      )}
    >
      {/* Logo & 名称 */}
      {hasSession && (
        <button
          onClick={onHomeClick}
          className="flex items-center gap-2 mr-6 hover:opacity-80 transition-opacity flex-shrink-0"
        >
          <BrandMark />
          <div className="flex flex-col leading-tight">
            <span className="font-bold text-sm text-gray-800 tracking-tight">
              {APP_NAME}
            </span>
          </div>
        </button>
      )}

      {/* 分隔线 */}
      {hasSession && <div className="w-px h-6 bg-gray-200 mr-4 flex-shrink-0" />}

      {/* 阶段进度条 */}
      {hasSession && (
        <nav className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
          {STAGES.map((stage, idx) => {
            const status = stageStatuses[stage.id] || 'pending';
            const isActive = activeStage === stage.id;

            return (
              <React.Fragment key={stage.id}>
                {idx > 0 && (
                  <div
                    className={clsx(
                      'w-6 h-px flex-shrink-0',
                      stageStatuses[STAGES[idx - 1].id] === 'completed'
                        ? 'bg-green-300'
                        : 'bg-gray-200'
                    )}
                  />
                )}
                <button
                  onClick={() => onStageClick(stage.id)}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex-shrink-0',
                    isActive
                      ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                      : status === 'completed'
                        ? 'text-green-700 hover:bg-green-50'
                        : status === 'error'
                          ? 'text-red-600 hover:bg-red-50'
                          : 'text-gray-500 hover:bg-gray-50'
                  )}
                >
                  {getStageIcon(status, isActive)}
                  <span>{stage.shortName}</span>
                </button>
              </React.Fragment>
            );
          })}
        </nav>
      )}

      {/* 右侧控制区 */}
      <div className="ml-auto flex min-w-0 items-center justify-end gap-2 flex-shrink-0">
        {/* 模型选择 */}
        {hasSession && modelConfig && onModelConfigChange && (
          <ModelSelector config={modelConfig} onChange={onModelConfigChange} />
        )}

        {/* 代理模式切换 */}
        {hasSession && (
          <button
            onClick={() => onAutoModeChange(!autoMode)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
              autoMode
                ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                : 'text-gray-500 hover:bg-gray-50'
            )}
            title={autoMode ? '代理模式：自动执行全流程' : '手动模式：每阶段需确认'}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{autoMode ? '自动' : '手动'}</span>
          </button>
        )}

        {/* 停止按钮 */}
        {isRunning && (
          <button
            onClick={onStop}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg text-xs font-medium transition-colors ring-1 ring-red-200"
            title="停止执行"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
            <span>停止</span>
          </button>
        )}

        {/* 项目状态 */}
        {hasSession && projectStatus && (
          <div
            className={clsx(
              'px-2 py-1 rounded-lg text-xs font-medium flex items-center gap-1',
              projectStatus === 'running' && 'bg-blue-50 text-blue-700',
              projectStatus === 'waiting' && 'bg-amber-50 text-amber-700',
              projectStatus === 'completed' && 'bg-green-50 text-green-700',
              projectStatus === 'pending' && 'bg-gray-50 text-gray-600',
              projectStatus === 'error' && 'bg-red-50 text-red-700',
              projectStatus === 'stopped' && 'bg-orange-50 text-orange-700'
            )}
            title="项目状态"
          >
            {projectStatus === 'running' && <Loader className="w-3 h-3 animate-spin" />}
            {projectStatus === 'waiting' && <Edit3 className="w-3 h-3" />}
            {projectStatus === 'error' && <AlertCircle className="w-3 h-3" />}
            <span>
              {projectStatus === 'running' ? '执行中' :
               projectStatus === 'waiting' ? '等待确认' :
               projectStatus === 'completed' ? '已完成' :
               projectStatus === 'pending' ? '空闲' :
               projectStatus === 'stopped' ? '已停止' :
               projectStatus === 'error' ? '出错' : projectStatus}
            </span>
          </div>
        )}

      </div>
    </header>
    <div className="h-14 flex-shrink-0" />
    </>
  );
}
