'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  startProject,
  executeStage,
  parseStreamEvents,
  getProjectStatus,
  getProjectStatusFromDisk,
  continueWorkflow,
  stopProject,
  intervene,
  getArtifact,
  fetchSessions,
  updateModels,
  deleteSession,
  saveSelections,
} from '@/lib/workflowApi';
import TopBar, { STAGES, type ModelConfig } from './TopBar';
import HomePage, { type ProjectParams } from './HomePage';
import {
  ScriptStage,
  CharacterStage,
  StoryboardStage,
  ReferenceStage,
  VideoStage,
  PostProductionStage,
  type StageState,
  type StageStatus,
} from './stages';

const STAGE_ORDER: string[] = STAGES.map(s => s.id);

const STAGE_COMPONENTS: Record<string, React.ComponentType<any>> = {
  script_generation: ScriptStage,
  character_design: CharacterStage,
  storyboard: StoryboardStage,
  reference_generation: ReferenceStage,
  video_generation: VideoStage,
  post_production: PostProductionStage,
};

interface HistoryItem {
  id: string;
  idea: string;
  style?: string;
  date: string;
  status: string;
  stages?: Record<string, string>; // stageId => status 映射
}

function initStageStates(): Record<string, StageState> {
  const states: Record<string, StageState> = {};
  for (const s of STAGE_ORDER) {
    states[s] = {
      status: 'pending',
      progress: 0,
      progressMessage: '',
      artifact: null,
      error: null,
    };
  }
  return states;
}

function hasDoneArtifactItems(artifact: any): boolean {
  if (!artifact) return false;
  return ['clips', 'images', 'scenes', 'characters', 'settings'].some(key => {
    const items = artifact?.[key];
    return Array.isArray(items) && items.some((item: any) => item?.status === 'done' || item?.selected);
  });
}

function hasRunningArtifactItems(artifact: any): boolean {
  if (!artifact) return false;
  return ['clips', 'images', 'scenes', 'characters', 'settings'].some(key => {
    const items = artifact?.[key];
    return Array.isArray(items) && items.some((item: any) => item?.status === 'running');
  });
}

function mergeAssetVersions(current?: string[], incoming?: string[]): string[] {
  const merged: string[] = [];
  [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])].forEach(path => {
    if (path && !merged.includes(path)) merged.push(path);
  });
  return merged;
}

function mergeAssetUpdateItem(item: any, assetUpdate: any): any {
  const hasExistingSelection = Boolean(item?.selected);
  const nextStatus = hasExistingSelection && ['done', 'failed'].includes(assetUpdate.status)
    ? 'done'
    : (assetUpdate.status ?? item.status);
  return {
    ...item,
    status: nextStatus,
    selected: hasExistingSelection
      ? item.selected
      : (assetUpdate.selected || item.selected),
    versions: assetUpdate.versions
      ? mergeAssetVersions(item.versions, assetUpdate.versions)
      : item.versions,
  };
}

function getStageProgressSnapshot(status: any, stageId: string): Partial<StageState> {
  const snapshot = status?.stage_progress?.[stageId];
  if (!snapshot || typeof snapshot !== 'object') return {};
  const progress = typeof snapshot.percent === 'number'
    ? Math.max(0, Math.min(100, Math.round(snapshot.percent)))
    : undefined;
  const progressMessage = typeof snapshot.message === 'string' && snapshot.message.trim()
    ? snapshot.message
    : (typeof snapshot.step === 'string' ? snapshot.step : undefined);
  return {
    ...(typeof progress === 'number' ? { progress } : {}),
    ...(progressMessage ? { progressMessage } : {}),
  };
}

export default function WorkflowPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [stageStates, setStageStates] = useState<Record<string, StageState>>(initStageStates());
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [projectParams, setProjectParams] = useState<ProjectParams | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  // 用于顶栏流程图状态判断
  const [currentStageFromSession, setCurrentStageFromSession] = useState<string | null>(null);
  const [completedStagesFromSession, setCompletedStagesFromSession] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const autoModeRef = useRef(autoMode);
  const pollRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    autoModeRef.current = autoMode;
  }, [autoMode]);

  const handleAutoModeChange = useCallback((nextAutoMode: boolean) => {
    autoModeRef.current = nextAutoMode;
    setAutoMode(nextAutoMode);
  }, []);

  // 清理轮询
  useEffect(() => {
    return () => { pollRef.current.clear(); };
  }, []);

  // 轮询等待后端阶段完成。运行中优先读后端内存，后端重启后再回退到磁盘快照。
  const pollForCompletion = useCallback(async (sid: string, stageId: string) => {
    const key = `${sid}:${stageId}`;
    pollRef.current.add(key);
    for (let i = 0; i < 300; i++) {  // 增加轮询次数（最多10分钟）
      await new Promise(r => setTimeout(r, 2000));
      if (!pollRef.current.has(key)) return;
      try {
        let status: any;
        try {
          status = await getProjectStatus(sid);
        } catch {
          status = await getProjectStatusFromDisk(sid);
        }
        if (!pollRef.current.has(key)) return;
        setGlobalStatusMap(status.status || {});
        const done = Object.keys(status.status || {}).filter(k => ["completed", "session_completed"].includes(status.status[k]));
        const currentStageStatus = status.status?.[stageId] || 'idle';
        const artifacts = status.artifacts || {};
        const currentArtifact = artifacts[stageId];
        const hasRunningItems = hasRunningArtifactItems(currentArtifact);
        if (done.includes(stageId) && !hasRunningItems) {
          const isWait = currentStageStatus === 'waiting' && status.current_stage === stageId;
          let artifact = null;
          try { artifact = (await getArtifact(sid, stageId)).artifact; } catch {}
          updateStageState(stageId, {
            status: isWait ? 'waiting' : 'completed',
            progress: 100,
            progressMessage: isWait ? '等待确认' : '已完成',
            artifact,
          });
          pollRef.current.delete(key);
          return;
        }
        if (currentStageStatus === 'error' && !hasRunningItems) {
          updateStageState(stageId, {
            status: 'error',
            error: status.error || '执行出错',
            progressMessage: '执行失败',
          });
          pollRef.current.delete(key);
          return;
        }
        if (currentStageStatus === 'stopped' && !hasRunningItems) {
          updateStageState(stageId, {
            status: 'stopped',
            error: '手动停止',
            progressMessage: '已停止',
          });
          pollRef.current.delete(key);
          return;
        }
        // 后台单卡重生成时，阶段状态可能仍是 waiting/completed；只要 item 还在 running 就继续轮询。
        if (currentStageStatus !== 'running' && !hasRunningItems) {
          updateStageState(stageId, {
            status: currentStageStatus === 'waiting'
              ? 'waiting'
              : (done.includes(stageId) ? 'completed' : 'pending'),
            progress: done.includes(stageId) ? 100 : undefined,
            progressMessage: currentStageStatus === 'waiting'
              ? '等待确认'
              : (done.includes(stageId) ? '已完成' : undefined),
            artifact: currentArtifact || null,
          });
          pollRef.current.delete(key);
          return;
        }
        // 更新进度信息（优先使用后端持久化的 stage_progress 快照）
        const update: Partial<StageState> = {
          status: 'running',
          ...getStageProgressSnapshot(status, stageId),
        };

        // 无论何种状态，只要有数据就更新 artifact
        if (currentArtifact) {
          update.artifact = currentArtifact;
        }

        if (!update.progressMessage && currentArtifact) {
          // 检查是否有已生成的参考图/视频/分镜
          const hasProgress = currentArtifact.scenes?.some((s: any) => s.versions?.length > 0) ||
                             currentArtifact.clips?.some((c: any) => c.versions?.length > 0) ||
                             currentArtifact.episodes?.some((e: any) => e.segments?.length > 0) ||
                             currentArtifact.characters?.length > 0 ||
                             currentArtifact.shots?.length > 0;
          if (hasProgress) {
            update.progressMessage = '执行中...（已生成部分资源）';
          } else {
            update.progressMessage = '执行中...';
          }
        } else if (!update.progressMessage) {
          update.progressMessage = '执行中...';
        }

        if (Object.keys(update).length > 0) {
          updateStageState(stageId, update);
        }
      } catch { /* retry */ }
    }
    pollRef.current.delete(key);
  }, []);

  // 检查 URL 参数，加载指定的 session 和阶段
  useEffect(() => {
    const sessionParam = searchParams.get('session');
    const stageParam = searchParams.get('stage');
    if (sessionParam) {
      // 保存目标阶段，等会话加载完成后再设置
      const targetStage = stageParam && STAGE_ORDER.includes(stageParam) ? stageParam : null;
      handleResumeProject(sessionParam, targetStage);
    }
  }, [searchParams]);

  // 页面加载时从后端获取历史记录
  useEffect(() => {
    fetchSessions()
      .then(sessions => {
        setHistory(
          sessions.map((s: any) => ({
            id: s.id,
            idea: (s.title || s.idea || 'Untitled').slice(0, 60),
            style: s.style || '',
            date: s.date
              ? new Date(s.date * 1000).toLocaleDateString('zh-CN')
              : '',
            status: Object.keys(s.status || {}).length > 0 ? 'partial' : 'new',
            stages: s.status || {},
          }))
        );
      })
      .catch(() => {});
  }, []);

  const updateStageState = (stageId: string, update: Partial<StageState>) => {
    setStageStates(prev => {
      const current = prev[stageId];
      const nextUpdate = { ...update };
      if (
        current?.status === 'running' &&
        typeof update.progress === 'number' &&
        update.progress < (current.progress || 0) &&
        update.status !== 'completed' &&
        update.status !== 'waiting'
      ) {
        nextUpdate.progress = current.progress;
      }
      return {
        ...prev,
        [stageId]: { ...current, ...nextUpdate },
      };
    });
  };

  // ── 停止执行 ──
  const handleStop = async () => {
    stoppedRef.current = true;
    // 1. 断开前端 SSE 流
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // 2. 通知后端停止
    if (sessionId) {
      try { await stopProject(sessionId); } catch { /* ignore */ }
    }
    setIsRunning(false);
    // 3. 将所有 running 阶段标记为 stopped，保留已有的 artifact
    setStageStates(prev => {
      const next = { ...prev };
      for (const s of STAGE_ORDER) {
        if (next[s]?.status === 'running') {
          // 如果已有 artifact 数据（如部分已生成的视频片段），保留为 waiting 状态以便用户操作
          const hasArtifact = hasDoneArtifactItems(next[s]?.artifact);
          if (hasArtifact) {
            next[s] = { ...next[s], status: 'waiting', error: null, progressMessage: '已停止（保留已完成内容）' };
          } else {
            next[s] = { ...next[s], status: 'error', error: '已手动停止', progressMessage: '已停止' };
          }
        }
      }
      return next;
    });
    // 4. 尝试从后端获取最新 artifact（后端可能已保存部分结果）
    if (sessionId) {
      setTimeout(async () => {
        for (const s of STAGE_ORDER) {
          try {
            const artResult = await getArtifact(sessionId, s);
            if (artResult?.artifact) {
              setStageStates(prev => {
                const cur = prev[s];
                if (!cur || cur.status === 'completed') return prev;
                // 检查 artifact 是否含有效内容
                const hasDone = hasDoneArtifactItems(artResult.artifact);
                if (hasDone) {
                  return { ...prev, [s]: { ...cur, status: 'waiting', artifact: artResult.artifact, error: null, progressMessage: '已停止（保留已完成内容）' } };
                }
                return prev;
              });
            }
          } catch { /* 该阶段无 artifact，跳过 */ }
        }
      }, 500);
    }
  };

  // ── 执行单个阶段 ──
  const runStage = async (sid: string, stageId: string, inputData: Record<string, any>) => {
    if (stoppedRef.current) throw new Error('Stopped');
    updateStageState(stageId, { status: 'running', progress: 0, progressMessage: '启动中...', error: null });
    setActiveStage(stageId);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await executeStage(sid, stageId, inputData, controller.signal);

      for await (const event of parseStreamEvents(response)) {
        if (event.type === 'progress') {
          updateStageState(stageId, {
            progress: event.percent || 0,
            progressMessage: event.message || '',
          });
          // 处理素材预览和逐个完成事件
          if (event.data?.assets_preview) {
            updateStageState(stageId, { artifact: event.data.assets_preview });
          }
          if (event.data?.asset_complete) {
            const assetUpdate = event.data.asset_complete;
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact;
              if (!prevArt) return prev;
              const key = assetUpdate.type as string;
              const items = [...(prevArt[key] || [])];
              const idx = items.findIndex((item: any) => item.id === assetUpdate.id);
              if (idx >= 0) {
                items[idx] = mergeAssetUpdateItem(items[idx], assetUpdate);
              }
              return {
                ...prev,
                [stageId]: { ...prev[stageId], artifact: { ...prevArt, [key]: items } },
              };
            });
          }
          // 处理剧本逐幕增量事件
          if (event.data?.beat_sheet) {
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact || {};
              return {
                ...prev,
                [stageId]: {
                  ...prev[stageId],
                  artifact: { ...prevArt, phase: 'generating', beat_sheet: event.data.beat_sheet },
                },
              };
            });
          }
          if (event.data?.act_complete) {
            const actData = event.data.act_complete;
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact || {};
              const prevActs = prevArt.completed_acts || [];
              return {
                ...prev,
                [stageId]: {
                  ...prev[stageId],
                  artifact: {
                    ...prevArt,
                    phase: 'generating',
                    completed_acts: [...prevActs, actData],
                  },
                },
              };
            });
          }
          // 处理分镜逐场完成事件
          if (event.data?.scene_shots_complete) {
            const sceneData = event.data.scene_shots_complete;
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact || {};
              const prevShots = prevArt.shots || [];
              return {
                ...prev,
                [stageId]: {
                  ...prev[stageId],
                  artifact: {
                    ...prevArt,
                    phase: 'generating',
                    shots: [...prevShots, ...sceneData.shots],
                  },
                },
              };
            });
          }
        } else if (event.type === 'stage_complete') {
          const newStatus: StageStatus = event.requires_intervention ? 'waiting' : 'completed';

          let artifact = null;
          try {
            const artResult = await getArtifact(sid, stageId);
            artifact = artResult.artifact;
          } catch { /* ignore */ }

          // 如果是后处理阶段，即使 artifact 为空也尝试从事件中读取预览数据
          if (stageId === 'post_production' && !artifact && event.data?.assets_preview) {
            artifact = event.data.assets_preview;
          }

          updateStageState(stageId, {
            status: newStatus,
            progress: 100,
            progressMessage: newStatus === 'waiting' ? '等待确认' : '已完成',
            artifact,
          });
        } else if (event.type === 'error') {
          // 取消/停止类错误：尝试获取部分结果而不是直接报错
          const isCancelError = /cancel|取消|停止/i.test(event.content || '');
          if (isCancelError) {
            let artifact = null;
            try {
              const artResult = await getArtifact(sid, stageId);
              artifact = artResult?.artifact;
            } catch { /* ignore */ }
            // 如果有已完成的内容，显示为 waiting 状态
            const hasDone = hasDoneArtifactItems(artifact);
            if (hasDone) {
              updateStageState(stageId, {
                status: 'waiting',
                progress: 100,
                progressMessage: '已停止（保留已完成内容）',
                artifact,
                error: null,
              });
              return; // 不抛异常，让工作流正常停下
            }
          }
          updateStageState(stageId, {
            status: 'error',
            error: event.content || 'Unknown error',
            progressMessage: '执行失败',
          });
          throw new Error(event.content);
        }
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        updateStageState(stageId, {
          status: 'error',
          error: error.message,
          progressMessage: '执行失败',
        });
      }
      throw error;
    }
  };

  // ── 启动新项目 ──
  const handleStartProject = async (params: ProjectParams, autoOverride?: boolean) => {
    if (isRunning) return;
    stoppedRef.current = false;
    const useAutoMode = autoOverride !== undefined ? autoOverride : autoMode;
    if (autoOverride !== undefined) handleAutoModeChange(autoOverride);
    setIsRunning(true);
    setStageStates(initStageStates());
    setProjectParams(params);

    try {
      const result = await startProject({
        idea: params.idea,
        file_path: params.file_path, // 修复：将上传的文件路径传给后端
        style: params.style,
        video_ratio: params.video_ratio,
        video_resolution: params.video_resolution,
        llm_model: params.llm_model,
        vlm_model: params.vlm_model,
        image_t2i_model: params.image_t2i_model,
        image_it2i_model: params.image_it2i_model,
        video_generation_mode: params.video_generation_mode,
        video_first_frame_model: params.video_first_frame_model,
        video_start_end_model: params.video_start_end_model,
        video_reference_model: params.video_reference_model,
        video_model: params.video_model,
        enable_concurrency: params.enable_concurrency,
        web_search: params.web_search,
        expand_idea: params.expand_idea,
        episodes: params.episodes,
      });
      setSessionId(result.session_id);

      // 添加到历史
      setHistory(prev => [
        {
          id: result.session_id,
          idea: params.idea.slice(0, 60),
          style: params.style,
          date: new Date().toLocaleDateString('zh-CN'),
          status: 'running',
          stages: {},
        },
        ...prev,
      ]);

      const inputData: Record<string, any> = {
        idea: params.idea,
        session_id: result.session_id,
        style: params.style,
        video_ratio: params.video_ratio,
        video_resolution: params.video_resolution,
        llm_model: params.llm_model,
        vlm_model: params.vlm_model,
        image_t2i_model: params.image_t2i_model,
        image_it2i_model: params.image_it2i_model,
        video_generation_mode: params.video_generation_mode,
        video_first_frame_model: params.video_first_frame_model,
        video_start_end_model: params.video_start_end_model,
        video_reference_model: params.video_reference_model,
        video_model: params.video_model,
        scene_number: result.params?.scene_number,
        expand_idea: params.expand_idea,
        enable_concurrency: params.enable_concurrency,
        web_search: params.web_search,
        episodes: params.episodes,
        auto_mode: useAutoMode,
      };

      for (const stageId of STAGE_ORDER) {
        if (stoppedRef.current) break;
        await runStage(result.session_id, stageId, inputData);

        // 剧本生成完成后，用实际场景数更新 scene_number
        if (stageId === 'script_generation') {
          try {
            const artResult = await getArtifact(result.session_id, 'script_generation');
            if (artResult?.artifact?.scenes?.length) {
              inputData.scene_number = artResult.artifact.scenes.length;
            }
          } catch { /* ignore */ }
        }

        const status = await getProjectStatus(result.session_id);
        const stageStatus = status?.status?.[stageId];
        setGlobalStatusMap(status.status || {});
        // waiting: 等待用户介入（如选择角色/图片），不能自动 continue
        // completed: 阶段完成，等待确认进入下一阶段
        if (stageStatus === 'completed' || stageStatus === 'session_completed') {
          if (autoModeRef.current) {
            // 代理模式：自动确认并继续
            await continueWorkflow(result.session_id);
            updateStageState(stageId, { status: 'completed', progressMessage: '已自动确认' });
          } else {
            updateStageState(stageId, { status: 'completed' });
            setActiveStage(stageId);
            setIsRunning(false);
            return;
          }
        } else if (stageStatus === 'waiting') {
          // 用户需要介入，停止自动执行
          updateStageState(stageId, { status: 'waiting' });
          setActiveStage(stageId);
          setIsRunning(false);
          return;
        }
      }
    } catch (error: any) {
      if (!stoppedRef.current) console.error('Workflow error:', error);
    } finally {
      setIsRunning(false);
    }
  };

  // ── 确认阶段并继续 ──
  const handleConfirmStage = async (stageId: string) => {
    if (!sessionId || isRunning) return;
    setIsRunning(true);

    try {
      const result: any = await continueWorkflow(sessionId);
      updateStageState(stageId, { status: 'completed', progressMessage: '已确认' });

      // 更新顶栏状态
      if (result.status_map) {
        setGlobalStatusMap(result.status_map);
      }
      setCompletedStagesFromSession(prev => [...prev, stageId]);
      if (result.next_stage) {
        setCurrentStageFromSession(result.next_stage);
      }

      if (result.next_stage) {
        const idx = STAGE_ORDER.indexOf(stageId);

        // 构建完整的 inputData
        const inputData: Record<string, any> = {
          session_id: sessionId,
          style: projectParams?.style,
          llm_model: projectParams?.llm_model,
          vlm_model: projectParams?.vlm_model,
          image_t2i_model: projectParams?.image_t2i_model,
          image_it2i_model: projectParams?.image_it2i_model,
          video_generation_mode: projectParams?.video_generation_mode,
          video_first_frame_model: projectParams?.video_first_frame_model,
          video_start_end_model: projectParams?.video_start_end_model,
          video_reference_model: projectParams?.video_reference_model,
          video_model: projectParams?.video_model,
          video_ratio: projectParams?.video_ratio,
          video_resolution: projectParams?.video_resolution,
          video_sound: 'on',
          video_shot_type: 'multi',
        };
        // 从剧本产物获取实际场景数
        try {
          const scriptArt = await getArtifact(sessionId, 'script_generation');
          if (scriptArt?.artifact?.scenes?.length) {
            inputData.scene_number = scriptArt.artifact.scenes.length;
          }
        } catch { /* ignore */ }

        // 从参考图产物获取用户选择的图片版本，传递给视频生成阶段
        if (stageId === 'reference_generation') {
          const refArt = stageStates['reference_generation']?.artifact;
          if (refArt?.scenes) {
            const selectedImages: Record<string, string> = {};
            refArt.scenes.forEach((s: any) => {
              if (s.id && s.selected) {
                selectedImages[s.id] = s.selected;
              }
            });
            inputData.selected_images = selectedImages;
          }
        }

        // 从视频产物获取用户选择的视频版本，传递给后期制作阶段
        if (stageId === 'video_generation') {
          const vidArt = stageStates['video_generation']?.artifact;
          if (vidArt?.clips) {
            const selectedClips: Record<string, string> = {};
            vidArt.clips.forEach((c: any) => {
              if (c.id && c.selected) {
                selectedClips[c.id] = c.selected;
              }
            });
            inputData.selected_clips = selectedClips;
          }
        }

        for (let i = idx + 1; i < STAGE_ORDER.length; i++) {
          if (stoppedRef.current) break;
          const nextStage = STAGE_ORDER[i];
          await runStage(sessionId, nextStage, inputData);

          const status = await getProjectStatus(sessionId);
          setGlobalStatusMap(status.status || {});
          const nStageStatus = status?.status?.[nextStage];
          // waiting: 等待用户介入（如选择角色/图片），不能自动 continue
          // completed: 阶段完成，等待确认进入下一阶段，可以自动 continue
          if (nStageStatus === 'completed' || nStageStatus === 'session_completed') {
            if (autoModeRef.current) {
              await continueWorkflow(sessionId);
              updateStageState(nextStage, { status: 'completed', progressMessage: '已自动确认' });
              setCompletedStagesFromSession(prev => [...prev, nextStage]);
              setCurrentStageFromSession(nextStage);
            } else {
              updateStageState(nextStage, { status: 'completed' });
              setCompletedStagesFromSession(prev => [...prev, nextStage]);
              setCurrentStageFromSession(nextStage);
              setActiveStage(nextStage);
              break;
            }
          } else if (nStageStatus === 'waiting') {
            // 用户需要介入，停止自动执行
            updateStageState(nextStage, { status: 'waiting' });
            setCurrentStageFromSession(nextStage);
            setActiveStage(nextStage);
            break;
          }
        }
      }
    } catch (error: any) {
      console.error('Continue error:', error);
    } finally {
      setIsRunning(false);
    }
  };

  // ── 用户介入修改 ──
  const handleIntervene = async (stageId: string, modifications: Record<string, any>) => {
    if (!sessionId) return;
    const isBackgroundItemRegeneration =
      (stageId === 'character_design' && (
        Array.isArray(modifications.regenerate_characters) ||
        Array.isArray(modifications.regenerate_settings)
      )) ||
      (stageId === 'reference_generation' && Array.isArray(modifications.regenerate_scenes)) ||
      (stageId === 'video_generation' && Array.isArray(modifications.regenerate_clips));
    
    // 构建完整的 inputData 传给后端，确保比例等参数能传递
    const inputData: Record<string, any> = {
      ...modifications,
      session_id: sessionId,
      style: projectParams?.style,
      video_ratio: projectParams?.video_ratio,
      video_resolution: projectParams?.video_resolution,
      llm_model: projectParams?.llm_model,
      vlm_model: projectParams?.vlm_model,
      image_t2i_model: projectParams?.image_t2i_model,
      image_it2i_model: projectParams?.image_it2i_model,
      video_generation_mode: projectParams?.video_generation_mode,
      video_first_frame_model: projectParams?.video_first_frame_model,
      video_start_end_model: projectParams?.video_start_end_model,
      video_reference_model: projectParams?.video_reference_model,
      video_model: projectParams?.video_model,
      video_sound: 'on',
      video_shot_type: 'multi',
    };

    // 设置 running 状态以便显示进度条（如 Logline 选择后生成剧本）
    // 若选择了 Logline，将其保存到 artifact 以便 ScriptStage 在生成期间展示
    // 若选择了模式，保留已选 Logline 并设置 generating 状态
    const artifactPatch = modifications.selected_logline
      ? { phase: 'generating', selected_logline: modifications.selected_logline }
      : modifications.selected_mode
        ? { phase: 'generating', selected_logline: stageStates[stageId]?.artifact?.selected_logline }
        : undefined;
    if (!isBackgroundItemRegeneration) {
      setIsRunning(true);
      updateStageState(stageId, { status: 'running', progress: 0, progressMessage: '处理中...', ...(artifactPatch ? { artifact: artifactPatch } : {}) });
    } else if (artifactPatch) {
      updateStageState(stageId, { artifact: artifactPatch });
    }
    try {
      const response = await intervene(sessionId, stageId, inputData);
      for await (const event of parseStreamEvents(response)) {
        if (event.type === 'progress') {
          if (!isBackgroundItemRegeneration) {
            updateStageState(stageId, {
              progress: event.percent || 0,
              progressMessage: event.message || '',
            });
          }
          // 处理 asset_complete 实时事件
          if (event.data?.asset_complete) {
            const assetUpdate = event.data.asset_complete;
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact;
              if (!prevArt) return prev;
              const key = assetUpdate.type as string;
              const items = [...(prevArt[key] || [])];
              const idx = items.findIndex((item: any) => item.id === assetUpdate.id);
              if (idx >= 0) {
                items[idx] = mergeAssetUpdateItem(items[idx], assetUpdate);
              }
              return {
                ...prev,
                [stageId]: { ...prev[stageId], artifact: { ...prevArt, [key]: items } },
              };
            });
          }
          // 处理剧本逐幕增量事件 (介入模式)
          if (event.data?.beat_sheet) {
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact || {};
              return {
                ...prev,
                [stageId]: {
                  ...prev[stageId],
                  artifact: { ...prevArt, phase: 'generating', beat_sheet: event.data.beat_sheet },
                },
              };
            });
          }
          if (event.data?.act_complete) {
            const actData = event.data.act_complete;
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact || {};
              const prevActs = prevArt.completed_acts || [];
              return {
                ...prev,
                [stageId]: {
                  ...prev[stageId],
                  artifact: {
                    ...prevArt,
                    phase: 'generating',
                    completed_acts: [...prevActs, actData],
                  },
                },
              };
            });
          }
          // 处理分镜逐场完成事件 (介入模式)
          if (event.data?.scene_shots_complete) {
            const sceneData = event.data.scene_shots_complete;
            setStageStates(prev => {
              const prevArt = prev[stageId]?.artifact || {};
              const prevShots = prevArt.shots || [];
              return {
                ...prev,
                [stageId]: {
                  ...prev[stageId],
                  artifact: {
                    ...prevArt,
                    phase: 'generating',
                    shots: [...prevShots, ...sceneData.shots],
                  },
                },
              };
            });
          }
        } else if (event.type === 'stage_complete') {
          const artResult = await getArtifact(sessionId, stageId);
          if (isBackgroundItemRegeneration) {
            updateStageState(stageId, { artifact: artResult.artifact });
          } else {
            updateStageState(stageId, { artifact: artResult.artifact, status: 'waiting' });
          }
        } else if (event.type === 'error') {
          console.error('Intervention error:', event.content);
        }
      }
    } catch (error: any) {
      console.error('Intervention error:', error);
    } finally {
      if (!isBackgroundItemRegeneration) {
        setIsRunning(false);
      }
    }
  };

  // ── 本地更新产物（不触发服务端调用） ──
  const handleUpdateArtifact = (stageId: string, patch: Record<string, any>) => {
    setStageStates(prev => ({
      ...prev,
      [stageId]: {
        ...prev[stageId],
        artifact: { ...(prev[stageId]?.artifact || {}), ...patch },
      },
    }));
  };

  // ── 保存用户选择到服务端 ──
  const handleSaveSelections = async (stageId: string, selections: Record<string, any>): Promise<void> => {
    if (!sessionId) return;
    try {
      // 构建更新: 把用户选择写回 artifact 中每个 item 的 selected 字段
      const art = stageStates[stageId]?.artifact;
      if (!art) return;

      let patch: Record<string, any> = {};
      if (stageId === 'script_generation') {
        // 剧本阶段：直接保存整个 data 覆盖 artifact
        patch = selections;
      } else if (stageId === 'character_design') {
        const { _editDescs, ...restSelections } = selections;
        const chars = (art.characters || []).map((c: any) => ({
          ...c,
          selected: restSelections[c.id] || c.selected,
          description: _editDescs?.characters?.[c.id] ?? c.description,
        }));
        const sets = (art.settings || []).map((s: any) => ({
          ...s,
          selected: restSelections[s.id] || s.selected,
          description: _editDescs?.settings?.[s.id] ?? s.description,
        }));
        patch = { characters: chars, settings: sets };
      } else if (stageId === 'storyboard') {
        // 分镜阶段：保存 shots 数据（排除 original_shots，只保留 artifact 需要的字段）
        const { original_shots, ...rest } = selections;
        patch = { ...rest, user_modified: true };
      } else if (stageId === 'reference_generation') {
        const { _editDescs, ...restSelections } = selections;
        const scenes = (art.scenes || []).map((s: any) => ({
          ...s,
          selected: restSelections[s.id] || s.selected,
          description: _editDescs?.[s.id] ?? s.description,
        }));
        patch = { scenes };
      } else if (stageId === 'video_generation') {
        const { _editDescs, ...restSelections } = selections;
        const clips = (art.clips || []).map((c: any) => ({
          ...c,
          selected: restSelections[c.id] || c.selected,
          description: _editDescs?.[c.id] ?? c.description,
        }));
        patch = { clips };
      }

      // 本地更新
      handleUpdateArtifact(stageId, patch);

      // 服务端持久化
      await saveSelections(sessionId, stageId, patch);
      // 保存成功后标记为已完成，顶栏显示对勾
      updateStageState(stageId, { status: 'completed' });

      // 如果是分镜阶段保存，刷���第3和第4阶段的 artifact
      console.log('[handleSaveSelections] stageId:', stageId, 'patch:', patch);
      if (stageId === 'storyboard') {
        // 更新本地 artifact 以清除 is_new 标记
        handleUpdateArtifact(stageId, patch);

        // 获取第4阶段当前已有 artifact
        const oldRefArtifact = stageStates['reference_generation']?.artifact;
        const oldScenes = (oldRefArtifact?.scenes || []) as any[];
        const oldScenesMap = new Map(oldScenes.map((s: any) => [s.id, s]));

        // 使用 segments 构建第4阶段 scenes 和第5阶段 clips
        const sourceSegments = patch.segments || [];
        console.log('[handleSaveSelections] sourceSegments:', sourceSegments);
        
        const newScenes = sourceSegments.map((seg: any, idx: number) => {
          const seg_id = seg.segment_id;
          const oldScene = oldScenesMap.get(seg_id) as any;
          const isNew = seg.is_new;
          
          const shots = seg.shots || [];
          const desc_ref = shots.map((sh: any) => sh.visual_prompt || sh.plot || sh.content || '').join(' ').trim();
          
          return {
            id: seg_id,
            name: `片段_${seg_id}`,
            index: idx + 1,
            description: desc_ref,
            selected: isNew ? '' : (oldScene?.selected || ''),
            versions: isNew ? [] : (oldScene?.versions || []),
            status: isNew ? 'pending' : 'done',
          };
        });

        // 更新第4阶段的 artifact
        updateStageState('reference_generation', {
          artifact: { session_id: sessionId, scenes: newScenes },
          status: 'completed'
        });

        // 同步更新第5阶段（video_generation）
        const oldVidArtifact = stageStates['video_generation']?.artifact;
        const oldClips = (oldVidArtifact?.clips || []) as any[];
        const oldClipsMap = new Map(oldClips.map((c: any) => [c.id, c]));

        const newClips = sourceSegments.map((seg: any, idx: number) => {
          const seg_id = seg.segment_id;
          const oldClip = oldClipsMap.get(seg_id) as any;
          
          const shots = seg.shots || [];
          const desc_video = shots.map((sh: any) => sh.plot || sh.content || '').join(' ').trim();
          const total_dur = seg.total_duration || shots.reduce((acc: number, sh: any) => acc + (sh.duration || 0), 0) || 10;

          return {
            id: seg_id,
            name: `片段_${seg_id}`,
            index: idx + 1,
            description: desc_video,
            duration: total_dur,
            selected: oldClip?.selected || '',
            versions: oldClip?.versions || [],
            status: 'pending',
          };
        });

        // 更新第5阶段的 artifact
        updateStageState('video_generation', {
          artifact: { session_id: sessionId, clips: newClips },
          status: 'completed'
        });
        console.log('[handleSaveSelections] 第5阶段已更新');
      }
    } catch (error) {
      console.error('Save selections error:', error);
      throw error; // 抛出让 StageActions 捕获以恢复按钮状态
    }
  };

  // ── 重新生成当前阶段 ──
  const handleRegenerate = async (stageId: string) => {
    if (!sessionId || isRunning) return;
    stoppedRef.current = false;
    setIsRunning(true);

    // 清空当前阶段状态
    updateStageState(stageId, {
      status: 'running',
      progress: 0,
      progressMessage: '重新生成中...',
      artifact: null,
      error: null,
    });

    // 将该阶段之后的所有阶段重置为 pending
    const idx = STAGE_ORDER.indexOf(stageId);
    for (let i = idx + 1; i < STAGE_ORDER.length; i++) {
      updateStageState(STAGE_ORDER[i], {
        status: 'pending',
        progress: 0,
        progressMessage: '',
        artifact: null,
        error: null,
      });
    }

    try {
      const inputData: Record<string, any> = {
        session_id: sessionId,
        style: projectParams?.style,
        llm_model: projectParams?.llm_model,
        vlm_model: projectParams?.vlm_model,
        image_t2i_model: projectParams?.image_t2i_model,
        image_it2i_model: projectParams?.image_it2i_model,
        video_generation_mode: projectParams?.video_generation_mode,
        video_first_frame_model: projectParams?.video_first_frame_model,
        video_start_end_model: projectParams?.video_start_end_model,
        video_reference_model: projectParams?.video_reference_model,
        video_model: projectParams?.video_model,
        video_ratio: projectParams?.video_ratio,
        video_resolution: projectParams?.video_resolution,
      };

      // 尝试获取场景数
      try {
        const scriptArt = await getArtifact(sessionId, 'script_generation');
        if (scriptArt?.artifact?.scenes?.length) {
          inputData.scene_number = scriptArt.artifact.scenes.length;
        }
      } catch { /* ignore */ }

      await runStage(sessionId, stageId, inputData);

      const status = await getProjectStatus(sessionId);
      if (status?.status?.[stageId] === 'waiting') {
        updateStageState(stageId, { status: 'waiting' });
        setActiveStage(stageId);
      }
    } catch (error: any) {
      if (!stoppedRef.current) console.error('Regenerate error:', error);
    } finally {
      setIsRunning(false);
    }
  };

  // ── 恢复历史项目 ──
  const handleResumeProject = async (sid: string, targetStage: string | null = null) => {
    // 如果正在执行的就是同一个项目，直接恢复视图，不重置状态
    if (sid === sessionId) {
      const runningStage = STAGE_ORDER.find(s => stageStates[s]?.status === 'running');
      const waitingStage = STAGE_ORDER.find(s => stageStates[s]?.status === 'waiting');
      const lastCompleted = [...STAGE_ORDER].reverse().find(s => stageStates[s]?.status === 'completed');
      setActiveStage(targetStage || runningStage || waitingStage || lastCompleted || STAGE_ORDER[0]);
      return;
    }

    setSessionId(sid);
    // 更新 URL 参数（包含阶段）
    const stageParam = targetStage ? `&stage=${targetStage}` : '';
    router.push(`/?session=${sid}${stageParam}`);
    try {
      let status: any;
      try {
        status = await getProjectStatus(sid);
      } catch {
        status = await getProjectStatusFromDisk(sid);
      }
      setGlobalStatusMap(status.status || {});
      const newStates = initStageStates();
      const stMap = status.status || {};
      const allStatusStages = Object.keys(stMap);
      const currentStage = status.current_stage;
      
      // 保存到 state 供顶栏流程图使用
      setCurrentStageFromSession(currentStage || null);
      const completedStages = allStatusStages.filter(k => ["completed", "session_completed"].includes(stMap[k]));
      setCompletedStagesFromSession(completedStages);

      for (const sName of allStatusStages) {
        const cStatus = stMap[sName];
        if (cStatus === 'pending' || cStatus === 'idle') {
          // 即使是 pending，如果 artifacts 中有数据，也尝试恢复数据（用于初始占位显示）
          if (status.artifacts?.[sName]) {
            newStates[sName].artifact = status.artifacts[sName];
          }
          continue;
        }

        const isCompleted = ["completed", "session_completed"].includes(cStatus);
        const isError = cStatus === 'error';
        const isWaiting = cStatus === 'waiting';
        const isStopped = cStatus === 'stopped';
        const isRunningStatus = cStatus === 'running';
        const progressSnapshot = getStageProgressSnapshot(status, sName);

        newStates[sName] = {
          status: isError ? 'error' : (isWaiting ? 'waiting' : (isStopped ? 'stopped' : (isCompleted ? 'completed' : 'running'))),
          progress: isCompleted ? 100 : (typeof progressSnapshot.progress === 'number' ? progressSnapshot.progress : 0),
          progressMessage: isError
            ? '执行失败'
            : (isWaiting
              ? '等待确认'
              : (isStopped
                ? '已停止'
                : (isCompleted
                  ? '已完成'
                  : (progressSnapshot.progressMessage || (isRunningStatus ? '执行中...' : '进行中'))))),
          artifact: status.artifacts?.[sName] || null,
          error: isError ? (status.error || '执行出错') : (isStopped ? '手动停止' : null),
        };
        
        // 如果内存中没有，尝试异步拉取
        if (!newStates[sName].artifact) {
          try {
            const artResult = await getArtifact(sid, sName);
            newStates[sName].artifact = artResult.artifact;
          } catch { /* ignore */ }
        }
      }

      // 恢复项目参数：会话级生成配置统一从 meta 中读取，兼容少量旧扁平字段。
      const meta = ((status as any).meta || {}) as any;
      const s = Object.keys(meta).length > 0 ? meta : (status as any);
      if (s.idea || s.user_textbox_input) {
        // Legacy session compatibility: old sessions only stored one video_model, so hydrate it as the first-frame model.
        const restoredFirstFrameVideoModel = s.video_first_frame_model || s.video_model || '';
        setProjectParams({
          idea: s.idea || s.user_textbox_input || '',
          style: s.style || '',
          video_ratio: s.video_ratio || '16:9',
          video_resolution: s.video_resolution || '720P',
          llm_model: s.llm_model || '',
          vlm_model: s.vlm_model || '',
          image_t2i_model: s.image_t2i_model || '',
          image_it2i_model: s.image_it2i_model || '',
          video_generation_mode: s.video_generation_mode || 'first_frame',
          video_first_frame_model: restoredFirstFrameVideoModel,
          video_start_end_model: s.video_start_end_model || 'wan2.7-i2v',
          video_reference_model: s.video_reference_model || 'wan2.7-r2v',
          video_model: s.video_model || '',
          expand_idea: s.expand_idea || false,
          enable_concurrency: s.enable_concurrency || false,
          web_search: s.web_search || false,
        });
      }

      // 确定要显示的阶段（优先使用 URL 中的目标阶段）
      let finalStage = targetStage;
      if (!finalStage) {
        finalStage = currentStage || (completedStages.length > 0 ? completedStages[completedStages.length - 1] : STAGE_ORDER[0]);
      }
      setActiveStage(finalStage);
      setStageStates(newStates);

      // 轮询正在执行的阶段；后台单卡重生成时阶段可能不是 running，但 item 会是 running。
      for (const stageId of STAGE_ORDER) {
        if (stMap[stageId] === 'running' || hasRunningArtifactItems(status.artifacts?.[stageId])) {
          pollForCompletion(sid, stageId);
        }
      }
    } catch {
      setActiveStage(STAGE_ORDER[0]);
    }
  };

  // ── 返回首页 ──
  // 处理阶段点击，更新 URL
  const handleStageClick = (stage: string) => {
    setActiveStage(stage);
    if (sessionId) {
      router.push(`/?session=${sessionId}&stage=${stage}`);
    }
  };

  const handleGoHome = () => {
    setActiveStage(null);
    router.push('/');
  };

  // ── 删除历史记录 ──
  const handleDeleteSession = async (sid: string) => {
    await deleteSession(sid);
    setHistory(prev => prev.filter(h => h.id !== sid));
  };

  // ── 模型配置变更处理 ──
  const handleModelConfigChange = (config: ModelConfig) => {
    setProjectParams(prev => prev ? { ...prev, ...config } : null);
    // 同步到后端会话元数据
    if (sessionId) {
      const payload: Record<string, any> = { ...config };
      updateModels(sessionId, payload).catch(console.error);
    }
  };

  // 构建 modelConfig for TopBar
  const modelConfig: ModelConfig | undefined = projectParams
    ? {
        llm_model: projectParams.llm_model,
        vlm_model: projectParams.vlm_model,
        image_t2i_model: projectParams.image_t2i_model,
        image_it2i_model: projectParams.image_it2i_model,
        // Legacy session compatibility: projectParams may come from an old session with only video_model.
        video_generation_mode: projectParams.video_generation_mode || 'first_frame',
        video_first_frame_model: projectParams.video_first_frame_model || projectParams.video_model,
        video_start_end_model: projectParams.video_start_end_model || 'wan2.7-i2v',
        video_reference_model: projectParams.video_reference_model || 'wan2.7-r2v',
        video_model: projectParams.video_model,
        video_ratio: projectParams.video_ratio,
        video_resolution: projectParams.video_resolution || '720P',
        enable_concurrency: projectParams.enable_concurrency || false,
        // web_search: projectParams.web_search || false,
        // expand_idea: projectParams.expand_idea || false,
      }
    : undefined;

  // ── 计算 stageStatuses for TopBar ──
  // 直接根据后端返回的 status 数据计算图标状态
  const [globalStatusMap, setGlobalStatusMap] = useState<Record<string, string>>({});
  
  const stageStatuses: Record<string, StageStatus> = {};

  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const s = STAGE_ORDER[i];
    const backendStatus = globalStatusMap[s]; // get status from global mapping updated from backend

    if (backendStatus === 'completed') {
      stageStatuses[s] = 'completed';
    } else if (backendStatus === 'waiting') {
      stageStatuses[s] = 'waiting';
    } else if (backendStatus === 'running') {
      stageStatuses[s] = 'running';
    } else if (backendStatus === 'error') {
      stageStatuses[s] = 'error';
    } else {
      stageStatuses[s] = 'pending';
    }
  }

  // ── 计算项目状态 ──
  // 后端阶段状态: pending, running, waiting, completed, stopped, error
  // 前端 StageStatus: pending, running, waiting, completed, error
  const hasRunning = Object.values(stageStates).some(s => s.status === 'running');
  const hasWaiting = Object.values(stageStates).some(s => s.status === 'waiting');
  const hasError = Object.values(stageStates).some(s => s.status === 'error');
  const allCompleted = Object.values(stageStates).every(s => s.status === 'completed' || s.status === 'pending');
  const effectiveIsRunning = isRunning || hasRunning;

  let computedStatus: string;
  if (hasRunning) computedStatus = 'running';
  else if (hasWaiting) computedStatus = 'waiting';
  else if (hasError) computedStatus = 'error';
  // Check if stopped in stageStates
  else if (Object.values(stageStates).some(s => s.status === 'stopped')) computedStatus = 'stopped';
  else if (allCompleted && stageStates[STAGE_ORDER[STAGE_ORDER.length - 1]]?.status === 'completed') {
    computedStatus = 'completed';
  } else if (allCompleted) {
    computedStatus = 'completed';
  } else {
    computedStatus = Object.values(stageStates).some(s => s.status === 'stopped') ? 'stopped' : 'pending';
  }

  const projectStatus = sessionId ? computedStatus : undefined;

  // ── 渲染阶段内容 ──
  const renderStageContent = () => {
    if (!activeStage) return null;
    const Component = STAGE_COMPONENTS[activeStage];
    if (!Component) return null;

    const state = stageStates[activeStage];

    // 判断后续阶段是否已执行过：如有，则隐藏"确认并继续"
    const idx = STAGE_ORDER.indexOf(activeStage);
    const hasSubsequentExecution = STAGE_ORDER.slice(idx + 1).some(
      s => stageStates[s]?.status && stageStates[s].status !== 'pending'
    );
    const showConfirm = !hasSubsequentExecution;

    // 计算是否有待生成的项（阶段2、4、5）
    let hasPendingItems = false;
    if (activeStage === 'character_design') {
      const chars = state?.artifact?.characters || [];
      const sets = state?.artifact?.settings || [];
      hasPendingItems = chars.some((c: any) => !c.selected) || sets.some((s: any) => !s.selected);
    } else if (activeStage === 'reference_generation') {
      const scenes = state?.artifact?.scenes || [];
      hasPendingItems = scenes.some((s: any) => !s.selected);
    } else if (activeStage === 'video_generation') {
      const clips = state?.artifact?.clips || [];
      // 检查是否有未选中的 clips
      const hasUnselected = clips.some((c: any) => !c.selected);
      // 检查参考图阶段的 scenes 数量是否大于 video clips 数量
      // 如果是，说明有新分镜需要生成
      const refScenes = stageStates['reference_generation']?.artifact?.scenes || [];
      const hasNewShots = refScenes.length > clips.length;
      hasPendingItems = hasUnselected || hasNewShots;
    }

    // 计算后续阶段是否已开始（阶段1、3）
    const hasNextStageStarted = hasSubsequentExecution;

    // 传递第4阶段的 artifact 到第5阶段用于依赖检查
    const referenceArtifact = activeStage === 'video_generation'
      ? stageStates['reference_generation']?.artifact
      : undefined;

    // 传递第1阶段的 artifact 到第4、5、6阶段用于获取剧集标题
    const scriptArtifact = (activeStage === 'reference_generation' || activeStage === 'video_generation' || activeStage === 'post_production')
      ? stageStates['script_generation']?.artifact
      : undefined;

    return (
      <Component
        state={state}
        sessionId={sessionId || ''}
        onConfirm={() => handleConfirmStage(activeStage)}
        onIntervene={(mods: Record<string, any>) => handleIntervene(activeStage, mods)}
        onRegenerate={() => handleRegenerate(activeStage)}
        onUpdateArtifact={(patch: Record<string, any>) => handleUpdateArtifact(activeStage, patch)}
        onSaveSelections={(selections: Record<string, any>) => handleSaveSelections(activeStage, selections)}
        showConfirm={showConfirm}
        isRunning={effectiveIsRunning}
        hasPendingItems={hasPendingItems}
        hasNextStageStarted={hasNextStageStarted}
        referenceArtifact={referenceArtifact}
        scriptArtifact={scriptArtifact}
        artifacts={Object.keys(stageStates).reduce((acc: any, key) => {
          acc[key] = stageStates[key].artifact;
          return acc;
        }, {})}
      />
    );
  };

  const showHome = activeStage === null;

  return (
    <div className="flex h-screen w-full min-w-0 flex-col bg-gray-50/50">
      <TopBar
        activeStage={activeStage}
        stageStatuses={stageStatuses}
        onStageClick={handleStageClick}
        onHomeClick={handleGoHome}
        hasSession={sessionId !== null}
        isRunning={effectiveIsRunning}
        onStop={handleStop}
        autoMode={autoMode}
        onAutoModeChange={handleAutoModeChange}
        modelConfig={modelConfig}
        onModelConfigChange={handleModelConfigChange}
        projectStatus={projectStatus}
      />

      <main className="flex-1 min-w-0 overflow-hidden">
        {showHome ? (
          <HomePage
            onStartProject={handleStartProject}
            onResumeProject={handleResumeProject}
            onDeleteSession={handleDeleteSession}
            history={history}
          />
        ) : (
          renderStageContent()
        )}
      </main>
    </div>
  );
}
