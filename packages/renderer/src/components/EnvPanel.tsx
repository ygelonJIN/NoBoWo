import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineEnvInfo, YoloEnvInfo, YoloTrainingEvent } from '@nobowo/core';

type Props = {
  /** 面板模式：template 只显示模板匹配所需（OpenCV）；yolo 只显示训练推理所需（PyTorch/YOLOX）；full 全部显示 */
  mode?: 'template' | 'yolo' | 'full';
  /** 环境变化（安装完成/重新检测）后通知父组件 */
  onChanged?: () => void;
};

type DepRow = {
  id: string;
  label: string;
  state: 'ok' | 'missing' | 'na' | 'info';
  value: string;
  hint?: string;
  commands?: string[];
  installLabel?: string;
  installAction?: () => Promise<{ started: boolean; message?: string }>;
};

const isMac = () => navigator.platform.toLowerCase().includes('mac');

export function EnvPanel({ mode = 'full', onChanged }: Props) {
  const [engineEnv, setEngineEnv] = useState<EngineEnvInfo | null>(null);
  const [yoloEnv, setYoloEnv] = useState<YoloEnvInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [output, setOutput] = useState<YoloTrainingEvent[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const consoleRef = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all([
        window.engineAPI ? window.engineAPI.envInfo() : Promise.resolve(null),
        window.yoloAPI ? window.yoloAPI.getEnvInfo() : Promise.resolve(null),
      ]);
      setEngineEnv(results[0]);
      setYoloEnv(results[1]);
      onChanged?.();
    } catch {
      setEngineEnv(null);
      setYoloEnv(null);
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!window.yoloAPI) return;
    return window.yoloAPI.onPackageOutput((ev) => {
      setOutput((prev) => [...prev.slice(-499), ev]);
      if (ev.t === 'log' && (ev.message.includes('安装完成') || ev.message.startsWith('pip 退出') || ev.level === 'error')) {
        setInstalling(null);
        void refresh();
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

  const rows = useMemo<DepRow[]>(() => {
    const list: DepRow[] = [];
    const showYoloDeps = mode === 'yolo' || mode === 'full';

    if (yoloEnv) {
      if (yoloEnv.pythonAvailable) {
        list.push({ id: 'python', label: 'Python', state: 'ok', value: `${yoloEnv.pythonPath ?? ''}（v${yoloEnv.pythonVersion ?? '?'}）` });
      } else {
        list.push({
          id: 'python',
          label: 'Python',
          state: 'missing',
          value: '未找到 Python',
          hint: '识别引擎需要 Python 3 运行环境。macOS 自带 /usr/bin/python3；也可以安装 Homebrew Python 或 Anaconda。',
          commands: ['brew install python3', 'python3 --version'],
        });
      }
    }

    const cv2 = engineEnv?.cv2 ?? null;
    if (cv2) {
      list.push({ id: 'cv2', label: 'OpenCV', state: 'ok', value: `v${cv2}` });
    } else {
      list.push({
        id: 'cv2',
        label: 'OpenCV',
        state: 'missing',
        value: '未安装',
        hint: 'OpenCV 提供模板匹配算法（截图里找目标图案）。缺少它，模板匹配策略无法运行。',
        commands: ['python3 -m pip install opencv-python-headless'],
        installLabel: '安装 OpenCV',
        installAction: () => (window.yoloAPI?.installPackage('opencv-python-headless') ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
      });
    }

    if (showYoloDeps) {
      const torch = engineEnv?.torch ?? yoloEnv?.torch ?? null;
      if (torch) {
        list.push({ id: 'torch', label: 'PyTorch', state: 'ok', value: `v${torch}` });
      } else {
        list.push({
          id: 'torch',
          label: 'PyTorch',
          state: 'missing',
          value: '未安装',
          hint: 'PyTorch 是 YOLO 训练与推理的框架。缺少它，YOLO 检测策略无法运行。',
          commands: isMac()
            ? ['python3 -m pip install torch torchvision torchaudio']
            : ['python3 -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121'],
          installLabel: '安装 PyTorch',
          installAction: () => (window.yoloAPI?.installPackage('torch torchvision torchaudio') ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      }

      const yolox = engineEnv?.yolox ?? yoloEnv?.yolox ?? null;
      if (yolox) {
        list.push({ id: 'yolox', label: 'YOLOX', state: 'ok', value: `v${yolox}` });
      } else if (yoloEnv?.yoloxPath) {
        list.push({
          id: 'yolox',
          label: 'YOLOX',
          state: 'missing',
          value: '依赖未安装',
          hint: 'YOLOX 源码已配置，但依赖未安装。点下方按钮按 requirements.txt 安装。',
          installLabel: '安装 YOLOX 依赖',
          installAction: () => (window.yoloAPI?.installYoloxDeps() ?? Promise.resolve({ started: false, message: '当前环境不可用' })),
        });
      } else {
        list.push({
          id: 'yolox',
          label: 'YOLOX',
          state: 'na',
          value: '未配置源码目录',
          hint: 'YOLOX 源码目录未配置。可在「YOLO 训练 → 环境」页选择，或克隆官方仓库。',
          commands: ['git clone https://github.com/Megvii-BaseDetection/YOLOX'],
        });
      }

      const device = engineEnv?.device ?? yoloEnv?.device ?? 'none';
      const deviceLabel =
        device === 'cuda' ? 'CUDA GPU 加速' : device === 'mps' ? 'Apple MPS 加速' : device === 'cpu' ? 'CPU 运算' : '未知';
      list.push({ id: 'device', label: '推理设备', state: device === 'none' ? 'na' : 'info', value: deviceLabel });
    }

    return list;
  }, [engineEnv, yoloEnv, mode]);

  const missingCount = rows.filter((row) => row.state === 'missing').length;

  const modeLabel = mode === 'template' ? '模板匹配所需' : mode === 'yolo' ? 'YOLO 训练推理所需' : '识别引擎全部依赖';

  return (
    <div className={`env-panel ${mode !== 'full' ? 'env-panel--compact' : ''}`}>
      <div className="env-panel__head">
        <span className="env-panel__title">
          <span>运行环境</span>
          <span className="env-panel__title-sub">{modeLabel}</span>
        </span>
        <span className={`env-panel__summary ${missingCount === 0 ? 'ok' : ''}`}>
          {loading ? '检测中…' : missingCount === 0 ? '依赖就绪 ✓' : `缺少 ${missingCount} 项`}
        </span>
        <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => void refresh()} disabled={loading}>
          重新检测
        </button>
      </div>

      <div className="env-panel__rows">
        {rows.map((row) => {
          const isOpen = Boolean(expanded[row.id]);
          const expandable = Boolean(row.hint || (row.commands && row.commands.length > 0) || row.installAction);
          return (
            <div
              key={row.id}
              className={`yolo-env-row yolo-env-row--${row.state} ${expandable ? 'yolo-env-row--clickable' : ''} ${isOpen ? 'open' : ''}`}
              onClick={() => expandable && setExpanded((cur) => ({ ...cur, [row.id]: !cur[row.id] }))}
            >
              <span className="yolo-env-row__label">{row.label}</span>
              <span className={`yolo-env-row__status ${row.state}`}>
                {row.state === 'ok' ? '✓ 正常' : row.state === 'missing' ? '✗ 缺失' : row.state === 'na' ? '— 不适用' : row.state === 'info' ? 'ℹ' : '…'}
              </span>
              <span className="yolo-env-row__value">{row.value}</span>
              {row.installAction && row.state !== 'ok' && (
                <button
                  className="yolo-btn--primary yolo-btn--compact"
                  onClick={(e) => {
                    e.stopPropagation();
                    void runInstall(row.id, row.installAction!);
                  }}
                  disabled={installing !== null}
                >
                  {installing === row.id ? '安装中…' : (row.installLabel ?? '安装')}
                </button>
              )}
              {expandable && (
                <span className={`yolo-env-row__solve ${row.state === 'missing' ? 'missing' : row.state === 'na' ? 'na' : 'info'}`}>
                  {row.state === 'missing' ? '如何安装' : '说明'} {isOpen ? '▴' : '▾'}
                </span>
              )}
              {isOpen && (row.hint || row.commands) && (
                <div className="yolo-env-row__guide">
                  {row.hint && <div className="yolo-env-row__guide-hint">{row.hint}</div>}
                  {row.commands && row.commands.length > 0 && (
                    <pre className="yolo-env__guide-cmd">
                      <code>{row.commands.join('\n')}</code>
                      <button
                        className="yolo-env__guide-copy"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(row.commands!.join('\n')).catch(() => {});
                        }}
                        title="复制命令"
                      >⎘</button>
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="env-panel__log">
        <button className="env-panel__log-head" onClick={() => setLogsOpen((open) => !open)}>
          <span>安装输出</span>
          <span className="env-panel__log-meta">
            <span className="env-panel__log-count">{output.length} 条</span>
            <span className={`env-panel__log-chevron ${logsOpen ? 'open' : ''}`}>▾</span>
          </span>
        </button>
        {logsOpen && (
          <div
            className="env-panel__log-body"
            ref={consoleRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              setStickBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 24);
            }}
          >
            {output.length === 0 && <div className="env-panel__log-empty">点击上方「安装」后，这里会实时显示 pip 安装进度。</div>}
            {output.map((ev, i) => (
              <div key={i} className={`env-panel__log-line env-panel__log-line--${ev.t === 'log' ? ev.level : ev.t}`}>
                {ev.t === 'log' ? ev.message : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
