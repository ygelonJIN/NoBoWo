import { useEffect, useMemo, useRef, useState } from 'react';
import type { YoloAugmentConfig, YoloDataset, YoloEnvInfo, YoloEpochMetrics, YoloTrainConfig, YoloTrainingEvent, YoloTrainingState } from '@nobowo/core';

type Props = {
  datasets: YoloDataset[];
  selectedDatasetId: string | null;
  onSelectDataset: (id: string) => void;
  envInfo: YoloEnvInfo | null;
  trainingState: YoloTrainingState;
  trainingEvents: YoloTrainingEvent[];
  epochHistory: { epoch: number; lr: number; metrics: YoloEpochMetrics }[];
  onStart: (cfg: YoloTrainConfig, datasetId: string) => Promise<void>;
  onStop: () => Promise<void>;
};

type PreviewBox = { x: number; y: number; width: number; height: number; classId: string | null; color: string };

type AugPreview = { label: string; src: string; boxes: PreviewBox[] };

const PREVIEW_BASE_BOX: PreviewBox[] = [
  { x: 0.16, y: 0.18, width: 0.28, height: 0.28, classId: 'btn', color: '#78a9ff' },
  { x: 0.55, y: 0.22, width: 0.24, height: 0.18, classId: 'field', color: '#6ae3a1' },
  { x: 0.34, y: 0.58, width: 0.18, height: 0.22, classId: 'icon', color: '#f7c948' },
];

const PREVIEW_BG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 640">
    <defs>
      <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#1d2634"/>
        <stop offset="100%" stop-color="#0c1118"/>
      </linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
    </defs>
    <rect width="960" height="640" fill="url(#g)"/>
    <circle cx="210" cy="150" r="92" fill="#78a9ff" opacity="0.22" filter="url(#blur)"/>
    <circle cx="720" cy="180" r="140" fill="#6ae3a1" opacity="0.18" filter="url(#blur)"/>
    <circle cx="600" cy="430" r="180" fill="#f7c948" opacity="0.14" filter="url(#blur)"/>
    <rect x="130" y="130" width="320" height="180" rx="20" fill="#d7e4ff" opacity="0.12" stroke="#8fb4f5" stroke-width="4"/>
    <rect x="544" y="160" width="260" height="120" rx="18" fill="#d9ffe9" opacity="0.12" stroke="#6ae3a1" stroke-width="4"/>
    <rect x="320" y="390" width="180" height="160" rx="18" fill="#fff7d6" opacity="0.12" stroke="#f7c948" stroke-width="4"/>
    <text x="168" y="220" fill="#e7ecf3" font-size="42" font-family="Inter, sans-serif">Button</text>
    <text x="582" y="235" fill="#e7ecf3" font-size="32" font-family="Inter, sans-serif">Field</text>
    <text x="356" y="478" fill="#e7ecf3" font-size="32" font-family="Inter, sans-serif">Icon</text>
  </svg>
`);

function distortPreview(base: PreviewBox[], cfg: YoloAugmentConfig, seed: number): PreviewBox[] {
  const rand = (n: number) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const rot = (cfg.degrees / 180) * 0.16 * (rand(1) - 0.5);
  const scale = 1 - cfg.scale * 0.18 * (rand(2) - 0.35);
  const shiftX = (cfg.translate * 0.14) * (rand(3) - 0.5);
  const shiftY = (cfg.translate * 0.14) * (rand(4) - 0.5);
  const flip = rand(5) < cfg.fliplr;
  return base.map((b, i) => {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    let nx = cx - 0.5;
    const ny = cy - 0.5;
    if (flip) nx *= -1;
    const x = 0.5 + nx * scale + shiftX + (i * rot * 0.22);
    const y = 0.5 + ny * scale + shiftY + (i * rot * -0.16);
    const w = Math.max(0.05, Math.min(0.9, b.width * scale * (1 - cfg.shear * 0.002)));
    const h = Math.max(0.05, Math.min(0.9, b.height * scale * (1 - cfg.perspective * 300)));
    return { ...b, x: Math.min(0.92 - w, Math.max(0.04, x - w / 2)), y: Math.min(0.92 - h, Math.max(0.04, y - h / 2)), width: w, height: h };
  });
}

function PreviewCard({ preview }: { preview: AugPreview }) {
  return (
    <div className="yolo-preview-card">
      <div className="yolo-preview-card__head">
        <span>{preview.label}</span>
      </div>
      <div className="yolo-preview-card__image">
        <img src={preview.src} alt="增强预览" draggable={false} />
        {preview.boxes.map((box, idx) => (
          <div key={idx} className="yolo-preview-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%`, borderColor: box.color }}>
            <span style={{ background: box.color }}>{box.classId ?? 'obj'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const CONFIG_KEY = 'nobowo.yolo.trainConfig.v1';

const BASE_MODELS = ['yolov8n.pt', 'yolov8s.pt', 'yolov8m.pt', 'yolov8l.pt', 'yolov8x.pt', 'yolov8n-seg.pt', 'yolov8s-seg.pt'];

const defaultConfig = (): YoloTrainConfig => ({
  model: 'yolov8n.pt',
  epochs: 100,
  batch: 8,
  imageSize: 640,
  lr0: 0.01,
  lrf: 0.01,
  momentum: 0.937,
  weightDecay: 0.0005,
  warmupEpochs: 3,
  patience: 20,
  device: 'auto',
  workers: 4,
  seed: 0,
  deterministic: true,
  splitTrain: 0.9,
  splitVal: 0.1,
  augment: {
    hsvH: 0.015,
    hsvS: 0.7,
    hsvV: 0.4,
    degrees: 0,
    translate: 0.1,
    scale: 0.5,
    shear: 0,
    perspective: 0,
    flipud: 0,
    fliplr: 0.5,
    mosaic: 1.0,
    mixup: 0,
    copyPaste: 0,
    erasing: 0,
    cropFraction: 1.0,
  },
});

type NumFieldProps = {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
};

function NumberField({ label, value, onChange, min, max, step, hint }: NumFieldProps) {
  return (
    <label className="yolo-field">
      <span className="yolo-field__label">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      {hint && <span className="yolo-field__hint">{hint}</span>}
    </label>
  );
}

type SliderFieldProps = {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
};

function SliderField({ label, value, onChange, min, max, step, format }: SliderFieldProps) {
  return (
    <label className="yolo-slider">
      <span className="yolo-slider__head">
        <span className="yolo-field__label">{label}</span>
        <span className="yolo-slider__value">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="yolo-toggle-row">
      <span className="yolo-toggle-row__text">
        <span className="yolo-field__label">{label}</span>
        {hint && <span className="yolo-field__hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const AUGMENT_GROUPS: { title: string; desc: string; items: { key: keyof YoloAugmentConfig; label: string; min: number; max: number; step: number; format?: (v: number) => string }[] }[] = [
  {
    title: '翻转',
    desc: '对图片做水平/垂直镜像',
    items: [
      { key: 'flipud', label: '上下翻转概率', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'fliplr', label: '左右翻转概率', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    ],
  },
  {
    title: '几何变换',
    desc: '旋转 / 平移 / 缩放 / 错切 / 透视',
    items: [
      { key: 'degrees', label: '旋转角度 ±', min: 0, max: 180, step: 5, format: (v) => `${v}°` },
      { key: 'translate', label: '平移比例', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'scale', label: '缩放比例', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'shear', label: '错切角度 ±', min: 0, max: 90, step: 5, format: (v) => `${v}°` },
      { key: 'perspective', label: '透视强度', min: 0, max: 0.001, step: 0.00005, format: (v) => v.toFixed(5) },
      { key: 'cropFraction', label: '随机裁剪比例', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    ],
  },
  {
    title: '色彩抖动',
    desc: '色相 / 饱和度 / 明度扰动，增强泛化',
    items: [
      { key: 'hsvH', label: '色相 HSV-H', min: 0, max: 0.5, step: 0.005 },
      { key: 'hsvS', label: '饱和度 HSV-S', min: 0, max: 1, step: 0.05 },
      { key: 'hsvV', label: '明度 HSV-V', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: '拼接与遮挡',
    desc: 'Mosaic / MixUp / Copy-Paste / 随机擦除',
    items: [
      { key: 'mosaic', label: 'Mosaic 拼接', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'mixup', label: 'MixUp 混合', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'copyPaste', label: 'Copy-Paste 复制粘贴', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'erasing', label: '随机擦除', min: 0, max: 0.99, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
    ],
  },
];

const HYPER_FIELDS: { key: 'epochs' | 'batch' | 'imageSize' | 'lr0' | 'lrf' | 'momentum' | 'weightDecay' | 'warmupEpochs' | 'patience' | 'workers' | 'seed'; label: string; min: number; max: number; step: number; hint?: string }[] = [
  { key: 'epochs', label: '训练轮数 (epochs)', min: 1, max: 2000, step: 1 },
  { key: 'batch', label: '批次大小 (batch)', min: 1, max: 512, step: 1, hint: '显存不足时调小' },
  { key: 'imageSize', label: '输入尺寸 (imgsz)', min: 320, max: 1280, step: 32 },
  { key: 'lr0', label: '初始学习率 (lr0)', min: 0.0001, max: 0.1, step: 0.0005 },
  { key: 'lrf', label: '最终学习率系数 (lrf)', min: 0.0001, max: 1, step: 0.01 },
  { key: 'momentum', label: '动量 (momentum)', min: 0, max: 0.99, step: 0.001 },
  { key: 'weightDecay', label: '权重衰减 (weight_decay)', min: 0, max: 0.01, step: 0.0001 },
  { key: 'warmupEpochs', label: '预热轮数 (warmup)', min: 0, max: 20, step: 0.5 },
  { key: 'patience', label: '早停耐心 (patience)', min: 0, max: 200, step: 1, hint: '0 = 关闭早停' },
  { key: 'workers', label: '数据加载线程', min: 0, max: 32, step: 1 },
  { key: 'seed', label: '随机种子', min: 0, max: 99999, step: 1 },
];

function Sparkline({ values, color, height = 44 }: { values: number[]; color: string; height?: number }) {
  if (values.length < 2) {
    return <div className="yolo-chart__empty">等待数据…</div>;
  }
  const w = 120;
  const h = height;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 3 - ((v - min) / range) * (h - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="yolo-chart__svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.12" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function YoloTrainingTab({ datasets, selectedDatasetId, onSelectDataset, envInfo, trainingState, trainingEvents, epochHistory, onStart, onStop }: Props) {
  const [cfg, setCfg] = useState<YoloTrainConfig>(() => {
    try {
      const raw = window.localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as YoloTrainConfig;
        if (parsed && parsed.augment && typeof parsed.augment === 'object') return parsed;
      }
    } catch {
      // 配置损坏时使用默认值
    }
    return defaultConfig();
  });
  const [savedFlash, setSavedFlash] = useState(false);
  const [starting, setStarting] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1200);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [cfg]);

  useEffect(() => {
    const el = consoleRef.current;
    if (el && stickBottom) el.scrollTop = el.scrollHeight;
  }, [trainingEvents, stickBottom]);

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId) ?? null;
  const running = trainingState.running;
  const apiAvailable = Boolean(window.yoloAPI);
  const canStart = Boolean(apiAvailable && !running && !starting && selectedDataset);

  const patch = (p: Partial<YoloTrainConfig>) => setCfg((c) => ({ ...c, ...p }));
  const patchAugment = (key: keyof YoloAugmentConfig, value: number) =>
    setCfg((c) => ({ ...c, augment: { ...c.augment, [key]: value } }));

  const startEvent = trainingEvents.find((e) => e.t === 'start');
  const doneEvent = [...trainingEvents].reverse().find((e) => e.t === 'done');
  const errorEvent = [...trainingEvents].reverse().find((e) => e.t === 'error');
  const lastProgress = [...trainingEvents].reverse().find((e) => e.t === 'progress');
  const lastEpoch = epochHistory.length > 0 ? epochHistory[epochHistory.length - 1] : null;
  const totalEpochs = startEvent && startEvent.t === 'start' ? startEvent.totalEpochs : cfg.epochs;
  const progressPct = lastProgress && lastProgress.t === 'progress' ? lastProgress.percent : lastEpoch ? (lastEpoch.epoch / Math.max(1, totalEpochs)) * 100 : 0;

  const status: 'idle' | 'running' | 'done' | 'error' = running ? 'running' : errorEvent ? 'error' : doneEvent ? 'done' : 'idle';

  const deviceOptions = ['auto', 'cpu'];
  if (envInfo?.mps) deviceOptions.push('mps');
  if (envInfo?.cuda) deviceOptions.push('cuda:0');

  const handleStart = async () => {
    if (!selectedDatasetId || running || starting) return;
    setStarting(true);
    try {
      await onStart(cfg, selectedDatasetId);
    } finally {
      setStarting(false);
    }
  };

  const previews = useMemo<AugPreview[]>(() => {
    const labels = ['原图', '左右翻转', '旋转 + 缩放', '颜色抖动'];
    const configs: YoloAugmentConfig[] = [
      cfg.augment,
      { ...cfg.augment, fliplr: 1 },
      { ...cfg.augment, degrees: Math.max(cfg.augment.degrees, 20), scale: Math.min(1, cfg.augment.scale + 0.18), translate: Math.min(1, cfg.augment.translate + 0.05) },
      { ...cfg.augment, hsvH: Math.min(0.5, cfg.augment.hsvH + 0.08), hsvS: Math.min(1, cfg.augment.hsvS + 0.25), hsvV: Math.min(1, cfg.augment.hsvV + 0.2) },
    ];
    return labels.map((label, i) => ({
      label,
      src: PREVIEW_BG,
      boxes: distortPreview(PREVIEW_BASE_BOX, configs[i], i + 1),
    }));
  }, [cfg.augment]);

  const metricCards: { label: string; value: string; color: string }[] = [
    { label: 'mAP50', value: lastEpoch ? `${lastEpoch.metrics.mAP50.toFixed(2)}%` : '—', color: '#6ae3a1' },
    { label: 'mAP50-95', value: lastEpoch ? `${lastEpoch.metrics.mAP50_95.toFixed(2)}%` : '—', color: '#78a9ff' },
    { label: 'Precision', value: lastEpoch ? `${lastEpoch.metrics.precision.toFixed(2)}%` : '—', color: '#c585ff' },
    { label: 'Recall', value: lastEpoch ? `${lastEpoch.metrics.recall.toFixed(2)}%` : '—', color: '#f7c948' },
    { label: 'box loss', value: lastEpoch ? lastEpoch.metrics.boxLoss.toFixed(4) : '—', color: '#ff8f8f' },
    { label: 'cls loss', value: lastEpoch ? lastEpoch.metrics.clsLoss.toFixed(4) : '—', color: '#5ad5ff' },
    { label: 'dfl loss', value: lastEpoch ? lastEpoch.metrics.dflLoss.toFixed(4) : '—', color: '#ffb86b' },
  ];

  return (
    <div className="yolo-train">
      <aside className="yolo-train__config">
        <div className="yolo-train__config-head">
          <span className="yolo-panel-title">训练配置</span>
          <span className={`yolo-train__saved ${savedFlash ? 'flash' : ''}`}>{savedFlash ? '已保存 ✓' : ''}</span>
        </div>

        <div className="yolo-config-section">
          <div className="yolo-config-section__title">基础设置</div>
          <label className="yolo-field">
            <span className="yolo-field__label">数据集</span>
            <select value={selectedDatasetId ?? ''} onChange={(e) => onSelectDataset(e.target.value)}>
              {datasets.length === 0 && <option value="">暂无数据集</option>}
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}（{d.imageCount} 图 / {d.classCount} 类）
                </option>
              ))}
            </select>
          </label>
          {selectedDataset && (
            <div className="yolo-train__ds-stats">
              图片 {selectedDataset.imageCount} · 已标注 {selectedDataset.annotatedCount} · 类别 {selectedDataset.classCount}
            </div>
          )}
          <label className="yolo-field">
            <span className="yolo-field__label">基础模型</span>
            <select value={cfg.model} onChange={(e) => patch({ model: e.target.value })}>
              {BASE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}（{m.includes('n.') ? 'nano' : m.includes('s.') ? 'small' : m.includes('m.') ? 'medium' : m.includes('l.') ? 'large' : m.includes('x.') ? 'xlarge' : m}）
                </option>
              ))}
            </select>
            <span className="yolo-field__hint">越大的模型精度越高、训练越慢；小数据集优先 nano/small</span>
          </label>
          <label className="yolo-field">
            <span className="yolo-field__label">计算设备</span>
            <select value={cfg.device} onChange={(e) => patch({ device: e.target.value })}>
              {deviceOptions.map((d) => (
                <option key={d} value={d}>
                  {d === 'auto' ? 'auto（自动选择）' : d === 'cpu' ? 'CPU' : d === 'mps' ? 'MPS（Apple 芯片）' : d}
                </option>
              ))}
            </select>
          </label>
          <SliderField
            label="训练集占比"
            value={Math.round(cfg.splitTrain * 100)}
            onChange={(v) => {
              patch({ splitTrain: v / 100, splitVal: Math.round((100 - v) * 10) / 1000 });
            }}
            min={50}
            max={90}
            step={1}
            format={(v) => `${v}% 训练 / ${100 - v}% 验证`}
          />
        </div>

        <div className="yolo-config-section">
          <div className="yolo-config-section__title">超参数</div>
          <div className="yolo-train__hyper-grid">
            {HYPER_FIELDS.map((f) => (
              <NumberField key={f.key} label={f.label} value={cfg[f.key]} min={f.min} max={f.max} step={f.step} hint={f.hint} onChange={(v) => patch({ [f.key]: v } as Partial<YoloTrainConfig>)} />
            ))}
          </div>
          <ToggleRow label="确定性训练 (deterministic)" hint="保证同种子下结果可复现" checked={cfg.deterministic} onChange={(v) => patch({ deterministic: v })} />
        </div>

        <div className="yolo-config-section">
          <div className="yolo-config-section__title">数据增强（对照片的微调）</div>
          <div className="yolo-config-section__desc">训练时自动对图片做这些变换，让模型更鲁棒；增强越强越不容易过拟合</div>
          <div className="yolo-preview-grid">
            {previews.map((preview) => (
              <PreviewCard key={preview.label} preview={preview} />
            ))}
          </div>
          {AUGMENT_GROUPS.map((group) => (
            <div key={group.title} className="yolo-augment-group">
              <div className="yolo-augment-group__head">
                <span>{group.title}</span>
                <span className="yolo-augment-group__desc">{group.desc}</span>
              </div>
              <div className="yolo-train__hyper-grid">
                {group.items.map((item) => (
                  <SliderField
                    key={item.key}
                    label={item.label}
                    value={cfg.augment[item.key]}
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    format={item.format}
                    onChange={(v) => patchAugment(item.key, v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="yolo-config-section yolo-config-section--notice">
          <div className="yolo-config-section__title">训练数据合规提示</div>
          <div className="yolo-config-section__desc">
            本地训练默认只使用你当前设备中的图片与标注，不会自动上传云端。请确认你的截图、模板和训练数据符合公司/客户的保密要求；若数据含个人隐私、账号信息、内部界面或敏感字段，建议先脱敏再训练。
          </div>
          <ul className="yolo-compliance-list">
            <li>尽量使用本地图片目录，避免把原始数据同步到任何公共云盘。</li>
            <li>如需共享模型，优先共享权重文件，不共享原图与标注源数据。</li>
            <li>训练日志与导出的模型只保存在本机用户目录，不会默认外发。</li>
          </ul>
        </div>

        {!apiAvailable && (
          <div className="yolo-train__notice">当前运行在浏览器预览模式，训练功能不可用。请通过 npm run dev 启动桌面版。</div>
        )}
        {envInfo && envInfo.pythonAvailable && !envInfo.ultralytics && (
          <div className="yolo-train__notice">检测到 Python 但缺少 ultralytics，请到「环境」页安装依赖。</div>
        )}
      </aside>

      <section className="yolo-train__monitor">
        <div className="yolo-train__monitor-head">
          <div className="yolo-train__status">
            <span className={`status-dot ${status === 'running' ? 'status-dot--saving' : status === 'done' ? 'status-dot--saved' : status === 'error' ? 'status-dot--error' : ''}`} />
            <span>
              {status === 'running' ? `训练中 · 任务 ${trainingState.jobId ?? ''}` : status === 'done' ? '训练完成' : status === 'error' ? '训练出错' : '等待开始'}
            </span>
          </div>
          <div className="yolo-train__controls">
            <button className="yolo-train__start" onClick={() => void handleStart()} disabled={!canStart}>
              {starting ? '启动中…' : running ? '训练中…' : '开始训练'}
            </button>
            <button className="yolo-btn--danger" onClick={() => void onStop()} disabled={!running}>
              停止训练
            </button>
          </div>
        </div>

        {!canStart && !running && (
          <div className="yolo-train__notice">
            {!selectedDataset
              ? '请先在「数据集」页创建数据集并上传图片，再回来训练。'
              : !apiAvailable
                ? '浏览器预览模式不可训练，请启动桌面版。'
                : '已就绪，可以开始训练。'}
          </div>
        )}

        <div className="yolo-train__progress">
          <div className="yolo-train__progress-head">
            <span>轮数 Epoch</span>
            <span className="yolo-train__progress-val">
              {lastEpoch ? lastEpoch.epoch : startEvent ? '初始化…' : '0'} / {totalEpochs} · {Math.round(progressPct)}%
            </span>
          </div>
          <div className="yolo-train__bar">
            <div className="yolo-train__bar-fill" style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }} />
          </div>
          <div className="yolo-train__lr">学习率 lr: {lastEpoch ? lastEpoch.lr : '—'}</div>
        </div>

        <div className="yolo-train__metrics">
          {metricCards.map((m) => (
            <div key={m.label} className="yolo-metric">
              <span className="yolo-metric__label">{m.label}</span>
              <span className="yolo-metric__value" style={{ color: m.color }}>
                {m.value}
              </span>
            </div>
          ))}
        </div>

        <div className="yolo-config-section yolo-config-section--notice">
          <div className="yolo-config-section__title">训练建议</div>
          <div className="yolo-config-section__desc">如果你是第一次训练，可以先用小模型 + 适中的增强参数，等数据集稳定后再逐步提高 epochs 与图像尺寸。</div>
          <ul className="yolo-compliance-list">
            <li>数据少于 200 张时，优先使用 `yolov8n.pt` 或 `yolov8s.pt`。</li>
            <li>卡顿或显存不足时，先把 batch 调小，再降低 imgsz。</li>
            <li>如果模型学偏了，先检查类别是否足够均衡，再调低 Mosaic/MixUp。</li>
          </ul>
        </div>

        <div className="yolo-train__charts">
          <div className="yolo-chart">
            <span className="yolo-chart__label">mAP50 趋势</span>
            <Sparkline values={epochHistory.map((e) => e.metrics.mAP50)} color="#6ae3a1" />
          </div>
          <div className="yolo-chart">
            <span className="yolo-chart__label">mAP50-95 趋势</span>
            <Sparkline values={epochHistory.map((e) => e.metrics.mAP50_95)} color="#78a9ff" />
          </div>
          <div className="yolo-chart">
            <span className="yolo-chart__label">box loss 趋势</span>
            <Sparkline values={epochHistory.map((e) => e.metrics.boxLoss)} color="#ff8f8f" />
          </div>
          <div className="yolo-chart">
            <span className="yolo-chart__label">cls loss 趋势</span>
            <Sparkline values={epochHistory.map((e) => e.metrics.clsLoss)} color="#5ad5ff" />
          </div>
        </div>

        <div className="yolo-console">
          <div className="yolo-console__head">
            <span>实时训练日志</span>
            <span className="yolo-console__count">{trainingEvents.length} 条</span>
            <button onClick={() => setStickBottom((s) => !s)} className={stickBottom ? 'active' : ''}>
              {stickBottom ? '自动滚动' : '手动滚动'}
            </button>
          </div>
          <div
            className="yolo-console__body"
            ref={consoleRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              setStickBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
            }}
          >
            {trainingEvents.length === 0 && <div className="yolo-console__placeholder">训练开始后，这里会实时显示 epoch / batch / loss 等日志…</div>}
            {trainingEvents.map((ev, i) => {
              if (ev.t === 'log') {
                return (
                  <div key={i} className={`yolo-console__line yolo-console__line--${ev.level}`}>
                    {ev.message}
                  </div>
                );
              }
              if (ev.t === 'progress') return null;
              if (ev.t === 'epoch') {
                return (
                  <div key={i} className="yolo-console__line yolo-console__line--info">
                    ▸ Epoch {ev.epoch}/{ev.totalEpochs} · mAP50 {ev.metrics.mAP50}% · box {ev.metrics.boxLoss} · cls {ev.metrics.clsLoss}
                  </div>
                );
              }
              if (ev.t === 'start') {
                return (
                  <div key={i} className="yolo-console__line yolo-console__line--start">
                    ▶ {ev.message}
                  </div>
                );
              }
              if (ev.t === 'done') {
                return (
                  <div key={i} className="yolo-console__line yolo-console__line--done">
                    ✓ 训练完成 · {ev.metrics ? `mAP50 ${ev.metrics.mAP50}% / mAP50-95 ${ev.metrics.mAP50_95}%` : ''}
                  </div>
                );
              }
              if (ev.t === 'error') {
                return (
                  <div key={i} className="yolo-console__line yolo-console__line--error">
                    ✗ {ev.message}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
