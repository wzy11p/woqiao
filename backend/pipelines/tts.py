import os
from typing import Optional


def speed_to_rate(speed: Optional[float]) -> str:
    value = 1.0 if speed is None else float(speed)
    percent = int(round((value - 1.0) * 100))
    sign = "+" if percent >= 0 else ""
    return f"{sign}{percent}%"


async def generate_edge_tts(
    text: str,
    output_path: str,
    voice: str = "zh-CN-YunjianNeural",
    speed: float = 1.0,
) -> str:
    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError("edge-tts is required for audio generation. Install backend dependencies again.") from exc

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=speed_to_rate(speed))
    await communicate.save(output_path)
    return output_path
