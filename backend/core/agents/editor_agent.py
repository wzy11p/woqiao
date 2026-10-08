# -*- coding: utf-8 -*-
"""
阶段6: 后期制作智能体
拼接用户在阶段5选定的视频片段 → 最终成片
"""

import os
import re
import asyncio
import logging
import subprocess
from typing import Any, Optional, Dict

from .base_agent import AgentInterface

logger = logging.getLogger(__name__)


class VideoEditorAgent(AgentInterface):
    """后期制作：拼接用户选择的视频片段 → 最终成片"""

    def __init__(self):
        super().__init__(name="VideoEditor")

    async def process(self, input_data: Any, intervention: Optional[Dict] = None) -> Dict:
        input_data = self._merge_session_params(input_data)
        sid = input_data["session_id"]

        # 从编排器注入的统一 session 快照读取阶段5数据。
        artifacts = self._session_artifacts(input_data)
        video_art = artifacts.get("video_generation", {})
        clips_list = video_art.get("clips", [])
        
        # 获取剧集标题映射 (从 Storyboard)
        storyboard_art = artifacts.get("storyboard", {})
        episodes_info = storyboard_art.get("episodes", [])
        ep_title_map = {int(ep.get("episode_number", 0)): ep.get("act_title", f"第 {ep.get('episode_number')} 集") 
                        for ep in episodes_info if ep.get("episode_number")}
        
        if not clips_list:
            # 兼容旧逻辑：如果 artifacts 里没有，尝试从 input_data 获取
            selected_clips: dict = input_data.get("selected_clips", {})
            if not selected_clips:
                raise Exception("未找到选定的视频片段数据，请先完成阶段5")
        
        self._report_progress("后期制作", "准备视频片段...", 5)

        def run():
            video_dir = os.path.join('code/result/video', str(sid))
            os.makedirs(video_dir, exist_ok=True)
            output_dir = os.path.join(video_dir, 'output')
            os.makedirs(output_dir, exist_ok=True)
            
            # 按剧集分组片段
            episodes_map = {}  # { episode_index: [clip_paths] }
            
            if clips_list:
                for clip in clips_list:
                    path = clip.get("selected")
                    if not path or not os.path.exists(path):
                        logger.warning(f"[{sid}] Clip missing: {clip.get('id')} → {path}")
                        continue
                    
                    # 优先使用片段数据中的 episode 字段
                    ep_idx = clip.get("episode")
                    
                    # 如果没有 episode 字段，则尝试通过 ID 解析
                    if ep_idx is None:
                        match = re.search(r'(?:seg_|shot_)?(\d{1,3})_\d{1,3}', clip.get("id", ""))
                        if match:
                            ep_idx = int(match.group(1))
                        else:
                            # 最后的归底方案：从 name 提取或默认为 1
                            name_match = re.search(r'第(\d+)集', clip.get("name", ""))
                            if not name_match:
                                name_match = re.search(r'(\d+)', clip.get("name", ""))
                            ep_idx = int(name_match.group(1)) if name_match else 1
                    
                    episodes_map.setdefault(int(ep_idx), []).append(path)
            else:
                # 兼容旧逻辑
                def sort_key(k: str) -> tuple:
                    return tuple(int(n) for n in re.findall(r'\d+', k)) or (999,)
                selected_clips = input_data.get("selected_clips", {})
                for shot_id in sorted(selected_clips.keys(), key=sort_key):
                    path = selected_clips[shot_id]
                    if os.path.exists(path):
                        # 旧逻辑默认全部归为第1集
                        episodes_map.setdefault(1, []).append(path)
                    else:
                        logger.warning(f"[{sid}] Clip missing: {shot_id} → {path}")

            if not episodes_map:
                raise Exception("没有可用于拼接的视频文件")

            final_videos = []
            sorted_episodes = sorted(episodes_map.keys())
            total_eps = len(sorted_episodes)

            ffmpeg_exe = 'ffmpeg'

            for i, ep_idx in enumerate(sorted_episodes):
                self._report_progress("后期制作", f"正在拼接第 {ep_idx} 集 ({i+1}/{total_eps})...", int(20 + (i/total_eps)*70))
                
                clip_paths = episodes_map[ep_idx]
                list_file = os.path.join(video_dir, f'concat_list_ep{ep_idx}.txt')
                output = os.path.join(output_dir, f'{sid}_ep{ep_idx}.mp4')
                
                with open(list_file, 'w', encoding='utf-8') as f:
                    for p in clip_paths:
                        abs_p = os.path.abspath(p).replace('\\', '/')
                        f.write(f"file '{abs_p}'\n")

                cmd = [
                    ffmpeg_exe, '-y', '-f', 'concat', '-safe', '0',
                    '-i', list_file, 
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
                    '-c:a', 'aac', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', output
                ]
                
                logger.info(f"[{sid}] Running ffmpeg for Ep {ep_idx}: {cmd}")
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
                except subprocess.CalledProcessError as e:
                    logger.error(f"FFmpeg failed with exit code {e.returncode}")
                    logger.error(f"FFmpeg stderr: {e.stderr}")
                    raise Exception(f"视频拼接失败: {e.stderr}")
                
                ep_title = ep_title_map.get(ep_idx, f"第 {ep_idx} 集")
                final_videos.append({
                    "episode": ep_idx,
                    "path": output,
                    "name": ep_title
                })

            return final_videos

        loop = asyncio.get_running_loop()
        final_results = await loop.run_in_executor(None, run)

        self._report_progress("后期制作", "成片完成", 100)

        return {
            "payload": {
                "session_id": sid,
                "final_videos": final_results,
                "final_video": final_results[0]["path"] if final_results else "",
            },
            "stage_completed": True,
        }
