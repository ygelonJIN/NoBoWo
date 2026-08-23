import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StreamSourceProfile, StreamSourceType, StreamWindowInfo } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';

const STREAM_TYPE_OPTIONS: { value: StreamSourceType; label: string }[] = [
  { value: 'ps5', label: 'PS5 主机' },
  { value: 'xbox', label: 'Xbox 主机' },
  { value: 'secondPc', label: '第二台电脑' },
  { value: 'otherDevice', label: '其他设备' },
];

const STREAM_TYPE_LABEL: Record<StreamSourceType, string> = {
  ps5: 'PS5',
  xbox: 'Xbox',
  secondPc: '第二台电脑',
  otherDevice: '其他设备',
};

const TYPE_HELP: Record<StreamSourceType, string> = {
  ps5: '用 PS Remote Play 或 Chiaki 连接 PS5 后，串流画面会显示在本地窗口里。',
  xbox: '用 Xbox 应用或浏览器远程串流后，选择对应的串流窗口即可。',
  secondPc: '用 Parsec / Moonlight / Steam / 向日葵 等把第二台电脑的画面投到本机。',
  otherDevice: '手机、平板或其他设备投屏到本机后，选择对应的投屏窗口即可。',
};

const blankProfile = (): Omit<StreamSourceProfile, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  type: 'ps5',
  host: '',
  port: undefined,
  url: '',
  windowHint: '',
  notes: '',
  lastTestAt: null,
  lastTestStatus: null,
  lastTestMessage: null,
});

type MotionState = {
  running: boolean;
  changed: boolean | null;
  diffRatio: number;
  message: string;
};

type LiveStatus = 'idle' | 'starting' | 'live' | 'error';

const MOTION_THRESHOLD = 0.01;

function computeFrameDiff(a: string, b: string): Promise<number> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      resolve(0);
      return;
    }
    const W = 96;
    const H = 54;
    const first = new Image();
    first.onload = () => {
      canvas.width = W;
      canvas.height = H;
      ctx.drawImage(first, 0, 0, W, H);
      const dataA = ctx.getImageData(0, 0, W, H).data;
      const second = new Image();
      second.onload = () => {
        ctx.drawImage(second, 0, 0, W, H);
        const dataB = ctx.getImageData(0, 0, W, H).data;
        let total = 0;
        let changed = 0;
        for (let i = 0; i < dataA.length; i += 4) {
          const dr = Math.abs(dataA[i] - dataB[i]);
          const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
          const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
          total++;
          if (dr + dg + db > 30) changed++;
        }
        resolve(total > 0 ? changed / total : 0);
      };
      second.onerror = () => resolve(0);
      second.src = b;
    };
    first.onerror = () => resolve(0);
    first.src = a;
  });
}

type Props = {
  onClose: () => void;
  onChanged: () => void;
};

export function StreamManagerModal({ onClose, onChanged }: Props) {
  const [sources, setSources] = useState<StreamSourceProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(blankProfile());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [windows, setWindows] = useState<StreamWindowInfo[]>([]);
  const [probing, setProbing] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [motion, setMotion] = useState<MotionState>({ running: false, changed: null, diffRatio: 0, message: '' });
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle');
  const [liveError, setLiveError] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestRef = useRef(0);
  const selected = useMemo(() => sources.find((s) => s.id === selectedId) ?? null, [sources, selectedId]);
  const isNew = !selected;
  const selectedWindow = useMemo(() => windows.find((w) => w.id === selectedWindowId) ?? null, [windows, selectedWindowId]);

  const stopPreview = useCallback(() => {
    requestRef.current += 1;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startPreview = useCallback(async (sourceId: string) => {
    if (!sourceId || !window.streamAPI) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    stopPreview();
    setError(null);
    try {
      setLiveStatus('starting');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: 30,
          },
        },
      } as unknown as MediaStreamConstraints);
      if (requestId !== requestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          setLiveStatus('error');
          setLiveError('串流窗口已关闭或画面源断开');
        };
      });
      if (requestId !== requestRef.current) return;
      setLiveStatus('live');
      setLiveError('');
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setLiveStatus('error');
      setLiveError(err instanceof Error ? err.message : String(err));
    }
  }, [stopPreview]);

  const refresh = useCallback(async () => {
    if (!window.streamAPI) return;
    try {
      const list = await window.streamAPI.list();
      setSources(list);
      setSelectedId((cur) => (cur && list.some((s) => s.id === cur) ? cur : null));
    } catch (err) {
      setSources([]);
      setSelectedId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    if (selected) {
      setDraft({
        name: selected.name,
        type: selected.type,
        host: selected.host ?? '',
        port: selected.port ?? undefined,
        url: selected.url ?? '',
        windowHint: selected.windowHint ?? '',
        notes: selected.notes ?? '',
        lastTestAt: selected.lastTestAt ?? null,
        lastTestStatus: selected.lastTestStatus ?? null,
        lastTestMessage: selected.lastTestMessage ?? null,
      });
    } else {
      setDraft(blankProfile());
    }
    setConfirmDelete(false);
    setError(null);
    setWindows([]);
    setSelectedWindowId(null);
    setPreviewFrame(null);
    setPreviewSize(null);
    setProbeMessage(null);
    setMotion({ running: false, changed: null, diffRatio: 0, message: '' });
    setLiveStatus('idle');
    setLiveError('');
    stopPreview();
  }, [selected, stopPreview]);

  const startNew = () => {
    setSelectedId(null);
    setDraft(blankProfile());
    setConfirmDelete(false);
    setError(null);
    setWindows([]);
    setSelectedWindowId(null);
    setPreviewFrame(null);
    setPreviewSize(null);
    setProbeMessage(null);
    setMotion({ running: false, changed: null, diffRatio: 0, message: '' });
    setLiveStatus('idle');
    setLiveError('');
    stopPreview();
  };

  const buildPayload = () => ({
    name: draft.name.trim(),
    type: draft.type,
    host: draft.host?.trim() || undefined,
    port: typeof draft.port === 'number' && draft.port > 0 ? draft.port : undefined,
    url: draft.url?.trim() || undefined,
    windowHint: draft.windowHint?.trim() || undefined,
    notes: draft.notes?.trim() || undefined,
  });

  const save = async () => {
    if (!window.streamAPI || saving) return;
    if (!draft.name.trim()) {
      setError('请填写设备名称');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (selected) {
        await window.streamAPI.update(selected.id, buildPayload());
      } else {
        const created = await window.streamAPI.create(buildPayload());
        setSelectedId(created.id);
      }
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || !window.streamAPI || saving) return;
    setSaving(true);
    try {
      await window.streamAPI.remove(selected.id);
      setConfirmDelete(false);
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!window.streamAPI || testing) return;
    const host = draft.host?.trim();
    const url = draft.url?.trim();
    if (!host && !url) {
      setError('请填写主机地址（+端口）或流地址 URL 后再测试连通性');
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const result = await window.streamAPI.testConnection({
        host,
        port: typeof draft.port === 'number' ? draft.port : undefined,
        url,
        name: draft.name.trim() || '串流设备',
      });
      setDraft((prev) => ({
        ...prev,
        lastTestAt: result.lastTestAt ?? Date.now(),
        lastTestStatus: result.ok ? 'ok' : 'error',
        lastTestMessage: result.message ?? (result.ok ? '连接成功' : '连接失败'),
      }));
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const probeWindows = useCallback(async () => {
    if (!window.streamAPI || probing) return;
    setProbing(true);
    setProbeMessage(null);
    try {
      const result = await window.streamAPI.probeWindows();
      setWindows(result.windows);
      const hint = draft.windowHint?.trim().toLowerCase();
      const matched = hint ? result.windows.find((w) => w.name.toLowerCase().includes(hint)) : null;
      if (matched) {
        setSelectedWindowId(matched.id);
        void startPreview(matched.id);
        setProbeMessage(`${result.message ?? ''} · 已按窗口关键字自动选中「${matched.name}」并开始实时预览`);
      } else {
        setSelectedWindowId(null);
        stopPreview();
        setProbeMessage(result.message ?? null);
      }
      setPreviewFrame(null);
      setPreviewSize(null);
      setMotion({ running: false, changed: null, diffRatio: 0, message: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  }, [draft.windowHint, probing, startPreview, stopPreview]);

  useEffect(() => {
    if (!selected?.windowHint?.trim()) return;
    const timer = window.setTimeout(() => {
      void probeWindows();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [probeWindows, selected?.windowHint, selected?.id]);

  const handleSelectWindow = (win: StreamWindowInfo) => {
    setSelectedWindowId(win.id);
    setPreviewFrame(null);
    setPreviewSize(null);
    setMotion({ running: false, changed: null, diffRatio: 0, message: '' });
    void startPreview(win.id);
  };

  const capturePreview = async () => {
    if (!window.streamAPI || !selectedWindowId || motion.running) return;
    setMotion({ running: true, changed: null, diffRatio: 0, message: '正在抓帧…' });
    try {
      const result = await window.streamAPI.captureWindow(selectedWindowId);
      if (!result.ok || !result.frame) {
        setMotion({ running: false, changed: null, diffRatio: 0, message: result.message ?? '抓帧失败' });
        return;
      }
      setPreviewFrame(result.frame);
      setPreviewSize(result.width && result.height ? { width: result.width, height: result.height } : null);
      setMotion({ running: false, changed: null, diffRatio: 0, message: `抓帧成功 · ${result.width} × ${result.height}` });
    } catch (err) {
      setMotion({ running: false, changed: null, diffRatio: 0, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const runMotionTest = async () => {
    if (!window.streamAPI || !selectedWindowId || motion.running) return;
    setMotion({ running: true, changed: null, diffRatio: 0, message: '正在抓取两帧对比画面活动状态…' });
    try {
      const first = await window.streamAPI.captureWindow(selectedWindowId);
      if (!first.ok || !first.frame) {
        setMotion({ running: false, changed: null, diffRatio: 0, message: first.message ?? '第一次抓帧失败' });
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      const second = await window.streamAPI.captureWindow(selectedWindowId);
      if (!second.ok || !second.frame) {
        setMotion({ running: false, changed: null, diffRatio: 0, message: second.message ?? '第二次抓帧失败' });
        return;
      }
      const diffRatio = await computeFrameDiff(first.frame, second.frame);
      const changed = diffRatio >= MOTION_THRESHOLD;
      setPreviewFrame(second.frame);
      setPreviewSize(second.width && second.height ? { width: second.width, height: second.height } : null);
      setMotion({
        running: false,
        changed,
        diffRatio,
        message: changed
          ? `画面在动 · 两帧差异 ${(diffRatio * 100).toFixed(1)}%（串流正常）`
          : `画面基本静止 · 两帧差异 ${(diffRatio * 100).toFixed(1)}%（可能是菜单/暂停画面，或串流卡死）`,
      });
    } catch (err) {
      setMotion({ running: false, changed: null, diffRatio: 0, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const statusClass = draft.lastTestStatus === 'ok' ? 'ok' : draft.lastTestStatus === 'error' ? 'bad' : 'idle';
  const statusText = draft.lastTestStatus === 'ok' ? '连接成功' : draft.lastTestStatus === 'error' ? '连接失败' : '尚未测试';
  const livePillClass = liveStatus === 'live' ? 'ok' : liveStatus === 'error' ? 'bad' : liveStatus === 'starting' ? 'starting' : 'idle';
  const livePillText = liveStatus === 'live' ? '实况中' : liveStatus === 'starting' ? '连接中…' : liveStatus === 'error' ? '连接失败' : '未连接';

  return (
    <div className="template-modal__overlay stream-modal__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="template-modal stream-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="template-modal__header stream-modal__header">
          <div>
            <h2>串流设备管理</h2>
            <p>管理 PS5 / Xbox / 第二台电脑 / 其他设备的串流源，实时预览画面并测试连接状态</p>
          </div>
          <div className="template-modal__header-actions">
            <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="stream-modal__body">
          <aside className="stream-modal__sidebar">
            <div className="stream-modal__sidebar-head">
              <span className="template-modal__section-title">设备列表</span>
            </div>
            <button className="template-folder-new-card" onClick={startNew}>
              <span className="template-folder-new-card__icon">＋</span>
              <span className="template-folder-new-card__text">新建设备</span>
            </button>
            <div className="stream-modal__cards">
              {sources.map((source) => {
                const active = source.id === selectedId;
                const status = source.lastTestStatus ?? null;
                return (
                  <button key={source.id} className={`stream-card ${active ? 'stream-card--active' : ''}`} onClick={() => setSelectedId(source.id)}>
                    <div className="stream-card__head">
                      <span className="stream-card__name">{source.name}</span>
                      <span className={`stream-card__pill ${status === 'ok' ? 'ok' : status === 'error' ? 'bad' : 'idle'}`}>
                        {status === 'ok' ? '已验证' : status === 'error' ? '失败' : '未测试'}
                      </span>
                    </div>
                    <div className="stream-card__meta-row">
                      <span className="stream-card__type">{STREAM_TYPE_LABEL[source.type]}</span>
                      <span className="stream-card__meta">{source.host || source.url || source.windowHint || '未配置连接信息'}</span>
                    </div>
                  </button>
                );
              })}
              {sources.length === 0 && <div className="stream-modal__empty">还没有串流设备，点击「新建」添加一个。</div>}
            </div>
            <div className="stream-modal__guide">
              <div className="stream-modal__guide-title">使用流程</div>
              <div className="stream-modal__guide-step"><span className="stream-modal__guide-num">1</span> 新建设备</div>
              <div className="stream-modal__guide-step"><span className="stream-modal__guide-num">2</span> 扫描窗口，选中串流画面</div>
              <div className="stream-modal__guide-step"><span className="stream-modal__guide-num">3</span> 实时预览，开始自动化</div>
            </div>
            <div className="stream-modal__tip">
              <span className="stream-modal__tip-icon">ⓘ</span>
              <span>串流窗口扫描不到？检查系统设置里的屏幕录制权限（系统设置 → 隐私与安全性 → 屏幕录制 → 勾选本应用后重启）。</span>
            </div>
          </aside>

          <section className="stream-modal__editor">
            <div className="stream-modal__config">
              <div className="stream-modal__config-main">
              <div className="template-modal__step">1 · 基本信息</div>
              <div className="stream-modal__basic">
                <div className="stream-form stream-form--compact">
                  <label className="template-form__field">
                    设备名称
                    <input value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} placeholder="例如：客厅 PS5 / 书房 Xbox / 工作电脑" />
                  </label>
                  <div className="template-form__field">
                    设备类型
                    <CustomSelect value={draft.type} options={STREAM_TYPE_OPTIONS} onChange={(v) => setDraft((prev) => ({ ...prev, type: v as StreamSourceType }))} maxHeight={220} />
                  </div>
                  <label className="template-form__field stream-form__wide">
                    窗口标题关键字
                    <input value={draft.windowHint ?? ''} onChange={(e) => setDraft((prev) => ({ ...prev, windowHint: e.target.value }))} placeholder="例如：Remote Play / Xbox / Moonlight" />
                  </label>
                  <div className="stream-form__help">{TYPE_HELP[draft.type]}</div>
                </div>
              </div>

              <div className="template-modal__step">2 · 连通性测试（可选）</div>
              <div className="stream-modal__test">
                <div className="stream-form stream-form--compact">
                  <label className="template-form__field">
                    主机地址
                    <input value={draft.host ?? ''} onChange={(e) => setDraft((prev) => ({ ...prev, host: e.target.value }))} placeholder="例如：192.168.1.100" />
                  </label>
                  <label className="template-form__field">
                    端口
                    <input value={draft.port ?? ''} onChange={(e) => setDraft((prev) => ({ ...prev, port: e.target.value === '' ? undefined : Number(e.target.value) }))} placeholder="例如：9295" inputMode="numeric" />
                  </label>
                  <label className="template-form__field stream-form__wide">
                    流地址 URL
                    <input value={draft.url ?? ''} onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))} placeholder="http://… / rtsp://…（与主机地址二选一）" />
                  </label>
                </div>
                <div className="stream-modal__test-row">
                  <p className="cloud-api-modal__status-msg">
                    <span className={`cloud-api-modal__status ${statusClass}`}>{statusText}</span>
                    <span className="stream-modal__test-result">{draft.lastTestMessage ?? '点击「测试连通性」验证目标是否可达。'}</span>
                  </p>
                  <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => void testConnection()} disabled={testing || saving}>
                    {testing ? '测试中…' : '测试连通性'}
                  </button>
                </div>
              </div>

              <div className="template-modal__step">3 · 画面源</div>
              <div className="stream-modal__stage">
                <div className="stream-modal__stage-head">
                  <span>扫描本机窗口，选中串流画面所在窗口</span>
                  <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => void probeWindows()} disabled={probing}>
                    {probing ? '扫描中…' : '扫描窗口'}
                  </button>
                </div>
                {probeMessage && <div className="stream-modal__probe-msg">{probeMessage}</div>}
                {windows.length > 0 && (
                  <div className="stream-modal__window-grid">
                    {windows.map((win) => {
                      const active = win.id === selectedWindowId;
                      return (
                        <button key={win.id} className={`stream-window-card ${active ? 'stream-window-card--active' : ''}`} onClick={() => handleSelectWindow(win)}>
                          <img src={win.thumbnail} alt={win.name} className="stream-window-card__thumb" />
                          <span className="stream-window-card__name">{win.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {windows.length === 0 && !probing && (
                  <div className="stream-modal__stage-empty">
                    {probeMessage ? (
                      <>
                        <p>{probeMessage}</p>
                        <p>若扫描结果为空：请确认串流画面所在的窗口已打开。macOS 下第一次使用需要授权「屏幕录制」权限（系统设置 → 隐私与安全性 → 屏幕录制 → 勾选本应用），授权后重启应用再试。</p>
                      </>
                    ) : (
                      <p>点击「扫描窗口」，从缩略图列表中选中串流画面所在窗口。</p>
                    )}
                  </div>
                )}
              </div>

              </div>
              <div className="stream-modal__footer stream-modal__footer--middle">
                {!isNew && (
                  <span className="cloud-delete-controls" onClick={(e) => e.stopPropagation()}>
                    {confirmDelete ? (
                      <>
                        <button className="delete-confirm__ok" onClick={() => void remove()} disabled={saving}>确定</button>
                        <button className="delete-confirm__cancel" onClick={() => setConfirmDelete(false)} disabled={saving}>取消</button>
                      </>
                    ) : (
                      <button className="delete-trigger delete-trigger--visible" onClick={() => setConfirmDelete(true)} disabled={saving}>删除设备</button>
                    )}
                  </span>
                )}
                <div className="stream-modal__footer-actions">
                  <button className="template-modal__save" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : isNew ? '创建设备' : '保存修改'}</button>
                  {error && <div className="stream-modal__error">{error}</div>}
                </div>
              </div>
            </div>

            <div className="stream-modal__live">
              <div className="stream-modal__live-head">
                <div className="stream-modal__live-info">
                  <span className={`stream-modal__live-pill ${livePillClass}`}>{livePillText}</span>
                  <span className="stream-modal__live-title">{selectedWindow?.name ?? (selected ? selected.name : '串流实况')}</span>
                  {liveStatus === 'live' && previewSize && <span className="stream-modal__live-sub">{previewSize.width} × {previewSize.height}</span>}
                </div>
                <div className="stream-modal__live-actions">
                  <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => void capturePreview()} disabled={!selectedWindowId || motion.running}>
                    抓帧快照
                  </button>
                  <button className="yolo-btn--primary yolo-btn--compact" onClick={() => void runMotionTest()} disabled={!selectedWindowId || motion.running}>
                    {motion.running ? '检测中…' : '动帧检测'}
                  </button>
                  {(liveStatus === 'live' || liveStatus === 'starting') && (
                    <button className="yolo-btn--ghost yolo-btn--compact" onClick={stopPreview}>停止预览</button>
                  )}
                  {liveStatus === 'error' && selectedWindowId && (
                    <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => void startPreview(selectedWindowId)}>重连</button>
                  )}
                </div>
              </div>

              <div className="stream-modal__live-stage">
                <video ref={videoRef} muted autoPlay playsInline />
                {(liveStatus === 'idle' || liveStatus === 'error') && (
                  <div className="stream-modal__live-empty">
                    <span className="stream-modal__live-empty-icon">▣</span>
                    <div>{liveStatus === 'error' ? '串流画面连接失败。请检查串流窗口和屏幕录制权限。' : '选择串流窗口后，这里会实时显示串流画面。'}</div>
                  </div>
                )}
                {liveStatus === 'starting' && (
                  <div className="stream-modal__live-empty">
                    <span className="stream-modal__live-empty-icon">⏳</span>
                    <div>正在连接实时画面…</div>
                  </div>
                )}
              </div>

              <div className="stream-modal__live-overlay">
                {liveError && <div className="stream-modal__live-error">{liveError}</div>}
                {motion.message && <div className={`stream-modal__motion ${motion.changed === null ? '' : motion.changed ? 'ok' : 'warn'}`}>{motion.message}</div>}
                {previewFrame && (
                  <div className="stream-modal__snapshot">
                    <img src={previewFrame} alt="最近抓帧" className="stream-modal__snapshot-img" />
                    {previewSize && <span className="stream-modal__snapshot-sub">{previewSize.width} × {previewSize.height} 快照</span>}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
