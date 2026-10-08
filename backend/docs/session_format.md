# Session 数据格式

Session 数据存储在 `code/data/sessions/{session_id}.json`，包含完整的项目会话信息。

## 根级字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | string | 会话唯一 ID |
| `idea` | string | 用户原始创意/故事想法 |
| `style` | string | 视觉风格，如 `realistic`、`anime` |
| `episodes` | int | 生成的剧集数量，默认 4 |
| `video_ratio` | string | 视频比例，如 `16:9`、`9:16` |
| `expand_idea` | bool | 是否扩展创意 |
| `llm_model` | string | LLM 模型名称 |
| `vlm_model` | string | VLM 模型名称 |
| `image_t2i_model` | string | 文生图模型 |
| `image_it2i_model` | string | 图生图模型 |
| `video_model` | string | 视频生成模型 |
| `enable_concurrency` | string/bool | 是否启用并发 |
| `web_search` | bool | 是否启用网络搜索 |
| `created_at` | float | 创建时间戳 |
| `updated_at` | float | 更新时间戳 |
| `current_stage` | string | 当前阶段 |
| `status` | string | 会话状态 |
| `stages_completed` | string[] | 已完成的阶段列表 |
| `error` | null / string | 错误信息 |
| `artifacts` | object | 各阶段产物（见下文） |

## Status 状态值

| 状态 | 说明 |
|------|------|
| `idle` | 初始状态 |
| `running` | 运行中 |
| `waiting` | 等待用户确认 |
| `stage_completed` | 阶段完成 |
| `session_completed` | 会话完成 |

## Stages Completed 阶段列表

按顺序完成的所有阶段：
```
script_generation → character_design → storyboard → reference_generation → video_generation → post_production
```

---

## Artifacts 各阶段产物

### 1. script_generation

```json
{
  "project_id": "proj_xxx",
  "session_id": "...",
  "version": 1,
  "created_at": "2026-04-06T00:00:00.000Z",
  "metadata": {
    "generation_model": "模型名",
    "generation_prompt": "原始生成提示词",
    "original_text": "LLM生成的原始剧本文本"
  },
  "title": "剧本名称",
  "logline": "详细故事梗概",
  "genre": ["奇幻", "温情"],
  "mood": "整体情绪基调",
  "characters": [
    {
      "name": "角色名",
      "character_id": "char_xxx",
      "description": "角色描述",
      "role": "主角/配角/反派"
    }
  ],
  "settings": [
    {
      "name": "场景名",
      "setting_id": "set_xxx",
      "description": "场景描述"
    }
  ],
  "episodes": [
    {
      "episode_number": 1,
      "act_title": "第一集标题",
      "content": "第一集的剧本正文内容"
    }
  ]
}
```

### 2. character_design

```json
{
  "session_id": "...",
  "characters": [
    {
      "id": "char_xxx",
      "name": "角色名",
      "description": "角色外观描述",
      "selected": "选中的角色图路径",
      "versions": ["所有版本路径"]
    }
  ],
  "settings": [
    {
      "id": "set_xxx",
      "name": "场景名",
      "description": "场景描述",
      "selected": "选中的场景图路径",
      "versions": ["所有版本路径"]
    }
  ]
}
```

### 3. storyboard

```json
{
  "session_id": "...",
  "episodes": [
    {
      "episode_number": 1,
      "episode_title": "第一集标题",
      "segments": [
        {
          "segment_id": "seg_01_01",
          "segment_number": 1,
          "total_duration": 10,
          "characters": ["角色名"],
          "setting": "场景位置",
          "visual_prompt": "该视频片段的参考图提示词",
          "video_prompt": "该视频片段的视频生成提示词",
          "shots": [
            {
              "shot_number": 1,
              "duration": 5,
              "content": "镜头内容",
              "camera": "镜头语言"
            }
          ]
        }
      ]
    }
  ]
}
```

> **注意**：当前完整链路是 `episode → segment → shot`。一个 `segment` 对应一次视频模型调用，`segment.shots[]` 描述同一个视频片段内部的镜头变化。

### 4. reference_generation

```json
{
  "session_id": "...",
  "scenes": [
    {
      "id": "seg_01_01",
      "name": "第1集-片段1",
      "index": 1,
      "description": "视频片段参考图描述",
      "selected": "用户选中的参考图路径",
      "versions": ["所有版本路径"],
      "status": "done/pending/failed"
    }
  ]
}
```

> **注意**：
> - `scenes[].id` = `storyboard.episodes[].segments[].segment_id`，用于跨阶段关联
> - 参考图按视频片段生成，不按单个 shot 生成

### 5. video_generation

```json
{
  "session_id": "...",
  "clips": [
    {
      "id": "seg_01_01",
      "name": "第1集-片段1",
      "index": 1,
      "description": "视频片段描述（由 storyboard.plot 同步）",
      "duration": 5,
      "selected": "用户选中的视频路径",
      "versions": ["所有版本路径"],
      "status": "done/pending/failed"
    }
  ]
}
```

> **注意**：`clips[].id` = `storyboard.episodes[].segments[].segment_id`

### 6. post_production

```json
{
  "session_id": "...",
  "final_videos": [
    {
      "episode": 1,
      "path": "code/result/video/xxx_ep1.mp4",
      "name": "第 1 集"
    }
  ],
  "final_video": "code/result/video/xxx_ep1.mp4"
}
```

> **注意**：`final_videos` 包含按剧集拼接的所有成片列表，`final_video` 保留为兼容第一集的字段。

---

## 跨阶段数据同步关系

```
storyboard (修改 segment.visual_prompt / segment.video_prompt / total_duration / shots)
    ↓
video_generation.clips (description/duration)
    ↑ (修改 description/duration)
    ↑
video_generation (修改 clips.description/clips.duration)
    ↓ (修改后同步回 storyboard)
storyboard (修改后同步回 storyboard.episodes[].segments[])

reference_generation (修改 scenes.description)
    ↓
storyboard.episodes[].segments[].visual_prompt (由 reference_generation 同步)
    ↑ (修改后同步)
    ↑
reference_generation (修改 scenes.description)
```

---

## PATCH /artifact/{stage} 请求格式

### storyboard
```json
{
  "episodes": [
    {
      "episode_number": 1,
      "segments": [
        {"segment_id": "seg_01_01", "total_duration": 10, "visual_prompt": "新提示词", "shots": []}
      ]
    }
  ]
}
```

### reference_generation（修改视觉提示词）
```json
{
  "segments": [
    {"segment_id": "seg_01_01", "visual_prompt": "新提示词"}
  ]
}
```

### reference_generation（选择图片版本）
```json
{
  "seg_01_01": "code/result/image/xxx/seg_01_01_v2.jpg"
}
```

### video_generation（修改片段描述/时长）
```json
{
  "seg_01_01": {"description": "新描述", "duration": 5}
}
```

### video_generation（选择视频版本）
```json
{
  "shot_001_01": "code/result/video/xxx/shot_001_01_v2.mp4"
}
```
