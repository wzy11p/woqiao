'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Clapperboard, Download, ImagePlus, Loader2, Music2, Plus, Save, Trash2, Upload } from 'lucide-react';
import BrandHeader from '@/components/BrandHeader';
import { uploadMedia, fetchPipelineTask, type PipelineTask } from '@/lib/workflowApi';
import styles from './MotionWorkspace.module.css';

type Camera = 'fixed' | 'follow' | 'push' | 'reveal' | 'arc';
type Shot = {
  id: string; title: string; prompt: string; camera: Camera;
  character_image: string; scene_image: string; frame_image: string; action_video: string;
  use_reference_music: boolean; reference_start: number; action_start: number; duration: number;
  selected_video: string; trim_start: number; trim_duration: number; speed: number; original_volume: number;
  dialogue_path: string; dialogue_delay: number; candidates: string[];
};
type Project = {
  id: string; title: string; idea: string; ratio: string; video_model: string; image_model: string;
  reference_music_path: string; final_music_path: string; music_start: number; music_delay: number;
  music_volume: number; markers: number[]; shots: Shot[]; export_task_id: string;
};
type Task = PipelineTask & { remote_task_id?: string };
const API = '/api/pipelines/motion';
const media = (path: string) => `${API}/media?path=${encodeURIComponent(path)}`;
const cameraOptions: [Camera, string][] = [['fixed', '固定机位 · 看清动作'], ['follow', '平稳跟拍 · 陪人物前行'], ['push', '缓慢推近 · 强调反应'], ['reveal', '抬镜揭示 · 展示场景'], ['arc', '小幅环绕 · 展示人物']];
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const shortTime = (value: number) => `${value.toFixed(2)} 秒`;

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '输入内容无效，请检查时间和素材');
  return data;
}

function makeShot(title = '新镜头', prompt = ''): Shot {
  return { id: crypto.randomUUID(), title, prompt, camera: 'fixed', character_image: '', scene_image: '',
    frame_image: '', action_video: '', use_reference_music: false, reference_start: 0, action_start: 0,
    duration: 5, selected_video: '', trim_start: 0, trim_duration: 5, speed: 1, original_volume: 0,
    dialogue_path: '', dialogue_delay: 0, candidates: [] };
}

function NumberInput({ label, value, onChange, min = 0, max = 7200, step = .1 }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number;
}) {
  return <label className={styles.field}>{label}<input type="number" min={min} max={max} step={step} value={value}
    onChange={event => { const number = Number(event.target.value); if (Number.isFinite(number)) onChange(number); }} /></label>;
}

function MediaInput({ label, value, kind, onChange, onError }: {
  label: string; value: string; kind: 'image' | 'video' | 'audio'; onChange: (value: string) => void; onError: (value: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const accept = kind === 'image' ? '.jpg,.jpeg,.png,.webp,.bmp' : kind === 'video' ? '.mp4,.mov,.webm' : '.mp3,.wav,.m4a,.aac,.flac,.ogg';
  async function upload(file?: File) {
    if (!file) return;
    setUploading(true);
    try { onChange((await uploadMedia(file)).file_path); }
    catch (error) { onError(message(error)); }
    finally { setUploading(false); }
  }
  return <div className={styles.mediaInput}>
    <div className={styles.mediaLabel}><span>{label}</span>{value && <button type="button" className={styles.textButton} onClick={() => onChange('')}>移除</button>}</div>
    {value && kind === 'image' && <img className={styles.assetImage} src={media(value)} alt={label} />}
    {value && kind === 'video' && <video className={styles.assetVideo} src={media(value)} controls preload="metadata" />}
    {value && kind === 'audio' && <audio src={media(value)} controls preload="metadata" />}
    <label className={styles.upload}>
      {uploading ? <Loader2 size={16} className={styles.spin} /> : <Upload size={16} />}
      <span>{uploading ? '上传中…' : value ? '更换文件' : '选择文件'}</span>
      <input aria-label={label} type="file" accept={accept} disabled={uploading}
        onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
    </label>
  </div>;
}

export default function MotionWorkspace() {
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'shots' | 'edit'>('shots');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState('已保存');
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [pollRevision, setPollRevision] = useState(0);
  const [removedShot, setRemovedShot] = useState<{ projectId: string; shot: Shot; index: number } | null>(null);
  const [musicPosition, setMusicPosition] = useState(0);
  const musicRef = useRef<HTMLAudioElement>(null);
  const current = useRef<Project | null>(null);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const saveQueue = useRef<Promise<Project | null>>(Promise.resolve(null));

  const adopt = useCallback((value: Project) => {
    current.current = value; savedVersion.current = ++version.current;
    setProject(value); setSaveState('已保存');
    setProjects(list => [value, ...list.filter(item => item.id !== value.id)]);
    setSelected(id => value.shots.some(shot => shot.id === id) ? id : value.shots[0]?.id || '');
  }, []);

  const save = useCallback((): Promise<Project | null> => {
    const snapshot = current.current;
    if (!snapshot || savedVersion.current === version.current) return saveQueue.current.then(() => current.current);
    const revision = version.current;
    setSaveState('保存中…');
    const operation = saveQueue.current.catch(() => null).then(async () => {
      const value = await request<Project>(`/projects/${snapshot.id}`, 'PUT', snapshot);
      savedVersion.current = revision;
      if (version.current === revision && current.current?.id === value.id) {
        current.current = value; setProject(value); setSaveState('已保存');
        setProjects(list => [value, ...list.filter(item => item.id !== value.id)]);
      }
      return value;
    });
    saveQueue.current = operation;
    return operation;
  }, []);

  const change = (edit: (value: Project) => Project) => {
    if (!current.current) return;
    const value = edit(current.current);
    current.current = value; version.current += 1;
    setProject(value); setSaveState('待保存'); setNotice('');
  };
  const changeShot = (patch: Partial<Shot>, id = selected) => change(value => ({ ...value,
    shots: value.shots.map(shot => shot.id === id ? { ...shot, ...patch } : shot) }));

  useEffect(() => {
    let cancelled = false;
    request<Project[]>('/projects').then(async list => {
      if (cancelled) return;
      setProjects(list);
      if (list[0]) adopt(list[0]);
      else {
        const first = await request<Project>('/projects', 'POST', { title: '我的漫剧', shots: [makeShot()] });
        if (!cancelled) adopt(first);
      }
    }).catch(value => { if (!cancelled) setError(message(value)); });
    return () => { cancelled = true; };
  }, [adopt]);

  useEffect(() => {
    if (!project || savedVersion.current === version.current) return;
    const timer = setTimeout(() => { void save().catch(value => { setSaveState('保存失败'); setError(message(value)); }); }, 900);
    return () => clearTimeout(timer);
  }, [project, save]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (savedVersion.current !== version.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const taskIds = [...new Set([...(project?.shots.flatMap(shot => shot.candidates) || []), project?.export_task_id || ''].filter(Boolean))].join(',');
  useEffect(() => {
    if (!taskIds) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await Promise.allSettled(taskIds.split(',').map(id => fetchPipelineTask(id)));
      if (stopped) return;
      let pending = false;
      const updates: Record<string, Task> = {};
      result.forEach((item, index) => {
        if (item.status === 'fulfilled') {
          updates[item.value.task_id] = item.value;
          pending ||= ['pending', 'running'].includes(item.value.status);
        } else {
          updates[taskIds.split(',')[index]] = { task_id: taskIds.split(',')[index], pipeline: 'motion_shot', status: 'unavailable', error: '暂时无法读取任务；重试读取不会重新生成。' };
        }
      });
      setTasks(value => ({ ...value, ...updates }));
      if (pending) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [taskIds, pollRevision]);

  async function action(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await save(); await operation(); }
    catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }

  const shot = project?.shots.find(item => item.id === selected);
  const exportTask = project?.export_task_id ? tasks[project.export_task_id] : null;
  const total = project?.shots.reduce((sum, item) => sum + item.trim_duration / item.speed, 0) || 0;

  function reorder(id: string, direction: number) {
    change(value => {
      const list = [...value.shots];
      const index = list.findIndex(item => item.id === id);
      const target = index + direction;
      if (target < 0 || target >= list.length) return value;
      [list[index], list[target]] = [list[target], list[index]];
      return { ...value, shots: list };
    });
  }

  async function chooseVideo(path: string, id: string) {
    try {
      const info = await request<{ duration: number; has_video: boolean }>(`/media-info?path=${encodeURIComponent(path)}`);
      if (!info.has_video) throw new Error('请选择有效的视频文件');
      changeShot({ selected_video: path, trim_start: 0, trim_duration: Math.round(info.duration * 100) / 100 }, id);
    } catch (value) { setError(message(value)); }
  }

  async function generate(kind: 'image' | 'video') {
    await action(async () => {
      const value = current.current;
      if (!value || !shot) return;
      const task = await request<Task>(`/projects/${value.id}/shots/${shot.id}/generate`, 'POST', { kind });
      setTasks(previous => ({ ...previous, [task.task_id]: task }));
      adopt(await request<Project>(`/projects/${value.id}`));
      setNotice('任务已提交，可以继续准备其他镜头。');
    });
  }

  async function create(example = false) {
    await action(async () => {
      const shots = example ? [
        makeShot('山中前行', '漫剧画风。主角沿山间石阶向前走，目光坚定。'),
        makeShot('发现学校', '云雾中的山间学校庄严而神圣，主角停下脚步仰望。'),
        makeShot('推门进入', '主角走到学校门前，推开门，停顿片刻。'),
        makeShot('老师一登场', '第一位老师出现，短暂停顿后开始跳舞，动作清晰有力。'),
        makeShot('老师二登场', '第二位老师以不同的姿势登场，开始跳舞。'),
        makeShot('主角反应', '主角看着老师们，露出意料之外的惊讶表情。'),
      ] : [makeShot()];
      if (example) { shots[0].camera = 'follow'; shots[1].camera = 'reveal'; shots[5].camera = 'push'; }
      adopt(await request<Project>('/projects', 'POST', { title: example ? '山中求学 · 起步分镜' : '我的漫剧',
        idea: example ? '山中求学，发现神圣学校，进入后老师依次登场跳舞。以下镜头为可修改的草稿。' : '', shots }));
      setTab('shots');
    });
  }

  return <div className={styles.page}>
    <BrandHeader />
    <main className={styles.workspace}>
      <header className={styles.heading}>
        <div><h1>人物与动作</h1><p>先把角色和动作做对，再用剪辑完成你的片子。</p></div>
        <button type="button" onClick={() => void create()} disabled={busy || !project}><Plus size={16} />新建项目</button>
      </header>
      {error && <div role="alert" className={styles.error}>{error}<button type="button" className={styles.textButton} onClick={() => setError('')}>关闭</button></div>}
      {!project ? <p role="status">{error ? '请启动后端服务后刷新页面。' : '正在读取你的项目…'}</p> : <>
        <fieldset disabled={busy} className={styles.projectBar}>
          <label className={styles.field}>当前项目<select value={project.id} onChange={event => {
            const id = event.target.value;
            void action(async () => adopt(await request<Project>(`/projects/${id}`)));
          }}>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label className={styles.field}>项目名称<input value={project.title} onChange={event => change(value => ({ ...value, title: event.target.value }))} /></label>
          <label className={styles.field}>画面比例<select value={project.ratio} onChange={event => change(value => ({ ...value, ratio: event.target.value }))}>
            <option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option><option value="1:1">方形 1:1</option>
          </select></label>
          <button type="button" onClick={() => void action(async () => { await save(); setNotice('项目已保存到本机。'); })}><Save size={16} />保存</button>
          <span className={styles.saveStatus} role="status">{busy ? '处理中…' : saveState}</span>
        </fieldset>
        <details className={styles.details}>
          <summary>我的想法与生成设置</summary>
          <fieldset disabled={busy} className={styles.resetFieldset}>
          <label className={styles.field}>保留你的原始想法<textarea value={project.idea} placeholder="把已经想好的情节、台词、人物和必须保留的感觉写在这里。" onChange={event => change(value => ({ ...value, idea: event.target.value }))} /></label>
          <div className={styles.twoColumns}>
            <label className={styles.field}>视频模型<input value={project.video_model} onChange={event => change(value => ({ ...value, video_model: event.target.value }))} /><small>使用已开通的 Seedance 2.0 / 2.5 模型 ID。密钥在「设置」中配置。</small></label>
            <label className={styles.field}>镜头图模型<input value={project.image_model} onChange={event => change(value => ({ ...value, image_model: event.target.value }))} /><small>可直接上传你画好或生成好的图片，跳过生图。</small></label>
          </div>
          <button type="button" onClick={() => void create(true)} disabled={busy}>新建「山中求学」起步分镜</button>
          </fieldset>
        </details>

        <div className={styles.tabs} role="tablist" aria-label="制作阶段">
          <button type="button" role="tab" aria-selected={tab === 'shots'} onClick={() => setTab('shots')}>人物与镜头</button>
          <button type="button" role="tab" aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>配乐与剪辑</button>
        </div>
        {notice && <p className={styles.notice} role="status"><Check size={16} />{notice}</p>}
        {removedShot?.projectId === project.id && <button type="button" disabled={busy || project.shots.length >= 40} onClick={() => {
          change(value => { const shots = [...value.shots]; shots.splice(removedShot.index, 0, removedShot.shot); return { ...value, shots }; });
          setSelected(removedShot.shot.id); setRemovedShot(null); setNotice('镜头已恢复。');
        }}>撤销移除「{removedShot.shot.title}」</button>}

        {tab === 'shots' ? <div className={styles.shotLayout}>
          <aside className={styles.shotList} aria-label="镜头列表">
            <div className={styles.sectionTitle}><h2>镜头顺序</h2><span>{project.shots.length} 镜</span></div>
            {project.shots.map((item, index) => <button key={item.id} type="button" className={item.id === selected ? styles.selectedShot : styles.shotRow} onClick={() => setSelected(item.id)}>
              <span className={styles.shotIndex}>{index + 1}</span><span><strong>{item.title || '未命名镜头'}</strong><small>{item.selected_video ? '已选定视频' : item.frame_image ? '已有镜头图' : '准备素材'}</small></span>
            </button>)}
            <button type="button" disabled={project.shots.length >= 40 || busy} onClick={() => {
              const next = makeShot(); change(value => ({ ...value, shots: [...value.shots, next] })); setSelected(next.id);
            }}><Plus size={16} />添加镜头</button>
            <p className={styles.hint}>可以先只做老师跳舞的一镜，满意后再补齐其他镜头。</p>
          </aside>
          <section className={styles.editor}>
            {!shot ? <p>添加一个镜头，开始准备人物与动作。</p> : <fieldset disabled={busy} className={styles.resetFieldset}>
              <div className={styles.shotHeader}>
                <label className={styles.field}>镜头名称<input value={shot.title} onChange={event => changeShot({ title: event.target.value })} /></label>
                <button type="button" aria-label="镜头上移" disabled={project.shots[0].id === shot.id} onClick={() => reorder(shot.id, -1)}><ArrowUp size={16} /></button>
                <button type="button" aria-label="镜头下移" disabled={project.shots.at(-1)?.id === shot.id} onClick={() => reorder(shot.id, 1)}><ArrowDown size={16} /></button>
              </div>
              <label className={styles.field}>这一镜发生什么<textarea value={shot.prompt} onChange={event => changeShot({ prompt: event.target.value })} placeholder="例如：老师正面站在教室中央，先抬起右手，再侧身踏步，最后停在一个夸张的姿势。" /></label>
              <div className={styles.twoColumns}>
                <MediaInput label="人物参考图" value={shot.character_image} kind="image" onChange={value => changeShot({ character_image: value })} onError={setError} />
                <MediaInput label="场景参考图（可选）" value={shot.scene_image} kind="image" onChange={value => changeShot({ scene_image: value })} onError={setError} />
              </div>
              <div className={styles.twoColumns}>
                <label className={styles.field}>镜头怎么拍<select value={shot.camera} onChange={event => changeShot({ camera: event.target.value as Camera })}>{cameraOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
                <NumberInput label="生成时长（秒）" value={shot.duration} min={4} max={12} step={1} onChange={duration => changeShot({ duration })} />
              </div>
              <details className={styles.details}>
                <summary>参考动作与音乐（可选）{shot.action_video || shot.use_reference_music ? ' · 已设置' : ''}</summary>
                <p className={styles.hint}>先试动作可以留空。需要指定舞步时加动作视频；需要动作跟随音乐时，再开启这一镜的节奏参考。</p>
                <MediaInput label="动作参考视频" value={shot.action_video} kind="video" onChange={value => changeShot({ action_video: value })} onError={setError} />
                {shot.action_video && <NumberInput label="从动作视频的第几秒开始" value={shot.action_start} onChange={action_start => changeShot({ action_start })} />}
                <MediaInput label="项目参考音乐" value={project.reference_music_path} kind="audio" onChange={path => change(value => ({ ...value, reference_music_path: path }))} onError={setError} />
                <label className={styles.checkbox}><input type="checkbox" checked={shot.use_reference_music} onChange={event => changeShot({ use_reference_music: event.target.checked })} />让这一镜参考音乐节奏</label>
                {shot.use_reference_music && <NumberInput label="从参考音乐的第几秒开始" value={shot.reference_start} onChange={reference_start => changeShot({ reference_start })} />}
                <p className={styles.hint}>截取与生成时长相同的参考片段。参考音乐用于指导动作，最终成片的配乐在下一步单独选择。</p>
              </details>
              <div className={styles.twoColumns}>
                <MediaInput label="镜头图（可直接上传）" value={shot.frame_image} kind="image" onChange={value => changeShot({ frame_image: value })} onError={setError} />
                <div className={styles.generationActions}>
                  <p>已有满意的画面，就直接生成动作。镜头图和视频都会保留为候选。</p>
                  <button type="button" disabled={!shot.prompt.trim()} onClick={() => void generate('image')}><ImagePlus size={16} />生成镜头图</button>
                  <button type="button" className={styles.primary} disabled={!shot.prompt.trim() || !(shot.frame_image || shot.character_image) || (shot.use_reference_music && !project.reference_music_path)} onClick={() => void generate('video')}><Clapperboard size={16} />生成动作视频</button>
                  <small>生成会使用你配置的模型账户额度。视频默认静音，便于后期独立配乐。</small>
                </div>
              </div>
              <div className={styles.sectionTitle}><h2>这一镜的候选</h2><span>选择满意的版本后进入剪辑</span></div>
              {!shot.candidates.length && <p className={styles.hint}>生成结果会出现在这里。也可以在下方导入现有视频。</p>}
              <div className={styles.candidates}>
                {shot.candidates.map(id => {
                  const task = tasks[id];
                  const image = task?.output?.image_path as string | undefined;
                  const video = task?.output?.video_path as string | undefined;
                  const chosen = image ? shot.frame_image === image : video ? shot.selected_video === video : false;
                  return <div key={id} className={styles.candidate}>
                    {image ? <img src={media(image)} alt="镜头图候选" /> : video ? <video src={media(video)} controls preload="metadata" /> : <p role="status">{task?.status === 'failed' ? '生成失败' : task?.status === 'unavailable' ? '读取失败' : `生成中 ${task?.progress || 0}%`}</p>}
                    {task?.error && <p className={styles.taskError}>{task.error.split('Traceback')[0]}</p>}
                    {(image || video) && <button type="button" disabled={chosen} onClick={() => image ? changeShot({ frame_image: image }) : void chooseVideo(video!, shot.id)}>{chosen ? <Check size={15} /> : null}{chosen ? '已选用' : image ? '用作镜头图' : '选入成片'}</button>}
                    {task?.remote_task_id && task.status !== 'completed' && <button type="button" onClick={() => void action(async () => {
                      const resumed = await request<Task>(`/tasks/${id}/resume`, 'POST');
                      setTasks(value => ({ ...value, [id]: resumed }));
                      setPollRevision(value => value + 1);
                      adopt(await request<Project>(`/projects/${project.id}`));
                      setNotice('已继续查询原任务，不重复提交生成。');
                    })}>继续查询原任务</button>}
                    {task?.status === 'unavailable' && <button type="button" onClick={() => setPollRevision(value => value + 1)}>重试读取</button>}
                  </div>;
                })}
              </div>
              <MediaInput label="选入成片的视频（也可导入）" value={shot.selected_video} kind="video" onChange={path => path ? void chooseVideo(path, shot.id) : changeShot({ selected_video: '' })} onError={setError} />
              <div className={styles.footerActions}>
                <button type="button" onClick={() => {
                  const copy = { ...shot, id: crypto.randomUUID(), title: shot.title + ' · 新镜头', selected_video: '', candidates: [] };
                  change(value => ({ ...value, shots: [...value.shots, copy] })); setSelected(copy.id);
                }} disabled={project.shots.length >= 40}>复用人物与场景，新建一镜</button>
                <button type="button" className={styles.textButton} onClick={() => {
                  const removed = shot; const index = project.shots.findIndex(item => item.id === shot.id);
                  setRemovedShot({ projectId: project.id, shot: removed, index });
                  change(value => ({ ...value, shots: value.shots.filter(item => item.id !== shot.id) }));
                  setSelected(project.shots[index + 1]?.id || project.shots[index - 1]?.id || '');
                  setNotice(`已移除「${removed.title}」；原素材和生成任务仍保留。`);
                }}><Trash2 size={15} />移除镜头</button>
              </div>
            </fieldset>}
          </section>
        </div> : <fieldset disabled={busy} className={styles.resetFieldset}>
          <section className={styles.soundtrack}>
            <div className={styles.sectionTitle}><h2><Music2 size={19} />最终配乐</h2><span>可以现在再决定</span></div>
            <p className={styles.hint}>配乐、台词和镜头原声分别控制。更换这里的音乐不会重新生成视频；明显的舞步错拍仍需挑选片段或调整速度。</p>
            <MediaInput label="成片音乐" value={project.final_music_path} kind="audio" onChange={path => change(value => ({ ...value, final_music_path: path }))} onError={setError} />
            {project.reference_music_path && <button type="button" onClick={() => change(value => ({ ...value, final_music_path: value.reference_music_path }))}>将参考音乐用作成片配乐</button>}
            {project.final_music_path && <>
              <div className={styles.threeColumns}>
                <NumberInput label="从音乐第几秒开始" value={project.music_start} onChange={music_start => change(value => ({ ...value, music_start }))} />
                <NumberInput label="在成片第几秒进入" value={project.music_delay} onChange={music_delay => change(value => ({ ...value, music_delay }))} />
                <NumberInput label="音乐音量（0–2）" value={project.music_volume} max={2} onChange={music_volume => change(value => ({ ...value, music_volume }))} />
              </div>
              <div className={styles.markerPlayer}><audio ref={musicRef} src={media(project.final_music_path)} controls onTimeUpdate={event => setMusicPosition(event.currentTarget.currentTime)} />
                <button type="button" disabled={musicPosition < project.music_start} onClick={() => {
                  const point = Math.round((musicPosition - project.music_start + project.music_delay) * 100) / 100;
                  change(value => ({ ...value, markers: [...new Set([...value.markers, point])].sort((a, b) => a - b) }));
                }}>在播放位置标记切点</button></div>
              <div className={styles.markers}>{project.markers.map(point => <button type="button" key={point} title="点击移除这个标记" onClick={() => change(value => ({ ...value, markers: value.markers.filter(item => item !== point) }))}>{shortTime(point)} ×</button>)}</div>
              <small>标记以成片时间显示。调整音乐起点后，请重新核对标记。</small>
            </>}
          </section>
          <section className={styles.editList}>
            <div className={styles.sectionTitle}><h2>镜头剪辑</h2><span>预计 {shortTime(total)}</span></div>
            {project.shots.map((item, index) => <div className={styles.editRow} key={item.id}>
              <div className={styles.editPreview}>{item.selected_video ? <video src={media(item.selected_video)} controls preload="metadata" /> : <p>尚未选定视频</p>}</div>
              <div className={styles.editControls}>
                <div className={styles.sectionTitle}><strong>{index + 1}. {item.title}</strong><div className={styles.inlineActions}>
                  <button type="button" aria-label={`${item.title}上移`} disabled={index === 0} onClick={() => reorder(item.id, -1)}><ArrowUp size={15} /></button>
                  <button type="button" aria-label={`${item.title}下移`} disabled={index === project.shots.length - 1} onClick={() => reorder(item.id, 1)}><ArrowDown size={15} /></button>
                  <button type="button" onClick={() => { setSelected(item.id); setTab('shots'); }}>返回制作</button></div></div>
                <div className={styles.threeColumns}>
                  <NumberInput label="从视频第几秒开始" value={item.trim_start} onChange={trim_start => changeShot({ trim_start }, item.id)} />
                  <NumberInput label="截取时长（秒）" value={item.trim_duration} min={.1} max={120} onChange={trim_duration => changeShot({ trim_duration }, item.id)} />
                  <NumberInput label="播放速度（0.5–2）" value={item.speed} min={.5} max={2} onChange={speed => changeShot({ speed }, item.id)} />
                </div>
                <p className={styles.hint}>成片占 {shortTime(item.trim_duration / item.speed)} · 起于 {shortTime(project.shots.slice(0, index).reduce((sum, s) => sum + s.trim_duration / s.speed, 0))}</p>
                <details className={styles.details}><summary>台词与原声</summary>
                  <NumberInput label="镜头原声音量（0 为静音）" value={item.original_volume} max={2} onChange={original_volume => changeShot({ original_volume }, item.id)} />
                  <MediaInput label="这一镜的台词音频" value={item.dialogue_path} kind="audio" onChange={dialogue_path => changeShot({ dialogue_path }, item.id)} onError={setError} />
                  {item.dialogue_path && <NumberInput label="台词在本镜第几秒进入" value={item.dialogue_delay} max={120} onChange={dialogue_delay => changeShot({ dialogue_delay }, item.id)} />}
                </details>
              </div>
            </div>)}
          </section>
          <div className={styles.exportBar}><p>先导出预览，检查切点与声音。不满意时，只替换对应镜头。</p>
            <button type="button" className={styles.primary} disabled={!project.shots.length || project.shots.some(item => !item.selected_video) || (!!exportTask && ['pending', 'running'].includes(exportTask.status))} onClick={() => void action(async () => {
              const value = current.current!;
              const task = await request<Task>(`/projects/${value.id}/export`, 'POST');
              setTasks(previous => ({ ...previous, [task.task_id]: task }));
              adopt(await request<Project>(`/projects/${value.id}`));
            })}><Clapperboard size={16} />导出成片预览</button></div>
          {exportTask && <div className={styles.exportResult}>
            {exportTask.output?.video_path ? <><p className={styles.hint}>上一次导出的预览。修改镜头或配乐后，请重新导出。</p><video src={media(exportTask.output.video_path)} controls />
              <a className={styles.download} href={media(exportTask.output.video_path)} download={`${project.title}.mp4`}><Download size={16} />下载成片</a></> : <p role="status">{exportTask.status === 'failed' ? '导出失败：' + exportTask.error?.split('Traceback')[0] : `正在导出 ${exportTask.progress || 0}%`}</p>}
          </div>}
        </fieldset>}
      </>}
    </main>
  </div>;
}
