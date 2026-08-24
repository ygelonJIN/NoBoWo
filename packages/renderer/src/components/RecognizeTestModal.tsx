import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloudApiProfile, RecognizeNode, StreamSourceProfile } from '@nobowo/core';

import { CustomSelect } from './CustomSelect';

type StrategyKey = 'coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi';

const STRATEGY_INFO: Record<StrategyKey, { label: string; color: string }> = {
  coords: { label: '坐标回放', color: '#78a9ff' },
  template: { label: '模板匹配', color: '#6ae3a1' },
  yolo: { label: 'YOLO 检测', color: '#f7c948' },
  ocr: { label: 'OCR 定位', color: '#ff8f8f' },
  cloudApi: { label: '云端 API', color: '#c585ff' },
};

type Marker =
  | { kind: 'point'; x: number; y: number; color: string; label?: string }
  | { kind: 'box'; x: number; y: number; width: number; height: number; color: string; label: string };

type StrategyResult = {
  status: 'idle' | 'running' | 'ok' | 'fail';
  message?: string;
  markers?: Marker[];
  detail?: string;
  coords?: { x: number; y: number };
};

type Props = {
  onClose: () => void;
  strategies?: RecognizeNode['data']['strategies'];
  strategyOrder?: RecognizeNode['data']['strategyOrder'];
  onApplyCoords?: (coords: { x: number; y: number }) => void;
};

const STRATEGY_KEYS: StrategyKey[] = ['coords', 'template', 'yolo', 'ocr', 'cloudApi'];

const STREAM_TYPE_LABEL: Record<StreamSourceProfile['type'], string> = {
  local: '本机',
  ps5: 'PS5',
  xbox: 'Xbox',
  secondPc: '第二台电脑',
  otherDevice: '其他设备',
};
const STREAM_TYPE_ORDER: StreamSourceProfile['type'][] = ['ps5', 'xbox', 'secondPc', 'otherDevice'];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`读取失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function getImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

async function compressImage(dataUrl: string, maxSize = 1600, quality = 0.8): Promise<string> {
  const { width, height } = await getImageSize(dataUrl);
  if (width <= maxSize && height <= maxSize) return dataUrl;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  const img = new Image();
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function clampText(text: string) {
  return text.trim().replace(/\s+/g, ' ');
}

export function RecognizeTestModal({ onClose, strategies, strategyOrder, onApplyCoords }: Props) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [frameLabel, setFrameLabel] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [streamSources, setStreamSources] = useState<StreamSourceProfile[]>([]);
  const [streamValue, setStreamValue] = useState('local');
  const [apiProfiles, setApiProfiles] = useState<CloudApiProfile[]>([]);
  const [envInfo, setEnvInfo] = useState<{ cv2: string | null; yolox: string | null; torch: string | null } | null>(null);
  const [results, setResults] = useState<Partial<Record<StrategyKey, StrategyResult>>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const order = useMemo<StrategyKey[]>(
    () => (strategyOrder as StrategyKey[] | undefined) ?? STRATEGY_KEYS,
    [strategyOrder],
  );

  const streamOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [{ value: 'local', label: '本机（屏幕）' }];
    for (const type of STREAM_TYPE_ORDER) {
      const matched = streamSources.filter((source) => source.type === type);
      if (matched.length === 0) {
        options.push({ value: `type:${type}`, label: `${STREAM_TYPE_LABEL[type]}（未配置）` });
      } else {
        for (const source of matched) {
          options.push({ value: source.id, label: `${STREAM_TYPE_LABEL[type]} · ${source.name}` });
        }
      }
    }
    return options;
  }, [streamSources]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    if (window.streamAPI) {
      window.streamAPI
        .list()
        .then((list) => {
          setStreamSources(list);
        })
        .catch(() => setStreamSources([]));
    }
  }, []);

  useEffect(() => {
    if (window.cloudApiAPI) {
      window.cloudApiAPI
        .list()
        .then(setApiProfiles)
        .catch(() => setApiProfiles([]));
    }
  }, []);

  useEffect(() => {
    if (window.engineAPI) {
      window.engineAPI
        .envInfo()
        .then((info) => setEnvInfo({ cv2: info.cv2, yolox: info.yolox, torch: info.torch }))
        .catch(() => setEnvInfo(null));
    }
  }, []);

  const clearFrame = useCallback(() => {
    setFrameUrl(null);
    setFrameSize(null);
    setFrameLabel(null);
    setResults({});
    setCaptureError(null);
  }, []);

  const setFrame = useCallback((url: string, width: number, height: number, label: string) => {
    setFrameUrl(url);
    setFrameSize({ width, height });
    setFrameLabel(label);
    setResults({});
    setCaptureError(null);
  }, []);

  const captureScreen = async () => {
    if (!window.streamAPI || capturing) return;
    setCapturing(true);
    setCaptureError(null);
    try {
      const res = await window.streamAPI.captureScreenshot({ source: 'screen' });
      if (res.ok && res.frame) {
        await setFrame(res.frame, res.width ?? 0, res.height ?? 0, '屏幕');
      } else {
        setCaptureError(res.message ?? '截屏失败');
      }
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  };

  const captureStream = async () => {
    if (!window.streamAPI || capturing) return;
    if (streamValue === 'local') {
      await captureScreen();
      return;
    }
    if (streamValue.startsWith('type:')) {
      const type = streamValue.slice(5) as StreamSourceProfile['type'];
      setCaptureError(`还没有配置「${STREAM_TYPE_LABEL[type] ?? type}」设备，请先到「串流设备」管理页创建并保存`);
      return;
    }
    const streamSourceId = streamValue;
    setCapturing(true);
    setCaptureError(null);
    try {
      const res = await window.streamAPI.captureScreenshot({ source: 'stream', streamSourceId });
      if (res.ok && res.frame) {
        const profile = streamSources.find((source) => source.id === streamSourceId);
        await setFrame(res.frame, res.width ?? 0, res.height ?? 0, `串流 · ${profile?.name ?? ''}`);
      } else {
        setCaptureError(res.message ?? '串流截图失败');
      }
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  };

  const handleFile = useCallback(
    async (file?: File | null) => {
      if (!file || !file.type.startsWith('image/')) return;
      const url = await readFileAsDataUrl(file);
      const size = await getImageSize(url);
      setFrame(url, size.width, size.height, file.name);
    },
    [setFrame],
  );

  const markStrategy = useCallback((key: StrategyKey, result: StrategyResult) => {
    setResults((current) => ({ ...current, [key]: result }));
  }, []);

  const runCoords = useCallback(() => {
    const strategy = strategies?.coords;
    if (!strategy) return;
    const x = strategy.x ?? 0;
    const y = strategy.y ?? 0;
    markStrategy('coords', {
      status: 'ok',
      message: `回放坐标 (${x}, ${y})`,
      coords: { x, y },
      markers: [{ kind: 'point', x, y, color: STRATEGY_INFO.coords.color, label: '坐标' }],
    });
  }, [strategies, markStrategy]);

  const runTemplate = useCallback(async () => {
    const strategy = strategies?.template;
    if (!frameUrl || !strategy) return;
    if (!window.engineAPI) {
      markStrategy('template', { status: 'fail', message: '视觉引擎仅可在 Electron 应用中使用（浏览器预览不支持）' });
      return;
    }
    if (!strategy.templateId) {
      markStrategy('template', { status: 'fail', message: '未选择模板，请先在策略中选定' });
      return;
    }
    markStrategy('template', { status: 'running', message: '正在匹配…' });
    try {
      const res = await window.engineAPI.templateMatch({
        imageDataUrl: frameUrl,
        templateId: strategy.templateId,
        threshold: strategy.threshold ?? 60,
      });
      if (res.ok && typeof res.x === 'number' && typeof res.y === 'number') {
        const width = typeof res.width === 'number' ? res.width : 0;
        const height = typeof res.height === 'number' ? res.height : 0;
        const confidence = typeof res.confidence === 'number' ? res.confidence : 0;
        const clickX = typeof res.clickX === 'number' ? res.clickX : res.x;
        const clickY = typeof res.clickY === 'number' ? res.clickY : res.y;
        markStrategy('template', {
          status: 'ok',
          message: `命中 (${res.x}, ${res.y}) · 置信度 ${confidence}%`,
          detail: `模板 ${width}×${height} · 点击点 (${clickX}, ${clickY})${res.clickX !== undefined ? '（含热点/偏移）' : ''}`,
          coords: { x: clickX, y: clickY },
          markers: [
            { kind: 'box', x: res.x, y: res.y, width, height, color: STRATEGY_INFO.template.color, label: '模板' },
            { kind: 'point', x: clickX, y: clickY, color: '#ffffff', label: '点击' },
          ],
        });
      } else {
        markStrategy('template', { status: 'fail', message: res.message ?? '匹配失败' });
      }
    } catch (err) {
      markStrategy('template', { status: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  }, [strategies, frameUrl, markStrategy]);

  const runYolo = useCallback(async () => {
    const strategy = strategies?.yolo;
    if (!frameUrl || !strategy) return;
    if (!window.engineAPI) {
      markStrategy('yolo', { status: 'fail', message: '视觉引擎仅可在 Electron 应用中使用（浏览器预览不支持）' });
      return;
    }
    if (!strategy.modelId) {
      markStrategy('yolo', { status: 'fail', message: '未选择模型，请先在策略中选定' });
      return;
    }
    markStrategy('yolo', { status: 'running', message: '正在推理…' });
    try {
      const res = await window.engineAPI.yoloDetect({
        imageDataUrl: frameUrl,
        modelId: strategy.modelId,
        threshold: strategy.threshold ?? 60,
      });
      if (res.ok) {
        const detections = Array.isArray(res.detections) ? res.detections : [];
        if (detections.length === 0) {
          markStrategy('yolo', { status: 'ok', message: '未检测到目标（高于阈值）' });
        } else {
          const best = detections[0];
          const box = best.box;
          const center = { x: box[0] + Math.round(box[2] / 2), y: box[1] + Math.round(box[3] / 2) };
          markStrategy('yolo', {
            status: 'ok',
            message: `检测到 ${detections.length} 个目标 · 最佳 ${best.label} ${best.confidence}%`,
            detail: detections.map((d) => `${d.label} ${d.confidence}%`).join(' · '),
            coords: center,
            markers: detections.map((d) => ({
              kind: 'box' as const,
              x: d.box[0],
              y: d.box[1],
              width: d.box[2],
              height: d.box[3],
              color: d === best ? STRATEGY_INFO.yolo.color : 'rgba(247,201,72,0.5)',
              label: `${d.label} ${d.confidence}%`,
            })),
          });
        }
      } else {
        markStrategy('yolo', { status: 'fail', message: res.message ?? '推理失败' });
      }
    } catch (err) {
      markStrategy('yolo', { status: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  }, [strategies, frameUrl, markStrategy]);

  const runOcr = useCallback(async () => {
    const strategy = strategies?.ocr;
    if (!frameUrl || !strategy) return;
    if (!window.ocrAPI) {
      markStrategy('ocr', { status: 'fail', message: 'OCR 仅可在 Electron 应用中使用（浏览器预览不支持）' });
      return;
    }
    markStrategy('ocr', { status: 'running', message: '正在识别…' });
    try {
      const res = await window.ocrAPI.run({
        engine: strategy.engine ?? 'auto',
        imageDataUrl: frameUrl,
        targetText: clampText(strategy.text ?? ''),
        width: frameSize?.width ?? 0,
        height: frameSize?.height ?? 0,
      });
      const target = clampText(strategy.text ?? '');
      const targetMatch = target
        ? res.matches.find((m) => clampText(m.text).includes(target))
        : null;
      const markers: Marker[] = res.matches.slice(0, 40).map((m) => ({
        kind: 'box' as const,
        x: m.box.x,
        y: m.box.y,
        width: m.box.width,
        height: m.box.height,
        color: m.id === targetMatch?.id ? STRATEGY_INFO.ocr.color : 'rgba(255,143,143,0.35)',
        label: clampText(m.text).slice(0, 12),
      }));
      markStrategy('ocr', {
        status: 'ok',
        message: targetMatch
          ? `找到目标「${clampText(targetMatch.text)}」@ (${targetMatch.box.x}, ${targetMatch.box.y})`
          : `识别出 ${res.matches.length} 个文本块${target ? '，未找到目标文字' : ''}`,
        coords: targetMatch
          ? { x: targetMatch.box.x + Math.round(targetMatch.box.width / 2), y: targetMatch.box.y + Math.round(targetMatch.box.height / 2) }
          : undefined,
        markers,
      });
    } catch (err) {
      markStrategy('ocr', { status: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  }, [strategies, frameUrl, frameSize, markStrategy]);

  const runCloudApi = useCallback(async () => {
    const strategy = strategies?.cloudApi;
    if (!frameUrl || !strategy) return;
    if (!window.cloudApiAPI) {
      markStrategy('cloudApi', { status: 'fail', message: '云端 API 仅可在 Electron 应用中使用（浏览器预览不支持）' });
      return;
    }
    const profileId = strategy.profileId ?? (strategy.apiIds && strategy.apiIds.length > 0 ? strategy.apiIds[0] : undefined);
    if (!profileId) {
      markStrategy('cloudApi', { status: 'fail', message: '未选择云端 API，请先在策略中添加' });
      return;
    }
    markStrategy('cloudApi', { status: 'running', message: '正在请求云端…' });
    try {
      const compressed = await compressImage(frameUrl);
      const res = await window.cloudApiAPI.vision({
        imageDataUrl: compressed,
        profileId,
        prompt: strategy.prompt ?? undefined,
      });
      if (res.ok && typeof res.x === 'number' && typeof res.y === 'number') {
        markStrategy('cloudApi', {
          status: 'ok',
          message: `返回坐标 (${res.x}, ${res.y})`,
          detail: res.raw ? res.raw.slice(0, 160) : undefined,
          coords: { x: res.x, y: res.y },
          markers: [{ kind: 'point', x: res.x, y: res.y, color: STRATEGY_INFO.cloudApi.color, label: '云端' }],
        });
      } else {
        markStrategy('cloudApi', { status: 'fail', message: res.message ?? '未能解析坐标' });
      }
    } catch (err) {
      markStrategy('cloudApi', { status: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  }, [strategies, frameUrl, markStrategy]);

  const runStrategy = useCallback(
    (key: StrategyKey) => {
      if (key === 'coords') runCoords();
      else if (key === 'template') void runTemplate();
      else if (key === 'yolo') void runYolo();
      else if (key === 'ocr') void runOcr();
      else if (key === 'cloudApi') void runCloudApi();
    },
    [runCoords, runTemplate, runYolo, runOcr, runCloudApi],
  );

  const runAll = useCallback(async () => {
    if (!frameUrl || runningAll) return;
    setRunningAll(true);
    for (const key of STRATEGY_KEYS) {
      runStrategy(key);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    setRunningAll(false);
  }, [frameUrl, runningAll, runStrategy]);

  const applyCoords = useCallback(
    (coords?: { x: number; y: number }) => {
      if (coords && onApplyCoords) onApplyCoords(coords);
    },
    [onApplyCoords],
  );

  const renderMarkers = () => {
    if (!frameSize) return null;
    const all = STRATEGY_KEYS.flatMap((key) => results[key]?.markers ?? []);
    return all.map((marker, index) => {
      if (marker.kind === 'point') {
        return (
          <div
            key={index}
            className="recognize-test__marker recognize-test__marker--point"
            style={{
              left: `${(marker.x / frameSize.width) * 100}%`,
              top: `${(marker.y / frameSize.height) * 100}%`,
              borderColor: marker.color,
            }}
            title={marker.label ?? `(${marker.x}, ${marker.y})`}
          >
            {marker.label && <span className="recognize-test__marker-label" style={{ background: marker.color }}>{marker.label}</span>}
          </div>
        );
      }
      return (
        <div
          key={index}
          className="recognize-test__marker recognize-test__marker--box"
          style={{
            left: `${(marker.x / frameSize.width) * 100}%`,
            top: `${(marker.y / frameSize.height) * 100}%`,
            width: `${(marker.width / frameSize.width) * 100}%`,
            height: `${(marker.height / frameSize.height) * 100}%`,
            borderColor: marker.color,
          }}
        >
          <span className="recognize-test__marker-label" style={{ background: marker.color }}>{marker.label}</span>
        </div>
      );
    });
  };

  const hasFrame = frameUrl !== null;

  return (
    <div
      className="template-modal__overlay recognize-test__overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="template-modal recognize-test"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="template-modal__header recognize-test__header">
          <div>
            <h2>识别测试台</h2>
            <p>截取真实画面，逐层验证每个识别策略能否命中目标</p>
          </div>
          <div className="template-modal__header-actions">
            <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="recognize-test__body">
          <section className="recognize-test__stage">
            <div className="recognize-test__source-bar">
              <button className="yolo-btn--primary yolo-btn--compact" onClick={() => void captureScreen()} disabled={capturing}>
                {capturing ? '截取中…' : '截屏'}
              </button>
              <div className="recognize-test__source-select-wrap">
                <CustomSelect
                  value={streamValue}
                  options={streamOptions}
                  onChange={setStreamValue}
                />
              </div>
              <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => void captureStream()} disabled={capturing}>
                串流窗口
              </button>
              <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => fileRef.current?.click()}>
                上传图片
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void handleFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              {envInfo && (
                <span className="recognize-test__env" title="视觉运行时依赖状态">
                  <span className={envInfo.cv2 ? 'recognize-test__env-dot ok' : 'recognize-test__env-dot bad'} title={`OpenCV: ${envInfo.cv2 ?? '未安装'}`} />
                  <span className={envInfo.yolox && envInfo.torch ? 'recognize-test__env-dot ok' : 'recognize-test__env-dot bad'} title={`YOLOX: ${envInfo.yolox ?? '未安装'} · PyTorch: ${envInfo.torch ?? '未安装'}`} />
                </span>
              )}
            </div>

            {!hasFrame ? (
              <button
                className={`recognize-test__upload ${dragOver ? 'recognize-test__upload--drag' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  await handleFile(file);
                }}
              >
                <div className="recognize-test__upload-icon">＋</div>
                <div className="recognize-test__upload-title">截屏、选串流窗口，或拖入一张截图</div>
                <div className="recognize-test__upload-sub">
                  策略测试会基于这张画面运行：模板匹配 / YOLO 推理 / OCR 定位 / 云端 API
                </div>
              </button>
            ) : (
              <div className="recognize-test__preview-panel">
                <div className="recognize-test__preview-head">
                  <span>{frameLabel}</span>
                  {frameSize && <span className="recognize-test__preview-size">{frameSize.width} × {frameSize.height}</span>}
                </div>
                <div className="recognize-test__preview-shell">
                  <div className="recognize-test__preview-wrap">
                    <img src={frameUrl} alt="测试画面" className="recognize-test__preview-image" />
                    {renderMarkers()}
                  </div>
                </div>
              </div>
            )}

            {captureError && <div className="recognize-test__error">{captureError}</div>}

            {hasFrame && (
              <div className="recognize-test__stage-actions">
                <button className="yolo-btn--primary yolo-btn--compact" onClick={() => void runAll()} disabled={runningAll}>
                  {runningAll ? '运行中…' : '运行全部策略'}
                </button>
                <button className="yolo-btn--ghost yolo-btn--compact" onClick={clearFrame}>清除画面</button>
              </div>
            )}
          </section>

          <section className="recognize-test__workspace">
            <div className="recognize-test__strategy-list">
              {order.map((key, index) => {
                const strategy = strategies?.[key];
                const enabled = strategy?.enabled !== false;
                const result = results[key] ?? { status: 'idle' as const };
                const info = STRATEGY_INFO[key];
                return (
                  <div
                    key={key}
                    className={`recognize-test__strategy ${enabled ? '' : 'recognize-test__strategy--disabled'} ${result.status !== 'idle' ? 'recognize-test__strategy--has-result' : ''} ${result.status === 'running' ? 'recognize-test__strategy--running' : ''}`}
                  >
                    <div className="recognize-test__strategy-head">
                      <span className="recognize-test__strategy-index">{index + 1}</span>
                      <span className="recognize-test__strategy-name">{info.label}</span>
                      {!enabled && result.status === 'idle' && (
                        <span className="recognize-test__strategy-badge recognize-test__strategy-badge--off">已停用</span>
                      )}
                      <span className={`recognize-test__strategy-status recognize-test__strategy-status--${result.status}`}>
                        {result.status === 'running' ? '运行中' : result.status === 'ok' ? '✓' : result.status === 'fail' ? '✗' : enabled ? '就绪' : '可测试'}
                      </span>
                      <button
                        className="yolo-btn--primary yolo-btn--compact"
                        onClick={() => runStrategy(key)}
                        disabled={!hasFrame || result.status === 'running'}
                      >
                        运行
                      </button>
                    </div>
                    {result.status !== 'idle' && (
                      <div className={`recognize-test__strategy-result recognize-test__strategy-result--${result.status}`}>
                        <div className="recognize-test__result-message">{result.message ?? ''}</div>
                        {result.detail && <div className="recognize-test__result-detail">{result.detail}</div>}
                        {result.coords && (
                          <div className="recognize-test__result-coords">
                            命中坐标 ({result.coords.x}, {result.coords.y})
                            {onApplyCoords && (
                              <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => applyCoords(result.coords)}>
                                写入坐标回放
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {result.status === 'idle' && enabled && (
                      <div className="recognize-test__strategy-hint">
                        {key === 'coords' && `回放坐标 (${strategies?.coords?.x ?? 0}, ${strategies?.coords?.y ?? 0})`}
                        {key === 'template' && (strategies?.template?.templateId ? `模板已选 · 阈值 ${strategies?.template?.threshold ?? 60}%` : '未选择模板')}
                        {key === 'yolo' && (strategies?.yolo?.modelId ? '模型已选 · 点击运行推理' : '未选择模型')}
                        {key === 'ocr' && (strategies?.ocr?.text ? `查找「${strategies?.ocr?.text}」` : '未设置目标文字')}
                        {key === 'cloudApi' && (strategies?.cloudApi?.apiIds?.length || strategies?.cloudApi?.profileId ? '云端 API 已选' : '未选择云端 API')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
