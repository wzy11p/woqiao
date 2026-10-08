import { Suspense } from 'react';
import PipelinePage from '@/components/pipelines/PipelinePage';

export default function StandardPipelinePage() {
  return (
    <Suspense fallback={null}>
      <PipelinePage
        pipeline="standard"
        title="文艺短视频"
        subtitle="输入创作灵感或完整文案，生成图片拼接或动态视频短片"
      />
    </Suspense>
  );
}
