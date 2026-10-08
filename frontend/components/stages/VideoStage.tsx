'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Film, RefreshCw, ChevronLeft, ChevronRight, Loader, AlertCircle, AlertTriangle, Play, Edit2, Save, X } from 'lucide-react';
import type { StageViewProps } from './types';
import { assetUrl } from './utils';
import StageActions from './StageActions';
import StageProgress from './StageProgress';

/* ─── 类型 ─── */
interface ClipItem {
  id: string;             // shot_001_01, shot_001_02, ...
  name: string;           // 场景1-镜头1
  index?: number;         // 全局编号
  description: string;    // 提示词
  duration?: number;      // 视频时长（秒）
  selected: string;       // 当前选中的视频路径
  versions: string[];     // 所有历史版本路径
  status?: 'pending' | 'done' | 'failed' | 'running';
}

/* ─── 水平滚动视频画廊 ─── */
function VideoGallery({
  versions,
  selected,
  onSelect,
  showPlaceholder,
}: {
  versions: string[];
  selected: string;
  onSelect: (path: string) => void;
  showPlaceholder?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -300 : 300, behavior: 'smooth' });
  };

  if (!versions.length && !showPlaceholder) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-xs">
        暂无视频
      </div>
    );
  }

  return (
    <div className="relative group">
      {(versions.length > 1 || (versions.length >= 1 && showPlaceholder)) && (
        <>
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-white/90 shadow border border-gray-200 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronLeft className="w-4 h-4 text-gray-600" />
          </button>
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-white/90 shadow border border-gray-200 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronRight className="w-4 h-4 text-gray-600" />
          </button>
        </>
      )}
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto scrollbar-hide py-1 px-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {versions.map((path, i) => {
          const isSelected = path === selected;
          return (
            <div
              key={path}
              onClick={() => onSelect(path)}
              className={`flex-shrink-0 cursor-pointer rounded-lg overflow-hidden transition-all ${
                isSelected
                  ? 'ring-3 ring-rose-500 shadow-lg shadow-rose-200'
                  : 'ring-1 ring-gray-200 hover:ring-gray-300 hover:shadow-md'
              }`}
            >
              <div className="relative bg-black flex items-center justify-center h-32 aspect-video overflow-hidden">
                <video
                  src={assetUrl(path)}
                  controls={isSelected}
                  preload="metadata"
                  className="h-full w-full object-contain"
                />
                {!isSelected && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/10 transition-colors">
                    <Play className="w-8 h-8 text-white filter drop-shadow-lg" />
                  </div>
                )}
              </div>
              <div className={`text-center text-[10px] py-1 ${
                isSelected ? 'bg-rose-500 text-white font-medium' : 'bg-gray-50 text-gray-400'
              }`}>
                v{i + 1}
              </div>
            </div>
          );
        })}
        {showPlaceholder && (
          <div className="flex-shrink-0 flex items-center justify-center h-32 aspect-video bg-gray-50 rounded-lg border border-dashed border-gray-200 px-4">
            <div className="flex items-center gap-2 text-gray-400 text-xs">
              <Loader className="w-4 h-4 animate-spin" />
              <span>生成中...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── 视频行 ─── */
function ClipRow({
  clip,
  editDesc,
  onDescChange,
  onSavePrompt,
  onRegenerate,
  onSelectVersion,
  onToggleEdit,
  onCancelEdit,
  isStageRunning,
  isRegenerating,
  isEditing,
  canEdit,
  disabled,
  isSaving,
  allowMissingGenerate,
}: {
  clip: ClipItem;
  editDesc?: string;
  onDescChange?: (val: string) => void;
  onSavePrompt?: () => void;
  onRegenerate: () => void;
  onSelectVersion: (path: string) => void;
  onToggleEdit?: () => void;
  onCancelEdit?: () => void;
  isStageRunning?: boolean;
  isRegenerating?: boolean;
  isEditing?: boolean;
  canEdit?: boolean;
  disabled?: boolean;
  isSaving?: boolean;
  allowMissingGenerate?: boolean;
}) {
  const isRunning = clip.status === 'running' || isRegenerating;
  const isPending = clip.status === 'pending';
  const isFailed = clip.status === 'failed' && !isRegenerating;
  const hasChanges = editDesc !== clip.description;
  const hasVideo = Boolean(clip.selected) || clip.versions.length > 0;
  const canGenerateMissing = Boolean(allowMissingGenerate) && !hasVideo && !isRunning && !isRegenerating;

  return (
    <div className={`flex flex-col xl:flex-row border rounded-xl overflow-hidden bg-white ${disabled ? 'opacity-50' : ''} ${
      isFailed ? 'border-red-200' : 'border-gray-200'
    }`}>
      {/* 左侧: 描述信息 */}
      <div className="w-full xl:w-80 xl:flex-shrink-0 p-4 border-b xl:border-b-0 xl:border-r border-gray-100 flex flex-col">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex items-center justify-center h-6 px-1.5 rounded-full bg-rose-100 text-rose-700 text-[10px] font-bold flex-shrink-0 whitespace-nowrap">
            {clip.index ?? clip.id.replace('Scene_', '')}
          </span>
          <span className="text-sm font-semibold text-gray-800 truncate">{clip.name}</span>
          {clip.duration && (
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{clip.duration}s</span>
          )}
          {isPending && (
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">等待中</span>
          )}
          {isRunning && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">
              <Loader className="w-2.5 h-2.5 animate-spin" />生成中
            </span>
          )}
          {isFailed && (
            <span className="text-[10px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded">失败</span>
          )}
          {/* 编辑/保存按钮 */}
          {canEdit && !isStageRunning && (
            isEditing ? (
              <div className="ml-auto flex gap-1">
                <button
                  onClick={onCancelEdit}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100"
                >
                  <X className="w-3 h-3" />取消
                </button>
                <button
                  onClick={onSavePrompt}
                  disabled={!hasChanges || isSaving}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
                    hasChanges && !isSaving
                      ? 'text-white bg-emerald-500 hover:bg-emerald-600'
                      : 'text-gray-400 bg-gray-100 cursor-not-allowed'
                  }`}
                >
                  <Save className="w-3 h-3" />
                  {isSaving ? '保存中' : '保存'}
                </button>
              </div>
            ) : (
              <button
                onClick={onToggleEdit}
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
              >
                <Edit2 className="w-3 h-3" />
                编辑
              </button>
            )
          )}
        </div>
        {isEditing ? (
          <textarea
            value={editDesc ?? clip.description}
            onChange={e => onDescChange?.(e.target.value)}
            rows={4}
            className="h-[120px] text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-rose-300"
          />
        ) : clip.description ? (
          <div className="h-[120px] overflow-y-auto pr-1 custom-scrollbar">
             <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">{clip.description}</p>
          </div>
        ) : (
          <div className="h-[120px] flex items-center justify-center">
            <p className="text-xs text-gray-400 italic">无提示词</p>
          </div>
        )}
        {/* 已有视频显示重新生成；失败/旧数据空资源允许补生成。 */}
        {!isStageRunning && (hasVideo || isFailed || canGenerateMissing) && (
          <button
            onClick={onRegenerate}
            disabled={disabled}
            className={`mt-3 flex items-center gap-1.5 self-start px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              disabled
                ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                : isFailed
                  ? 'text-red-600 bg-red-50 hover:bg-red-100'
                  : 'text-rose-600 bg-rose-50 hover:bg-rose-100'
            }`}
          >
            <RefreshCw className="w-3 h-3" />
            {isFailed ? '点击重试' : hasVideo ? '重新生成' : '生成'}
          </button>
        )}
      </div>

      {/* 右侧: 视频画廊 / 占位 */}
      <div className="flex-1 min-w-0 p-3 flex items-center">
        {isRunning && !hasVideo ? (
          <div className="flex items-center justify-center h-32 aspect-video bg-gray-50 rounded-lg border border-dashed border-gray-200">
            <div className="flex items-center gap-2 text-gray-400 text-xs px-4">
              <Loader className="w-4 h-4 animate-spin" />
              <span>正在生成视频...</span>
            </div>
          </div>
        ) : isPending && !hasVideo ? (
          <div className="flex items-center justify-center h-32 aspect-video bg-gray-50/30 rounded-lg border border-dashed border-gray-200">
            <div className="flex items-center gap-2 text-gray-400 text-xs px-4">
              <span>等待生成视频...</span>
            </div>
          </div>
        ) : isFailed && !hasVideo ? (
          <div className="flex items-center justify-center h-32 aspect-video bg-red-50/50 rounded-lg border border-dashed border-red-200">
            <div className="flex flex-col items-center gap-1 text-red-400 text-xs px-4">
              <AlertCircle className="w-4 h-4" />
              <span>生成失败</span>
              {!isStageRunning && (
                <button
                  onClick={onRegenerate}
                  disabled={disabled}
                  className={`mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                    disabled
                      ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                      : 'text-red-600 bg-red-50 hover:bg-red-100'
                  }`}
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  点击重试
                </button>
              )}
            </div>
          </div>
        ) : !hasVideo ? (
          <div className="flex items-center justify-center h-32 aspect-video bg-gray-50/30 rounded-lg border border-dashed border-gray-200">
            <div className="flex flex-col items-center gap-1 text-gray-400 text-xs px-4">
              <span>暂无视频</span>
              {!isStageRunning && canGenerateMissing && (
                <button
                  onClick={onRegenerate}
                  disabled={disabled}
                  className={`mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                    disabled
                      ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                      : 'text-rose-600 bg-rose-50 hover:bg-rose-100'
                  }`}
                >
                  <RefreshCw className="w-2.5 h-2.5" />
                  生成
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="relative w-full">
            <VideoGallery
              versions={clip.versions}
              selected={clip.selected}
              onSelect={onSelectVersion}
              showPlaceholder={isRunning}
            />
            {isFailed && (
              <button
                onClick={onRegenerate}
                className="absolute top-1 right-1 z-10 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-white bg-red-500/80 hover:bg-red-600 shadow transition-colors"
              >
                <RefreshCw className="w-2.5 h-2.5" />
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── 主组件 ─── */
export default function VideoStage({ state, sessionId, onConfirm, onIntervene, onRegenerate, onUpdateArtifact, onSaveSelections, showConfirm, isRunning, referenceArtifact, hasPendingItems, hasNextStageStarted, scriptArtifact }: StageViewProps) {
  // 提取剧集标题映射
  const episodeTitleMap = React.useMemo(() => {
    const map: Record<number, string> = {};
    if (scriptArtifact?.episodes) {
      scriptArtifact.episodes.forEach((ep: any) => {
        // 关键修复：兼容剧本阶段的字段名
        const epNum = ep.episode_number || ep.episode;
        const epTitle = ep.act_title || ep.title;
        if (epNum) {
          map[Number(epNum)] = epTitle || '';
        }
      });
    }
    return map;
  }, [scriptArtifact]);

  // 检查每个 clip 是否有对应的参考图
  const hasReferenceImage = useCallback((clipId: string): boolean => {
    if (!referenceArtifact?.scenes) return false;
    const refScene = referenceArtifact.scenes.find((s: any) => s.id === clipId);
    return !!(refScene?.selected || refScene?.versions?.length);
  }, [referenceArtifact]);

  // 兼容旧格式: video_clips: {Scene_1: "path"} → clips: [{id, ...}]
  const clips: ClipItem[] = (() => {
    if (state.artifact?.clips?.length) return state.artifact.clips;
    if (state.artifact?.video_clips) {
      const vc = state.artifact.video_clips as Record<string, string>;
      return Object.entries(vc)
        .sort(([a], [b]) => {
          const na = parseInt(a.replace(/\D/g, '')) || 0;
          const nb = parseInt(b.replace(/\D/g, '')) || 0;
          return na - nb;
        })
        .map(([id, path]) => ({
          id,
          name: `片段 ${id.replace('Scene_', '')}`,
          description: '',
          selected: path,
          versions: [path],
          status: 'done' as const,
        }));
    }
    return [];
  })();

  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [editDescs, setEditDescs] = useState<Record<string, string>>({});
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(new Set());
  const regenerationStartCounts = useRef<Record<string, number>>({});
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  // 当分镜数据变化时，初始化编辑描述
  useEffect(() => {
    if (clips.length > 0) {
      setEditDescs(prev => {
        const next: Record<string, string> = {};
        clips.forEach(c => { next[c.id] = prev[c.id] ?? c.description; });
        return next;
      });
    }
  }, [clips]);

  // 当对应片段新增版本或失败时，仅清除该片段的重新生成状态，支持多个任务并行。
  useEffect(() => {
    if (regeneratingIds.size === 0) return;
    setRegeneratingIds(prev => {
      let changed = false;
      const next = new Set(prev);
      clips.forEach(clip => {
        if (!next.has(clip.id)) return;
        const startCount = regenerationStartCounts.current[clip.id] ?? 0;
        const currentCount = clip.versions?.length ?? 0;
        if (currentCount > startCount || clip.status === 'failed') {
          next.delete(clip.id);
          delete regenerationStartCounts.current[clip.id];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  const hasClips = clips.length > 0;
  const canEdit = state.status === 'waiting' || state.status === 'completed';

  // 保存单个提示词到后端 JSON
  const handleSavePrompt = async (clipId: string) => {
    const newPrompt = editDescs[clipId];
    if (!newPrompt) return;

    setSavingIds(prev => new Set(prev).add(clipId));
    try {
      const response = await fetch(`/api/project/${sessionId}/artifact/video_generation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [clipId]: { description: newPrompt }
        })
      });
      if (response.ok) {
        // 更新前端缓存的 clips.description
        if (onUpdateArtifact && state.artifact?.clips) {
          const updatedClips = state.artifact.clips.map((c: ClipItem) =>
            c.id === clipId ? { ...c, description: newPrompt } : c
          );
          onUpdateArtifact({ clips: updatedClips });
        }
        setEditingIds(prev => {
          const next = new Set(prev);
          next.delete(clipId);
          return next;
        });
        setEditDescs(prev => ({ ...prev, [clipId]: newPrompt }));
      }
    } catch (error) {
      console.error('保存提示词失败:', error);
    } finally {
      setSavingIds(prev => {
        const next = new Set(prev);
        next.delete(clipId);
        return next;
      });
    }
  };

  // 切换编辑模式
  const handleToggleEdit = (clipId: string) => {
    setEditingIds(prev => {
      const next = new Set(prev);
      if (next.has(clipId)) {
        next.delete(clipId);
      } else {
        next.add(clipId);
      }
      return next;
    });
  };

  const handleCancelEdit = (clipId: string) => {
    const clip = clips.find(item => item.id === clipId);
    setEditDescs(prev => ({ ...prev, [clipId]: clip?.description || '' }));
    setEditingIds(prev => {
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
  };

  const handleRegenerate = (clipId: string) => {
    const clip = clips.find(c => c.id === clipId);
    regenerationStartCounts.current[clipId] = clip?.versions?.length ?? 0;
    setRegeneratingIds(prev => new Set(prev).add(clipId));
    onIntervene({ regenerate_clips: [clipId] });
  };

  const handleSelectVersion = async (clipId: string, path: string) => {
    setSelectedVersions(prev => ({ ...prev, [clipId]: path }));
    // 同步更新 artifact 以便确认时能传递正确的选中片段给阶段6
    if (onUpdateArtifact && state.artifact?.clips) {
      const updatedClips = state.artifact.clips.map((c: ClipItem) =>
        c.id === clipId ? { ...c, selected: path } : c
      );
      onUpdateArtifact({ clips: updatedClips });
    }
    // 自动保存选择
    const selections: Record<string, string> = {};
    clips.forEach(c => { selections[c.id] = selectedVersions[c.id] || c.selected; });
    selections[clipId] = path;
    if (onSaveSelections) {
      await onSaveSelections(selections);
    }
  };

  const getSelected = (clip: ClipItem) => selectedVersions[clip.id] || clip.selected;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-800">视频生成</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          将场景参考图转化为视频片段，支持逐项重新生成
        </p>

        {/* 运行中 */}
        {state.status === 'running' && (
          <StageProgress message={state.progressMessage} fallback="正在生成视频..." progress={state.progress} color="rose" />
        )}

        {state.error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-4 rounded-xl mb-4">{state.error}</div>
        )}

        {/* ═══ 视频列表 ═══ */}
        {hasClips && (
          <div className="space-y-10">
            {(() => {
              // 按剧集分组
              const episodes: Record<number, ClipItem[]> = {};
              clips.forEach(c => {
                const ep = (c as any).episode || 1;
                if (!episodes[ep]) episodes[ep] = [];
                episodes[ep].push(c);
              });

              return Object.keys(episodes).sort((a, b) => Number(a) - Number(b)).map(epNum => {
                const epClips = episodes[Number(epNum)];
                const fallbackTitle = (epClips[0] as any).episode_title || `第 ${epNum} 集`;
                const scriptTitle = episodeTitleMap[Number(epNum)];
                const episodeTitle = scriptTitle ? `第 ${epNum} 集：${scriptTitle}` : fallbackTitle;
                
                return (
                  <div key={epNum} className="space-y-6">
                    <div className="flex items-center justify-between py-2 px-1 border-b border-gray-100">
                      <div className="flex items-center gap-3">
                        <div className="w-1.5 h-6 bg-blue-500 rounded-full" />
                        <h3 className="text-base font-bold text-gray-800">{episodeTitle}</h3>
                      </div>
                      <span className="text-[11px] text-blue-600 font-medium bg-blue-50 px-2.5 py-1 rounded-full border border-blue-100 italic">
                        {epClips.length} 个片段
                      </span>
                    </div>

                    <div className="space-y-4">
                      {epClips.map(clip => {
                        // 检查是否有参考图
                        const hasRef = hasReferenceImage(clip.id);
                        return (
                          <div key={clip.id} className="relative">
                            {!hasRef && (
                              <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex items-center gap-2">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                未检测到首帧参考图，请先完成参考图生成
                              </div>
                            )}
                            <ClipRow
                              clip={{ ...clip, selected: getSelected(clip) }}
                              editDesc={editDescs[clip.id]}
                              onDescChange={canEdit ? (val => setEditDescs(prev => ({ ...prev, [clip.id]: val }))) : undefined}
                              onSavePrompt={() => handleSavePrompt(clip.id)}
                              onRegenerate={() => handleRegenerate(clip.id)}
                              onSelectVersion={path => handleSelectVersion(clip.id, path)}
                              onToggleEdit={() => handleToggleEdit(clip.id)}
                              onCancelEdit={() => handleCancelEdit(clip.id)}
                              isStageRunning={state.status === 'running'}
                              isRegenerating={regeneratingIds.has(clip.id)}
                              isEditing={editingIds.has(clip.id)}
                              canEdit={canEdit}
                              disabled={!hasRef}
                              isSaving={savingIds.has(clip.id)}
                              allowMissingGenerate={state.status !== 'pending'}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}

        {/* 如果有 artifact 数据（即使 status 是 pending），也显示内容 */}
        {state.status === 'pending' && !hasClips && (
          <div className="text-center text-gray-400 text-sm py-20">等待上一阶段完成...</div>
        )}
      </div>

      {/* 底部操作栏 */}
      <StageActions
        status={state.status}
        onConfirm={onConfirm}
        showConfirm={showConfirm}
        onRegenerate={onRegenerate}
        stageId="video_generation"
        hasPendingItems={hasPendingItems}
        hasNextStageStarted={hasNextStageStarted}
        isRunning={isRunning}
      />
    </div>
  );
}
