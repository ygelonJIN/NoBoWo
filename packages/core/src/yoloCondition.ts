export type YoloConditionDetection = {
  label: string;
  confidence: number;
};

export type YoloConditionSample = {
  /** 样本产生时间（Unix 毫秒）。 */
  at: number;
  detections: YoloConditionDetection[];
};

/** YOLO 条件判断：存在、不存在，或达到指定置信度。 */
export type YoloConditionMode = 'present' | 'absent' | 'confidenceAtLeast';

/** stableFrames=连续稳定帧；recentWindow=最近一段时间内是否出现过。 */
export type YoloConditionTimingMode = 'stableFrames' | 'recentWindow';

export type YoloConditionRule = {
  /** 留空表示任意类别。 */
  label: string;
  mode: YoloConditionMode;
  /** confidenceAtLeast 模式使用的置信度阈值，0-100。 */
  threshold: number;
  /** 连续满足条件的帧数，1-60。 */
  stableFrames: number;
  /** 时间判断方式；缺省保持“连续稳定帧”的旧行为。 */
  timingMode?: YoloConditionTimingMode;
  /** recentWindow 模式的时间窗，单位毫秒。 */
  windowMs?: number;
  /** 连续帧之间允许的最大时间间隔，避免把陈旧样本误认为连续画面。 */
  maxFrameGapMs?: number;
};

export type YoloConditionEvaluation = {
  /** 已有连续、时间相邻的 requiredFrames 个样本，可以得出 True/False。 */
  ready: boolean;
  matched: boolean;
  branch: 'true' | 'false';
  matchedFrames: number;
  observedFrames: number;
  requiredFrames: number;
  consecutiveMatches: number;
  timingMode: YoloConditionTimingMode;
  windowMs?: number;
  bestConfidence: number | null;
  message: string;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function bestMatchingConfidence(
  detections: readonly YoloConditionDetection[],
  label: string,
): number | null {
  const wanted = label.trim();
  let best: number | null = null;
  for (const detection of detections) {
    if (wanted && detection.label !== wanted) continue;
    const confidence = Number(detection.confidence);
    if (!Number.isFinite(confidence)) continue;
    if (best === null || confidence > best) best = confidence;
  }
  return best;
}

function frameMatches(
  sample: YoloConditionSample,
  rule: YoloConditionRule,
): { matched: boolean; confidence: number | null } {
  const confidence = bestMatchingConfidence(sample.detections, rule.label);
  if (rule.mode === 'absent') {
    return { matched: confidence === null, confidence };
  }
  if (confidence === null) return { matched: false, confidence };
  const threshold = rule.mode === 'confidenceAtLeast' ? clamp(rule.threshold, 0, 100) : 0;
  return { matched: confidence >= threshold, confidence };
}

/**
 * 根据连续的 YOLO 检测样本判断 If 分支。
 * 最近 stableFrames 帧必须全部满足条件，且相邻帧时间差不超过 maxFrameGapMs。
 */
export function evaluateYoloCondition(
  samples: readonly YoloConditionSample[],
  rule: YoloConditionRule,
  now = Date.now(),
): YoloConditionEvaluation {
  const timingMode = rule.timingMode ?? 'stableFrames';
  const requiredFrames = Math.max(1, Math.round(rule.stableFrames || 1));
  const maxFrameGapMs = Math.max(50, rule.maxFrameGapMs ?? 1500);
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.at) && sample.at <= now)
    .sort((a, b) => a.at - b.at);

  if (timingMode === 'recentWindow') {
    const windowMs = Math.max(50, Math.round(rule.windowMs ?? 5000));
    const windowStart = now - windowMs;
    const window = ordered.filter((sample) => sample.at >= windowStart);
    const outcomes = window.map((sample) => frameMatches(sample, rule));
    const matchedFrames = outcomes.filter((item) => item.matched).length;
    const confidences = outcomes
      .map((item) => item.confidence)
      .filter((value): value is number => value !== null);
    const bestConfidence = confidences.length > 0 ? Math.max(...confidences) : null;
    let consecutiveMatches = 0;
    for (let index = outcomes.length - 1; index >= 0; index -= 1) {
      if (!outcomes[index].matched) break;
      consecutiveMatches += 1;
    }

    const oldestAt = window[0]?.at;
    const newestAt = ordered[ordered.length - 1]?.at;
    const windowCovered = oldestAt !== undefined && now - oldestAt >= windowMs;
    const hasWindowSamples = window.length > 0;
    const hasConfirmedGap = window.length === 0
      && newestAt !== undefined
      && newestAt <= windowStart;
    // “存在”只要窗口内有一个命中样本即可；“不存在”必须持续覆盖完整窗口，
    // 否则只能说明尚未观察到，不能证明这段时间内没有出现。
    const ready = rule.mode === 'absent'
      ? windowCovered
      : hasWindowSamples || hasConfirmedGap;
    const matched = ready && (rule.mode === 'absent'
      ? matchedFrames === window.length
      : matchedFrames > 0);

    const label = rule.label.trim() || '任意类别';
    const conditionLabel = rule.mode === 'absent'
      ? `「${label}」最近 ${windowMs}ms 内不存在`
      : rule.mode === 'confidenceAtLeast'
        ? `「${label}」最近 ${windowMs}ms 内置信度 ≥ ${clamp(rule.threshold, 0, 100)}%`
        : `「${label}」最近 ${windowMs}ms 内存在`;
    const coverageMessage = rule.mode === 'absent' && !ready && oldestAt !== undefined
      ? `（已观察 ${oldestAt === undefined ? 0 : Math.min(windowMs, now - oldestAt)}ms/${windowMs}ms）`
      : '';
    return {
      ready,
      matched,
      branch: matched ? 'true' : 'false',
      matchedFrames,
      observedFrames: window.length,
      requiredFrames: 1,
      consecutiveMatches,
      timingMode,
      windowMs,
      bestConfidence,
      message: `${conditionLabel}${coverageMessage}`,
    };
  }

  const window = ordered.slice(-requiredFrames);
  const outcomes = window.map((sample) => frameMatches(sample, rule));
  const matchedFrames = outcomes.filter((item) => item.matched).length;
  const confidences = outcomes
    .map((item) => item.confidence)
    .filter((value): value is number => value !== null);
  const bestConfidence = confidences.length > 0 ? Math.max(...confidences) : null;

  let consecutiveMatches = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (!outcomes[index].matched) break;
    consecutiveMatches += 1;
  }

  const gapsAreConsecutive = window.every((sample, index) =>
    index === 0 || sample.at - window[index - 1].at <= maxFrameGapMs,
  );
  const matched = window.length === requiredFrames
    && gapsAreConsecutive
    && matchedFrames === requiredFrames;

  const label = rule.label.trim() || '任意类别';
  const conditionLabel = rule.mode === 'absent'
    ? `「${label}」不存在`
    : rule.mode === 'confidenceAtLeast'
      ? `「${label}」置信度 ≥ ${clamp(rule.threshold, 0, 100)}%`
      : `「${label}」存在`;
  const gapMessage = window.length === requiredFrames && !gapsAreConsecutive ? '，样本时间不连续' : '';
  return {
    ready: window.length === requiredFrames && gapsAreConsecutive,
    matched,
    branch: matched ? 'true' : 'false',
    matchedFrames,
    observedFrames: window.length,
    requiredFrames,
    consecutiveMatches,
    timingMode,
    bestConfidence,
    message: `${conditionLabel}：连续 ${consecutiveMatches}/${requiredFrames} 帧满足${gapMessage}`,
  };
}
