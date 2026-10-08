'use client';

import { useState, useEffect, useRef, DragEvent } from 'react';
import { Sparkles, Image, Video, MessageSquare, Zap, Loader2, Copy, Check, Trash2, X, FolderOpen, Upload, Globe, Hexagon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type { ModelOption, ProviderGroup } from '@/config/models';
import BrandHeader from '@/components/BrandHeader';
import { fetchSandboxTasks, uploadMedia } from '@/lib/workflowApi';
import { fetchModelGroupsByType } from '@/lib/modelRegistry';

// 辅助函数：将相对路径转换为完整 URL
const toMediaUrl = (path: string) => {
  if (!path) return '';
  // 如果已经是完整 URL，直接返回
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  // 相对路径添加 /code/ 前缀（result/xxx 格式）
  if (path.startsWith('result/')) {
    return `/code/${path}`;
  } else if (!path.startsWith('/code/')) {
    return `/code/result/${path}`;
  }
  return path;
};

async function readJsonResponse(resp: Response) {
  const text = await resp.text();
  if (!text.trim()) {
    if (!resp.ok) throw new Error(`请求失败：${resp.status}`);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(resp.ok ? `接口返回了非 JSON 内容：${preview}` : `请求失败：${resp.status} ${preview}`);
  }
}

// 工具类型
type ToolType = 'llm' | 'vlm' | 't2i' | 'i2i' | 'video';

const EMPTY_MODEL_GROUPS: Record<ToolType, ProviderGroup[]> = {
  llm: [],
  vlm: [],
  t2i: [],
  i2i: [],
  video: [],
};

interface Tool {
  id: ToolType;
  name: string;
  description: string;
  icon: React.ReactNode;
}

const tools: Tool[] = [
  { id: 'llm', name: 'LLM 对话', description: '文字生成', icon: <MessageSquare className="w-5 h-5" /> },
  { id: 'vlm', name: '图片理解', description: '分析图片内容', icon: <Image className="w-5 h-5" /> },
  { id: 't2i', name: '文生图', description: '文字生成图片', icon: <Sparkles className="w-5 h-5" /> },
  { id: 'i2i', name: '图生图', description: '图片风格转换', icon: <Zap className="w-5 h-5" /> },
  { id: 'video', name: '视频生成', description: '图生视频/文生视频', icon: <Video className="w-5 h-5" /> },
];

// 历史记录类型
interface HistoryRecord {
  id: string;
  tool: string;
  model: string;
  input: {
    prompt?: string;
    images?: string[];
    reference_image?: string;
  };
  output?: {
    response?: string;
    images?: string[];
    video?: string;
    video_path?: string;
  };
  created_at: string;
}

function SandboxOutput({ output }: { output?: HistoryRecord['output'] | null }) {
  if (!output) return null;
  return (
    <div className="space-y-4">
      {output.response && (
        <pre className="text-sm text-gray-700 whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
          {output.response}
        </pre>
      )}
      {output.images && output.images.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {output.images.map((img, i) => (
            <a key={i} href={toMediaUrl(img)} target="_blank" rel="noopener noreferrer" className="group block rounded-xl border border-gray-200 bg-white overflow-hidden">
              <img src={toMediaUrl(img)} alt={`output-${i}`} className="w-full h-56 object-contain bg-gray-50" />
              <div className="px-3 py-2 text-xs text-gray-500 group-hover:text-indigo-600 border-t border-gray-100">查看图片</div>
            </a>
          ))}
        </div>
      )}
      {output.video_path && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <video src={toMediaUrl(output.video_path)} controls className="w-full max-h-[28rem] bg-black object-contain" />
          <div className="px-3 py-2 border-t border-gray-100">
            <a href={toMediaUrl(output.video_path)} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline">
              查看视频
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// 图片上传组件
function ImageUploader({
  value,
  onChange,
  required,
  label,
}: {
  value: string;
  onChange: (url: string) => void;
  required?: boolean;
  label: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [inputMode, setInputMode] = useState<'url' | 'file'>('file');
  const [previewUrl, setPreviewUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await uploadFile(files[0]);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await uploadFile(files[0]);
    }
  };

  const uploadFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }

    setUploading(true);
    try {
      const result = await uploadMedia(file);
      setPreviewUrl(current => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      onChange(result.file_path);
    } catch (e) {
      alert(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  // 判断是否为 URL
  const isUrl = value.startsWith('http://') || value.startsWith('https://');

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {label} {required && <span className="text-red-500">*</span>}
      </label>

      {/* 切换 URL / 文件上传 */}
      <div className="flex gap-2 mb-2">
        <button
          type="button"
          onClick={() => setInputMode('url')}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
            inputMode === 'url' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          URL 地址
        </button>
        <button
          type="button"
          onClick={() => setInputMode('file')}
          className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
            inputMode === 'file' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          本地上传
        </button>
      </div>

      {/* URL 输入模式 */}
      {inputMode === 'url' && (
        <div className="space-y-2">
          <input
            type="text"
            value={isUrl ? value : ''}
            onChange={e => {
              setPreviewUrl(current => {
                if (current) URL.revokeObjectURL(current);
                return '';
              });
              onChange(e.target.value);
            }}
            placeholder="https://example.com/image.jpg"
            className="w-full px-4 py-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
          />
          {value && isUrl && (
            <div className="relative group">
              <img src={value} alt="预览" className="max-h-48 rounded-lg border border-gray-200" />
              <button
                onClick={() => onChange('')}
                className="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* 文件上传模式 */}
      {inputMode === 'file' && (
        <>
          {value && !isUrl ? (
            <div className="relative group">
              {previewUrl ? (
                <img src={previewUrl} alt="上传的图片" className="max-h-48 rounded-lg border border-gray-200" />
              ) : (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500 break-all">
                  已上传：{value}
                </div>
              )}
              <button
                onClick={() => {
                  setPreviewUrl(current => {
                    if (current) URL.revokeObjectURL(current);
                    return '';
                  });
                  onChange('');
                }}
                className="absolute top-2 right-2 p-1.5 bg-red-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
              {uploading ? (
                <Loader2 className="w-8 h-8 mx-auto mb-2 text-indigo-500 animate-spin" />
              ) : (
                <Upload className="w-8 h-8 mx-auto mb-2 text-gray-400" />
              )}
              <p className="text-sm text-gray-500">
                拖拽图片到此处，或 <span className="text-indigo-600">点击选择文件</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">支持 PNG、JPG、WebP 等格式</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function SandboxPage() {
  const [activeTool, setActiveTool] = useState<ToolType>('llm');
  const [modelGroups, setModelGroups] = useState<Record<ToolType, ProviderGroup[]>>(EMPTY_MODEL_GROUPS);
  const [prompt, setPrompt] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [currentOutput, setCurrentOutput] = useState<HistoryRecord['output'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 历史记录状态
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [manageMode, setManageMode] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<HistoryRecord | null>(null);
  const searchParams = useSearchParams();

  const flattenModels = (groups: ProviderGroup[]): ModelOption[] => groups.flatMap(group => group.models);

  const getModels = () => flattenModels(modelGroups[activeTool] || []);

  const firstModelId = (groups: ProviderGroup[]) => {
    const models = flattenModels(groups);
    return models.find(model => model.default)?.id || models[0]?.id || '';
  };

  const [selectedModel, setSelectedModel] = useState('');
  const [webSearch, setWebSearch] = useState(false);

  // 获取历史记录
  const fetchHistory = async () => {
    try {
      const resp = await fetch('/api/sandbox/history');
      const data = await readJsonResponse(resp);
      if (data.success) {
        setHistory(data.records);
      }
    } catch (e) {
      console.error('Failed to fetch history:', e);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchModelGroupsByType('llm'),
      fetchModelGroupsByType('vlm'),
      fetchModelGroupsByType('t2i'),
      fetchModelGroupsByType('i2i'),
      fetchModelGroupsByType('video'),
    ])
      .then(([llm, vlm, t2i, i2i, video]) => {
        if (cancelled) return;
        const groups = { llm, vlm, t2i, i2i, video };
        setModelGroups(groups);
        setSelectedModel(current => current || firstModelId(groups[activeTool]));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const applyRecord = (record: HistoryRecord) => {
    setSelectedRecord(record);
    setActiveTool(record.tool as ToolType);
    setSelectedModel(record.model);
    setPrompt(record.input.prompt || '');
    setImageUrl(record.input.reference_image || record.input.images?.[0] || '');
    if (record.output?.response) {
      setResult(record.output.response);
    } else {
      setResult(null);
    }
    setCurrentOutput(record.output || null);
    setLoading(false);
    setError(null);
  };

  // 检查 URL 参数，自动加载历史记录
  useEffect(() => {
    const recordId = searchParams.get('record');
    if (recordId && history.length > 0) {
      const record = history.find(r => r.id === recordId);
      if (record) {
        applyRecord(record);
      }
    }
  }, [searchParams, history]);

  useEffect(() => {
    const taskId = searchParams.get('task');
    if (!taskId) return;
    let cancelled = false;

    const loadTask = async () => {
      const historyRecord = history.find(r => r.id === taskId);
      if (historyRecord) {
        applyRecord(historyRecord);
        return;
      }

      const activeTasks = await fetchSandboxTasks();
      const activeTask = activeTasks.find(item => item.id === taskId);
      if (!activeTask || cancelled) return;
      setActiveTool(activeTask.tool as ToolType);
      setSelectedModel(activeTask.model);
      setPrompt(activeTask.input?.prompt || '');
      setImageUrl(activeTask.input?.reference_image || activeTask.input?.images?.[0] || '');
      setCurrentOutput(null);
      setResult(null);
      setError(null);
      setLoading(true);
    };

    loadTask().catch(() => {});
    const timer = window.setInterval(() => {
      fetchHistory().then(() => loadTask()).catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [searchParams, history]);

  // 删除历史记录
  const deleteRecord = async (id: string) => {
    setDeleting(id);
    try {
      const resp = await fetch(`/api/sandbox/history/${id}`, { method: 'DELETE' });
      const data = await readJsonResponse(resp);
      if (data.success) {
        setHistory(history.filter(r => r.id !== id));
        if (selectedRecord?.id === id) {
          setSelectedRecord(null);
          setResult(null);
          setCurrentOutput(null);
        }
      }
    } catch (e) {
      console.error('Failed to delete:', e);
    } finally {
      setDeleting(null);
    }
  };

  // 工具切换时重置模型选择
  const handleToolChange = (tool: ToolType) => {
    setActiveTool(tool);
    setSelectedModel(firstModelId(modelGroups[tool]));
    setResult(null);
    setCurrentOutput(null);
    setError(null);
    setImageUrl('');
  };

  // 监听工具变化，确保模型选择同步
  useEffect(() => {
    const models = getModels();
    // 只有当前模型不在新工具的模型列表中时才更新
    const currentInList = models.some(m => m.id === selectedModel);
    if (!currentInList) {
      setSelectedModel(models.find(m => m.default)?.id || models[0]?.id || '');
    }
  }, [activeTool, modelGroups, selectedModel]);

  // 检查是否可以提交
  const canSubmit = () => {
    if (!selectedModel) return false;
    if (!prompt.trim() && activeTool !== 't2i') return false;
    if ((activeTool === 'i2i') && !imageUrl) return false;
    return true;
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;

    setLoading(true);
    setResult(null);
    setCurrentOutput(null);
    setError(null);

    try {
      let apiUrl = '';
      let body: Record<string, unknown> = {
        model: selectedModel,
        prompt: prompt,
      };

      switch (activeTool) {
        case 'llm':
          apiUrl = '/api/sandbox/llm';
          // web_search 只对 LLM 有效
          if (webSearch) {
            body.web_search = true;
          }
          break;
        case 'vlm':
          apiUrl = '/api/sandbox/vlm';
          body.images = [imageUrl];
          break;
        case 't2i':
          apiUrl = '/api/sandbox/t2i';
          break;
        case 'i2i':
          apiUrl = '/api/sandbox/i2i';
          body.image = imageUrl;
          break;
        case 'video':
          apiUrl = '/api/sandbox/video';
          body.image = imageUrl;
          break;
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await readJsonResponse(response);

      if (data.success) {
        if (activeTool === 't2i' || activeTool === 'i2i' || activeTool === 'video') {
          const output = activeTool === 'video'
            ? { video_path: data.video_path }
            : { images: Array.isArray(data.result) ? data.result : [] };
          setCurrentOutput(output);
          setResult(null);
        } else {
          const output = { response: data.result };
          setCurrentOutput(output);
          setResult(data.result);
        }
        fetchHistory();
      } else {
        setError(data.error || '未知错误');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setLoading(false);
    }
  };

  const copyResult = () => {
    const copyText = result || JSON.stringify(currentOutput, null, 2);
    if (copyText) {
      navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 获取工具名称
  const getToolName = (tool: string) => {
    const t = tools.find(x => x.id === tool);
    return t?.name || tool;
  };

  // 格式化日期
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 获取图片输入的标签
  const getImageLabel = () => {
    switch (activeTool) {
      case 'vlm': return '上传图片';
      case 'i2i': return '参考图片';
      case 'video': return '首帧图片';
      default: return '图片';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50/50">
      <BrandHeader />

      <main className="max-w-5xl mx-auto px-6 py-8">
        <>
            <div className="mb-8 text-center">
              <div className="inline-flex items-center gap-2 mb-3">
                <Hexagon className="w-7 h-7 text-blue-500" />
                <h1 className="text-2xl font-bold text-gray-800">临时工作台</h1>
              </div>
              <p className="text-sm text-gray-500">独立调用各种 AI 工具</p>
            </div>

            {/* 工具选择 */}
            <div className="grid grid-cols-5 gap-3 mb-8">
              {tools.map(tool => (
                <button
                  key={tool.id}
                  onClick={() => handleToolChange(tool.id)}
                  className={`p-4 rounded-xl border-2 transition-all text-center ${
                    activeTool === tool.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-md'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:shadow-sm'
                  }`}
                >
                  <div className="flex justify-center mb-2">{tool.icon}</div>
                  <div className="font-medium text-sm">{tool.name}</div>
                  <div className="text-xs text-gray-400">{tool.description}</div>
                </button>
              ))}
            </div>

            {/* 输入区域 */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
              {/* 模型选择 */}
              <div className="mb-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700 mb-2">选择模型</label>
                    <select
                      value={selectedModel}
                      onChange={e => setSelectedModel(e.target.value)}
                      className="w-full px-4 py-2.5 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                    >
                      {getModels().map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  {/* 联网搜索开关 */}
                  {activeTool === 'llm' && (
                    <button
                      onClick={() => setWebSearch(!webSearch)}
                      className={`ml-4 px-4 py-2.5 rounded-lg border-2 flex items-center gap-2 transition-colors ${
                        webSearch
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300'
                      }`}
                    >
                      <Globe className="w-4 h-4" />
                      <span className="text-sm font-medium">联网搜索</span>
                    </button>
                  )}
                </div>
              </div>

              {/* 图片上传（部分工具需要） */}
              {(activeTool === 'vlm' || activeTool === 'i2i' || activeTool === 'video') && (
                <ImageUploader
                  value={imageUrl}
                  onChange={setImageUrl}
                  required={activeTool === 'i2i'}
                  label={getImageLabel()}
                />
              )}

              {/* 提示词输入 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {activeTool === 'llm' ? '对话内容' :
                   activeTool === 'vlm' ? '想了解图片的什么问题？' :
                   activeTool === 't2i' ? '图片描述（英文效果更好）' :
                   activeTool === 'i2i' ? '希望生成什么样的图片？' :
                   '视频描述（希望生成什么样的视频？）'}
                </label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder={
                    activeTool === 'llm' ? '输入你想问的问题...' :
                    activeTool === 'vlm' ? '描述这张图片的内容...' :
                    'A cute cat sitting on a couch, realistic style'
                  }
                  rows={4}
                  className="w-full px-4 py-3 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
                />
              </div>

              {/* 提交按钮 */}
              <button
                onClick={handleSubmit}
                disabled={loading || !canSubmit()}
                className="w-full py-3 px-6 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>处理中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    <span>生成</span>
                  </>
                )}
              </button>
            </div>

            {/* 结果展示 */}
            {(currentOutput || error) && (
              <div className={`rounded-2xl border p-6 ${error ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className={`font-medium ${error ? 'text-red-700' : 'text-green-700'}`}>
                    {error ? '错误' : '结果'}
                  </h3>
                  {!error && currentOutput && (
                    <button onClick={copyResult} className="p-2 rounded-lg hover:bg-white/50 transition-colors" title="复制结果">
                      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 text-gray-500" />}
                    </button>
                  )}
                </div>
                {error ? (
                  <p className="text-red-600 text-sm">{error}</p>
                ) : (
                  <SandboxOutput output={currentOutput} />
                )}
              </div>
            )}
          <section className="mt-10">
            <div className="flex items-center gap-2 mb-4">
              <FolderOpen className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-medium text-gray-600">{getToolName(activeTool)}历史记录</h2>
              <button
                onClick={() => setManageMode(value => !value)}
                className={`ml-auto text-xs px-2.5 h-8 rounded-lg transition-colors ${
                  manageMode ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {manageMode ? '完成' : '管理'}
              </button>
            </div>
            {history.filter(record => record.tool === activeTool).length === 0 ? (
              <div className="h-32 rounded-xl border border-dashed border-gray-200 bg-white/70 flex items-center justify-center text-sm text-gray-400">
                暂无历史记录
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {history.filter(record => record.tool === activeTool).map(record => (
                  <div
                    key={record.id}
                    onClick={() => {
                      if (manageMode) return;
                      setSelectedRecord(record);
                      setPrompt(record.input.prompt || '');
                      setImageUrl(record.input.reference_image || record.input.images?.[0] || '');
                      setCurrentOutput(record.output || null);
                      setResult(record.output?.response || null);
                      setError(null);
                    }}
                    className={`bg-white rounded-xl border border-gray-200 p-4 hover:border-indigo-300 hover:shadow-sm transition-all ${manageMode ? '' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-700 truncate">
                          {record.input.prompt || record.input.reference_image || '(无提示词)'}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded">{record.model}</span>
                          <span className="text-[10px] text-gray-400">{formatDate(record.created_at)}</span>
                        </div>
                      </div>
                      {manageMode && (
                        <button
                          onClick={event => {
                            event.stopPropagation();
                            deleteRecord(record.id);
                          }}
                          disabled={deleting === record.id}
                          className="w-8 h-8 rounded-lg text-red-500 bg-red-50 hover:bg-red-100 flex items-center justify-center flex-shrink-0"
                        >
                          {deleting === record.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      </main>
    </div>
  );
}
