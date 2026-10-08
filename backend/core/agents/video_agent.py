# -*- coding: utf-8 -*-
"""
阶段5: 视频生成智能体
- 从编排器注入的 artifacts["storyboard"] 读取拍摄片段(Segments)
- 视频提示词：风格控制 + 人物列表 + 分镜列表(分镜1: [时长] content...)
- 参考图：从 artifacts["reference_generation"] 读取
- 支持逐项并发生成、实时预览、重新生成
"""

import os
import re
import glob
import asyncio
import logging
from typing import Any, Optional, Dict, List
from concurrent.futures import ThreadPoolExecutor, as_completed

from .base_agent import AgentInterface

logger = logging.getLogger(__name__)


class VideoDirectorAgent(AgentInterface):
    """视频生成：拍摄片段(Segments) → 组装提示词 → 视频片段"""

    def __init__(self):
        super().__init__(name="VideoDirector")

    # ─── 版本管理 ───

    @staticmethod
    def _video_base(sid: str) -> str:
        return os.path.join('code/result/video', str(sid))

    def _list_versions(self, sid: str, segment_id: str) -> List[str]:
        """列出某个片段视频的所有历史版本"""
        video_dir = self._video_base(sid)
        pattern = os.path.join(video_dir, f"{segment_id}*.mp4")
        files = [f for f in sorted(glob.glob(pattern), key=os.path.getmtime)
                 if not f.endswith('_final.mp4')]
        return files

    def _next_version_path(self, sid: str, segment_id: str) -> str:
        """获取下一个版本路径"""
        video_dir = self._video_base(sid)
        os.makedirs(video_dir, exist_ok=True)

        existing = self._list_versions(sid, segment_id)
        if not existing:
            return os.path.join(video_dir, f"{segment_id}.mp4")

        max_v = 1
        for fp in existing:
            bn = os.path.splitext(os.path.basename(fp))[0]
            m = re.search(r'_v(\d+)$', bn)
            if m:
                max_v = max(max_v, int(m.group(1)))

        return os.path.join(video_dir, f"{segment_id}_v{max_v + 1}.mp4")

    # ─── 视频生成 ───

    def _generate_one(self, sid: str, segment_id: str, prompt: str,
                      img_path: Optional[str], video_model: str,
                      duration: int = 10, sound: str = "",
                      shot_type: str = "multi",
                      video_ratio: str = "16:9",
                      video_resolution: str = "720P",
                      video_generation_mode: str = "first_frame",
                      last_image_path: Optional[str] = None,
                      reference_image_paths: Optional[List[str]] = None) -> tuple:
        """生成单个视频片段，返回 (segment_id, path_or_None)"""
        if self.cancellation_check and self.cancellation_check():
            logger.info(f"VideoDirectorAgent: {segment_id} 跳过（用户取消）")
            return segment_id, None

        reference_image_paths = reference_image_paths or []
        if video_generation_mode == "reference":
            missing_refs = [path for path in reference_image_paths if not os.path.exists(path)]
            if not reference_image_paths or missing_refs:
                logger.warning("Reference images missing for %s: %s", segment_id, missing_refs or reference_image_paths)
                return segment_id, None
        elif not img_path or not os.path.exists(img_path):
            logger.warning(f"Image missing for {segment_id}: {img_path}")
            return segment_id, None

        save_path = self._next_version_path(sid, segment_id)
        try:
            from models.video_client import VideoClient
            client = VideoClient()
            client.generate_video(
                prompt=prompt,
                image_path=img_path,
                save_path=save_path,
                model=video_model,
                duration=duration,
                sound=sound,
                shot_type=shot_type,
                video_ratio=video_ratio,
                resolution=video_resolution,
                last_image_path=last_image_path if video_generation_mode == "start_end_frame" else None,
                reference_image_paths=reference_image_paths if video_generation_mode == "reference" else None,
            )
            return segment_id, save_path
        except Exception as e:
            logger.error(f"Video gen failed for {segment_id}: {e}")
            if os.path.exists(save_path):
                try:
                    os.remove(save_path)
                except Exception:
                    pass
        return segment_id, None

    # ─── 提示词组装 ───

    def _format_shot_section(self, segment: dict) -> str:
        prompt = "分镜列表："
        shots = segment.get("shots", [])
        for i, shot in enumerate(shots, 1):
            dur = shot.get("duration", 5)
            content = shot.get("content", "").strip()
            prompt += f"\n分镜{i}：[{dur}秒] {content}"
        return prompt

    @staticmethod
    def _extract_shot_section(prompt: str) -> str:
        text = (prompt or "").strip()
        if not text:
            return "分镜列表："
        marker = "分镜列表："
        alt_marker = "分镜列表:"
        if marker in text:
            text = text[text.index(marker):].strip()
        elif alt_marker in text:
            text = marker + text[text.index(alt_marker) + len(alt_marker):].strip()
        else:
            text = f"{marker}\n{text}"
        no_caption_marker = "\n不要生成字幕或水印"
        if no_caption_marker in text:
            text = text[:text.index(no_caption_marker)].rstrip()
        return text

    def _display_prompt(self, segment: dict, video_data: Optional[dict] = None) -> str:
        """前端只展示可编辑的分镜列表；风格和人物信息在调用视频模型前即时拼接。"""
        if video_data and video_data.get("description"):
            return self._extract_shot_section(video_data["description"])
        return self._format_shot_section(segment)

    def _build_character_section(self, segment: dict, character_artifact: Optional[dict]) -> str:
        characters = character_artifact.get("characters", []) if isinstance(character_artifact, dict) else []
        if not characters:
            return "人物列表：无"

        character_map = self._build_name_asset_map(characters)
        selected_assets = []
        seen = set()

        for character_name in segment.get("characters") or []:
            asset = self._match_asset_by_name(str(character_name), characters, character_map)
            asset_key = str(asset.get("id") or asset.get("name") or "") if asset else ""
            if asset and asset_key not in seen:
                selected_assets.append(asset)
                seen.add(asset_key)

        lines = []
        for asset in selected_assets:
            name = str(asset.get("name") or asset.get("id") or "").strip()
            desc = str(asset.get("description") or "").strip()
            if name and desc:
                lines.append(f"- {name}：{desc}")
            elif name:
                lines.append(f"- {name}")

        return "人物列表：\n" + "\n".join(lines) if lines else "人物列表：无"

    def _assemble_prompt(self, segment: dict, style_prompt: str,
                         character_artifact: Optional[dict] = None,
                         video_data: Optional[dict] = None) -> str:
        """组装视频提示词
        格式：
        风格控制：用户选择的风格提示词, 电影质感
        人物列表：从第二阶段人物描述读取
        分镜列表：分镜1:[时长] content... 分镜2:[时长] content...
        """
        if video_data and "description" in video_data:
            # 前端修改后的提示词会存入 artifacts.video_generation.clips.description。
            # 兼容旧格式：保留用户修改过的分镜部分，重新补齐最新风格和人物列表。
            shot_section = self._extract_shot_section(video_data["description"])
        else:
            shot_section = self._format_shot_section(segment)

        return (
            f"风格控制：{style_prompt}\n"
            f"{self._build_character_section(segment, character_artifact)}\n"
            f"{shot_section}\n"
            "不要生成字幕或水印"
        )

    def _get_style_keywords(self, session_data: dict) -> str:
        """从会话数据获取风格关键词"""
        style = session_data.get('style', 'realistic').lower()
        
        STYLE_MAP = {
            "anime": "anime style, vibrant colors, clean lines,",
            "realistic": "photorealistic, cinematic lighting, high-detail textures,",
            "cartoon": "cartoon style, thick outlines, bold colors,",
            "3d-disney": "3D CGI animation, Disney/Pixar style, smooth textures,",
            "oil-painting": "oil painting, artistic brushstrokes, rich textures,",
            "chinese-ink": "Chinese ink wash painting, traditional style, soft strokes,"
        }
        return STYLE_MAP.get(style, "cinematic, high quality,")

    # ─── 参考图获取 ───

    def _get_reference_image(self, sid: str, segment_id: str, scene_map: dict) -> str:
        """获取参考图路径：优先用选中的版本，次之用最新版本"""
        # 1. 检查 session 中 artifacts.reference_generation.scenes 里的 selected
        if segment_id in scene_map and scene_map[segment_id].get("selected"):
            path = scene_map[segment_id]["selected"]
            if os.path.exists(path):
                return path

        # 2. 回退：扫描磁盘 Scenes 目录
        from .reference_agent import ReferenceGeneratorAgent
        versions = ReferenceGeneratorAgent._list_versions_static(sid, segment_id)
        if versions:
            return versions[-1]

        # 3. 默认路径
        return os.path.abspath(os.path.join('code/result/image', str(sid), 'Scenes', f"{segment_id}.jpg"))

    def _get_next_reference_image(self, sid: str, segment_index: int, segments: list, scene_map: dict) -> Optional[str]:
        """首尾帧模式下，优先用下一个片段参考图作为尾帧。"""
        if segment_index + 1 >= len(segments):
            return None
        next_segment_id = segments[segment_index + 1].get("segment_id")
        if not next_segment_id:
            return None
        path = self._get_reference_image(sid, next_segment_id, scene_map)
        return path if path and os.path.exists(path) else None

    @staticmethod
    def _asset_selected_path(asset: dict) -> str:
        selected = asset.get("selected") or ""
        if selected and os.path.exists(selected):
            return selected
        # Legacy session compatibility: some old artifacts only have versions and no selected field.
        for path in reversed(asset.get("versions") or []):
            if path and os.path.exists(path):
                return path
        return ""

    @staticmethod
    def _build_name_asset_map(assets: list[dict]) -> dict[str, dict]:
        """Build name -> asset mapping from character_design characters/settings."""
        mapping = {}
        for asset in assets:
            name = str(asset.get("name") or "").strip()
            asset_id = str(asset.get("id") or "").strip()
            if name:
                mapping[name] = asset
            if asset_id:
                mapping[asset_id] = asset
        return mapping

    @staticmethod
    def _match_asset_by_name(name: str, assets: list[dict], asset_map: Optional[dict[str, dict]] = None) -> Optional[dict]:
        clean_name = (name or "").strip()
        if not clean_name:
            return None
        if asset_map and clean_name in asset_map:
            return asset_map[clean_name]
        for asset in assets:
            asset_name = str(asset.get("name") or "").strip()
            if asset_name and asset_name == clean_name:
                return asset
        for asset in assets:
            asset_name = str(asset.get("name") or "").strip()
            if asset_name and (asset_name in clean_name or clean_name in asset_name):
                return asset
        return None

    def _get_segment_reference_assets(self, segment: dict, character_artifact: dict) -> List[str]:
        """参考图生视频：按 segment.characters/location 读取第二阶段用户选中的人物图和场景图。"""
        characters = character_artifact.get("characters", []) if isinstance(character_artifact, dict) else []
        settings = character_artifact.get("settings", []) if isinstance(character_artifact, dict) else []
        character_map = self._build_name_asset_map(characters)
        setting_map = self._build_name_asset_map(settings)
        reference_paths: List[str] = []
        seen = set()

        def add_asset(asset: Optional[dict]) -> None:
            if not asset:
                return
            path = self._asset_selected_path(asset)
            if path and path not in seen:
                reference_paths.append(path)
                seen.add(path)

        location = str(segment.get("location") or "").strip()
        add_asset(self._match_asset_by_name(location, settings, setting_map))

        for character_name in segment.get("characters") or []:
            add_asset(self._match_asset_by_name(str(character_name), characters, character_map))

        return reference_paths

    @staticmethod
    def _select_video_model(input_data: dict, session_meta: dict) -> tuple[str, str]:
        mode = (
            input_data.get("video_generation_mode")
            or session_meta.get("video_generation_mode")
            or "first_frame"
        )
        model_key = {
            "first_frame": "video_first_frame_model",
            "start_end_frame": "video_start_end_model",
            "reference": "video_reference_model",
        }.get(mode, "video_first_frame_model")
        model = input_data.get(model_key) or session_meta.get(model_key)
        if not model:
            # Legacy session compatibility: sessions created before mode-specific video models only have video_model.
            model = input_data.get("video_model") or session_meta.get("video_model")
        if not model:
            raise ValueError("Missing required model configuration: video_model")
        return mode, model

    # ─── 预览 / Payload ───

    def _build_preview(self, sid: str, segments: list, scene_map: dict,
                       video_clips: Optional[list] = None) -> list:
        preview = []
        clip_map = {c.get("id"): c for c in (video_clips or []) if isinstance(c, dict) and c.get("id")}
        for idx, seg in enumerate(segments, 1):
            segment_id = seg["segment_id"]
            versions = self._list_versions(sid, segment_id)
            ep_n = seg.get('episode_number', 1)
            seg_n = seg.get('segment_number', idx)
            preview.append({
                "id": segment_id,
                "name": f"第{ep_n}集-片段{seg_n}",
                "episode": ep_n,
                "index": seg_n,
                "description": self._display_prompt(seg, clip_map.get(segment_id)),
                "duration": seg.get('total_duration', 10),
                "selected": versions[-1] if versions else "",
                "versions": versions,
                "status": "done" if versions else "pending",
            })
        return preview

    def _build_payload(self, sid: str, segments: list, video_clips: Optional[list] = None) -> dict:
        clips = []
        clip_map = {c.get("id"): c for c in (video_clips or []) if isinstance(c, dict) and c.get("id")}
        for idx, seg in enumerate(segments, 1):
            segment_id = seg["segment_id"]
            versions = self._list_versions(sid, segment_id)
            ep_n = seg.get('episode_number', 1)
            seg_n = seg.get('segment_number', idx)
            clips.append({
                "id": segment_id,
                "name": f"第{ep_n}集-片段{seg_n}",
                "episode": ep_n,
                "index": seg_n,
                "description": self._display_prompt(seg, clip_map.get(segment_id)),
                "duration": seg.get('total_duration', 10),
                "selected": versions[-1] if versions else "",
                "versions": versions,
                "status": "done" if versions else "failed",
            })
        return {
            "payload": {
                "session_id": sid,
                "clips": clips,
            },
            "stage_completed": True,
        }

    def _update_session_video_data(self, sid: str, segments: list, style_prompt: str) -> None:
        """保留兼容入口；session 状态统一由 WorkflowEngine 持久化。"""
        return

    # ─── 核心流程 ───

    async def process(self, input_data: Any, intervention: Optional[Dict] = None) -> Dict:
        from config import settings
        
        input_data = self._merge_session_params(input_data)
        sid = input_data["session_id"]
        
        # ═══ 介入：用户选择指定版本 ═══
        if intervention and "selected_clips" in intervention:
            selected_clips = intervention["selected_clips"] # Dict[segment_id, path]
            logger.info(f"[VideoAgent] 用户更新片段选择: {selected_clips}")

            # 返回当前状态
            artifacts = self._session_artifacts(input_data)
            episodes = artifacts.get('storyboard', {}).get('episodes', [])
            segments = []
            for ep in episodes:
                segments.extend(ep.get("segments", []))
            video_clips = artifacts.get('video_generation', {}).get('clips', [])
            payload = self._build_payload(sid, segments, video_clips)
            for clip in payload.get("payload", {}).get("clips", []):
                clip_id = clip.get("id")
                if clip_id in selected_clips:
                    clip["selected"] = selected_clips[clip_id]
            return payload

        session_meta = self._session_meta(input_data)
        video_generation_mode, video_model = self._select_video_model(input_data, session_meta)
        enable_concurrency = input_data.get("enable_concurrency", True)
        from models.config_model import get_max_concurrency
        concurrency = get_max_concurrency(video_model, enable_concurrency)
        
        video_ratio = input_data.get("video_ratio", "16:9")
        video_resolution = input_data.get("video_resolution", "720P")
        video_sound = "on"
        video_shot_type = "multi"

        artifacts = self._session_artifacts(input_data)
        
        # 1. 获取拍摄片段列表 (从 Storyboard)
        episodes = artifacts.get('storyboard', {}).get('episodes', [])
        segments = []
        for ep in episodes:
            segments.extend(ep.get("segments", []))
        if not segments:
            raise Exception("未找到分镜片段数据，请先完成阶段3")
        
        video_clips = artifacts.get('video_generation', {}).get('clips', [])

        # 2. 获取参考图路径映射 (从 Reference Generation)
        ref_art = artifacts.get('reference_generation', {})
        scene_list = ref_art.get('scenes', [])
        scene_map = {s['id']: s for s in scene_list if 'id' in s}
        character_art = artifacts.get('character_design', {})
        
        style_zh = input_data.get('style') or session_meta.get('style') or 'realistic'
        # 简单映射为中文显示名
        style_map_zh = {
            "anime": "动漫",
            "realistic": "写实",
            "cartoon": "卡通",
            "3d-disney": "3D迪斯尼",
            "oil-painting": "油画",
            "chinese-ink": "国画",
            "comic-book": "美漫",
            "cyberpunk": "赛博朋克"
        }
        style_name = style_map_zh.get(style_zh, style_zh)
        style_prompt = self._get_style_prompt(style_zh)

        # ═══ 介入：重新生成指定片段 ═══
        if intervention:
            regen_ids = intervention.get("regenerate_clips", [])
            if regen_ids:
                self._report_progress("视频生成", "重新生成中...", 5)
                segment_map = {s['segment_id']: s for s in segments}
                clip_map = {c['id']: c for c in video_clips}
                
                def regen_run():
                    done = 0
                    with ThreadPoolExecutor(max_workers=concurrency) as executor:
                        futs = {}
                        for seg_id in regen_ids:
                            seg = segment_map.get(seg_id)
                            clip = clip_map.get(seg_id) if clip_map.get(seg_id) else None
                            if not seg: continue
                            prompt = self._assemble_prompt(seg, style_prompt, character_art, video_data=clip)

                            reference_image_paths = None
                            if video_generation_mode == "reference":
                                img_path = None
                                reference_image_paths = self._get_segment_reference_assets(seg, character_art)
                                if not reference_image_paths:
                                    logger.warning("VideoDirectorAgent: %s 参考图模式未匹配到第二阶段人物/场景图", seg_id)
                            else:
                                img_path = self._get_reference_image(sid, seg_id, scene_map)
                            duration = seg.get("total_duration", 10)
                            seg_index = segments.index(seg)
                            last_img_path = self._get_next_reference_image(sid, seg_index, segments, scene_map)
                            if video_generation_mode == "start_end_frame" and not last_img_path:
                                logger.warning("VideoDirectorAgent: %s 首尾帧模式缺少尾帧，回退为首帧生视频入参", seg_id)
                            existing_versions = self._list_versions(sid, seg_id)
                            self._report_progress("视频生成", f"启动生成: {seg_id}", 5, data={
                                "asset_complete": {
                                    "type": "clips", "id": seg_id,
                                    "status": "running",
                                    "versions": existing_versions,
                                }
                            })
                            fut = executor.submit(
                                self._generate_one, sid, seg_id, prompt,
                                img_path, video_model, duration,
                                video_sound, video_shot_type, video_ratio, video_resolution,
                                video_generation_mode, last_img_path, reference_image_paths
                            )
                            futs[fut] = seg_id
                        for fut in as_completed(futs):
                            sid_done = futs[fut]
                            try:
                                _, res_path = fut.result()
                            except Exception as e:
                                logger.error(f"Regen future error for {sid_done}: {e}")
                                res_path = None
                            done += 1
                            pct = 5 + int(90 * done / max(1, len(regen_ids)))
                            if res_path:
                                versions = self._list_versions(sid, sid_done)
                                self._report_progress("视频生成", f"完成: {sid_done}", pct, data={
                                    "asset_complete": {
                                        "type": "clips", "id": sid_done,
                                        "status": "done",
                                        "selected": res_path,
                                        "versions": versions,
                                    }
                                })
                            else:
                                self._report_progress("视频生成", f"失败: {sid_done}", pct, data={
                                    "asset_complete": {
                                        "type": "clips", "id": sid_done,
                                        "status": "failed",
                                        "selected": "", "versions": [],
                                    }
                                })
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, regen_run)
                
                # 同步到 session artifacts
                self._update_session_video_data(sid, segments, style_prompt)
                
                return self._build_payload(sid, segments, video_clips)

        # ═══ 正常流程：全量生成 ═══
        self._report_progress("视频生成", "正在准备数据...", 2)
        preview = self._build_preview(sid, segments, scene_map, video_clips)
        self._report_progress("视频生成", "加载视频列表", 5, data={"assets_preview": {"clips": preview}})

        def run():
            tasks = []
            for seg_index, seg in enumerate(segments):
                seg_id = seg["segment_id"]
                existing = self._list_versions(sid, seg_id)
                if existing: continue
                prompt = self._assemble_prompt(seg, style_prompt, character_art)
                reference_image_paths = None
                if video_generation_mode == "reference":
                    img_path = None
                    reference_image_paths = self._get_segment_reference_assets(seg, character_art)
                    if not reference_image_paths:
                        logger.warning("VideoDirectorAgent: %s 参考图模式未匹配到第二阶段人物/场景图", seg_id)
                else:
                    img_path = self._get_reference_image(sid, seg_id, scene_map)
                duration = seg.get("total_duration", 10)
                last_img_path = self._get_next_reference_image(sid, seg_index, segments, scene_map)
                if video_generation_mode == "start_end_frame" and not last_img_path:
                    logger.warning("VideoDirectorAgent: %s 首尾帧模式缺少尾帧，回退为首帧生视频入参", seg_id)
                tasks.append((seg_id, prompt, img_path, duration, last_img_path, reference_image_paths))
            if not tasks:
                self._report_progress("视频生成", "所有视频片段已存在", 95)
                return
            done = 0
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futs = {}
                for seg_id, prompt, img_path, dur, last_img_path, reference_image_paths in tasks:
                    # 提交前立即发送正在运行的状态，让前端 UI 更新
                    self._report_progress("视频生成", f"启动生成: {seg_id}", 5, data={
                        "asset_complete": {
                            "type": "clips", "id": seg_id,
                            "status": "running"
                        }
                    })
                    fut = executor.submit(
                        self._generate_one, sid, seg_id, prompt,
                        img_path, video_model, dur,
                        video_sound, video_shot_type, video_ratio, video_resolution,
                        video_generation_mode, last_img_path, reference_image_paths
                    )
                    futs[fut] = seg_id
                for fut in as_completed(futs):
                    sid_done = futs[fut]
                    try:
                        _, res_path = fut.result()
                    except Exception as e:
                        logger.error(f"Video future error for {sid_done}: {e}")
                        res_path = None
                    done += 1
                    pct = 5 + int(90 * done / max(1, len(tasks)))
                    if res_path:
                        versions = self._list_versions(sid, sid_done)
                        self._report_progress("视频生成", f"完成: {sid_done}", pct, data={
                            "asset_complete": {
                                "type": "clips", "id": sid_done,
                                "status": "done",
                                "selected": res_path,
                                "versions": versions,
                            }
                        })
                    else:
                        self._report_progress("视频生成", f"失败: {sid_done}", pct, data={
                            "asset_complete": {
                                "type": "clips", "id": sid_done,
                                "status": "failed",
                                "selected": "", "versions": [],
                            }
                        })
                    if self.cancellation_check and self.cancellation_check():
                        for f in futs:
                            if not f.done(): f.cancel()
                        break
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, run)
        
        # 同步到 session artifacts
        self._update_session_video_data(sid, segments, style_prompt)
        
        self._report_progress("视频生成", "完成", 100)
        return self._build_payload(sid, segments, video_clips)
