export type StageStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'error' | 'stopped';

export interface StageState {
  status: StageStatus;
  progress: number;
  progressMessage: string;
  artifact: any;
  error: string | null;
}

export interface StageViewProps {
  state: StageState;
  sessionId: string;
  onConfirm: () => void;
  onIntervene: (modifications: Record<string, any>) => void;
  onRegenerate: () => void;
  onUpdateArtifact?: (patch: Record<string, any>) => void;
  onSaveSelections?: (selections: Record<string, any>) => Promise<void>;
  /** 是否显示"确认并继续"按钮（后续阶段已执行过时为 false） */
  showConfirm?: boolean;
  isRunning: boolean;
  /** 是否有待生成的项（阶段2、4、5使用） */
  hasPendingItems?: boolean;
  /** 后续阶段是否已开始（阶段1、3使用） */
  hasNextStageStarted?: boolean;
  /** 用于组件访问其他阶段的数据 */
  artifacts?: Record<string, any>;
  /** 参考图阶段的 artifact（仅 VideoStage 使用，用于检查依赖） */
  referenceArtifact?: any;
  /** 剧本阶段的 artifact（用于获取剧集标题） */
  scriptArtifact?: any;
}
