import asyncio
import base64
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from html import escape
from pathlib import Path
from typing import Any, Iterable, Optional

from PIL import Image, ImageDraw, ImageFont

from config import BASE_DIR, settings
from path_security import resolve_media_reference

logger = logging.getLogger(__name__)

TEMPLATE_FIELD_DEFAULTS = {
    "title": "山河入梦",
    "text": "心之所向，素履而往",
    "author": "HITsz-TMG",
    "describe": "开源视频生成智能体",
    "brand": "卧巧",
    "signature": "HITsz-TMG",
    "subtitle": "这是一个副标题",
}
CUSTOM_TEMPLATE_FIELDS = ("author", "describe", "brand", "signature", "subtitle")


def write_text(path: str, content: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def write_json(path: str, data: Any) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def artifact(path: str, kind: str, name: Optional[str] = None) -> dict[str, Any]:
    return {
        "kind": kind,
        "name": name or os.path.basename(path),
        "path": path,
        "exists": os.path.exists(path),
    }


def extract_json_array(text: str) -> list[Any]:
    text = text.strip()
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
    except Exception:
        pass

    match = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.S)
    if not match:
        match = re.search(r"(\[.*\])", text, re.S)
    if match:
        data = json.loads(match.group(1))
        if isinstance(data, list):
            return data
    raise ValueError("Model response did not contain a JSON array.")


def split_script(text: str, split_mode: str = "paragraph") -> list[str]:
    if split_mode == "line":
        parts = [line.strip() for line in text.splitlines()]
    elif split_mode == "sentence":
        parts = [part.strip() for part in re.split(r"(?<=[。！？.!?])\s*", text)]
    else:
        parts = [part.strip() for part in re.split(r"\n\s*\n", text)]
    return [part for part in parts if part]


def copy_input_file(path: str, output_dir: str, prefix: str) -> str:
    resolved = resolve_media_reference(
        path,
        [settings.TEMP_DIR, settings.RESULT_DIR],
        allow_remote_urls=True,
    )
    if resolved.startswith(("http://", "https://")):
        return resolved
    src = Path(resolved)
    dst = Path(output_dir) / f"{prefix}{src.suffix.lower()}"
    shutil.copy2(src, dst)
    return str(dst)


async def run_blocking(func, *args, **kwargs):
    return await asyncio.to_thread(func, *args, **kwargs)


def concat_videos(video_paths: Iterable[str], output_path: str) -> Optional[str]:
    paths = [path for path in video_paths if path and os.path.exists(path)]
    if not paths:
        return None

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        logger.warning("ffmpeg not found; cannot concatenate videos")
        return None

    list_path = os.path.join(os.path.dirname(output_path), "concat.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for path in paths:
            f.write(f"file '{os.path.abspath(path)}'\n")

    cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", output_path]
    logger.info("Concatenating %d videos -> %s", len(paths), output_path)
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    logger.info("Video concatenation complete: %s", output_path)
    return output_path


def create_static_image_clip(
    image_path: str,
    audio_path: str,
    output_path: str,
    *,
    video_ratio: str = "9:16",
    duration: Optional[float] = None,
) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to create static short-video clips.")
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio not found: {audio_path}")

    width, height = _resolution_from_ratio(video_ratio)
    clip_duration = duration or media_duration_seconds(audio_path) or 3.0
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        "format=yuv420p"
    )
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    logger.info(
        "Creating static image clip: image=%s audio=%s duration=%.2fs -> %s",
        image_path,
        audio_path,
        clip_duration,
        output_path,
    )
    cmd = [
        ffmpeg,
        "-y",
        "-loop",
        "1",
        "-framerate",
        "30",
        "-i",
        image_path,
        "-i",
        audio_path,
        "-t",
        f"{clip_duration:.3f}",
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-shortest",
        "-movflags",
        "+faststart",
        output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return output_path


def _load_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in str(text or "").splitlines() or [""]:
        current = ""
        for char in paragraph.strip():
            candidate = current + char
            if current and _text_width(draw, candidate, font) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines or [""]


def _draw_centered_lines(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    *,
    center_x: int,
    y: int,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    stroke_width: int,
    stroke_fill: tuple[int, int, int, int],
    line_gap: int,
) -> int:
    cursor = y
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        draw.text(
            (center_x - width / 2, cursor),
            line,
            font=font,
            fill=fill,
            stroke_width=stroke_width,
            stroke_fill=stroke_fill,
        )
        cursor += height + line_gap
    return cursor


def render_static_text_image(
    image_path: str,
    output_path: str,
    *,
    subtitle: str,
    title: Optional[str] = None,
    video_ratio: str = "9:16",
) -> str:
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image not found: {image_path}")

    width, height = _resolution_from_ratio(video_ratio)
    with Image.open(image_path) as source:
        source = source.convert("RGB")
        source.thumbnail((width, height), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (width, height), (0, 0, 0))
        canvas.paste(source, ((width - source.width) // 2, (height - source.height) // 2))

    image = canvas.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    title_font = _load_font(max(48, int(height * 0.06)))
    subtitle_font = _load_font(max(32, int(height * 0.035)))
    margin_x = max(48, int(width * 0.07))
    max_text_width = width - margin_x * 2

    if title:
        title_lines = _wrap_text(draw, title, title_font, max_text_width)
        title_line_height = max(1, draw.textbbox((0, 0), "国", font=title_font)[3])
        title_height = len(title_lines) * title_line_height + max(0, len(title_lines) - 1) * 10
        title_y = max(48, int(height * 0.055))
        _draw_centered_lines(
            draw,
            title_lines,
            center_x=width // 2,
            y=title_y,
            font=title_font,
            fill=(255, 255, 255, 255),
            stroke_width=3,
            stroke_fill=(0, 0, 0, 210),
            line_gap=10,
        )

    subtitle_lines = _wrap_text(draw, subtitle, subtitle_font, max_text_width)
    subtitle_line_height = max(1, draw.textbbox((0, 0), "国", font=subtitle_font)[3])
    subtitle_height = len(subtitle_lines) * subtitle_line_height + max(0, len(subtitle_lines) - 1) * 10
    subtitle_y = height - max(96, int(height * 0.08)) - subtitle_height
    _draw_centered_lines(
        draw,
        subtitle_lines,
        center_x=width // 2,
        y=subtitle_y,
        font=subtitle_font,
        fill=(255, 255, 255, 255),
        stroke_width=3,
        stroke_fill=(0, 0, 0, 230),
        line_gap=10,
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    Image.alpha_composite(image, overlay).convert("RGB").save(output_path, quality=95)
    logger.info("Rendered static title/subtitle image: %s -> %s", image_path, output_path)
    return output_path


def ratio_from_size(width: int, height: int) -> str:
    if width <= 0 or height <= 0:
        return "1:1"
    divisor = max(1, math.gcd(width, height))
    return f"{width // divisor}:{height // divisor}"


def _template_size_from_id(template_id: str) -> tuple[str, int, int]:
    size = str(template_id or "").split("/", 1)[0]
    if size == "1920x1080":
        return size, 1920, 1080
    if size == "1080x1080":
        return size, 1080, 1080
    if size == "1080x1920":
        return size, 1080, 1920
    raise ValueError(f"Unsupported subtitle template size: {template_id}")


def _resolve_template_path(template_id: str, video_ratio: str) -> tuple[str, int, int]:
    if "/" in str(template_id):
        size, filename = str(template_id).split("/", 1)
        _, width, height = _template_size_from_id(template_id)
    else:
        width, height = _resolution_from_ratio(video_ratio)
        size = f"{width}x{height}"
        filename = str(template_id)
    if "/" in filename or "\\" in filename or not filename.endswith(".html"):
        raise ValueError(f"Invalid subtitle template: {template_id}")
    path = (BASE_DIR / "templates" / size / filename).resolve()
    root = (BASE_DIR / "templates" / size).resolve()
    if not str(path).startswith(str(root) + os.sep) or not path.exists():
        raise FileNotFoundError(f"Subtitle template not found: {template_id}")
    return str(path), width, height


def template_media_spec(template_id: str, video_ratio: str = "9:16") -> dict[str, Any]:
    template_path, _, _ = _resolve_template_path(template_id, video_ratio)
    with open(template_path, "r", encoding="utf-8") as f:
        raw = f.read()
    width_match = re.search(
        r'<meta\s+name=["\']template:media-width["\']\s+content=["\'](\d+)["\']',
        raw,
        re.I,
    )
    height_match = re.search(
        r'<meta\s+name=["\']template:media-height["\']\s+content=["\'](\d+)["\']',
        raw,
        re.I,
    )
    if not width_match or not height_match:
        raise ValueError(f"Subtitle template missing media size metadata: {template_id}")
    width = int(width_match.group(1))
    height = int(height_match.group(1))
    return {
        "media_width": width,
        "media_height": height,
        "media_ratio": ratio_from_size(width, height),
        "media_resolution": f"{width}*{height}",
        "supports_video": template_supports_video_media(raw),
    }


def template_supports_video_media(raw: str) -> bool:
    visible_raw = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    if re.search(r"\{\{\s*media(?:[:=][^{}]*)?\s*\}\}", visible_raw):
        return True
    return bool(
        re.search(
            r"<img\b[^>]*\bsrc=[\"']\{\{\s*image\s*\}\}[\"'][^>]*>",
            visible_raw,
            re.I,
        )
    )


def parse_template_placeholders(raw: str) -> list[dict[str, str]]:
    placeholders = []
    for match in re.finditer(r"\{\{\s*([^{}]+?)\s*\}\}", raw):
        token = match.group(1).strip()
        key = token.split(":", 1)[0].split("=", 1)[0].strip()
        field_type = token.split(":", 1)[1].split("=", 1)[0].strip() if ":" in token else "text"
        default = token.split("=", 1)[1].strip() if "=" in token else ""
        placeholders.append({
            "key": key,
            "type": field_type,
            "default": TEMPLATE_FIELD_DEFAULTS.get(key, default),
        })
    return placeholders


def template_custom_fields(template_id: str, video_ratio: str = "9:16") -> list[dict[str, str]]:
    template_path, _, _ = _resolve_template_path(template_id, video_ratio)
    with open(template_path, "r", encoding="utf-8") as f:
        placeholders = parse_template_placeholders(f.read())

    fields = []
    seen = set()
    for item in placeholders:
        key = item["key"]
        if key not in CUSTOM_TEMPLATE_FIELDS or key in seen:
            continue
        seen.add(key)
        fields.append(item)
    return fields


def _image_data_uri(path: str) -> str:
    if path.startswith(("http://", "https://", "data:", "file:")):
        return path
    if not os.path.exists(path):
        raise FileNotFoundError(f"Image not found: {path}")
    suffix = Path(path).suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(suffix, "image/png")
    with open(path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _render_template_html(raw: str, values: dict[str, Any], raw_keys: Optional[set[str]] = None) -> str:
    raw_keys = raw_keys or set()

    def repl(match: re.Match) -> str:
        token = match.group(1).strip()
        key = token.split(":", 1)[0].split("=", 1)[0].strip()
        if key in values:
            if key in raw_keys:
                return str(values[key] or "")
            return escape(str(values[key] or ""), quote=True)
        if "=" in token:
            return escape(token.split("=", 1)[1].strip(), quote=True)
        return ""

    return re.sub(r"\{\{\s*([^{}]+?)\s*\}\}", repl, raw)


def _media_file_uri(path: str) -> str:
    if path.startswith(("http://", "https://", "data:", "file:")):
        return path
    if not os.path.exists(path):
        raise FileNotFoundError(f"Media not found: {path}")
    return Path(path).resolve().as_uri()


def _template_media_element(src: str, media_kind: str) -> str:
    attrs = 'class="template-media" style="width:100%;height:100%;object-fit:cover;display:block;"'
    if media_kind == "video":
        return f'<video {attrs} src="{escape(src, quote=True)}" muted playsinline preload="auto"></video>'
    return f'<img {attrs} src="{escape(src, quote=True)}" alt="">'


def _inject_template_media_css(raw: str) -> str:
    css = (
        "<style>"
        ".template-media{width:100%;height:100%;object-fit:cover;display:block;}"
        "video.template-media{background:#000;}"
        "</style>"
    )
    if "</head>" in raw:
        return raw.replace("</head>", f"{css}</head>", 1)
    return css + raw


def _prepare_template_media_html(raw: str, *, media_kind: str) -> str:
    prepared = _inject_template_media_css(raw)
    if media_kind != "video":
        return prepared
    if re.search(r"\{\{\s*media(?:[:=][^{}]*)?\s*\}\}", prepared):
        return prepared
    return re.sub(
        r"<img\b[^>]*\bsrc=[\"']\{\{\s*image\s*\}\}[\"'][^>]*>",
        "{{media}}",
        prepared,
        flags=re.I,
    )


def _template_values(
    *,
    image_path: str,
    subtitle: str,
    title: Optional[str],
    template_values: Optional[dict[str, Any]],
    index: int,
    media_kind: str = "image",
    media_path: Optional[str] = None,
) -> dict[str, Any]:
    image_uri = _image_data_uri(image_path)
    media_src = _media_file_uri(media_path) if media_kind == "video" and media_path else image_uri
    return {
        **TEMPLATE_FIELD_DEFAULTS,
        **(template_values or {}),
        "title": title or TEMPLATE_FIELD_DEFAULTS["title"],
        "text": subtitle or "",
        "image": image_uri,
        "media": _template_media_element(media_src, media_kind),
        "index": index,
    }


def _install_playwright_chromium() -> None:
    cmd = [sys.executable, "-m", "playwright", "install", "chromium"]
    logger.info("Installing Playwright Chromium for HTML subtitle templates")
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Playwright is installed, but Chromium is missing and automatic installation failed. "
            "Run `python -m playwright install chromium` manually and retry."
        ) from exc


def _launch_playwright_chromium(playwright):
    try:
        return playwright.chromium.launch(headless=True)
    except Exception as exc:
        message = str(exc)
        if "Executable doesn't exist" not in message and "playwright install" not in message:
            raise
        _install_playwright_chromium()
        return playwright.chromium.launch(headless=True)


def render_template_text_image(
    image_path: str,
    output_path: str,
    *,
    subtitle: str,
    title: Optional[str] = None,
    video_ratio: str = "9:16",
    template_id: str,
    template_values: Optional[dict[str, Any]] = None,
    index: int = 1,
) -> str:
    template_path, width, height = _resolve_template_path(template_id, video_ratio)
    with open(template_path, "r", encoding="utf-8") as f:
        raw = _prepare_template_media_html(f.read(), media_kind="image")
    html = _render_template_html(
        raw,
        _template_values(
            image_path=image_path,
            subtitle=subtitle,
            title=title,
            template_values=template_values,
            index=index,
        ),
        raw_keys={"media"},
    )

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "HTML subtitle templates require Playwright. "
            "Install backend dependencies again or run `pip install playwright`."
        ) from exc

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with sync_playwright() as playwright:
        browser = _launch_playwright_chromium(playwright)
        try:
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
            page.set_content(html, wait_until="networkidle", timeout=30000)
            page.screenshot(path=output_path, full_page=False, type="jpeg", quality=95)
        finally:
            browser.close()
    logger.info("Rendered HTML template subtitle image: template=%s image=%s -> %s", template_id, image_path, output_path)
    return output_path


def render_template_media_video(
    media_video_path: str,
    output_path: str,
    *,
    poster_image_path: str,
    subtitle: str,
    title: Optional[str] = None,
    video_ratio: str = "9:16",
    template_id: str,
    template_values: Optional[dict[str, Any]] = None,
    index: int = 1,
    duration: Optional[float] = None,
    fps: int = 24,
) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to render HTML template videos.")
    if not os.path.exists(media_video_path):
        raise FileNotFoundError(f"Template media video not found: {media_video_path}")

    template_path, width, height = _resolve_template_path(template_id, video_ratio)
    with open(template_path, "r", encoding="utf-8") as f:
        raw = f.read()
    if not template_supports_video_media(raw):
        raise ValueError(f"Template does not support video media: {template_id}")

    raw = _prepare_template_media_html(raw, media_kind="video")
    html = _render_template_html(
        raw,
        _template_values(
            image_path=poster_image_path,
            media_kind="image",
            subtitle=subtitle,
            title=title,
            template_values=template_values,
            index=index,
        ),
        raw_keys={"media"},
    )

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "HTML subtitle templates require Playwright. "
            "Install backend dependencies again or run `pip install playwright`."
        ) from exc

    clip_duration = float(duration or media_duration_seconds(media_video_path) or 3.0)
    frame_count = max(1, int(math.ceil(clip_duration * fps)))
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    frame_dir = tempfile.mkdtemp(prefix="template_frames_", dir=os.path.dirname(output_path))
    media_frame_dir = tempfile.mkdtemp(prefix="template_media_frames_", dir=os.path.dirname(output_path))
    frame_pattern = os.path.join(frame_dir, "frame_%05d.jpg")
    media_frame_pattern = os.path.join(media_frame_dir, "media_%05d.jpg")

    logger.info(
        "Rendering HTML template video: template=%s media=%s duration=%.2fs fps=%d -> %s",
        template_id,
        media_video_path,
        clip_duration,
        fps,
        output_path,
    )
    try:
        extract_cmd = [
            ffmpeg,
            "-y",
            "-i",
            media_video_path,
            "-vf",
            f"fps={fps}",
            "-q:v",
            "2",
            media_frame_pattern,
        ]
        subprocess.run(extract_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        media_frames = sorted(str(path) for path in Path(media_frame_dir).glob("media_*.jpg"))
        if not media_frames:
            media_frames = [poster_image_path]

        with sync_playwright() as playwright:
            browser = _launch_playwright_chromium(playwright)
            try:
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                page.set_content(html, wait_until="networkidle", timeout=30000)
                for frame_index in range(frame_count):
                    media_frame_uri = _image_data_uri(media_frames[frame_index % len(media_frames)])
                    page.evaluate(
                        """async (src) => {
                            const images = Array.from(document.querySelectorAll('img.template-media'));
                            await Promise.all(images.map(async (image) => {
                                image.src = src;
                                if (image.decode) {
                                    await image.decode().catch(() => {});
                                }
                            }));
                            await new Promise(resolve => requestAnimationFrame(resolve));
                        }""",
                        media_frame_uri,
                    )
                    page.screenshot(
                        path=os.path.join(frame_dir, f"frame_{frame_index + 1:05d}.jpg"),
                        full_page=False,
                        type="jpeg",
                        quality=92,
                    )
            finally:
                browser.close()

        cmd = [
            ffmpeg,
            "-y",
            "-framerate",
            str(fps),
            "-i",
            frame_pattern,
            "-t",
            f"{clip_duration:.3f}",
            "-vf",
            "format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-movflags",
            "+faststart",
            output_path,
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)
        shutil.rmtree(media_frame_dir, ignore_errors=True)
    return output_path


def concat_audios(audio_paths: Iterable[str], output_path: str) -> Optional[str]:
    paths = [path for path in audio_paths if path and os.path.exists(path)]
    if not paths:
        return None
    if len(paths) == 1:
        return paths[0]

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        logger.warning("ffmpeg not found; cannot concatenate audios")
        return None

    list_path = os.path.join(os.path.dirname(output_path), "concat_audio.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for path in paths:
            f.write(f"file '{os.path.abspath(path)}'\n")

    cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", output_path]
    logger.info("Concatenating %d audios -> %s", len(paths), output_path)
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return output_path


def replace_video_audio(video_path: str, audio_path: str, output_path: str) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to replace digital-human video audio.")
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio not found: {audio_path}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    logger.info("Replacing video audio: video=%s audio=%s -> %s", video_path, audio_path, output_path)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        video_path,
        "-i",
        audio_path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return output_path


def media_duration_seconds(path: str) -> Optional[float]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe or not os.path.exists(path):
        return None

    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
    ]
    try:
        result = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        duration = float(result.stdout.strip())
        logger.debug("Media duration: %s = %.3fs", path, duration)
        return duration
    except Exception as exc:
        logger.warning("Failed to probe media duration: %s (%s)", path, exc)
        return None


def _resolution_from_ratio(video_ratio: str) -> tuple[int, int]:
    ratio = (video_ratio or "9:16").strip()
    if ratio in {"16:9", "landscape"}:
        return 1920, 1080
    if ratio in {"1:1", "square"}:
        return 1080, 1080
    return 1080, 1920


def _ass_time(seconds: float) -> str:
    total_centiseconds = max(0, int(round(seconds * 100)))
    centiseconds = total_centiseconds % 100
    total_seconds = total_centiseconds // 100
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours}:{minutes:02d}:{secs:02d}.{centiseconds:02d}"


def _ass_text(text: str) -> str:
    cleaned = str(text or "").strip()
    cleaned = cleaned.replace("{", "｛").replace("}", "｝")
    return cleaned.replace("\r\n", "\\N").replace("\n", "\\N")


def write_ass_subtitles(
    path: str,
    *,
    subtitles: Iterable[tuple[str, float]],
    title: Optional[str] = None,
    video_ratio: str = "9:16",
) -> str:
    width, height = _resolution_from_ratio(video_ratio)
    title_size = max(36, int(height * 0.038))
    subtitle_size = max(34, int(height * 0.032))
    title_margin_v = max(70, int(height * 0.06))
    subtitle_margin_v = max(80, int(height * 0.085))
    subtitle_margin_h = max(70, int(width * 0.07))

    events: list[str] = []
    cursor = 0.0
    normalized: list[tuple[str, float, float]] = []
    for text, duration in subtitles:
        duration_seconds = max(0.1, float(duration or 0))
        start = cursor
        end = cursor + duration_seconds
        normalized.append((text, start, end))
        cursor = end

    total_duration = cursor or 0.1
    if title:
        events.append(
            f"Dialogue: 0,{_ass_time(0)},{_ass_time(total_duration)},Title,,0,0,0,,{_ass_text(title)}"
        )
    for text, start, end in normalized:
        events.append(
            f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Subtitle,,0,0,0,,{_ass_text(text)}"
        )

    content = "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            "Collisions: Normal",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "WrapStyle: 0",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            f"Style: Title,Arial,{title_size},&H00FFFFFF,&H000000FF,&H99000000,&H66000000,-1,0,0,0,100,100,0,0,1,4,0,8,{subtitle_margin_h},{subtitle_margin_h},{title_margin_v},1",
            f"Style: Subtitle,Arial,{subtitle_size},&H00FFFFFF,&H000000FF,&HAA000000,&H66000000,0,0,0,0,100,100,0,0,1,4,0,2,{subtitle_margin_h},{subtitle_margin_h},{subtitle_margin_v},1",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            *events,
            "",
        ]
    )
    logger.info("Writing ASS subtitles: %s lines=%d title=%s", path, len(normalized), bool(title))
    return write_text(path, content)


def _ffmpeg_filter_path(path: str) -> str:
    escaped = os.path.abspath(path).replace("\\", "/")
    return escaped.replace(":", "\\:").replace("'", "\\'")


def _ffmpeg_has_filter(ffmpeg: str, filter_name: str) -> bool:
    try:
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except Exception as exc:
        logger.warning("Failed to inspect ffmpeg filters: %s", exc)
        return False
    return any(line.split()[1:2] == [filter_name] for line in result.stdout.splitlines() if line.strip())


def burn_ass_subtitles(video_path: str, subtitle_path: str, output_path: str) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to burn subtitles into video.")
    if not _ffmpeg_has_filter(ffmpeg, "ass"):
        raise RuntimeError(
            "ffmpeg was found, but its libass/ass filter is unavailable. "
            "Install an ffmpeg build with libass support before burning ASS subtitles."
        )
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")
    if not os.path.exists(subtitle_path):
        raise FileNotFoundError(f"Subtitle not found: {subtitle_path}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    logger.info("Burning ASS subtitles: video=%s subtitles=%s -> %s", video_path, subtitle_path, output_path)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        video_path,
        "-vf",
        f"ass=filename='{_ffmpeg_filter_path(subtitle_path)}'",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "veryfast",
        "-c:a",
        "copy",
        output_path,
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except subprocess.CalledProcessError as exc:
        logger.error("Failed to burn ASS subtitles: %s", exc.stderr)
        raise
    return output_path


def speed_audio_to_duration(audio_path: str, output_path: str, target_seconds: int) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to speed up long digital-human narration audio.")

    duration = media_duration_seconds(audio_path)
    if not duration:
        return audio_path
    if duration <= target_seconds:
        return audio_path

    speed = duration / float(target_seconds)
    filters = []
    remaining = speed
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    filters.append(f"atempo={remaining:.6f}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    logger.info(
        "Speeding audio to fit video duration: %s duration=%.2fs target=%ss speed=%.3fx -> %s",
        audio_path,
        duration,
        target_seconds,
        speed,
        output_path,
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        audio_path,
        "-filter:a",
        ",".join(filters),
        "-vn",
        "-acodec",
        "libmp3lame",
        output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return output_path


def extract_last_frame(video_path: str, output_path: str) -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to extract the previous video tail frame.")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    logger.info("Extracting tail frame: %s -> %s", video_path, output_path)
    cmd = [
        ffmpeg,
        "-y",
        "-sseof",
        "-0.1",
        "-i",
        video_path,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return output_path
