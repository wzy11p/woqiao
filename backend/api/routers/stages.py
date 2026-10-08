from fastapi import APIRouter

router = APIRouter(tags=["Stages"])


@router.get("/api/stages")
async def list_stages():
    return {
        "stages": [
            {"id": "script_generation", "name": "剧本生成", "order": 1, "description": "将灵感转化为结构化剧本"},
            {"id": "character_design", "name": "角色/场景设计", "order": 2, "description": "生成角色设计图和场景背景"},
            {"id": "storyboard", "name": "分镜设计", "order": 3, "description": "设计镜头语言和分镜脚本"},
            {"id": "reference_generation", "name": "参考图生成", "order": 4, "description": "生成高精度参考图"},
            {"id": "video_generation", "name": "视频生成", "order": 5, "description": "将参考图/分镜图生成视频"},
            {"id": "post_production", "name": "后期剪辑", "order": 6, "description": "拼接视频片段为最终成片"},
        ]
    }

