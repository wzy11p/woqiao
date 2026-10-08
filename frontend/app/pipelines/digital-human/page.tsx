import { Suspense } from 'react';
import PipelinePage from '@/components/pipelines/PipelinePage';

export default function DigitalHumanPipelinePage() {
  return (
    <Suspense fallback={null}>
      <PipelinePage
        pipeline="digital_human"
        title="数字人口播"
        subtitle="基于人物图片和文案生成数字人口播视频"
      />
    </Suspense>
  );
}
