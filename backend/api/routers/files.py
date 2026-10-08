import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile

from config import settings
from models.file_reader import FileReader
from path_security import resolve_allowed_local_file

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Files"])

DOCUMENT_UPLOAD_LIMIT = 20 * 1024 * 1024
MEDIA_UPLOAD_LIMIT = 500 * 1024 * 1024
UPLOAD_CHUNK_SIZE = 1024 * 1024


async def _save_upload(file: UploadFile, destination: str, max_bytes: int) -> int:
    written = 0
    try:
        with open(destination, "wb") as buffer:
            while chunk := await file.read(UPLOAD_CHUNK_SIZE):
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(status_code=413, detail=f"文件大小不能超过 {max_bytes // 1024 // 1024} MB")
                buffer.write(chunk)
    except Exception:
        if os.path.exists(destination):
            os.remove(destination)
        raise
    return written


def _safe_upload_name(filename: str, fallback: str = "upload") -> str:
    original_name = Path(filename or fallback).name or fallback
    return f"{uuid.uuid4().hex}_{original_name}"


def _path_size(path: str) -> int:
    if os.path.isfile(path) or os.path.islink(path):
        return os.path.getsize(path)
    total = 0
    for root, dirs, files in os.walk(path):
        for name in files:
            item = os.path.join(root, name)
            try:
                total += os.path.getsize(item)
            except OSError:
                continue
        for name in dirs:
            item = os.path.join(root, name)
            if os.path.islink(item):
                try:
                    total += os.path.getsize(item)
                except OSError:
                    continue
    return total


@router.post("/api/upload_file")
async def upload_file(file: UploadFile = File(...)):
    allowed_exts = [".docx", ".doc", ".txt", ".md", ".pdf"]
    filename = Path(file.filename or "upload").name
    ext = os.path.splitext(filename)[1].lower()
    if ext not in allowed_exts:
        raise HTTPException(status_code=400, detail=f"仅支持 {', '.join(allowed_exts)} 格式的文件")

    os.makedirs(settings.TEMP_DIR, exist_ok=True)
    safe_filename = _safe_upload_name(filename)
    file_path = os.path.join(settings.TEMP_DIR, safe_filename)
    try:
        await _save_upload(file, file_path, DOCUMENT_UPLOAD_LIMIT)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"保存上传文件失败: {e}")
        raise HTTPException(status_code=500, detail=f"文件保存失败: {str(e)}")

    return {"filename": filename, "file_path": safe_filename}


@router.post("/api/upload_media")
async def upload_media(file: UploadFile = File(...)):
    allowed_exts = [
        ".jpg", ".jpeg", ".png", ".webp", ".bmp",
        ".mp4", ".mov", ".avi", ".mkv", ".webm",
        ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
    ]
    filename = file.filename or "upload"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in allowed_exts:
        raise HTTPException(status_code=400, detail=f"仅支持 {', '.join(allowed_exts)} 格式的媒体文件")

    os.makedirs(settings.TEMP_DIR, exist_ok=True)
    safe_filename = _safe_upload_name(filename)
    file_path = os.path.join(settings.TEMP_DIR, safe_filename)
    try:
        await _save_upload(file, file_path, MEDIA_UPLOAD_LIMIT)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"保存上传媒体失败: {e}")
        raise HTTPException(status_code=500, detail=f"媒体保存失败: {str(e)}")

    return {
        "filename": filename,
        "file_path": str(Path(file_path).resolve()),
    }


@router.delete("/api/cache/temp")
async def clear_temp_cache():
    os.makedirs(settings.TEMP_DIR, exist_ok=True)
    deleted = 0
    freed_bytes = 0
    errors = []
    for entry in os.scandir(settings.TEMP_DIR):
        try:
            freed_bytes += _path_size(entry.path)
            if entry.is_dir(follow_symlinks=False):
                shutil.rmtree(entry.path)
            else:
                os.remove(entry.path)
            deleted += 1
        except Exception as exc:
            logger.warning("Failed to delete temp cache item: %s", entry.path, exc_info=True)
            errors.append({"path": entry.name, "error": str(exc)})
    return {
        "status": "ok",
        "deleted": deleted,
        "freed_bytes": freed_bytes,
        "freed_mb": round(freed_bytes / 1024 / 1024, 2),
        "errors": errors,
    }


def merge_uploaded_file_into_idea(idea: str, file_path: Optional[str]) -> str:
    if not file_path:
        return idea

    try:
        full_path = resolve_allowed_local_file(file_path, [settings.TEMP_DIR])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    content = FileReader.extract_text(full_path)
    if content:
        original_filename = "_".join(os.path.basename(file_path).split("_")[1:])
        prompt_fragment = FileReader.format_as_prompt(original_filename, content)
        idea = f"{idea}\n\n{prompt_fragment}"
    logger.info(f"成功处理上传文件: {full_path}")
    logger.debug(f"文件内容预览:\n{content[:500]}")
    return idea
