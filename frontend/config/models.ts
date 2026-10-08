/* ─── Provider + Model 分组结构 ─── */
export interface ModelOption {
    id: string;
    label: string;
    default?: boolean;
}

export interface ProviderGroup {
    provider: string;
    label: string;
    models: ModelOption[];
}

export type VideoGenerationMode = 'first_frame' | 'start_end_frame' | 'reference';

export const VIDEO_GENERATION_MODES: Array<{ id: VideoGenerationMode; label: string; ability: string; modelKey: string }> = [
    { id: 'first_frame', label: '首帧生视频', ability: 'first_frame_i2v', modelKey: 'video_first_frame_model' },
    { id: 'start_end_frame', label: '首尾帧生视频', ability: 'start_end_frame_i2v', modelKey: 'video_start_end_model' },
    { id: 'reference', label: '参考图生视频', ability: 'reference_to_video', modelKey: 'video_reference_model' },
];

export function videoModeAbility(mode: string | undefined) {
    return VIDEO_GENERATION_MODES.find(item => item.id === mode)?.ability || 'first_frame_i2v';
}

export function videoModeModelKey(mode: string | undefined) {
    return VIDEO_GENERATION_MODES.find(item => item.id === mode)?.modelKey || 'video_first_frame_model';
}

export const STYLES = [
    { id: 'comic-book', label: 'Comic Book / 漫画' },
    { id: 'anime', label: 'Anime / 动漫' },
    { id: 'realistic', label: 'Realistic / 写实' },
    { id: '3d-disney', label: '3D Disney / 迪士尼' },
    { id: 'watercolor', label: 'Watercolor / 水彩' },
    { id: 'oil-painting', label: 'Oil Painting / 油画' },
    { id: 'cyberpunk', label: 'Cyberpunk / 赛博朋克' },
    { id: 'chinese-ink', label: 'Chinese Ink / 水墨' },
];

/* ─── 视频比例 ─── */
export const VIDEO_RATIOS = [
    { id: '16:9', label: '16:9', ratio: '16:9' },
    { id: '9:16', label: '9:16', ratio: '9:16' },
    { id: '1:1', label: '1:1', ratio: '1:1' },
    { id: '4:3', label: '4:3', ratio: '4:3' },
    { id: '3:4', label: '3:4', ratio: '3:4' },
    { id: '21:9', label: '21:9', ratio: '21:9' },
];

/* ─── 视频分辨率 ─── */
export const VIDEO_RESOLUTIONS = [
    { id: '720P', label: '720P' },
    { id: '1080P', label: '1080P' },
];
