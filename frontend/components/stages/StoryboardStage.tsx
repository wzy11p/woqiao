'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { 
  Plus, Trash2, Film, Clock, MapPin, Users, Edit3, Save, X, 
  LayoutList, Camera, ChevronDown, ChevronRight,
  AlertCircle, Clapperboard
} from 'lucide-react';
import type { StageViewProps } from './types';
import StageActions from './StageActions';
import StageProgress from './StageProgress';

// ─── 类型定义 ───

interface Shot {
  shot_number: number;
  shot_type: string;
  duration: number;
  content: string;
}

interface Segment {
  segment_id: string;
  segment_number: number;
  episode_number: number;
  location: string;
  characters: string[];
  total_duration: number;
  shots: Shot[];
}

interface Episode {
  episode_number: number;
  episode_title: string;
  segments: Segment[];
}

// ─── 样式常量 ───

const SHOT_TYPE_DECOR = {
  '远景': { bg: 'bg-indigo-50', text: 'text-indigo-600', border: 'border-indigo-100' },
  '中景': { bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-100' },
  '近景': { bg: 'bg-cyan-50', text: 'text-cyan-600', border: 'border-cyan-100' },
  '过肩近景': { bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-100' },
  '特写': { bg: 'bg-rose-50', text: 'text-rose-600', border: 'border-rose-100' },
};

// ─── 主组件 ───

export default function StoryboardStage({ 
  state, 
  onConfirm, 
  onIntervene, 
  onRegenerate, 
  showConfirm, 
  isRunning, 
  hasPendingItems,
  hasNextStageStarted
}: StageViewProps) {
  const artifactData = state.artifact;
  
  // 获取剧集数据 (新结构)
  const episodes: Episode[] = useMemo(() => {
    if (Array.isArray(artifactData?.episodes)) return artifactData.episodes;
    if (artifactData?.payload?.episodes) return artifactData.payload.episodes;
    return [];
  }, [artifactData]);

  const [isEditing, setIsEditing] = useState(false);
  const [editMode, setEditMode] = useState<'structured' | 'raw'>('structured');
  const [editEpisodes, setEditEpisodes] = useState<Episode[]>([]);
  const [rawJson, setRawJson] = useState('');

  // ─── 编辑逻辑 ───

  const startEdit = useCallback(() => {
    setEditEpisodes(JSON.parse(JSON.stringify(episodes)));
    setRawJson(JSON.stringify(episodes, null, 2));
    setIsEditing(true);
    setEditMode('structured');
  }, [episodes]);

  const cancelEdit = useCallback(() => setIsEditing(false), []);

  const handleSave = useCallback(() => {
    let finalEpisodes: Episode[];
    if (editMode === 'raw') {
      try { finalEpisodes = JSON.parse(rawJson); } catch { finalEpisodes = editEpisodes; }
    } else {
      finalEpisodes = editEpisodes;
    }
    onIntervene({ modified_storyboard: finalEpisodes });
    setIsEditing(false);
  }, [editMode, rawJson, editEpisodes, onIntervene]);

  const switchEditMode = (mode: 'structured' | 'raw') => {
    if (mode === 'raw') {
      setRawJson(JSON.stringify(editEpisodes, null, 2));
    } else {
      try { 
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed)) setEditEpisodes(parsed);
      } catch { /* ignore */ }
    }
    setEditMode(mode);
  };

  const updateSegmentField = (epIdx: number, segIdx: number, field: keyof Segment, value: any) => {
    setEditEpisodes(prev => prev.map((ep, i) => {
      if (i !== epIdx) return ep;
      const newSegments = ep.segments.map((s, j) => j === segIdx ? { ...s, [field]: value } : s);
      return { ...ep, segments: newSegments };
    }));
  };

  const updateShotField = (epIdx: number, segIdx: number, shotIdx: number, field: keyof Shot, value: any) => {
    setEditEpisodes(prev => prev.map((ep, i) => {
      if (i !== epIdx) return ep;
      const newSegments = ep.segments.map((seg, j) => {
        if (j !== segIdx) return seg;
        const newShots = seg.shots.map((shot, k) => k === shotIdx ? { ...shot, [field]: value } : shot);
        const newTotal = newShots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
        return { ...seg, shots: newShots, total_duration: newTotal };
      });
      return { ...ep, segments: newSegments };
    }));
  };

  const addShot = (epIdx: number, segIdx: number) => {
    setEditEpisodes(prev => prev.map((ep, i) => {
      if (i !== epIdx) return ep;
      const newSegments = ep.segments.map((seg, j) => {
        if (j !== segIdx) return seg;
        const newShot: Shot = { shot_number: seg.shots.length + 1, shot_type: '近景', duration: 5, content: '' };
        return { ...seg, shots: [...seg.shots, newShot], total_duration: seg.total_duration + 5 };
      });
      return { ...ep, segments: newSegments };
    }));
  };

  const deleteShot = (epIdx: number, segIdx: number, shotIdx: number) => {
    setEditEpisodes(prev => prev.map((ep, i) => {
      if (i !== epIdx) return ep;
      const newSegments = ep.segments.map((seg, j) => {
        if (j !== segIdx) return seg;
        const newShots = seg.shots.filter((_, k) => k !== shotIdx);
        const newTotal = newShots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
        return { ...seg, shots: newShots.map((s, idx) => ({...s, shot_number: idx + 1})), total_duration: newTotal };
      });
      return { ...ep, segments: newSegments };
    }));
  };

  // ─── 渲染部分 ───

  const episodesToRender = isEditing ? editEpisodes : episodes;
  const hasEpisodes = episodes.length > 0;

  // 计算统计数据
  const stats = useMemo(() => {
    if (!episodesToRender.length) return { episodes: 0, segments: 0, duration: 0 };
    let totalSegments = 0;
    let totalDuration = 0;
    episodesToRender.forEach(ep => {
      const segs = ep.segments || [];
      totalSegments += segs.length;
      segs.forEach(seg => {
        totalDuration += (seg.total_duration || 0);
      });
    });
    return {
      episodes: episodesToRender.length,
      segments: totalSegments,
      duration: totalDuration
    };
  }, [episodesToRender]);

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 custom-scrollbar">
        {/* 标题栏 */}
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4 mb-6">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-lg font-semibold text-gray-800">分镜设计</h2>
            <p className="text-sm text-gray-500">
              生成分段分镜脚本 (景别·时长·叙事内容) 以及指导性的视觉流转设计
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {hasEpisodes && !isEditing && (
              <div className="flex flex-wrap items-center min-h-12 gap-3 sm:gap-5 px-4 sm:px-5 py-2 bg-violet-50 rounded-xl border border-violet-100 shadow-sm">
                <div className="flex items-center gap-2">
                  <Film className="w-3.5 h-3.5 text-violet-500" />
                  <span className="text-sm text-violet-700 font-bold whitespace-nowrap">总计 {stats.episodes} 集</span>
                </div>
                <div className="w-px h-6 bg-violet-200" />
                <div className="flex items-center gap-2">
                  <Clapperboard className="w-3.5 h-3.5 text-violet-500" />
                  <span className="text-sm text-violet-700 font-bold whitespace-nowrap">{stats.segments} 段分镜</span>
                </div>
                <div className="w-px h-6 bg-violet-200" />
                <div className="flex items-center gap-2 px-1">
                  <Clock className="w-3.5 h-3.5 text-violet-500" />
                  <span className="text-sm text-violet-700 font-black whitespace-nowrap">预计时长 {stats.duration}s</span>
                </div>
              </div>
            )}
            
            {isEditing && (
              <div className="flex items-center gap-2">
                <div className="bg-gray-100 p-1 rounded-lg flex items-center mr-2">
                  <button onClick={() => switchEditMode('structured')} className={`px-2 py-1 text-[10px] font-medium rounded-md transition-all ${editMode === 'structured' ? 'bg-white text-violet-600 shadow-sm' : 'text-gray-500'}`}>可视化</button>
                  <button onClick={() => switchEditMode('raw')} className={`px-2 py-1 text-[10px] font-medium rounded-md transition-all ${editMode === 'raw' ? 'bg-white text-violet-600 shadow-sm' : 'text-gray-500'}`}>JSON</button>
                </div>
                <button onClick={cancelEdit} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-100">
                  <X className="w-3.5 h-3.5" />取消
                </button>
                <button onClick={handleSave} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-violet-500 hover:bg-violet-600">
                  <Save className="w-3.5 h-3.5" />保存
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 进度提示 */}
        {isRunning && state.progress < 100 && (
          <StageProgress message={state.progressMessage} progress={state.progress} color="violet" />
        )}

        {/* 主体内容 */}
        {!hasEpisodes && !isRunning && !isEditing ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Film className="w-12 h-12 text-gray-200 mb-4" />
            <p className="text-xs">等待生成分镜剧本...</p>
          </div>
        ) : isEditing && editMode === 'raw' ? (
          <div className="h-[500px] bg-gray-950 rounded-xl overflow-hidden border border-gray-800">
            <textarea
              className="w-full h-full bg-transparent text-gray-300 p-6 font-mono text-sm resize-none focus:outline-none"
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              spellCheck={false}
            />
          </div>
        ) : (
          <div className="space-y-12">
            {episodesToRender.map((episode, epIdx) => {
              const segs = episode.segments || [];
              const epTotalTime = segs.reduce((sum, s) => sum + (s.total_duration || 0), 0);
              return (
                <div key={epIdx} className="space-y-4">
                  {/* 一级：剧集抬头 (参考第一阶段) */}
                  <div className="flex items-center justify-between py-2 px-1 border-b border-gray-100">
                    <div className="flex items-center gap-3">
                      <div className="w-1.5 h-6 bg-violet-500 rounded-full" />
                      <h3 className="text-base font-bold text-gray-800">第 {String(episode.episode_number)} 集：{episode.episode_title}</h3>
                    </div>
                    <span className="text-[11px] text-violet-600 font-medium bg-violet-50 px-2.5 py-1 rounded-full border border-violet-100 flex items-center gap-1 italic">
                      <Clock className="w-3 h-3" /> 总计 {epTotalTime}s
                    </span>
                  </div>

                  {/* 二级：拍摄分段 */}
                  <div className="space-y-8 pl-1">
                    {segs.map((segment, segIdx) => (
                      <div key={segment.segment_id} className="space-y-3">
                        <div className="flex items-center justify-between bg-gray-50/50 rounded-lg px-4 py-2 border border-gray-100">
                          <div className="flex items-center gap-6">
                            <span className="text-xs font-black text-gray-400">#{segment.segment_number}</span>
                            <div className="flex items-center gap-1.5">
                              <MapPin className="w-3.5 h-3.5 text-gray-400" />
                              <span className="text-sm font-bold text-gray-800">
                                {isEditing ? (
                                  <input 
                                    value={segment.location || ''} 
                                    onChange={e => updateSegmentField(epIdx, segIdx, 'location', e.target.value)} 
                                    className="bg-transparent border-b border-gray-200 focus:border-violet-400 outline-none px-1" 
                                  />
                                ) : (segment.location || '未知地点')}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Users className="w-3.5 h-3.5 text-gray-400" />
                              <div className="flex gap-1.5">
                                {(segment.characters || []).map((c, i) => (
                                  <span key={i} className="px-2 py-0.5 bg-white border border-gray-200 text-xs text-gray-600 rounded font-bold">{c}</span>
                                ))}
                              </div>
                            </div>
                          </div>
                          <span className="text-xs font-black text-violet-600 bg-violet-50 px-2.5 py-1 rounded-full">{segment.total_duration}s</span>
                        </div>

                        {/* 三级：分镜表格 */}
                        <div className="ml-8 border border-gray-100 rounded-xl overflow-hidden shadow-sm bg-white">
                          <table className="w-full text-left">
                            <thead className="bg-gray-50/50 border-b border-gray-100">
                              <tr className="text-[12px] font-bold text-gray-500 uppercase tracking-wider">
                                <th className="px-4 py-2 w-10 text-center">#</th>
                                <th className="px-4 py-2 w-24 text-center">景别</th>
                                <th className="px-4 py-2 w-20 text-center">时长</th>
                                <th className="px-4 py-2">分镜内容描述</th>
                                {isEditing && <th className="px-4 py-2 w-10"></th>}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {(segment.shots || []).map((shot, sIdx) => {
                                const decor = SHOT_TYPE_DECOR[shot.shot_type as keyof typeof SHOT_TYPE_DECOR] || SHOT_TYPE_DECOR['近景'];
                                return (
                                  <tr key={sIdx} className="group hover:bg-gray-50/30 transition-colors">
                                    <td className="px-4 py-3 text-center text-xs font-mono text-gray-400">{shot.shot_number}</td>
                                    <td className="px-4 py-3 text-center">
                                      {isEditing ? (
                                        <select 
                                          value={shot.shot_type} 
                                          onChange={e => updateShotField(epIdx, segIdx, sIdx, 'shot_type', e.target.value)} 
                                          className="w-full bg-white border border-gray-200 rounded text-xs font-bold py-1 px-1 outline-none focus:ring-1 focus:ring-violet-300"
                                        >
                                          {Object.keys(SHOT_TYPE_DECOR).map(t => <option key={t} value={t}>{t}</option>)}
                                        </select>
                                      ) : (
                                        <span className={`px-2 py-0.5 rounded text-xs font-black ${decor.bg} ${decor.text}`}>{shot.shot_type}</span>
                                      )}
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                      {isEditing ? (
                                        <input 
                                          type="number" 
                                          value={shot.duration} 
                                          onChange={e => updateShotField(epIdx, segIdx, sIdx, 'duration', Number(e.target.value))} 
                                          className="w-12 bg-white border border-gray-200 rounded text-xs font-mono py-1 px-1 text-center focus:ring-1 focus:ring-violet-300 outline-none" 
                                        />
                                      ) : (
                                        <span className="text-xs font-mono text-gray-500">{shot.duration}s</span>
                                      )}
                                    </td>
                                    <td className="px-4 py-3">
                                      {isEditing ? (
                                        <textarea 
                                          value={shot.content} 
                                          onChange={e => updateShotField(epIdx, segIdx, sIdx, 'content', e.target.value)} 
                                          rows={1} 
                                          className="w-full bg-gray-50 border border-transparent rounded px-2 py-1 text-sm text-gray-700 focus:bg-white focus:border-violet-100 outline-none resize-none" 
                                        />
                                      ) : (
                                        <p className="text-sm text-gray-700 leading-relaxed font-semibold">{shot.content}</p>
                                      )}
                                    </td>
                                    {isEditing && (
                                      <td className="px-2 py-3">
                                        <button onClick={() => deleteShot(epIdx, segIdx, sIdx)} className="p-1 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </td>
                                    )}
                                  </tr>
                                );
                              })}
                              {isEditing && (
                                <tr>
                                  <td colSpan={5} className="p-2">
                                    <button onClick={() => addShot(epIdx, segIdx)} className="w-full py-1.5 border border-dashed border-gray-100 rounded-lg text-gray-400 text-[10px] font-bold hover:bg-violet-50 hover:text-violet-500 transition-all flex items-center justify-center gap-1">
                                      <Plus className="w-3 h-3" /> 插入新分镜点
                                    </button>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部确认操作 (参考第二阶段 StageActions 放在底部) */}
      <StageActions 
        status={state.status}
        onConfirm={onConfirm} 
        onEdit={!isEditing ? startEdit : undefined}
        onSave={isEditing ? handleSave : undefined}
        onRegenerate={onRegenerate} 
        showConfirm={showConfirm} 
        isRunning={isRunning} 
        hasPendingItems={hasPendingItems} 
        hasNextStageStarted={hasNextStageStarted}
        stageId="storyboard"
      />

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #F1F1F1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #E5E7EB; }
      `}</style>
    </div>
  );
}
