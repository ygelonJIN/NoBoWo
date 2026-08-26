import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineEnvInfo, YoloEnvInfo, YoloTrainingEvent } from '@nobowo/core';
import { GITHUB_PROXY_OPTIONS, PIP_MIRROR_OPTIONS } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';

type Props = {
  /** template 只显示模板匹配所需；yolo 只显示训练推理所需；input 只显示键鼠输入所需；full 全部显示 */
  mode?: 'template' | 'yolo' | 'input' | 'full';
  onChanged?: () => void;
};

type DepGroup = 'runtime' | 'template' | 'input' | 'yolo' | 'weights' | 'ocr';
type DepState = 'ok' | 'missing' | 'na' | 'info';

type DepRow = {
  id: string;
  label: string;
  group: DepGroup;
  usedBy: string;
  state: DepState;
  value: string;
  hint?: string;
  commands?: string[];
  installLabel?: string;
  installAction?: () => Promise<{ started: boolean; message?: string }>;
};

const GROUP_META: Record<DepGroup, { title: string; desc: string }> = {
  runtime: { title: '基础运行时', desc: '视觉引擎脚本与运行依赖' },
  template: { title: '模板匹配', desc: '识别节点「模板匹配」策略、模板匹配测试台' },
  input: { title: '点击输入', desc: 'click / input / scroll / keyboard 节点' },
  yolo: { title: 'YOLO 运行环境', desc: '识别节点「YOLO」策略与训练推理依赖' },
  weights: { title: 'YOLO 预训练权重', desc: 'COCO 预训练参数，训练时作为初始权重' },
  ocr: { title: 'OCR 引擎', desc: 'OCR 测试台、识别节点「OCR」策略' },
};

const CUSTOM_MIRROR = '__custom__';
const isMac = () => navigator.platform.toLowerCase().includes('mac');
const isKnown = (list: { value: string }[], u: string) => list.some((o) => o.value === u);
const withCustom = (list: { value: string; label: string }[]) => [...list.map((o) => ({ value: o.value, label: o.label })), { value: CUSTOM_MIRROR, label: '自定义…' }];
const pipMirrorSelectOptions = withCustom(PIP_MIRROR_OPTIONS);
const githubProxySelectOptions = withCustom(GITHUB_PROXY_OPTIONS);

type MirrorSourceControlProps = {
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  customPlaceholder: string;
  get: () => Promise<string | null>;
  set: (url: string | null) => Promise<void>;
  className?: string;
};

function MirrorSourceControl({ label, hint, options, customPlaceholder, get, set, className }: MirrorSourceControlProps) {
  const [sel, setSel] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    (url: string | null) => {
      setSaving(true);
      void set(url).catch(() => {}).finally(() => setSaving(false));
    },
    [set],
  );

  useEffect(() => {
    let alive = true;
    get()
      .then((url) => {
        if (!alive) return;
        const u = url ?? '';
        if (u && !isKnown(options, u)) {
          setSel(CUSTOM_MIRROR);
          setDraft(u);
        } else {
          setSel(u);
          setDraft('');
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [get, options]);

  const handleSelect = (v: string) => {
    if (v === CUSTOM_MIRROR) {
      if (sel !== CUSTOM_MIRROR) setDraft('');
      setSel(CUSTOM_MIRROR);
      return;
    }
    setSel(v);
    setDraft('');
    save(v || null);
  };

  const handleDraftCommit = () => {
    const u = draft.trim();
    setDraft(u);
    if (u) {
      setSel(CUSTOM_MIRROR);
      save(u);
    } else {
      setSel('');
      save(null);
    }
  };

  return (
    <div className={`env-panel__mirror ${className ?? ''} ${sel === CUSTOM_MIRROR ? 'env-panel__mirror--custom' : ''}`.trim()}>
      <span className="env-panel__mirror-label">{label}</span>
      <div className="env-panel__mirror-control">
        <div className="env-panel__mirror-select-wrap">
          <CustomSelect value={sel} options={options} onChange={handleSelect} />
        </div>
        {sel === CUSTOM_MIRROR && (
          <input
            className="env-panel__mirror-input"
            type="text"
            spellCheck={false}
            placeholder={customPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleDraftCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleDraftCommit();
            }}
          />
        )}
      </div>
      <p className="env-panel__mirror-hint">
        {hint}
        {saving ? ' 保存中…' : ''}
      </p>
    </div>
  );
}

export function PipMirrorControl({ className }: { className?: string }) {
  return (
    <MirrorSourceControl
      label="pip 镜像源"
      hint="OpenCV、PyTorch、pyautogui、YOLOX 依赖的安装都会走所选镜像源（自定义需在网址后以 /simple 结尾）。"
      options={pipMirrorSelectOptions}
      customPlaceholder="https://mirrors.example.com/simple"
      get={() => window.yoloAPI?.getPipMirror() ?? Promise.resolve(null)}
      set={(url) => window.yoloAPI?.setPipMirror(url) ?? Promise.resolve()}
      className={className}
    />
  );
}

export function GithubProxyControl({ className }: { className?: string }) {
  return (
    <MirrorSourceControl
      label="GitHub 加速"
      hint="YOLOX 预训练权重默认从 GitHub Releases 下载，国内直连容易失败，可选加速前缀。"
      options={githubProxySelectOptions}
      customPlaceholder="https://你的代理前缀/"
      get={() => window.yoloAPI?.getGithubProxy() ?? Promise.resolve(null)}
      set={(url) => window.yoloAPI?.setGithubProxy(url) ?? Promise.resolve()}
      className={className}
    />
  );
}

/** 顶栏共用的下拉（紧凑形态）：pip 镜像源 / GitHub 加速 */
function GenvMirrorSelect({
  label,
  placeholder,
  options,
  get,
  set,
}: {
  label: string;
  placeholder: string;
  options: { value: string; label: string }[];
  get: () => Promise<string | null>;
  set: (url: string | null) => Promise<void>;
}) {
  const [sel, setSel] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const save = useCallback((url: string | null) => {
    setSaving(true);
    void set(url).catch(() => {}).finally(() => setSaving(false));
  }, [set]);

  useEffect(() => {
    let alive = true;
    get()
      .then((url) => {
        if (!alive) return;
        const u = url ?? '';
        if (u && !isKnown(options, u)) {
          setSel(CUSTOM_MIRROR);
          setDraft(u);
        } else {
          setSel(u);
          setDraft('');
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [get, options]);

  const handleSelect = (v: string) => {
    if (v === CUSTOM_MIRROR) {
      if (sel !== CUSTOM_MIRROR) setDraft('');
      setSel(CUSTOM_MIRROR);
      return;
    }
    setSel(v);
    setDraft('');
    save(v || null);
  };

  const handleDraftCommit = () => {
    const u = draft.trim();
    setDraft(u);
    if (u) {
      setSel(CUSTOM_MIRROR);
      save(u);
    } else {
      setSel('');
      save(null);
    }
  };

  return (
    <div className={`genv__mirror ${sel === CUSTOM_MIRROR ? 'genv__mirror--custom' : ''}`}>
      <span className="genv__mirror-label">{label}</span>
      <CustomSelect value={sel} options={options} onChange={handleSelect} />
      {sel === CUSTOM_MIRROR && (
        <input
          className="genv__mirror-input"
          type="text"
          spellCheck={false}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleDraftCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleDraftCommit();
          }}
        />
      )}
      {saving && <span className="genv__mirror-saving">保存中…</span>}
    </div>
  );
}

function GenvMirror() {
  return (
    <GenvMirrorSelect
      label="pip 镜像源"
      placeholder="https://mirrors.example.com/simple"
      options={pipMirrorSelectOptions}
      get={() => window.yoloAPI?.getPipMirror() ?? Promise.resolve(null)}
      set={(url) => window.yoloAPI?.setPipMirror(url) ?? Promise.resolve()}
    />
  );
}

function GenvGithubProxy() {
  return (
    <GenvMirrorSelect
      label="GitHub 加速"
      placeholder="https://你的代理前缀/"
      options={githubProxySelectOptions}
      get={() => window.yoloAPI?.getGithubProxy() ?? Promise.resolve(null)}
      set={(url) => window.yoloAPI?.setGithubProxy(url) ?? Promise.resolve()}
    />
  );
}

export function EnvPanel({ mode = 'full', onChanged }: Props) {
  const [engineEnv, setEngineEnv] = useState<EngineEnvInfo | null>(null);
  const [yoloEnv, setYoloEnv] = useState<YoloEnvInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number; doneMb: number; totalMb: number; speed: string; eta: string } | null>(null);
  const [output, setOutput] = useState<YoloTrainingEvent[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [weights, setWeights] = useState<{ name: string; present: boolean; sizeBytes: number }[]>([]);
  const [weightsLoading, setWeightsLoading] = useState(false);
  const [downloadingWeight, setDownloadingWeight] = useState<string | null>(null);
  const [ocrLangInstalled, setOcrLangInstalled] = useState<Record<string, boolean> | null>(null);
  const [installingOcrLang, setInstallingOcrLang] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all([
        window.engineAPI ? window.engineAPI.envInfo() : Promise.resolve(null),
        window.yoloAPI ? window.yoloAPI.getEnvInfo() : Promise.resolve(null),
      ]);
      setEngineEnv(results[0]);
      setYoloEnv(results[1]);
      onChangedRef.current?.();
    } catch {
      setEngineEnv(null);
      setYoloEnv(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.yoloAPI) return;
    return window.yoloAPI.onPackageOutput((ev) => {
      if (ev.t === 'packageProgress') {
        setProgress(ev);
        return;
      }
      if (ev.t !== 'log') return;
      setOutput((prev) => [...prev.slice(-199), ev]);
      if (ev.message.includes('安装完成') || ev.message.includes('下载完成') || ev.message.startsWith('pip 退出') || ev.level === 'error') {
        setInstalling(null);
        setDownloadingWeight(null);
        setProgress(null);
        void refresh();
        void refreshWeights();
      }
    });
  }, [refresh]);

  useEffect(() => {
    const el = consoleRef.current;
    if (el && stickBottom) el.scrollTop = el.scrollHeight;
  }, [output, stickBottom]);

  const runInstall = async (key: string, action: () => Promise<{ started: boolean; message?: string }>) => {
    if (installing) return;
    setInstalling(key);
    setProgress(null);
    try {
      const res = await action();
      if (!res.started) {
        setInstalling(null);
        setOutput((prev) => [...prev, { t: 'log', level: 'warn', message: res.message ?? '已有安装任务在进行中' }]);
      }
    } catch (err) {
      setInstalling(null);
      setOutput((prev) => [...prev, { t: 'log', level: 'error', message: String(err) }]);
    }
  };

  const refreshOcrLang = useCallback(async () => {
    if (!window.ocrAPI) return;
    try {
      const status = await window.ocrAPI.langStatus();
      setOcrLangInstalled(status.installed);
    } catch {
      setOcrLangInstalled(null);
    }
  }, []);

  const installOcrLang = useCallback(async (lang: string) => {
    if (!window.ocrAPI || installingOcrLang) return;
    const label = lang === 'chi_sim' ? '中文' : '英文';
    setInstallingOcrLang(lang);
    setOutput((prev) => [...prev.slice(-199), { t: 'log', level: 'info', message: `开始下载 Tesseract ${label}语言包…` }]);
    try {
      const res = await window.ocrAPI.installLangData({ lang });
      setOutput((prev) => [...prev.slice(-199), { t: 'log', level: res.ok ? 'info' : 'error', message: res.message ?? (res.ok ? `${label}语言包安装完成` : `${label}语言包安装失败`) }]);
      setOcrLangInstalled((current) => ({ ...(current ?? {}), [lang]: res.ok }));
    } catch (err) {
      setOutput((prev) => [...prev.slice(-199), { t: 'log', level: 'error', message: String(err) }]);
    } finally {
      setInstallingOcrLang(null);
    }
  }, [installingOcrLang]);

  const refreshWeights = useCallback(async () => {
    if (!window.yoloAPI) return;
    setWeightsLoading(true);
    try {
      setWeights(await window.yoloAPI.getWeightsInfo());
    } catch {
      setWeights([]);
    } finally {
      setWeightsLoading(false);
    }
  }, []);

  const downloadWeight = useCallback(async (modelName: string) => {
    if (!window.yoloAPI || downloadingWeight) return;
    setDownloadingWeight(modelName);
    try {
      const res = await window.yoloAPI.downloadWeights(modelName);
      if (!res.started) {
        setDownloadingWeight(null);
        setOutput((prev) => [...prev, { t: 'log', level: 'warn', message: res.message ?? '已有下载任务在进行中' }]);
      }
    } catch (err) {
      setDownloadingWeight(null);
      setOutput((prev) => [...prev, { t: 'log', level: 'error', message: String(err) }]);
    }
  }, [downloadingWeight]);

  useEffect(() => {
    void refreshWeights();
  }, [refreshWeights]);

  useEffect(() => {
    void refreshOcrLang();
  }, [refreshOcrLang]);

  const rows = useMemo<DepRow[]>(() => {
    const list: DepRow[] = [];
    const push = (row: DepRow) => list.push(row);
    const showTemplateDeps = mode === 'template' || mode === 'yolo' || mode === 'full';
    const showInputDeps = mode === 'input' || mode === 'full';
    const showYoloDeps = mode === 'yolo' || mode === 'full';
    const showOcrDeps = mode === 'full';

    if (!yoloEnv) return list;

    if (yoloEnv.pythonAvailable) {
      push({ id: 'python', label: 'Python', group: 'runtime', usedBy: '视觉引擎脚本、YOLO 训练脚本', state: 'ok', value: `${yoloEnv.pythonPath ?? ''}（v${yoloEnv.pythonVersion ?? '?'}）` });
    } else {
      push({
        id: 'python',
        label: 'Python',
        group: 'runtime',
        usedBy: '视觉引擎脚本、YOLO 训练脚本',
        state: 'missing',
        value: '未找到 Python',
        hint: '识别引擎与 YOLO 训练脚本需要 Python 3 运行环境。macOS 自带 /usr/bin/python3；也可以安装 Homebrew Python 或 Anaconda。',
        commands: ['brew install python3', 'python3 --version'],
      });
    }

    if (showTemplateDeps) {
      const cv2 = engineEnv?.cv2 ?? null;
      if (cv2) {
        push({ id: 'cv2', label: 'OpenCV', group: 'template', usedBy: '模板匹配策略、模板匹配测试台', state: 'ok', value: `v${cv2}` });
      } else {
        push({
          id: 'cv2',
          label: 'OpenCV',
          group: 'template',
          usedBy: '模板匹配策略、模板匹配测试台',
          state: 'missing',
          value: '未安装',
          hint: 'OpenCV 提供模板匹配算法（截图里找目标图案），缺少它「模板匹配」策略和模板匹配测试台都无法运行。',
          commands: ['python3 -m pip install opencv-python-headless'],
          installLabel: '安装 OpenCV',
          installAction: () => (window.yoloAPI?.installPackage('opencv-python-headless') ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      }
    }

    if (showInputDeps) {
      const pyautogui = engineEnv?.pyautogui ?? null;
      if (pyautogui) {
        push({ id: 'pyautogui', label: 'pyautogui', group: 'input', usedBy: 'click、input、scroll、keyboard 节点', state: 'ok', value: `v${pyautogui}` });
      } else {
        push({
          id: 'pyautogui',
          label: 'pyautogui',
          group: 'input',
          usedBy: 'click、input、scroll、keyboard 节点',
          state: 'missing',
          value: '未安装',
          hint: 'pyautogui 负责模拟鼠标点击、键盘输入和滚动，缺少它 click / input / scroll / keyboard 节点会直接失败。',
          commands: ['python3 -m pip install pyautogui'],
          installLabel: '安装 pyautogui',
          installAction: () => (window.yoloAPI?.installPackage('pyautogui') ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      }
    }

    if (showYoloDeps) {
      const pipVersion = yoloEnv?.pip ?? null;
      if (pipVersion) {
        push({ id: 'pip', label: 'pip', group: 'yolo', usedBy: 'YOLO 依赖安装', state: 'ok', value: `v${pipVersion}` });
      } else {
        push({
          id: 'pip',
          label: 'pip',
          group: 'yolo',
          usedBy: 'YOLO 依赖安装',
          state: 'missing',
          value: '未安装',
          hint: 'pip 是 Python 包管理器，YOLO 相关依赖、PyTorch、YOLOX 都靠它安装。',
          commands: ['python3 -m ensurepip --upgrade'],
          installLabel: '修复 pip',
          installAction: () => Promise.resolve({ started: false, message: 'pip 修复需要在终端中执行' }),
        });
      }

      const torch = engineEnv?.torch ?? yoloEnv?.torch ?? null;
      if (torch) {
        push({ id: 'torch', label: 'PyTorch', group: 'yolo', usedBy: 'YOLO 训练与推理', state: 'ok', value: `v${torch}` });
      } else {
        push({
          id: 'torch',
          label: 'PyTorch',
          group: 'yolo',
          usedBy: 'YOLO 训练与推理',
          state: 'missing',
          value: '未安装',
          hint: 'PyTorch 是 YOLO 训练与推理的框架，缺少它「YOLO」识别策略和 YOLO 训练都无法运行。',
          commands: isMac()
            ? ['python3 -m pip install torch torchvision torchaudio']
            : ['python3 -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121'],
          installLabel: '安装 PyTorch',
          installAction: () => (window.yoloAPI?.installPackage('torch torchvision torchaudio') ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      }

      const cuda = yoloEnv?.cuda ?? engineEnv?.cuda ?? false;
      push({
        id: 'cuda',
        label: 'CUDA',
        group: 'yolo',
        usedBy: 'YOLO GPU 加速',
        state: cuda ? 'ok' : 'na',
        value: cuda ? '可用' : '不可用',
        hint: cuda ? '检测到 NVIDIA CUDA 环境，YOLO 会优先使用 GPU。' : '未检测到 NVIDIA CUDA 环境。Windows/Linux 上若要 GPU 加速，需要 NVIDIA 显卡与驱动。',
      });

      const mps = yoloEnv?.mps ?? engineEnv?.mps ?? false;
      push({
        id: 'mps',
        label: 'MPS',
        group: 'yolo',
        usedBy: 'YOLO Apple 芯片加速',
        state: mps ? 'ok' : 'na',
        value: mps ? '可用' : '不可用',
        hint: mps ? '检测到 Apple 芯片 MPS 加速，YOLO 会自动使用。' : '未检测到 MPS。Mac 上如果是 Intel 机型，这是正常情况；Apple 芯片上则建议检查 PyTorch 版本。',
      });

      const yolox = engineEnv?.yolox ?? yoloEnv?.yolox ?? null;
      if (yolox) {
        push({ id: 'yolox', label: 'YOLOX', group: 'yolo', usedBy: 'YOLO 识别策略、YOLO 训练模型', state: 'ok', value: `v${yolox}` });
      } else if (yoloEnv?.yoloxPath) {
        push({
          id: 'yolox',
          label: 'YOLOX',
          group: 'yolo',
          usedBy: 'YOLO 识别策略、YOLO 训练模型',
          state: 'missing',
          value: '依赖未安装',
          hint: 'YOLOX 源码已配置，但依赖未安装，点下方按钮按 requirements.txt 一键安装。',
          installLabel: '安装 YOLOX 依赖',
          installAction: () => (window.yoloAPI?.installYoloxDeps() ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      } else {
        push({
          id: 'yolox',
          label: 'YOLOX',
          group: 'yolo',
          usedBy: 'YOLO 识别策略、YOLO 训练模型',
          state: 'na',
          value: '未配置源码目录',
          hint: 'YOLOX 源码目录未配置。可在「YOLO 训练 → 环境」页选择，或手动克隆官方仓库。',
          commands: ['git clone https://github.com/Megvii-BaseDetection/YOLOX'],
        });
      }

      const yoloxWeights = weights ?? [];
      const readyCount = yoloxWeights.filter((w) => w.present).length;
      push({
        id: 'weights',
        label: '预训练权重',
        group: 'weights',
        usedBy: 'YOLO 训练初始权重、微调与加速收敛',
        state: yoloxWeights.length > 0 && readyCount > 0 ? 'ok' : 'missing',
        value: yoloxWeights.length > 0 ? `${readyCount}/${yoloxWeights.length} 已下载` : '未检测',
        hint: '预训练权重是 COCO 上预先训练好的参数，训练时会作为初始权重。建议按模型需要下载后再开始训练。',
      });

      const device = engineEnv?.device ?? yoloEnv?.device ?? 'none';
      const deviceLabel =
        device === 'cuda' ? 'CUDA GPU 加速' : device === 'mps' ? 'Apple MPS 加速' : device === 'cpu' ? 'CPU 运算' : '未知';
      push({
        id: 'device',
        label: '推理设备',
        group: 'yolo',
        usedBy: 'YOLO 推理与训练',
        state: device === 'none' ? 'na' : 'info',
        value: deviceLabel,
        hint: device === 'cuda'
          ? '检测到 NVIDIA GPU，YOLO 训练与推理自动使用 CUDA 加速。'
          : device === 'mps'
            ? '检测到 Apple 芯片，YOLO 训练与推理自动使用 MPS 加速。'
            : device === 'cpu'
              ? '当前使用 CPU 运算，训练会偏慢；安装带 GPU 后端的 PyTorch 可加速。'
              : '未检测到可用推理设备，先安装 PyTorch 后再重新检测。',
      });
    }

    if (showOcrDeps) {
      const langs: { key: string; label: string; sizeHint: string }[] = [
        { key: 'eng', label: 'Tesseract 英文语言包', sizeHint: '约 4 MB' },
        { key: 'chi_sim', label: 'Tesseract 中文语言包', sizeHint: '约 13 MB，含英文' },
      ];
      for (const lang of langs) {
        const installed = ocrLangInstalled?.[lang.key] ?? null;
        if (installed === true) {
          push({ id: `ocrLang-${lang.key}`, label: lang.label, group: 'ocr', usedBy: 'Tesseract OCR 识别', state: 'ok', value: `${lang.key}.traineddata 已就绪` });
        } else {
          push({
            id: `ocrLang-${lang.key}`,
            label: lang.label,
            group: 'ocr',
            usedBy: 'Tesseract OCR 识别',
            state: 'missing',
            value: installed === null ? '未检测' : '未下载',
            hint: `Tesseract ${lang.key === 'chi_sim' ? '中文' : '英文'}识别需要 ${lang.key}.traineddata 语言包（${lang.sizeHint}）。可在「OCR 测试台」识别时按需自动下载，或在这里手动下载。`,
            installLabel: '下载语言包',
            installAction: async () => {
              await installOcrLang(lang.key);
              return { started: true, message: '语言包下载任务已启动' };
            },
          });
        }
      }
      const paddle = engineEnv?.paddleocr ?? null;
      if (paddle) {
        push({ id: 'paddleocr', label: 'PaddleOCR', group: 'ocr', usedBy: 'PaddleOCR 识别', state: 'ok', value: `v${paddle}` });
      } else {
        push({
          id: 'paddleocr',
          label: 'PaddleOCR',
          group: 'ocr',
          usedBy: 'PaddleOCR 识别',
          state: 'missing',
          value: '未安装',
          hint: 'PaddleOCR 是百度开源的 OCR 引擎，适合中文识别；体积较大，按需安装。',
          commands: ['python3 -m pip install paddleocr paddlepaddle'],
          installLabel: '安装 PaddleOCR',
          installAction: () => (window.yoloAPI?.installPackage('paddleocr paddlepaddle') ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      }
    }

    return list;
  }, [engineEnv, yoloEnv, mode, ocrLangInstalled, installOcrLang]);

  const grouped = useMemo(() => {
    const map = new Map<DepGroup, DepRow[]>();
    for (const row of rows) {
      const arr = map.get(row.group) ?? [];
      arr.push(row);
      map.set(row.group, arr);
    }
    return (Object.keys(GROUP_META) as DepGroup[])
      .map((key) => ({ key, rows: map.get(key) ?? [] }))
      .filter((block) => block.rows.length > 0);
  }, [rows]);

  const okCount = rows.filter((r) => r.state === 'ok').length;
  const missingCount = rows.filter((r) => r.state === 'missing').length;
  const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`);

  return (
    <div className="genv">
      {/* 顶部一行：标题 + 汇总 + 共用镜像源 + 重新检测 */}
      <div className="genv__top">
        <span className="genv__top-title">全局环境依赖</span>
        <span className={`genv__summary ${missingCount === 0 ? 'genv__summary--ok' : ''}`}>
          {rows.length} 项 · {okCount} 正常{missingCount > 0 ? ` · 缺 ${missingCount} 项` : ' · 全部就绪'}
        </span>
        <div className="genv__top-spacer" />
        <GenvGithubProxy />
        <GenvMirror />
        <button className="genv__refresh" onClick={() => void refresh()} disabled={loading}>
          {loading ? '检测中…' : '重新检测'}
        </button>
      </div>

      {/* 中部：按分类分组的依赖行列表 */}
      <div className="genv__list">
        {grouped.map((group) => {
          if (group.key === 'weights') {
            const isOpen = expanded.weights ?? true;
            const readyCount = weights.filter((w) => w.present).length;
            const groupMissing = weights.filter((w) => !w.present).length;
            return (
              <section key={group.key} className="genv__group">
                <div className="genv__group-head">
                  <span className="genv__group-dot genv__group-dot--weights" />
                  <span className="genv__group-title">{GROUP_META.weights.title}</span>
                  <span className="genv__group-desc">{GROUP_META.weights.desc}</span>
                  <span className="genv__group-count">{weights.length > 0 ? `${readyCount}/${weights.length} 已下载` : '未检测'}</span>
                </div>
                <div className={`genv__row genv__row--weights ${groupMissing > 0 ? 'genv__row--missing' : ''} ${isOpen ? 'genv__row--open' : ''}`}>
                  <div className="genv__row-main" onClick={() => setExpanded((p) => ({ ...p, weights: !(p.weights ?? true) }))}>
                    <span className="genv__row-name">预训练权重</span>
                    <span className={`genv__row-badge genv__row-badge--${groupMissing > 0 ? 'missing' : 'ok'}`}>
                      {weights.length > 0 ? (groupMissing > 0 ? '未下载' : '已就绪') : '未检测'}
                    </span>
                    <span className="genv__row-value">{weights.length > 0 ? `${readyCount}/${weights.length} 已下载` : '未检测'}</span>
                    <span className="genv__row-usedby">YOLO 训练初始权重、微调与加速收敛</span>
                    <span className="genv__row-toggle">{isOpen ? '收起 ▴' : '展开 ▾'}</span>
                  </div>
                  {isOpen && (
                    <div className="genv__row-detail">
                      <div className="genv__row-hint">预训练权重是 COCO 上预先训练好的参数，训练时会作为初始权重。建议按模型需要下载后再开始训练。</div>
                      {weights.length === 0 ? (
                        <div className="yolo-env__weights-empty">{weightsLoading ? '正在检测…' : '未检测到可用的预训练权重列表'}</div>
                      ) : (
                        <div className="yolo-env__weights-grid">
                          {weights.map((w) => (
                            <div key={w.name} className={`yolo-weight-card ${w.present ? 'present' : ''}`}>
                              <div className="yolo-weight-card__info">
                                <span className="yolo-weight-card__name">{w.name.replace(/_/g, '-')}</span>
                                <span className="yolo-weight-card__size">{w.present ? `${(w.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '未下载'}</span>
                              </div>
                              {w.present ? (
                                <span className="yolo-weight-card__badge">已下载 ✓</span>
                              ) : (
                                <button className="genv__row-install" onClick={() => void downloadWeight(w.name)} disabled={downloadingWeight !== null}>
                                  {downloadingWeight === w.name ? '下载中…' : '下载'}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          }
          const groupMissing = group.rows.filter((r) => r.state === 'missing').length;
          return (
            <section key={group.key} className="genv__group">
              <div className="genv__group-head">
                <span className={`genv__group-dot genv__group-dot--${group.key}`} />
                <span className="genv__group-title">{GROUP_META[group.key].title}</span>
                <span className="genv__group-desc">{GROUP_META[group.key].desc}</span>
                <span className="genv__group-count">{groupMissing > 0 ? `缺 ${groupMissing} 项` : '已就绪'}</span>
              </div>
              {group.rows.map((item) => {
                const missing = item.state === 'missing';
                const isInfo = item.state === 'na' || item.state === 'info';
                const isOpen = expanded[item.id] ?? missing;
                const badge =
                  item.state === 'ok' ? '✓ 正常' : item.state === 'missing' ? '✗ 缺失' : item.state === 'na' ? '— 不适用' : 'ℹ 信息';
                const usedByText = missing ? `用在哪里：${item.usedBy}` : item.usedBy;
                return (
                  <div key={item.id} className={`genv__row genv__row--${item.state} ${isOpen ? 'genv__row--open' : ''}`}>
                    <div
                      className="genv__row-main"
                      title={usedByText}
                      onClick={() => missing && setExpanded((p) => ({ ...p, [item.id]: !(p[item.id] ?? true) }))}
                    >
                      <span className="genv__row-name">{item.label}</span>
                      <span className={`genv__row-badge genv__row-badge--${item.state}`}>{badge}</span>
                      <span className="genv__row-value" title={item.value}>
                        {item.value}
                      </span>
                      <span className="genv__row-usedby">{usedByText}</span>
                      {missing && <span className="genv__row-toggle">{isOpen ? '收起 ▴' : '展开 ▾'}</span>}
                    </div>
                    {isInfo && item.hint && <div className="genv__row-note">{item.hint}</div>}
                    {isOpen && missing && (
                      <div className="genv__row-detail">
                        {item.hint && <div className="genv__row-hint">{item.hint}</div>}
                        {item.commands && item.commands.length > 0 && (
                          <div className="genv__row-cmd">
                            <span className="genv__row-cmd-label">手动命令</span>
                            <code>{item.commands.join('\n')}</code>
                            <button
                              className="genv__row-copy"
                              onClick={() => navigator.clipboard.writeText(item.commands!.join('\n')).catch(() => {})}
                              title="复制命令"
                            >
                              ⎘
                            </button>
                          </div>
                        )}
                        {item.installAction && (
                          <div className="genv__row-actions">
                            <button className="genv__row-install" onClick={() => void runInstall(item.id, item.installAction!)} disabled={installing !== null}>
                              {installing === item.id ? '安装中…' : item.installLabel ?? '安装'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {/* 底部：共用的一条矮安装输出 */}
      <div className="genv__console">
        <div className="genv__console-head">
          <span className="genv__console-title">安装输出</span>
          <span className="genv__console-count">{output.length} 条</span>
          <span className="genv__console-status">{installing ? (progress ? '下载中' : '准备中…') : '空闲'}</span>
          <span className="genv__console-spacer" />
          {installing !== null && progress && (
            <span className="genv__console-progress-text">
              {progress.percent}% · {fmtMb(progress.doneMb)}/{fmtMb(progress.totalMb)}
              {progress.speed ? ` · ${progress.speed}` : ''}
              {progress.eta ? ` · 剩余 ${progress.eta}` : ''}
            </span>
          )}
          <button className="genv__console-clear" onClick={() => setOutput([])}>
            清空
          </button>
        </div>
        {installing !== null && (
          <div className="genv__console-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.percent ?? 0}>
            <div className={`genv__console-progress-fill ${progress ? '' : 'idle'}`} style={{ width: `${progress?.percent ?? 0}%` }} />
          </div>
        )}
        <div
          className="genv__console-body"
          ref={consoleRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setStickBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
          }}
        >
          {output.length === 0 && <div className="genv__console-empty">点击缺失项的安装按钮后，pip 输出会实时显示在这里…</div>}
          {output.map((ev, i) => (
            <div key={i} className={`genv__console-line genv__console-line--${ev.t === 'log' ? ev.level : 'info'}`}>
              {ev.t === 'log' ? ev.message : JSON.stringify(ev)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
