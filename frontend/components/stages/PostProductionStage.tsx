'use client';

import React from 'react';
import { Download, Film } from 'lucide-react';
import type { StageViewProps } from './types';
import { assetUrl } from './utils';
import StageProgress from './StageProgress';
import StageActions from './StageActions';

export default function PostProductionStage({ state, onConfirm, onRegenerate, showConfirm, isRunning, hasPendingItems, hasNextStageStarted, artifacts, scriptArtifact }: StageViewProps) {
  // 提取最终视频列表
  const finalVideos: any[] = state.artifact?.final_videos || [];
  
  // 兼容旧格式及其变形
  const legacyVideo = state.artifact?.final_video;
  
  // 从剧本或分镜数据中提取剧集名称映射
  const episodeTitleMap = React.useMemo(() => {
    // 优先从 scriptArtifact 获取
    const episodes = scriptArtifact?.episodes || artifacts?.storyboard?.episodes || artifacts?.script?.episodes || [];
    const map: Record<number, string> = {};
    episodes.forEach((ep: any) => {
      const epNum = ep.episode_number || ep.episode;
      if (epNum) {
        map[Number(epNum)] = ep.act_title || ep.title || '';
      }
    });
    return map;
  }, [artifacts, scriptArtifact]);
  
  // 确保能拿到展示数据
  const videosToDisplay = React.useMemo(() => {
    if (finalVideos && finalVideos.length > 0) return finalVideos;
    if (legacyVideo) return [{ name: '最终成片', path: legacyVideo, episode: 1 }];
    return [];
  }, [finalVideos, legacyVideo]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-1">后期剪辑</h2>
        <p className="text-sm text-gray-500 mb-6">按剧集拼接视频，生成各集独立成片</p>

        {/* 运行中 */}
        {state.status === 'running' && (
          <StageProgress message={state.progressMessage} fallback="正在合成视频..." progress={state.progress} color="cyan" />
        )}

        {state.error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 p-4 rounded-xl mb-4">{state.error}</div>
        )}

        {/* 最终视频列表 */}
        {videosToDisplay.length > 0 && (
          <div className="space-y-10 pb-10">
            {videosToDisplay.map((video, idx) => {
              const epNum = video.episode || (idx + 1);
              const scriptTitle = episodeTitleMap[epNum];
              const epTitle = scriptTitle ? `第 ${epNum} 集：${scriptTitle}` : (video.name || `第 ${epNum} 集`);
              
              return (
                <div key={idx} className="space-y-4">
                  {/* 剧集分割行 - 完全同步 S4/S5 格式 */}
                  <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-gray-100">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="w-1.5 h-6 bg-cyan-500 rounded-full" />
                      <h3 className="min-w-0 text-base font-bold text-gray-800">{epTitle}</h3>
                    </div>
                  </div>
                  
                  <div className="bg-black rounded-xl overflow-hidden shadow-lg border border-gray-800">
                    <video 
                      src={assetUrl(video.path)} 
                      controls 
                      className="w-full max-h-[60vh] object-contain" 
                    />
                  </div>
                  
                  <div className="flex items-center justify-end">
                    <a
                      href={assetUrl(video.path)}
                      download={`${epTitle}.mp4`}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg text-xs font-medium hover:bg-black transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      下载本集
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {state.status === 'completed' && videosToDisplay.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Film className="w-12 h-12 mb-3" />
            <div className="text-sm">视频合成完成</div>
          </div>
        )}

        {state.status === 'pending' && (
          <div className="text-center text-gray-400 text-sm py-20">等待上一阶段完成...</div>
        )}
      </div>

      <StageActions
        status={state.status}
        onConfirm={onConfirm}
        showConfirm={false}
        onRegenerate={onRegenerate}
        stageId="post_production"
        hasPendingItems={hasPendingItems}
        hasNextStageStarted={hasNextStageStarted}
        isRunning={isRunning}
      />
    </div>
  );
}
