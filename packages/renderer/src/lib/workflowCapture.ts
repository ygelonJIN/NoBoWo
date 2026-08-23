import type { ScreenshotNode } from '@nobowo/core';

export type CapturedImage = {
  frame: string;
  width: number;
  height: number;
};

/**
 * 按截图节点的配置抓取一帧画面：
 * - source = 'screen'：抓整个主屏幕
 * - source = 'stream'：从配置的串流设备（streamSourceId）窗口抓图
 * 模板匹配 / OCR 等识别策略统一通过这个入口取图，因此不会再看全屏。
 */
export async function captureNodeImage(node: ScreenshotNode): Promise<CapturedImage> {
  if (!window.streamAPI) {
    throw new Error('截图功能仅在桌面版（npm run dev）可用');
  }
  if (node.data.source === 'stream' && !node.data.streamSourceId) {
    throw new Error('截图节点选择了「串流窗口」，但没有选择串流设备');
  }
  const result = await window.streamAPI.captureScreenshot({
    source: node.data.source ?? 'screen',
    streamSourceId: node.data.source === 'stream' ? node.data.streamSourceId : undefined,
  });
  if (!result.ok || !result.frame) {
    throw new Error(result.message ?? '截图失败');
  }
  return { frame: result.frame, width: result.width ?? 0, height: result.height ?? 0 };
}
