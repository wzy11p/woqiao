import { Suspense } from 'react';
import MotionWorkspace from '@/components/pipelines/MotionWorkspace';
import PipelinePage from '@/components/pipelines/PipelinePage';

export default async function ActionTransferPipelinePage({ searchParams }: { searchParams: Promise<{ task?: string; legacy?: string }> }) {
  const params = await searchParams;
  return (
    <Suspense fallback={null}>
      {params.task || params.legacy ? <PipelinePage
        pipeline="action_transfer"
        title="动作迁移"
        subtitle="用参考图片和动作视频生成角色动作迁移结果"
      /> : <MotionWorkspace />}
    </Suspense>
  );
}
