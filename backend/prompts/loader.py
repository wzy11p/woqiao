# -*- coding: utf-8 -*-
"""
统一提示词加载器
从 prompts/ 目录加载提示词模板文件
"""

import os
from typing import Optional

# 获取 prompts 目录的绝对路径 (loader.py is in backend/prompts/, prompts are in backend/prompts/)
PROMPTS_DIR = os.path.dirname(os.path.abspath(__file__))


def load_prompt(category: str, name: str, lang: str = 'zh') -> str:
    """
    加载提示词文件

    Args:
        category: 提示词分类 (script, character, setting, storyboard, reference, video, logline)
        name: 提示词文件名 (不含扩展名)
        lang: 语言版本 ('zh' 或 'en')

    Returns:
        提示词内容字符串

    Example:
        prompt = load_prompt('script', 'logline_generate', 'zh')
    """
    # 尝试加载语言版本
    file_path = os.path.join(PROMPTS_DIR, category, f"{name}_{lang}.txt")
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read().strip()

    # 回退到带 _zh 的版本
    file_path = os.path.join(PROMPTS_DIR, category, f"{name}_zh.txt")
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read().strip()

    # 回退到不带后缀的通用版本
    file_path = os.path.join(PROMPTS_DIR, category, f"{name}.txt")
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read().strip()

    raise FileNotFoundError(f"Prompt not found: {category}/{name}_{lang}.txt or {category}/{name}.txt")


def load_prompt_with_fallback(category: str, name: str, lang: str = 'zh', fallback_lang: str = 'zh') -> str:
    """
    加载提示词，如果指定语言不存在则回退

    Args:
        category: 提示词分类
        name: 提示词文件名
        lang: 首选语言
        fallback_lang: 回退语言
    """
    # 先尝试首选语言
    file_path = os.path.join(PROMPTS_DIR, category, f"{name}_{lang}.txt")
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read().strip()

    # 回退到指定语言
    if fallback_lang != lang:
        file_path = os.path.join(PROMPTS_DIR, category, f"{name}_{fallback_lang}.txt")
        if os.path.exists(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read().strip()

    # 最后尝试不带后缀的版本
    file_path = os.path.join(PROMPTS_DIR, category, f"{name}.txt")
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read().strip()

    raise FileNotFoundError(f"Prompt not found: {category}/{name}_{lang}.txt")


def format_prompt(template: str, **kwargs) -> str:
    """
    格式化提示词模板

    Args:
        template: 提示词模板字符串
        **kwargs: 格式化参数

    Returns:
        格式化后的提示词

    Example:
        prompt = format_prompt("Hello {name}, you are {age} years old", name="John", age=30)
    """
    return template.format(**kwargs)
