'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Users, MapPin, RefreshCw, Save, X, ChevronLeft, ChevronRight, Loader, AlertCircle, ZoomIn, ImagePlus, Edit2, Upload } from 'lucide-react';
import type { StageViewProps } from './types';
import { assetUrl, assetVersionLabel } from './utils';
import { uploadArtifactImage } from '@/lib/workflowApi';
import StageActions from './StageActions';
import StageProgress from './StageProgress';
import ImageLightbox from './ImageLightbox';

/* ─── 类型 ─── */
interface AssetVersion {
  id: string;             // 唯一标识 (character_id / setting_id)
  name: string;
  description: string;
  selected: string;       // 当前选中的文件路径
  versions: string[];     // 所有历史版本路径
  status?: 'pending' | 'done' | 'failed' | 'running';  // 生成状态
}

/* ─── 水平滚动图片画廊 ─── */
function ImageGallery({
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
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const amount = 260;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  if (!versions.length) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-xs">
        暂无图片
      </div>
    );
  }

  return (
    <div className="relative group">
      {versions.length > 1 && (
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
                  ? 'ring-3 ring-violet-500 shadow-lg shadow-violet-200'
                  : 'ring-1 ring-gray-200 hover:ring-gray-300 hover:shadow-md'
              }`}
            >
              <div className="relative group/img">
                <img
                  src={assetUrl(path)}
                  alt={`v${i + 1}`}
                  className="h-32 w-auto object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(i); }}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-black/60"
                  title="放大查看"
                >
                  <ZoomIn className="w-3 h-3 text-white" />
                </button>
              </div>
              <div className={`text-center text-[10px] py-0.5 ${
                isSelected ? 'bg-violet-500 text-white font-medium' : 'bg-gray-50 text-gray-400'
              }`}>
                {assetVersionLabel(path, i)}
              </div>
            </div>
          );
        })}
        {showPlaceholder && (
          <div className="flex-shrink-0 flex items-center justify-center h-32 aspect-video bg-gray-50 rounded-lg border border-dashed border-gray-200">
            <div className="flex items-center gap-2 text-gray-400 text-xs">
              <Loader className="w-4 h-4 animate-spin" />
              <span>生成中...</span>
            </div>
          </div>
        )}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={versions}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

/* ─── 素材行 ─── */
function AssetRow({
  asset,
  type,
  isEditing,
  editDesc,
  onDescChange,
  onRegenerate,
  onSelectVersion,
  onSaveEdit,
  onCancelEdit,
  onToggleEdit,
  onUploadImage,
  isStageRunning,
  isRegenerating,
  isUploading,
}: {
  asset: AssetVersion;
  type: 'character' | 'setting';
  isEditing: boolean;
  editDesc: string;
  onDescChange: (val: string) => void;
  onRegenerate: () => void;
  onSelectVersion: (path: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleEdit: () => void;
  onUploadImage: (file: File) => void;
  isStageRunning?: boolean;
  isRegenerating?: boolean;
  isUploading?: boolean;
}) {
  const isRunning = asset.status === 'running' || isRegenerating;
  const isPending = asset.status === 'pending';
  const isFailed = asset.status === 'failed' && !isRegenerating;
  const hasImage = Boolean(asset.selected) || asset.versions.length > 0;
  const canGenerateMissing = !hasImage && !isPending && !isRunning;
  const canShowRegenerate = !isRunning && !isPending && (hasImage || isFailed || canGenerateMissing);

  return (
    <div className={`flex flex-col xl:flex-row border rounded-xl overflow-hidden bg-white ${
      isFailed ? 'border-red-200' : 'border-gray-200'
    }`}>
      {/* 左侧: 描述 */}
      <div className="w-full xl:w-80 xl:flex-shrink-0 p-4 border-b xl:border-b-0 xl:border-r border-gray-100 flex flex-col">
        <div className="flex items-center gap-2 mb-2">
          {type === 'character'
            ? <Users className="w-3.5 h-3.5 text-violet-500" />
            : <MapPin className="w-3.5 h-3.5 text-emerald-500" />
          }
          <span className="text-sm font-semibold text-gray-800 truncate">{asset.name}</span>
          {(isPending || isRunning) && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">
              {isRunning && <Loader className="w-2.5 h-2.5 animate-spin" />}
              {isRunning ? '生成中' : '等待中'}
            </span>
          )}
          {isFailed && (
            <span className="text-[10px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded">失败</span>
          )}
          {!isStageRunning && (
            isEditing ? (
              <div className="ml-auto flex gap-1">
                <button
                  onClick={onCancelEdit}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100"
                >
                  <X className="w-3 h-3" />取消
                </button>
                <button
                  onClick={onSaveEdit}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-white bg-violet-500 hover:bg-violet-600"
                >
                  <Save className="w-3 h-3" />保存
                </button>
              </div>
            ) : (
              <button
                onClick={onToggleEdit}
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
              >
                <Edit2 className="w-3 h-3" />修改
              </button>
            )
          )}
        </div>
        {isEditing ? (
          <textarea
            value={editDesc}
            onChange={e => onDescChange(e.target.value)}
            rows={5}
            className="h-[120px] text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-violet-300"
          />
        ) : (
          <div className="h-[120px] overflow-y-auto pr-1 custom-scrollbar">
            <p className="text-xs text-gray-600 leading-relaxed">{asset.description}</p>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canShowRegenerate && (
            <button
              onClick={onRegenerate}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                isFailed
                  ? 'text-red-600 bg-red-50 hover:bg-red-100'
                  : 'text-violet-600 bg-violet-50 hover:bg-violet-100'
              }`}
            >
              <RefreshCw className="w-3 h-3" />
              {isFailed ? '点击重试' : hasImage ? '重新生成' : '生成'}
            </button>
          )}
          <label className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            isUploading
              ? 'text-gray-400 bg-gray-100 cursor-wait'
              : 'text-gray-600 bg-gray-100 hover:bg-gray-200 cursor-pointer'
          }`}>
            {isUploading ? <Loader className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            {isUploading ? '上传中...' : '上传照片'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={isUploading}
              onChange={e => {
                const file = e.target.files?.[0];
                e.currentTarget.value = '';
                if (file) onUploadImage(file);
              }}
            />
          </label>
        </div>
      </div>

      {/* 右侧: 图片画廊 / 占位 */}
      <div className="flex-1 min-w-0 p-3 flex items-center">
        {isPending && !hasImage ? (
          <div className="flex items-center justify-center h-32 aspect-video bg-gray-50 rounded-lg border border-dashed border-gray-200">
            <div className="flex items-center gap-2 text-gray-400 text-xs">
              <Loader className="w-4 h-4 animate-spin" />
              <span>正在生成...</span>
            </div>
          </div>
        ) : !hasImage ? (
          <div className="flex items-center justify-center h-32 aspect-video bg-gray-50/60 rounded-lg border border-dashed border-gray-200">
            <div className="flex flex-col items-center gap-1 text-gray-400 text-xs">
              {isFailed ? (
                <>
              <AlertCircle className="w-4 h-4" />
                  <span>生成失败</span>
                  {!isRunning && (
                    <button
                      onClick={onRegenerate}
                      disabled={isRegenerating}
                      className="mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors disabled:text-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className="w-2.5 h-2.5" />
                      点击重试
                    </button>
                  )}
                </>
              ) : (
                <>
                  <ImagePlus className="w-4 h-4" />
                  <span>暂无图片</span>
                  {canGenerateMissing && (
                    <button
                      onClick={onRegenerate}
                      disabled={isRegenerating}
                      className="mt-1 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-violet-600 bg-violet-50 hover:bg-violet-100 transition-colors disabled:text-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className="w-2.5 h-2.5" />
                      生成
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="relative w-full">
            <ImageGallery
              versions={asset.versions}
              selected={asset.selected}
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
export default function CharacterStage({ state, sessionId, onConfirm, onIntervene, onRegenerate, onUpdateArtifact, onSaveSelections, showConfirm, isRunning, hasPendingItems, hasNextStageStarted }: StageViewProps) {
  const characters: AssetVersion[] = state.artifact?.characters || [];
  const settingsData: AssetVersion[] = state.artifact?.settings || [];

  const [editChars, setEditChars] = useState<Record<string, string>>({});
  const [editSets, setEditSets] = useState<Record<string, string>>({});
  // 跟踪前端选择的版本（覆盖后端返回的 selected）
  const [selectedChars, setSelectedChars] = useState<Record<string, string>>({});
  const [selectedSets, setSelectedSets] = useState<Record<string, string>>({});
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(new Set());
  const regenerationStartCounts = useRef<Record<string, number>>({});
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set());

  const allAssets = React.useMemo(() => [...characters, ...settingsData], [characters, settingsData]);

  // 当对应素材新增版本或失败时，仅清除该素材的重新生成状态，支持多个任务并行。
  useEffect(() => {
    if (regeneratingIds.size === 0) return;
    setRegeneratingIds(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        const asset = allAssets.find(item => item.id === id);
        if (!asset) continue;
        const startCount = regenerationStartCounts.current[id] ?? 0;
        if ((asset.versions?.length || 0) > startCount || asset.status === 'failed') {
          next.delete(id);
          delete regenerationStartCounts.current[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allAssets, regeneratingIds.size]);

  const hasChars = characters.length > 0;
  const hasSets = settingsData.length > 0;

  const startEdit = useCallback((id: string) => {
    const cd: Record<string, string> = {};
    characters.forEach(c => { cd[c.id] = c.description; });
    setEditChars(cd);
    const sd: Record<string, string> = {};
    settingsData.forEach(s => { sd[s.id] = s.description; });
    setEditSets(sd);
    setEditingIds(prev => new Set(prev).add(id));
  }, [characters, settingsData]);

  const cancelEdit = (id: string) => {
    setEditingIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const saveEdit = (id: string) => {
    const selections: Record<string, any> = {};
    characters.forEach(c => { selections[c.id] = selectedChars[c.id] || c.selected; });
    settingsData.forEach(s => { selections[s.id] = selectedSets[s.id] || s.selected; });
    selections._editDescs = {
      characters: id in editChars ? { [id]: editChars[id] } : {},
      settings: id in editSets ? { [id]: editSets[id] } : {},
    };
    onSaveSelections?.(selections);
    cancelEdit(id);
  };

  const handleUploadImage = async (type: 'characters' | 'settings', id: string, file: File) => {
    setUploadingIds(prev => new Set(prev).add(id));
    try {
      const result = await uploadArtifactImage(sessionId, 'character_design', type, id, file);
      const artifact = result.artifact;
      if (artifact) {
        onUpdateArtifact?.({
          characters: artifact.characters || [],
          settings: artifact.settings || [],
        });
      }
      if (artifact?.characters) {
        const char = artifact.characters.find((item: AssetVersion) => item.id === id);
        if (char?.selected) setSelectedChars(prev => ({ ...prev, [id]: char.selected }));
      }
      if (artifact?.settings) {
        const setting = artifact.settings.find((item: AssetVersion) => item.id === id);
        if (setting?.selected) setSelectedSets(prev => ({ ...prev, [id]: setting.selected }));
      }
    } catch (error) {
      console.error('上传图片失败:', error);
    } finally {
      setUploadingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleRegenerate = (type: 'characters' | 'settings', id: string) => {
    const source = type === 'characters' ? characters : settingsData;
    const asset = source.find(item => item.id === id);
    regenerationStartCounts.current[id] = asset?.versions?.length || 0;
    setRegeneratingIds(prev => new Set(prev).add(id));
    if (type === 'characters') {
      onIntervene({ regenerate_characters: [id] });
    } else {
      onIntervene({ regenerate_settings: [id] });
    }
  };

  const handleSelectCharVersion = async (id: string, path: string) => {
    setSelectedChars(prev => ({ ...prev, [id]: path }));
    // 自动保存选择
    const selections: Record<string, string> = {};
    characters.forEach(c => { selections[c.id] = selectedChars[c.id] || c.selected; });
    selections[id] = path;
    settingsData.forEach(s => { selections[s.id] = selectedSets[s.id] || s.selected; });
    if (onSaveSelections) {
      await onSaveSelections(selections);
    }
  };

  const handleSelectSetVersion = async (id: string, path: string) => {
    setSelectedSets(prev => ({ ...prev, [id]: path }));
    // 自动保存选择
    const selections: Record<string, string> = {};
    characters.forEach(c => { selections[c.id] = selectedChars[c.id] || c.selected; });
    settingsData.forEach(s => { selections[s.id] = selectedSets[s.id] || s.selected; });
    selections[id] = path;
    if (onSaveSelections) {
      await onSaveSelections(selections);
    }
  };

  const getCharSelected = (asset: AssetVersion) => selectedChars[asset.id] || asset.selected;
  const getSetSelected = (asset: AssetVersion) => selectedSets[asset.id] || asset.selected;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-800">角色 / 场景设计</h2>
        </div>
        <p className="text-sm text-gray-500 mb-6">
          生成角色4视图 (正面特写·正面全身·侧面全身·背面全身) 和场景全景图
        </p>

        {/* 运行中 */}
        {state.status === 'running' && (
          <StageProgress message={state.progressMessage} fallback="正在生成角色与场景..." progress={state.progress} color="violet" />
        )}

        {state.error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-4 rounded-xl mb-4">{state.error}</div>
        )}

        {/* ═══ 角色列表 ═══ */}
        {hasChars && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-violet-500" />
              <h3 className="text-sm font-semibold text-gray-700">角色 ({characters.length})</h3>
            </div>
            <div className="space-y-3">
              {characters.map(asset => (
                <AssetRow
                  key={asset.id}
                  asset={{ ...asset, selected: getCharSelected(asset) }}
                  type="character"
                  isEditing={editingIds.has(asset.id)}
                  editDesc={editChars[asset.id] || asset.description}
                  onDescChange={val => setEditChars(prev => ({ ...prev, [asset.id]: val }))}
                  onRegenerate={() => handleRegenerate('characters', asset.id)}
                  onSelectVersion={path => handleSelectCharVersion(asset.id, path)}
                  onToggleEdit={() => startEdit(asset.id)}
                  onSaveEdit={() => saveEdit(asset.id)}
                  onCancelEdit={() => cancelEdit(asset.id)}
                  onUploadImage={file => handleUploadImage('characters', asset.id, file)}
                  isStageRunning={state.status === 'running'}
                  isRegenerating={regeneratingIds.has(asset.id)}
                  isUploading={uploadingIds.has(asset.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* ═══ 场景列表 ═══ */}
        {hasSets && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <MapPin className="w-4 h-4 text-emerald-500" />
              <h3 className="text-sm font-semibold text-gray-700">场景 ({settingsData.length})</h3>
            </div>
            <div className="space-y-3">
              {settingsData.map(asset => (
                <AssetRow
                  key={asset.id}
                  asset={{ ...asset, selected: getSetSelected(asset) }}
                  type="setting"
                  isEditing={editingIds.has(asset.id)}
                  editDesc={editSets[asset.id] || asset.description}
                  onDescChange={val => setEditSets(prev => ({ ...prev, [asset.id]: val }))}
                  onRegenerate={() => handleRegenerate('settings', asset.id)}
                  onSelectVersion={path => handleSelectSetVersion(asset.id, path)}
                  onToggleEdit={() => startEdit(asset.id)}
                  onSaveEdit={() => saveEdit(asset.id)}
                  onCancelEdit={() => cancelEdit(asset.id)}
                  onUploadImage={file => handleUploadImage('settings', asset.id, file)}
                  isStageRunning={state.status === 'running'}
                  isRegenerating={regeneratingIds.has(asset.id)}
                  isUploading={uploadingIds.has(asset.id)}
                />
              ))}
            </div>
          </section>
        )}

        {state.status === 'pending' && (
          <div className="text-center text-gray-400 text-sm py-20">等待上一阶段完成...</div>
        )}
      </div>

      {/* 底部操作栏 */}
      <StageActions
        status={state.status}
        onConfirm={onConfirm}
        showConfirm={showConfirm}
        onRegenerate={onRegenerate}
        stageId="character_design"
        hasPendingItems={hasPendingItems}
        hasNextStageStarted={hasNextStageStarted}
        isRunning={isRunning}
      />
    </div>
  );
}
