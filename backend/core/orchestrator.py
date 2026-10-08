# -*- coding: utf-8 -*-
"""
核心编排器 / 工作流引擎
管理六阶段状态机，协调各智能体执行，支持用户在任意阶段介入
"""

import asyncio
import copy
import json
import logging
import os
import re
import shutil
import threading
import time
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

from core.agents import (
    CharacterDesignerAgent,
    ReferenceGeneratorAgent,
    ScriptWriterAgent,
    StoryboardAgent,
    VideoDirectorAgent,
    VideoEditorAgent,
)

logger = logging.getLogger(__name__)
ARTIFACT_IMAGE_LIMIT = 25 * 1024 * 1024
UPLOAD_CHUNK_SIZE = 1024 * 1024
SAFE_ARTIFACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class WorkflowStage(str, Enum):
    """工作流阶段"""
    INIT = "init"
    SCRIPT_GENERATION = "script_generation"
    CHARACTER_DESIGN = "character_design"
    STORYBOARD = "storyboard"
    REFERENCE_GENERATION = "reference_generation"
    VIDEO_GENERATION = "video_generation"
    POST_PRODUCTION = "post_production"
    COMPLETED = "completed"


STAGE_ORDER = [
    WorkflowStage.SCRIPT_GENERATION,
    WorkflowStage.CHARACTER_DESIGN,
    WorkflowStage.STORYBOARD,
    WorkflowStage.REFERENCE_GENERATION,
    WorkflowStage.VIDEO_GENERATION,
    WorkflowStage.POST_PRODUCTION,
]

SESSION_META_KEYS = (
    "idea",
    "user_textbox_input",
    "style",
    "video_ratio",
    "video_resolution",
    "expand_idea",
    "llm_model",
    "vlm_model",
    "image_t2i_model",
    "image_it2i_model",
    "video_model",
    "video_first_frame_model",
    "video_start_end_model",
    "video_reference_model",
    "video_generation_mode",
    "video_style",
    "enable_concurrency",
    "web_search",
    "episodes",
)


def _normalize_meta_value(value: Any) -> Any:
    if isinstance(value, str):
        lower = value.lower()
        if lower == "true":
            return True
        if lower == "false":
            return False
    return value


def _extract_session_meta(data: Dict[str, Any]) -> Dict[str, Any]:
    """Restore session-level generation params from nested or legacy flat storage."""
    meta: Dict[str, Any] = {}
    nested_meta = data.get("meta")
    if isinstance(nested_meta, dict):
        meta.update({k: _normalize_meta_value(v) for k, v in nested_meta.items() if v is not None})
    # Legacy session compatibility: old session JSON stored these fields at the root instead of under meta.
    for key in SESSION_META_KEYS:
        if key not in meta and key in data and data[key] is not None:
            meta[key] = _normalize_meta_value(data[key])
    return meta


class WorkflowState:
    """工作流状态"""

    # 阶段状态说明：
    # - pending: 阶段还没有产物，也没有在运行
    # - running: 阶段正在执行
    # - waiting: 阶段已产出内容，但需要用户介入（如选择角色、选择图片等）
    # - completed: 阶段已完成，可进入下一阶段
    # - stopped: 阶段被用户手动停止
    # - error: 阶段执行中遇到错误

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.current_stage: WorkflowStage = WorkflowStage.INIT
        self.status: Dict[str, str] = {
            stage.value: "pending" for stage in WorkflowStage if stage != WorkflowStage.INIT and stage != WorkflowStage.COMPLETED
        }
        self.artifacts: Dict[str, Any] = {}
        self.error: Optional[str] = None
        self.started_at: Optional[datetime] = None
        self.updated_at: datetime = datetime.now()
        self.meta: Dict[str, Any] = {}
        self.stage_progress: Dict[str, Dict[str, Any]] = {}

    def to_dict(self) -> Dict:
        return {
            "session_id": self.session_id,
            "current_stage": self.current_stage.value,
            "status": copy.deepcopy(self.status),
            "error": self.error,
            "artifacts": copy.deepcopy(self.artifacts),
            "meta": copy.deepcopy(self.meta),
            "stage_progress": copy.deepcopy(self.stage_progress),
            "updated_at": self.updated_at,
        }


class WorkflowEngine:
    """工作流引擎 - 管理六阶段状态机"""

    def __init__(self):
        self.agent_factories = {
            WorkflowStage.SCRIPT_GENERATION: ScriptWriterAgent,
            WorkflowStage.CHARACTER_DESIGN: CharacterDesignerAgent,
            WorkflowStage.STORYBOARD: StoryboardAgent,
            WorkflowStage.REFERENCE_GENERATION: ReferenceGeneratorAgent,
            WorkflowStage.VIDEO_GENERATION: VideoDirectorAgent,
            WorkflowStage.POST_PRODUCTION: VideoEditorAgent,
        }
        self.sessions: Dict[str, WorkflowState] = {}
        self._stop_events: Dict[str, threading.Event] = {}
        self._active_sessions: Set[str] = set()
        self._background_tasks: Set[Any] = set()
        self._state_lock = threading.RLock()
        self._session_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..', 'code', 'data', 'sessions'
        )
        os.makedirs(self._session_dir, exist_ok=True)
        self._load_sessions_from_disk()

    def get_or_create_state(self, session_id: str) -> WorkflowState:
        with self._state_lock:
            if session_id not in self.sessions:
                loaded_state = self.get_state(session_id)
                if loaded_state is None:
                    self.sessions[session_id] = WorkflowState(session_id=session_id)
            if session_id not in self._stop_events:
                self._stop_events[session_id] = threading.Event()
            return self.sessions[session_id]

    def get_state(self, session_id: str) -> Optional[WorkflowState]:
        with self._state_lock:
            # 先从内存中获取
            if session_id in self.sessions:
                return self.sessions[session_id]

            # 内存中没有，从磁盘加载
            path = os.path.join(self._session_dir, f"{session_id}.json")
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        data = json.load(f)

                    # 从磁盘数据恢复 WorkflowState
                    state = WorkflowState(session_id=session_id)
                    
                    stage_str = data.get('current_stage')
                    state.current_stage = WorkflowStage(stage_str) if stage_str else WorkflowStage.INIT
                    
                    loaded_status = data.get('status')
                    if isinstance(loaded_status, str):
                        stages_completed = data.get('stages_completed', [])
                        for stage in WorkflowStage:
                            if stage != WorkflowStage.INIT and stage != WorkflowStage.COMPLETED:
                                if stage.value in stages_completed:
                                    state.status[stage.value] = "completed"
                                elif stage.value == state.current_stage.value:
                                    state.status[stage.value] = loaded_status
                                else:
                                    state.status[stage.value] = "pending"
                    elif isinstance(loaded_status, dict):
                        state.status = loaded_status

                    state.artifacts = data.get('artifacts', {})
                    state.stage_progress = data.get('stage_progress', {})
                    state.meta = _extract_session_meta(data)
                    state.updated_at = data.get('updated_at', 0)

                    # 缓存到内存
                    self.sessions[session_id] = state
                    return state
                except json.JSONDecodeError as e:
                    logger.warning(f"Session file {session_id} is corrupted, ignoring: {e}")
                except Exception as e:
                    logger.warning(f"Failed to load session {session_id} from disk: {e}")

        return None

    def get_stop_event(self, session_id: str) -> threading.Event:
        with self._state_lock:
            if session_id not in self._stop_events:
                self._stop_events[session_id] = threading.Event()
            return self._stop_events[session_id]

    def create_session(self, session_id: str, meta: Dict[str, Any]) -> Dict[str, Any]:
        """Create or initialize a workflow session through the engine-owned state."""
        with self._state_lock:
            session_path = os.path.join(self._session_dir, f"{session_id}.json")
            if session_id in self.sessions or os.path.exists(session_path):
                raise ValueError(f"Session already exists: {session_id}")
            state = WorkflowState(session_id=session_id)
            self.sessions[session_id] = state
            self._stop_events[session_id] = threading.Event()
            state.started_at = datetime.now()
            state.status[state.current_stage.value] = "completed"
            state.meta = copy.deepcopy(meta)
            state.updated_at = datetime.now()
            try:
                self.save_session_to_disk(session_id, meta)
            except Exception:
                self.sessions.pop(session_id, None)
                self._stop_events.pop(session_id, None)
                raise
            return {
                "session_id": session_id,
                "status": copy.deepcopy(state.status),
                "meta": copy.deepcopy(state.meta),
            }

    def get_status_snapshot(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Return a deep-copied session snapshot from the unified in-memory state."""
        with self._state_lock:
            state = self.get_state(session_id)
            return state.to_dict() if state else None

    def get_artifact_snapshot(self, session_id: str, stage: str) -> Optional[Any]:
        """Return a deep-copied artifact snapshot from the unified in-memory state."""
        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")
            artifact = state.artifacts.get(stage)
            return copy.deepcopy(artifact) if artifact is not None else None

    def update_session_meta(self, session_id: str, updates: Dict[str, Any], allowed_keys: tuple[str, ...]) -> Dict[str, Any]:
        """Update session-level generation settings through the engine-owned meta store."""
        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")
            if not state.meta:
                state.meta = {}
            for key in allowed_keys:
                if key in updates:
                    state.meta[key] = updates[key]
            state.updated_at = datetime.now()
            self.save_session_to_disk(session_id)
            return {"status": "ok", "meta": copy.deepcopy(state.meta)}

    def prepare_stage_execution(self, session_id: str, stage: str, body: Dict[str, Any]) -> tuple[WorkflowState, Dict[str, Any]]:
        """Build stage input from current meta/artifacts without exposing mutable state to routers."""
        with self._state_lock:
            state = self.get_or_create_state(session_id)
            input_data = copy.deepcopy(body) if isinstance(body, dict) else {}
            input_data["session_id"] = session_id

            for key, value in copy.deepcopy(state.meta).items():
                if value is not None and (key not in input_data or not input_data[key]):
                    input_data[key] = value
            self._inject_user_selections(copy.deepcopy(state.artifacts), stage, input_data)
            return state, input_data

    def prepare_intervention_execution(
        self,
        session_id: str,
        stage: str,
        modifications: Dict[str, Any],
    ) -> tuple[WorkflowState, Dict[str, Any]]:
        """Build intervention input from the latest artifact/meta snapshot."""
        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")

            current_artifact = copy.deepcopy(state.artifacts.get(stage, {}))
            input_data = current_artifact if isinstance(current_artifact, dict) else {}
            input_data["session_id"] = session_id
            for key, value in copy.deepcopy(state.meta).items():
                if value is not None and key not in input_data:
                    input_data[key] = value
            self._inject_user_selections(copy.deepcopy(state.artifacts), stage, input_data)
            input_data.update(modifications or {})
            return state, input_data

    @staticmethod
    def _inject_user_selections(artifacts: Dict[str, Any], stage: str, data: Dict[str, Any]):
        """Inject persisted user choices into downstream stage input."""
        if stage == 'video_generation' and 'selected_images' not in data:
            ref_art = artifacts.get('reference_generation', {})
            if isinstance(ref_art, dict):
                scenes = ref_art.get('scenes', [])
                selected_images = {
                    s['id']: s['selected']
                    for s in scenes
                    if isinstance(s, dict) and s.get('id') and s.get('selected')
                }
                if selected_images:
                    data['selected_images'] = selected_images

        if stage == 'video_generation' and 'clips' not in data:
            vid_art = artifacts.get('video_generation', {})
            if isinstance(vid_art, dict):
                clips = vid_art.get('clips', [])
                if clips:
                    data['clips'] = clips

        if stage == 'post_production' and 'selected_clips' not in data:
            vid_art = artifacts.get('video_generation', {})
            if isinstance(vid_art, dict):
                clips = vid_art.get('clips', [])
                selected_clips = {
                    c['id']: c['selected']
                    for c in clips
                    if isinstance(c, dict) and c.get('id') and c.get('selected')
                }
                if selected_clips:
                    data['selected_clips'] = selected_clips

    def persist_session_snapshot(self, session_id: str) -> Dict[str, Any]:
        """Persist the latest engine-owned state and return a status snapshot."""
        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")
            self.save_session_to_disk(session_id)
            return copy.deepcopy(state.status)

    def stop_session(self, session_id: str):
        self.get_stop_event(session_id).set()
        with self._state_lock:
            state = self.get_state(session_id)
            if state and state.status.get(state.current_stage.value) == "running":
                state.status[state.current_stage.value] = "stopped"
                state.error = None  # 清除错误，因为是主动停止
                state.updated_at = datetime.now()
                current_progress = state.stage_progress.get(state.current_stage.value, {})
                state.stage_progress[state.current_stage.value] = {
                    **current_progress,
                    "step": "已停止",
                    "message": "已停止",
                    "updated_at": time.time(),
                }
                self.save_session_to_disk(session_id)
        logger.info(f"Session {session_id} stop signal sent")

    def reset_stop_event(self, session_id: str):
        with self._state_lock:
            if session_id in self._stop_events:
                self._stop_events[session_id].clear()

    def track_background_task(self, task: Any):
        """Keep detached workflow tasks alive after an SSE client disconnects."""
        with self._state_lock:
            self._background_tasks.add(task)

        def _cleanup(done_task: Any):
            with self._state_lock:
                self._background_tasks.discard(done_task)
            try:
                done_task.exception()
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("Detached workflow task failed")

        task.add_done_callback(_cleanup)

    def _get_next_stage(self, current: WorkflowStage) -> Optional[WorkflowStage]:
        try:
            idx = STAGE_ORDER.index(current)
            if idx + 1 < len(STAGE_ORDER):
                return STAGE_ORDER[idx + 1]
        except ValueError:
            pass
        return None

    # ──────────── 跨阶段同步逻辑 ────────────
    def _sync_artifacts_cross_stages(self, state: WorkflowState, stage: WorkflowStage, payload: Dict):
        """
        跨阶段数据同步钩子：当某个阶段产生新数据时，自动推送到后续阶段。
        例如：剧本续写产生的新角色/分镜，自动同步到 Stage 2 和 Stage 3。
        """
        if not isinstance(payload, dict):
            return

        # 案例 1: 剧本续写确认 (Script Confirmation)
        if stage == WorkflowStage.SCRIPT_GENERATION:
            # 获取合并后的角色、场景和剧集
            new_chars = payload.get("new_characters", [])
            new_settings = payload.get("new_settings", [])
            new_episodes = payload.get("new_episodes", [])
            # 如果没有新增剧集数据，无需同步到 Stage 2 和 3
            if not new_episodes: 
                return 
            
            # (A) 同步到第二阶段 (角色设计)
            if new_chars or new_settings:
                # 注意：WorkflowStage.CHARACTER_DESIGN 是 Enum，这里需要使用 .value
                char_stage_key = WorkflowStage.CHARACTER_DESIGN.value
                char_art = state.artifacts.get(char_stage_key)
                if not isinstance(char_art, dict):
                    char_art = {"characters": [], "settings": [], "version": 1}
                
                existing_chars = char_art.get("characters", [])
                for nc in new_chars:
                    if not any(c.get("id") == nc.get("character_id") for c in existing_chars):
                        existing_chars.append({
                            "id": nc.get("character_id"), "name": nc.get("name"), "description": nc.get("description"),
                            "selected": "", "versions": []
                        })
                char_art["characters"] = existing_chars
                
                existing_sets = char_art.get("settings", [])
                for ns in new_settings:
                    if not any(s.get("id") == ns.get("setting_id") for s in existing_sets):
                        existing_sets.append({
                            "id": ns.get("setting_id"), "name": ns.get("name"), "description": ns.get("description"),
                            "selected": "", "versions": []
                        })
                char_art["settings"] = existing_sets
                state.artifacts[char_stage_key] = char_art

            # (B) 同步到第三阶段 (分镜设计)
            if new_episodes:
                story_stage_key = WorkflowStage.STORYBOARD.value
                story_art = state.artifacts.get(story_stage_key)
                if not isinstance(story_art, dict):
                    story_art = {"episodes": [], "version": 1}
                
                existing_eps = story_art.get("episodes", [])
                for ne in new_episodes:
                    ep_num = ne.get("episode_number")
                    if not any(e.get("episode_number") == ep_num for e in existing_eps):
                        existing_eps.append({
                            "episode_number": ep_num,
                            "episode_title": ne.get("act_title") or f"第{ep_num}集",
                            "segments": []
                        })
                existing_eps.sort(key=lambda x: x.get("episode_number", 0))
                story_art["episodes"] = existing_eps
                state.artifacts[story_stage_key] = story_art

        # 案例 2: 分镜生成或修改同步到第四、第五阶段 (Storyboard -> Ref/Video)
        if stage == WorkflowStage.STORYBOARD:
            episodes = payload.get("episodes", []) if isinstance(payload, dict) else payload
            if not isinstance(episodes, list):
                return
                
            all_sync_clips = []
            for ep in episodes:
                if not isinstance(ep, dict): continue
                ep_n = ep.get("episode_number", 0)
                for s_i, seg in enumerate(ep.get("segments", []), 1):
                    if not isinstance(seg, dict): continue
                    seg_id = seg.get("segment_id", f"seg_{ep_n:02d}_{s_i:02d}")
                    
                    # 汇总 segment 级别的描述和时长
                    shots = seg.get("shots", [])
                    desc_video = " ".join([sh.get("plot") or sh.get("content") or "" for sh in shots]).strip()
                    desc_ref = " ".join([sh.get("visual_prompt") or sh.get("plot") or sh.get("content") or "" for sh in shots]).strip()
                    total_dur = seg.get("total_duration") or sum([sh.get("duration", 0) for sh in shots]) or 10
                    
                    all_sync_clips.append({
                        "segment_id": seg_id,
                        "desc_video": desc_video,
                        "desc_ref": desc_ref,
                        "duration": total_dur,
                        "episode": ep_n,
                        "index": s_i,
                        "name": f"第{ep_n}集-片段{s_i}"
                    })
            
            if not all_sync_clips:
                return

            # (A) 同步到第四阶段 (参考图生成)
            ref_stage_key = WorkflowStage.REFERENCE_GENERATION.value
            ref_art = state.artifacts.get(ref_stage_key)
            if not isinstance(ref_art, dict):
                ref_art = {"scenes": [], "version": 1}
            
            existing_scenes = ref_art.get("scenes", [])
            for c_info in all_sync_clips:
                id = c_info["segment_id"]
                idx = next((i for i, s in enumerate(existing_scenes) if s.get("id") == id), -1)
                if idx == -1:
                    existing_scenes.append({
                        "id": id,
                        "name": c_info["name"],
                        "index": c_info["index"],
                        "description": c_info["desc_ref"],
                        "selected": "",
                        "versions": [],
                        "status": "pending",
                        "episode": c_info["episode"]
                    })
                else:
                    # 更新已有记录
                    existing_scenes[idx]["description"] = c_info["desc_ref"]
                    existing_scenes[idx]["episode"] = c_info["episode"]
                    existing_scenes[idx]["index"] = c_info["index"]
                    existing_scenes[idx]["name"] = c_info["name"]
            
            # 排序：确保片段显示顺序正确 (按 id 排序，例如 seg_01_01 < seg_07_01)
            existing_scenes.sort(key=lambda x: x.get("id", ""))
            ref_art["scenes"] = existing_scenes
            state.artifacts[ref_stage_key] = ref_art

            # (B) 同步到第五阶段 (视频生成)
            video_stage_key = WorkflowStage.VIDEO_GENERATION.value
            video_art = state.artifacts.get(video_stage_key)
            if not isinstance(video_art, dict):
                video_art = {"clips": [], "version": 1}
            
            existing_clips = video_art.get("clips", [])
            for c_info in all_sync_clips:
                id = c_info["segment_id"]
                idx = next((i for i, c in enumerate(existing_clips) if c.get("id") == id), -1)
                if idx == -1:
                    existing_clips.append({
                        "id": id,
                        "name": c_info["name"],
                        "index": c_info["index"],
                        "description": c_info["desc_video"],
                        "duration": c_info["duration"],
                        "selected": "",
                        "versions": [],
                        "status": "pending",
                        "episode": c_info["episode"]
                    })
                else:
                    existing_clips[idx]["description"] = c_info["desc_video"]
                    existing_clips[idx]["duration"] = c_info["duration"]
                    existing_clips[idx]["episode"] = c_info["episode"]
                    existing_clips[idx]["index"] = c_info["index"]
                    existing_clips[idx]["name"] = c_info["name"]
            
            # 排序：确保片段显示顺序正确
            existing_clips.sort(key=lambda x: x.get("id", ""))
            video_art["clips"] = existing_clips
            state.artifacts[video_stage_key] = video_art

        # 案例 3: 角色/场景描述修改同步回剧本元数据，保证后续阶段读到用户最新描述。
        if stage == WorkflowStage.CHARACTER_DESIGN:
            script_art = state.artifacts.get(WorkflowStage.SCRIPT_GENERATION.value)
            if not isinstance(script_art, dict):
                return

            char_by_id = {
                c.get("id"): c for c in payload.get("characters", [])
                if isinstance(c, dict) and c.get("id")
            }
            setting_by_id = {
                s.get("id"): s for s in payload.get("settings", [])
                if isinstance(s, dict) and s.get("id")
            }

            for char in script_art.get("characters", []):
                if not isinstance(char, dict):
                    continue
                source = char_by_id.get(char.get("character_id") or char.get("id"))
                if source:
                    for key in ("name", "description", "species"):
                        if source.get(key):
                            char[key] = source[key]

            for setting in script_art.get("settings", []):
                if not isinstance(setting, dict):
                    continue
                source = setting_by_id.get(setting.get("setting_id") or setting.get("id"))
                if source:
                    for key in ("name", "description"):
                        if source.get(key):
                            setting[key] = source[key]

    def _recalculate_all_statuses(self, state: WorkflowState):
        """
        根据各阶段 artifacts 的数据完整性重新计算 status 字典。
        逻辑：
        - 如果 artifacts[stage] 不存在: pending
        - 如果存在且包含核心列表(characters/scenes/clips等):
            - 如果列表项存在 selected 为空的情况: waiting
            - 如果列表项全部已选择(或不需要选择): completed
        """
        for stage in WorkflowStage:
            if stage in [WorkflowStage.INIT, WorkflowStage.COMPLETED]:
                continue
            s_val = stage.value
            # 如果当前阶段正在运行，不自动覆盖其为 completed/waiting (除非它目前是空)
            current_s_status = state.status.get(s_val, "pending")
            if current_s_status == "running" or current_s_status == "error":
                continue

            art = state.artifacts.get(s_val)
            if not art or not isinstance(art, dict):
                state.status[s_val] = "pending"
                continue
            
            # 检查是否有待处理的“空数据占位”
            has_pending = False
            
            if s_val == "character_design":
                chars = art.get("characters", [])
                sets = art.get("settings", [])
                if any(not c.get("selected") for c in chars) or any(not s.get("selected") for s in sets):
                    has_pending = True
            elif s_val == "storyboard":
                # 检查分镜阶段：如果存在剧集（episode）但其 segments 为空，视为 waiting
                episodes = art.get("episodes", [])
                if not episodes or any(not ep.get("segments") for ep in episodes):
                    has_pending = True
            elif s_val == "reference_generation":
                scenes = art.get("scenes", [])
                if not scenes or any(not s.get("selected") for s in scenes):
                    has_pending = True
            elif s_val == "video_generation":
                clips = art.get("clips", [])
                if not clips or any(not c.get("selected") for c in clips):
                    has_pending = True
            
            if has_pending:
                state.status[s_val] = "waiting"
            else:
                # 已经有数据且没有 pending 项，标记为完成
                state.status[s_val] = "completed"

    @staticmethod
    def _is_background_item_regeneration(stage: WorkflowStage, intervention: Optional[Dict]) -> bool:
        if not isinstance(intervention, dict):
            return False
        if stage == WorkflowStage.CHARACTER_DESIGN:
            return isinstance(intervention.get("regenerate_characters"), list) or isinstance(intervention.get("regenerate_settings"), list)
        if stage == WorkflowStage.REFERENCE_GENERATION:
            return isinstance(intervention.get("regenerate_scenes"), list)
        if stage == WorkflowStage.VIDEO_GENERATION:
            return isinstance(intervention.get("regenerate_clips"), list)
        return False

    @staticmethod
    def _background_regeneration_targets(stage: WorkflowStage, intervention: Optional[Dict]) -> Dict[str, Set[str]]:
        if not isinstance(intervention, dict):
            return {}
        if stage == WorkflowStage.CHARACTER_DESIGN:
            return {
                "characters": set(intervention.get("regenerate_characters") or []),
                "settings": set(intervention.get("regenerate_settings") or []),
            }
        if stage == WorkflowStage.REFERENCE_GENERATION:
            return {"scenes": set(intervention.get("regenerate_scenes") or [])}
        if stage == WorkflowStage.VIDEO_GENERATION:
            return {"clips": set(intervention.get("regenerate_clips") or [])}
        return {}

    @staticmethod
    def _merge_item_regeneration_payload(
        existing: Any,
        payload: Any,
        item_keys: List[str],
        target_ids_by_key: Optional[Dict[str, Set[str]]] = None,
    ) -> Dict:
        """Merge concurrent single-item regeneration results without clobbering fresher items."""
        if not isinstance(existing, dict):
            existing = {}
        if not isinstance(payload, dict):
            return copy.deepcopy(existing)

        merged = copy.deepcopy(existing)
        for key, value in payload.items():
            if key not in item_keys:
                merged[key] = copy.deepcopy(value)

        for key in item_keys:
            existing_items = merged.get(key, [])
            payload_items = payload.get(key, [])
            if not isinstance(existing_items, list):
                existing_items = []
            if not isinstance(payload_items, list):
                merged[key] = existing_items
                continue

            target_ids = (target_ids_by_key or {}).get(key)
            by_id = {
                item.get("id"): copy.deepcopy(item)
                for item in existing_items
                if isinstance(item, dict) and item.get("id")
            }
            order = [
                item.get("id")
                for item in existing_items
                if isinstance(item, dict) and item.get("id")
            ]

            for item in payload_items:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                item_id = item["id"]
                if target_ids is not None and item_id not in target_ids:
                    continue
                current = by_id.get(item_id)
                if item_id not in order:
                    order.append(item_id)
                if not current:
                    by_id[item_id] = copy.deepcopy(item)
                    continue
                current_versions = current.get("versions") if isinstance(current.get("versions"), list) else []
                item_versions = item.get("versions") if isinstance(item.get("versions"), list) else []
                merged_versions = WorkflowEngine._merge_asset_versions(current_versions, item_versions)
                if len(item_versions) > len(current_versions):
                    merged_item = {**current, **copy.deepcopy(item)}
                    merged_item["versions"] = merged_versions
                    if current.get("selected"):
                        merged_item["selected"] = current.get("selected")
                        if item.get("status") in {"done", "failed"}:
                            merged_item["status"] = "done"
                    by_id[item_id] = merged_item
                elif len(item_versions) == len(current_versions):
                    merged_item = {**current, **copy.deepcopy(item)}
                    if not item.get("selected") and current.get("selected"):
                        merged_item["selected"] = current.get("selected")
                    if current.get("selected"):
                        merged_item["selected"] = current.get("selected")
                        if item.get("status") in {"done", "failed"}:
                            merged_item["status"] = "done"
                    if merged_versions:
                        merged_item["versions"] = merged_versions
                    if (
                        current.get("status") == "failed"
                        and item.get("status") == "done"
                        and not current.get("selected")
                    ):
                        merged_item["status"] = "failed"
                    by_id[item_id] = merged_item

            merged[key] = [by_id[item_id] for item_id in order if item_id in by_id]
        return merged

    @staticmethod
    def _merge_asset_versions(current_versions: Any, new_versions: Any) -> List[str]:
        merged: List[str] = []
        for value in list(current_versions if isinstance(current_versions, list) else []) + list(new_versions if isinstance(new_versions, list) else []):
            if value and value not in merged:
                merged.append(value)
        return merged

    @staticmethod
    def _selected_after_asset_update(current_selected: Any, new_selected: Any) -> Any:
        return current_selected or new_selected or ""

    async def execute_stage(self,
                            state: WorkflowState,
                            stage: WorkflowStage,
                            input_data: Any,
                            cancellation_check: Optional[Callable] = None,
                            progress_callback: Optional[Callable] = None,
                            intervention: Optional[Dict] = None) -> Dict:
        import time

        if not isinstance(input_data, dict):
            input_data = {}
        else:
            input_data = copy.deepcopy(input_data)

        with self._state_lock:
            input_data["_session_meta"] = copy.deepcopy(state.meta)
            input_data["_session_artifacts"] = copy.deepcopy(state.artifacts)

        agent = self.agent_factories[stage]()
        active_registered = False
        background_item_regeneration = self._is_background_item_regeneration(stage, intervention)

        # 合并会话级停止信号与请求级取消检查
        session_stop = self.get_stop_event(state.session_id)
        def combined_cancel_check():
            return session_stop.is_set() or (cancellation_check and cancellation_check())

        agent.set_cancellation_check(combined_cancel_check)

        # 包装 progress_callback：运行中进度只写入全局内存实例，避免并发阶段频繁抢写 session JSON。
        def persist_stage_progress(phase: str, step: str, percent: float):
            stage_key = stage.value
            try:
                safe_percent = max(0, min(100, int(round(float(percent)))))
            except (TypeError, ValueError):
                safe_percent = 0
            message = f"{phase}: {step}" if phase and step else (step or phase or "")
            state.stage_progress[stage_key] = {
                "phase": phase,
                "step": step,
                "message": message,
                "percent": safe_percent,
                "updated_at": time.time(),
            }
            state.updated_at = datetime.now()

        def merge_progress_artifact(data: dict):
            if not isinstance(data, dict):
                return
            stage_key = stage.value
            if data.get("assets_preview"):
                state.artifacts[stage_key] = copy.deepcopy(data["assets_preview"])

            asset_update = data.get("asset_complete")
            if not isinstance(asset_update, dict):
                return

            artifact = state.artifacts.setdefault(stage_key, {})
            item_type = asset_update.get("type")
            item_id = asset_update.get("id")
            if not item_type or not item_id:
                return

            items = artifact.setdefault(item_type, [])
            if not isinstance(items, list):
                items = []
                artifact[item_type] = items

            for item in items:
                if isinstance(item, dict) and item.get("id") == item_id:
                    next_status = asset_update.get("status", item.get("status"))
                    if item.get("selected") and next_status in {"done", "failed"}:
                        next_status = "done"
                    item["status"] = next_status
                    if "selected" in asset_update:
                        item["selected"] = self._selected_after_asset_update(
                            item.get("selected"),
                            asset_update.get("selected"),
                        )
                    if "versions" in asset_update:
                        item["versions"] = self._merge_asset_versions(
                            item.get("versions"),
                            asset_update.get("versions"),
                        )
                    return

            items.append({
                "id": item_id,
                "status": asset_update.get("status", "done"),
                "selected": asset_update.get("selected", ""),
                "versions": asset_update.get("versions", []),
            })

        def wrapped_progress_callback(phase: str, step: str, percent: float, data: dict = None):
            with self._state_lock:
                persist_stage_progress(phase, step, percent)
                if data:
                    merge_progress_artifact(data)

            # 调用原始 callback
            if progress_callback:
                progress_callback(phase, step, percent, data)

            should_persist = False
            if isinstance(data, dict):
                asset_update = data.get("asset_complete")
                should_persist = bool(data.get("persist")) or (
                    isinstance(asset_update, dict)
                    and asset_update.get("status") in {"done", "failed"}
                )
            if should_persist:
                self.save_session_to_disk(state.session_id)

        if progress_callback:
            agent.set_progress_callback(wrapped_progress_callback)

        if not background_item_regeneration:
            with self._state_lock:
                if state.session_id in self._active_sessions:
                    raise RuntimeError(f"Session {state.session_id} is already running a stage.")
                self._active_sessions.add(state.session_id)
                active_registered = True
                state.current_stage = stage
                state.status[stage.value] = "running"
                state.updated_at = datetime.now()
                state.stage_progress[stage.value] = {
                    "phase": stage.value,
                    "step": "启动中...",
                    "message": "启动中...",
                    "percent": 0,
                    "updated_at": time.time(),
                }
                try:
                    self.save_session_to_disk(state.session_id)
                except Exception:
                    self._active_sessions.discard(state.session_id)
                    active_registered = False
                    raise

        try:
            result = await agent.process(input_data, intervention=intervention)
            if not isinstance(result, dict):
                logger.error(f"[execute_stage] Agent {stage.value} returned non-dict result: {type(result)}")
                result = {"payload": result}
            
            payload = result.get("payload", {})
            requires_intervention = result.get("requires_intervention", False)

            with self._state_lock:
                # 根据阶段类型处理数据持久化和同步逻辑
                if stage == WorkflowStage.SCRIPT_GENERATION:
                    if requires_intervention:
                        # 【续写预览状态】直接保存 payload 以保留 new_episodes 供前端显示。
                        # 此时千万不要跨阶段同步（避免向第二、三阶段注入用户未确认的数据）。
                        state.artifacts[stage.value] = copy.deepcopy(payload)
                    else:
                        # 【确定续写 / 正常生成状态】
                        # 先同步增量数据到第二、三阶段
                        self._sync_artifacts_cross_stages(state, stage, payload)
                        # 然后清理第一阶段内部的临时增量字段并保存
                        clean_art = copy.deepcopy(payload)
                        for key in ["new_episodes", "new_characters", "new_settings", "sequel_idea"]:
                            clean_art.pop(key, None)
                        state.artifacts[stage.value] = clean_art
                else:
                    # 其他阶段正常执行跨阶段同步和赋值
                    if background_item_regeneration:
                        if stage == WorkflowStage.CHARACTER_DESIGN:
                            keys = ["characters", "settings"]
                        elif stage == WorkflowStage.REFERENCE_GENERATION:
                            keys = ["scenes"]
                        elif stage == WorkflowStage.VIDEO_GENERATION:
                            keys = ["clips"]
                        else:
                            keys = []
                        target_ids = self._background_regeneration_targets(stage, intervention)
                        payload = self._merge_item_regeneration_payload(state.artifacts.get(stage.value, {}), payload, keys, target_ids)
                    self._sync_artifacts_cross_stages(state, stage, payload)
                    state.artifacts[stage.value] = payload

                # 调试日志
                logger.info(f"[execute_stage] stage={stage.value}, intervention={intervention is not None}, requires_intervention={result.get('requires_intervention')}, stage_completed={result.get('stage_completed')}")

                # 重新计算所有阶段的状态（基于 artifacts 里的数据完整性）
                self._recalculate_all_statuses(state)

                # 如果 result 明确标记了完成且不是干预，则可能需要覆盖为 completed (除非 recalculate 认为是 waiting)
                if result.get("stage_completed") and not result.get("requires_intervention"):
                    # 如果 recalculate 没把它设为 waiting，就设为 completed
                    if state.status.get(stage.value) != "waiting":
                        state.status[stage.value] = "completed"
                elif result.get("requires_intervention"):
                    state.status[stage.value] = "waiting"

                state.updated_at = datetime.now()
                state.stage_progress[stage.value] = {
                    "phase": stage.value,
                    "step": "等待确认" if state.status.get(stage.value) == "waiting" else "已完成",
                    "message": "等待确认" if state.status.get(stage.value) == "waiting" else "已完成",
                    "percent": 100,
                    "updated_at": time.time(),
                }
                # 立即保存状态到磁盘，确保前端能获取到最新状态
                self.save_session_to_disk(state.session_id)
            return result

        except asyncio.CancelledError:
            with self._state_lock:
                if not background_item_regeneration:
                    state.status[stage.value] = "stopped"
                state.error = None
                state.updated_at = datetime.now()
                state.stage_progress[stage.value] = {
                    "phase": stage.value,
                    "step": "已取消",
                    "message": "已取消",
                    "percent": state.stage_progress.get(stage.value, {}).get("percent", 0),
                    "updated_at": time.time(),
                }
                self.save_session_to_disk(state.session_id)
            raise

        except Exception as e:
            with self._state_lock:
                if not background_item_regeneration:
                    state.status[stage.value] = "error"
                state.error = str(e)
                state.updated_at = datetime.now()
                state.stage_progress[stage.value] = {
                    "phase": stage.value,
                    "step": "执行失败",
                    "message": "执行失败",
                    "percent": state.stage_progress.get(stage.value, {}).get("percent", 0),
                    "updated_at": time.time(),
                }
                # 确保保存错误状态
                self.save_session_to_disk(state.session_id)
            raise
        finally:
            if active_registered:
                with self._state_lock:
                    self._active_sessions.discard(state.session_id)

    async def continue_workflow(self, session_id: str) -> Dict:
        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                return {
                    "status": "error",
                    "openclaw": "会话不存在，请刷新后重试。",
                    "message": "会话不存在",
                    "current_status": "missing",
                }
            logger.info(f"[continue_workflow] session={session_id}, current_stage={state.current_stage}, status={state.status}")

            # 检查当前状态是否已完成
            current_stage_str = state.current_stage.value if hasattr(state.current_stage, "value") else str(state.current_stage)

            # 在继续之前，先重新扫描一次状态，确保最新的选择已被计入
            self._recalculate_all_statuses(state)

            # 如果当前状态是 running，说明阶段还在执行中，不能继续
            if state.status.get(current_stage_str) == "running":
                return {
                    "status": "waiting",
                    "openclaw": f"当前阶段（{current_stage_str}）还在执行中，请等待完成后再调用 /continue。",
                    "message": f"当前阶段（{current_stage_str}）还在执行中，请等待完成后再调用 /continue。",
                    "current_status": "running",
                }

            # 状态转换逻辑：
            # - waiting 或 completed: 用户确认后直接进入下一阶段
            # 如果是 waiting，可能需要阻止进入下一阶段，除非业务允许强制通过
            # 这里我们遵循用户逻辑：如果有空数据，显示为 waiting，用户需要解决它才能真正 completed。
            if state.status.get(current_stage_str) == "waiting":
                # 如果是 waiting 状态，通常不应该自动跳到下一阶段
                # 但如果用户点击了“继续”，可能是想补全或者强制进入
                pass
            # 注意：只有当阶段真正完成（waiting 或 completed）时才允许继续

            current_status = state.status.get(current_stage_str)
            if current_status == "waiting" or current_status == "completed":
                # 直接进入下一阶段
                state.status[current_stage_str] = "completed"
                next_stage = self._get_next_stage(state.current_stage)

                if not next_stage:
                    state.status[current_stage_str] = "completed"
                    self.save_session_to_disk(state.session_id)
                    return {"status": "completed", "session_id": state.session_id, "status_map": copy.deepcopy(state.status)}

                self.save_session_to_disk(state.session_id)
                return {"status": "ready", "next_stage": next_stage.value, "session_id": state.session_id, "status_map": copy.deepcopy(state.status)}

        # 其他状态（如 pending, stopped, error, completed）不允许继续
        return {
            "status": "error",
            "openclaw": f"当前状态 {current_status} 不允许继续，请检查会话状态。",
            "message": f"当前状态不允许继续",
            "current_status": current_status,
        }

    # ──────────── Artifact 统一管理 ────────────

    def update_artifact(self, session_id: str, stage: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """Apply a user edit to an artifact, then recalculate and persist state."""
        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")

            self._apply_artifact_update(state, stage, body if isinstance(body, dict) else {})
            self._recalculate_all_statuses(state)
            self.save_session_to_disk(session_id)
            return {
                "status": "ok",
                "status_map": copy.deepcopy(state.status),
                "artifact": copy.deepcopy(state.artifacts.get(stage)),
            }

    def _apply_artifact_update(self, state: WorkflowState, stage: str, body: Dict[str, Any]):
        """Apply a user edit to in-memory artifacts before the session is persisted."""
        merge_keys_by_stage = {
            "character_design": ("characters", "settings"),
            "reference_generation": ("scenes",),
            "video_generation": ("clips",),
        }
        if stage in merge_keys_by_stage:
            current_art = state.artifacts.get(stage, {})
            if isinstance(current_art, dict):
                for list_key in merge_keys_by_stage[stage]:
                    if list_key not in body:
                        continue
                    current_items = current_art.get(list_key, [])
                    incoming_items = body.get(list_key, [])
                    if not isinstance(current_items, list) or not isinstance(incoming_items, list):
                        continue
                    current_by_id = {
                        item.get("id"): item
                        for item in current_items
                        if isinstance(item, dict) and item.get("id")
                    }
                    merged_items = []
                    seen_ids = set()
                    for incoming in incoming_items:
                        if not isinstance(incoming, dict) or not incoming.get("id"):
                            continue
                        item_id = incoming["id"]
                        current = current_by_id.get(item_id, {})
                        merged = {**current, **incoming}
                        if current.get("selected") and not incoming.get("selected"):
                            merged["selected"] = current.get("selected")
                        merged["versions"] = self._merge_asset_versions(
                            current.get("versions"),
                            incoming.get("versions"),
                        )
                        if current.get("selected") and incoming.get("status") in {"failed", "pending"}:
                            merged["status"] = current.get("status", "done")
                        merged_items.append(merged)
                        seen_ids.add(item_id)
                    for current in current_items:
                        if isinstance(current, dict) and current.get("id") not in seen_ids:
                            merged_items.append(current)
                    body[list_key] = merged_items

        if stage == "storyboard" and any(k in body for k in ("episodes", "segments", "shots")):
            for shot in body.get('shots', []):
                if isinstance(shot, dict) and 'is_new' in shot:
                    shot['is_new'] = False

            input_segments = list(body.get('segments', []))
            for ep in body.get('episodes', []):
                if isinstance(ep, dict):
                    input_segments.extend(seg for seg in ep.get('segments', []) if isinstance(seg, dict))

            seg_info_list = []
            for seg in input_segments:
                seg_id = seg.get('segment_id')
                if not seg_id:
                    continue
                shots = seg.get('shots', [])
                desc_video = " ".join([sh.get("plot") or sh.get("content") or "" for sh in shots]).strip()
                total_dur = seg.get("total_duration") or sum([sh.get("duration", 0) for sh in shots]) or 10
                seg_info_list.append({
                    "segment_id": seg_id,
                    "desc": desc_video,
                    "duration": total_dur,
                    "visual_prompt": seg.get("visual_prompt", ""),
                })

            video_art = state.artifacts.get('video_generation', {})
            if isinstance(video_art, dict) and isinstance(video_art.get('clips'), list):
                for clip in video_art['clips']:
                    target = next((item for item in seg_info_list if item["segment_id"] == clip.get('id')), None)
                    if target:
                        clip['duration'] = target['duration']
                        clip['description'] = target['desc']

            ref_art = state.artifacts.get('reference_generation', {})
            if isinstance(ref_art, dict) and isinstance(ref_art.get('scenes'), list):
                for scene in ref_art['scenes']:
                    target = next((item for item in seg_info_list if item["segment_id"] == scene.get('id')), None)
                    if target and target.get("visual_prompt"):
                        scene['description'] = target['visual_prompt']

            if "segments" in body and "episodes" not in body:
                body = {k: v for k, v in body.items() if k != "segments"}
            body.pop('new_shot_ids', None)

        elif stage == "reference_generation":
            if "segments" in body:
                seg_id_to_prompt = {
                    s['segment_id']: s.get('visual_prompt', '')
                    for s in body['segments']
                    if isinstance(s, dict) and 'segment_id' in s
                }

                storyboard_art = state.artifacts.get('storyboard', {})
                if isinstance(storyboard_art, dict):
                    for ep in storyboard_art.get('episodes', []):
                        if not isinstance(ep, dict):
                            continue
                        for seg in ep.get('segments', []):
                            if isinstance(seg, dict) and seg.get('segment_id') in seg_id_to_prompt:
                                seg['visual_prompt'] = seg_id_to_prompt[seg.get('segment_id')]

                ref_art = state.artifacts.get('reference_generation', {})
                if isinstance(ref_art, dict):
                    for scene in ref_art.get('scenes', []):
                        if isinstance(scene, dict) and scene.get('id') in seg_id_to_prompt:
                            scene['description'] = seg_id_to_prompt[scene.get('id')]

                body = {k: v for k, v in body.items() if k != "segments"}

            ref_art = state.artifacts.get('reference_generation', {})
            if isinstance(ref_art, dict):
                scenes = ref_art.get('scenes', [])
                is_selection_format = any(isinstance(k, str) and not isinstance(v, (list, dict)) for k, v in body.items())
                if is_selection_format and scenes:
                    for scene in scenes:
                        if isinstance(scene, dict) and scene.get('id') in body:
                            scene['selected'] = body[scene.get('id')]
                    body = {}

        elif stage == "video_generation":
            clip_id_to_duration = {}
            clip_id_to_description = {}
            for clip_id, value in body.items():
                if isinstance(value, dict):
                    if 'duration' in value:
                        clip_id_to_duration[clip_id] = value['duration']
                    if 'description' in value:
                        clip_id_to_description[clip_id] = value['description']

            if clip_id_to_duration or clip_id_to_description:
                storyboard_art = state.artifacts.get('storyboard', {})
                if isinstance(storyboard_art, dict):
                    for ep in storyboard_art.get('episodes', []):
                        if not isinstance(ep, dict):
                            continue
                        for seg in ep.get('segments', []):
                            if isinstance(seg, dict) and seg.get('segment_id') in clip_id_to_duration:
                                seg['total_duration'] = clip_id_to_duration[seg.get('segment_id')]

                vid_art = state.artifacts.get('video_generation', {})
                if isinstance(vid_art, dict):
                    for clip in vid_art.get('clips', []):
                        if not isinstance(clip, dict):
                            continue
                        clip_id = clip.get('id')
                        if clip_id in clip_id_to_duration:
                            clip['duration'] = clip_id_to_duration[clip_id]
                        if clip_id in clip_id_to_description:
                            clip['description'] = clip_id_to_description[clip_id]

            vid_art = state.artifacts.get('video_generation', {})
            if isinstance(vid_art, dict):
                clips = vid_art.get('clips', [])
                is_selection_format = any(isinstance(k, str) and not isinstance(v, (list, dict)) for k, v in body.items())
                if is_selection_format and clips:
                    for clip in clips:
                        if isinstance(clip, dict) and clip.get('id') in body:
                            clip['selected'] = body[clip.get('id')]
                    body = {}

        current = state.artifacts.get(stage)
        if current is None:
            state.artifacts[stage] = body
        elif isinstance(current, dict):
            current.update(body)
        else:
            state.artifacts[stage] = body

    def upload_artifact_image(
        self,
        session_id: str,
        stage: str,
        item_type: str,
        item_id: str,
        file_obj: Any,
        filename: str = "",
    ) -> Dict[str, Any]:
        """Save a user-provided image and attach it to the target artifact item."""
        allowed_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
        ext = os.path.splitext(filename or "")[1].lower() or ".png"
        if ext not in allowed_exts:
            raise ValueError(f"仅支持 {', '.join(sorted(allowed_exts))} 格式的图片")

        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")

            cfg = self._upload_item_config(stage, item_type, item_id)
            absolute_path, relative_path = self._next_upload_path(session_id, cfg, ext)
            try:
                written = 0
                with open(absolute_path, "wb") as buffer:
                    while chunk := file_obj.read(UPLOAD_CHUNK_SIZE):
                        written += len(chunk)
                        if written > ARTIFACT_IMAGE_LIMIT:
                            raise ValueError("图片大小不能超过 25 MB")
                        buffer.write(chunk)
            except ValueError:
                if os.path.exists(absolute_path):
                    os.remove(absolute_path)
                raise
            except Exception as exc:
                if os.path.exists(absolute_path):
                    os.remove(absolute_path)
                raise RuntimeError(f"图片保存失败: {exc}") from exc

            artifact = state.artifacts.setdefault(stage, {})
            items = artifact.setdefault(cfg["list_key"], [])
            if not isinstance(items, list):
                items = []
                artifact[cfg["list_key"]] = items

            target = next((item for item in items if isinstance(item, dict) and item.get("id") == item_id), None)
            if target is None:
                target = {"id": item_id, "name": item_id, "description": "", "versions": []}
                items.append(target)

            versions = target.get("versions")
            if not isinstance(versions, list):
                versions = []
            if relative_path not in versions:
                versions.append(relative_path)
            target["versions"] = versions
            target["selected"] = relative_path
            target["status"] = "done"

            self._recalculate_all_statuses(state)
            self.save_session_to_disk(session_id)
            return {
                "status": "ok",
                "path": relative_path,
                "item_id": item_id,
                "item_type": item_type,
                "artifact": copy.deepcopy(state.artifacts.get(stage)),
                "status_map": copy.deepcopy(state.status),
            }

    @staticmethod
    def _upload_item_config(stage: str, item_type: str, item_id: str) -> Dict[str, str]:
        if not SAFE_ARTIFACT_ID.fullmatch(item_id or ""):
            raise ValueError("素材 ID 只能包含字母、数字、点、下划线和连字符")
        if stage == "character_design" and item_type == "characters":
            base = item_id if item_id.startswith("char_") else f"char_{item_id}"
            return {"list_key": "characters", "dir": os.path.join("Assets", "characters"), "base": base}
        if stage == "character_design" and item_type == "settings":
            base = item_id if item_id.startswith("set_") else f"set_{item_id}"
            return {"list_key": "settings", "dir": os.path.join("Assets", "settings"), "base": base}
        if stage == "reference_generation" and item_type == "scenes":
            return {"list_key": "scenes", "dir": "Scenes", "base": item_id}
        raise ValueError("Unsupported upload target")

    @staticmethod
    def _next_upload_path(session_id: str, cfg: Dict[str, str], ext: str) -> tuple[str, str]:
        from config import settings

        save_dir = os.path.join(settings.RESULT_DIR, "image", str(session_id), cfg["dir"])
        os.makedirs(save_dir, exist_ok=True)

        pattern = re.compile(rf"^{re.escape(cfg['base'])}_upload_v(\d+)\.", re.IGNORECASE)
        max_version = 0
        for name in os.listdir(save_dir):
            match = pattern.match(name)
            if match:
                max_version = max(max_version, int(match.group(1)))
        version = f"v{max_version + 1}"
        upload_filename = f"{cfg['base']}_upload_{version}{ext}"
        absolute_path = os.path.join(save_dir, upload_filename)
        relative_path = os.path.relpath(absolute_path, settings.BASE_DIR)
        return absolute_path, relative_path

    # ──────────── 会话持久化 ────────────

    def save_session_to_disk(self, session_id: str, meta: Dict = None):
        """保存 / 更新会话到磁盘（原子写入）"""
        import tempfile
        import shutil

        with self._state_lock:
            path = os.path.join(self._session_dir, f"{session_id}.json")
            data: Dict[str, Any] = {}
            state = self.sessions.get(session_id)
            
            # 1. 准备基础数据
            if os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                except (json.JSONDecodeError, Exception):
                    pass

            data["session_id"] = session_id
            if meta:
                normalized_meta = {k: _normalize_meta_value(v) for k, v in meta.items() if v is not None}
                if state:
                    state.meta.update(normalized_meta)
            if "created_at" not in data:
                data["created_at"] = time.time()

            # Legacy session compatibility: clean root-level generation fields left by old session JSON.
            for key in SESSION_META_KEYS:
                data.pop(key, None)
            
            # 2. 将内存中的最新 state 合并到 data 中
            if state:
                data["current_stage"] = state.current_stage.value
                data["status"] = state.status
                # 这里的 state.artifacts 应该是已经经过 _sync_artifacts_cross_stages 处理的最新的内存对象
                data["artifacts"] = state.artifacts
                data["stage_progress"] = state.stage_progress
                data["error"] = state.error
                data["updated_at"] = state.updated_at.timestamp() if isinstance(state.updated_at, datetime) else time.time()
                
                # 保存元数据：meta 是唯一的会话级生成参数存储位置。
                if state.meta:
                    data["meta"] = copy.deepcopy(state.meta)
                else:
                    data.pop("meta", None)
            else:
                data["updated_at"] = time.time()

            # 3. 原子写入：先写临时文件，再重命名
            dir_path = os.path.dirname(path)
            fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix='.json')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                shutil.move(tmp_path, path)
                logger.info(f"[Orchestrator] Session {session_id} saved successfully.")
            except Exception as e:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                logger.error(f"[Orchestrator] Failed to save session {session_id}: {e}")
                raise

    def _load_sessions_from_disk(self):
        """启动时从磁盘加载所有已保存的会话"""
        if not os.path.exists(self._session_dir):
            return
        for filename in os.listdir(self._session_dir):
            if not filename.endswith('.json'):
                continue
            try:
                fpath = os.path.join(self._session_dir, filename)
                with open(fpath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                sid = data["session_id"]
                state = WorkflowState(sid)
                try:
                    state.current_stage = WorkflowStage(data.get("current_stage", "init"))
                except ValueError:
                    state.current_stage = WorkflowStage.INIT
                
                # 旧版本兼容：状态名称转换及迁移
                old_status = data.get("status", "pending")
                if isinstance(old_status, str):
                    if old_status == "waiting_intervention":
                        old_status = "waiting"
                    elif old_status == "completed":
                        old_status = "completed"
                    
                    stages_completed = data.get("stages_completed", [])
                    for stage in WorkflowStage:
                        if stage != WorkflowStage.INIT and stage != WorkflowStage.COMPLETED:
                            if stage.value in stages_completed:
                                state.status[stage.value] = "completed"
                            elif stage.value == state.current_stage.value:
                                state.status[stage.value] = old_status
                            else:
                                state.status[stage.value] = "pending"
                elif isinstance(old_status, dict):
                    state.status = old_status

                state.artifacts = data.get("artifacts", {})
                state.stage_progress = data.get("stage_progress", {})
                state.error = data.get("error")
                state.updated_at = data.get("updated_at", 0)
                state.meta = _extract_session_meta(data)
                self.sessions[sid] = state
            except json.JSONDecodeError:
                logger.warning(f"Skipping corrupted session file: {filename}")
            except Exception as e:
                logger.warning(f"Failed to load session {filename}: {e}")

    def delete_session(self, session_id: str) -> bool:
        """删除指定会话（内存 + 磁盘 + 结果文件）"""
        from config import settings
        import shutil

        with self._state_lock:
            if session_id in self._active_sessions:
                self.get_stop_event(session_id).set()
                logger.warning(f"Refusing to delete active session: {session_id}")
                return False

            path = os.path.join(self._session_dir, f"{session_id}.json")
            exists = session_id in self.sessions or os.path.exists(path)
            if not exists:
                return False

            # 从内存中移除
            self.sessions.pop(session_id, None)
            self._stop_events.pop(session_id, None)

            # 1. 删除会话元数据文件
            if os.path.exists(path):
                os.remove(path)

            # 2. 删除结果文件（剧本、图片、视频）
            result_base = settings.RESULT_DIR

            # 删除剧本文件
            script_file = os.path.join(result_base, 'script', f'{session_id}.json')
            if os.path.exists(script_file):
                os.remove(script_file)

            # 删除图片目录
            image_dir = os.path.join(result_base, 'image', session_id)
            if os.path.exists(image_dir):
                shutil.rmtree(image_dir)

            # 删除视频目录
            video_dir = os.path.join(result_base, 'video', session_id)
            if os.path.exists(video_dir):
                shutil.rmtree(video_dir)

        logger.info(f"Session and results deleted: {session_id}")
        return True

    def cleanup_orphan_results(self) -> Dict[str, Any]:
        """Remove result files whose session no longer exists."""
        from config import settings

        with self._state_lock:
            session_ids = set(self.sessions.keys())
            if os.path.isdir(self._session_dir):
                for filename in os.listdir(self._session_dir):
                    if filename.endswith('.json'):
                        session_ids.add(filename[:-5])

            cleaned = {"scripts": [], "images": [], "videos": []}
            result_base = settings.RESULT_DIR

            script_dir = os.path.join(result_base, 'script')
            if os.path.isdir(script_dir):
                for filename in os.listdir(script_dir):
                    if not filename.endswith('.json'):
                        continue
                    sid = filename[:-5]
                    if sid not in session_ids:
                        os.remove(os.path.join(script_dir, filename))
                        cleaned["scripts"].append(sid)

            image_dir = os.path.join(result_base, 'image')
            if os.path.isdir(image_dir):
                for dirname in os.listdir(image_dir):
                    if dirname != 'test_avail' and dirname not in session_ids:
                        shutil.rmtree(os.path.join(image_dir, dirname))
                        cleaned["images"].append(dirname)

            video_dir = os.path.join(result_base, 'video')
            if os.path.isdir(video_dir):
                for dirname in os.listdir(video_dir):
                    if dirname != 'test_avail' and dirname not in session_ids:
                        shutil.rmtree(os.path.join(video_dir, dirname))
                        cleaned["videos"].append(dirname)

            return {"status": "cleaned", "cleaned": cleaned}

    def get_scene_asset_counts(self, session_id: str, scene_number: int) -> Dict[str, Any]:
        """Count generated reference images/videos from the current artifact state only."""
        from config import settings

        with self._state_lock:
            state = self.get_state(session_id)
            if not state:
                raise KeyError(f"Session not found: {session_id}")
            artifacts = copy.deepcopy(state.artifacts)

        storyboard = artifacts.get('storyboard', {})
        segment_ids = self._segment_ids_for_scene(storyboard, scene_number)

        ref_artifact = artifacts.get('reference_generation', {})
        ref_scenes = ref_artifact.get('scenes', []) if isinstance(ref_artifact, dict) else []
        ref_image_count = self._count_existing_assets(ref_scenes, segment_ids, settings.CODE_DIR, include_versions=True)

        video_artifact = artifacts.get('video_generation', {})
        video_clips = video_artifact.get('clips', []) if isinstance(video_artifact, dict) else []
        video_count = self._count_existing_assets(video_clips, segment_ids, settings.CODE_DIR, include_versions=False)

        return {
            "scene_number": scene_number,
            "reference_images": ref_image_count,
            "videos": video_count,
            "shot_count": len(segment_ids),
        }

    @staticmethod
    def _segment_ids_for_scene(storyboard: Any, scene_number: int) -> List[str]:
        if not isinstance(storyboard, dict):
            return []

        ids: List[str] = []
        for shot in storyboard.get('shots', []):
            if isinstance(shot, dict) and shot.get('scene_number') == scene_number and shot.get('shot_id'):
                ids.append(shot['shot_id'])

        for episode in storyboard.get('episodes', []):
            if not isinstance(episode, dict):
                continue
            for segment in episode.get('segments', []):
                if not isinstance(segment, dict):
                    continue
                segment_scene = segment.get('scene_number') or segment.get('segment_number')
                if segment_scene == scene_number and segment.get('segment_id'):
                    ids.append(segment['segment_id'])

        return list(dict.fromkeys(ids))

    @staticmethod
    def _asset_exists(code_dir: str, path: str) -> bool:
        if not path:
            return False
        candidate = path if os.path.isabs(path) else os.path.join(code_dir, path.lstrip('/'))
        return os.path.exists(candidate)

    @classmethod
    def _count_existing_assets(
        cls,
        items: List[Any],
        target_ids: List[str],
        code_dir: str,
        *,
        include_versions: bool,
    ) -> int:
        count = 0
        target_set = set(target_ids)
        for item in items:
            if not isinstance(item, dict) or item.get('id') not in target_set:
                continue
            selected = item.get('selected')
            if selected and cls._asset_exists(code_dir, selected):
                count += 1
            if include_versions:
                versions = item.get('versions', [])
                for version in versions if isinstance(versions, list) else []:
                    if version and version != selected and cls._asset_exists(code_dir, version):
                        count += 1
        return count

    def list_saved_sessions(self) -> List[Dict]:
        """列出所有已保存的会话概要"""
        with self._state_lock:
            sessions: List[Dict] = []
            for sid, state in self.sessions.items():
                try:
                    meta = copy.deepcopy(state.meta)
                    artifacts = copy.deepcopy(state.artifacts)
                    script_artifact = artifacts.get("script_generation", {})
                    title = (
                        script_artifact.get("title")
                        or meta.get("idea")
                        or meta.get("user_textbox_input")
                        or ""
                    )
                    updated_at = state.updated_at
                    if isinstance(updated_at, datetime):
                        date_value = updated_at.timestamp()
                    else:
                        date_value = updated_at or 0
                    sessions.append({
                        "id": sid,
                        "title": title,
                        "idea": meta.get("idea") or meta.get("user_textbox_input") or "",
                        "style": meta.get("style") or "",
                        "date": date_value,
                        "status": copy.deepcopy(state.status),
                        "current_stage": state.current_stage.value,
                        "meta": meta,
                        "stage_progress": copy.deepcopy(state.stage_progress),
                    })
                except Exception:
                    continue
            sessions.sort(key=lambda x: x.get("date", 0), reverse=True)
            return sessions
