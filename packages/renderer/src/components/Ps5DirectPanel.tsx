import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  Ps5AccountProfile,
  Ps5Frame,
  Ps5HostInfo,
  Ps5RuntimeStatus,
  Ps5StreamResolution,
  StreamSourceProfile,
} from '@nobowo/core';
import { CustomSelect } from './CustomSelect';
import { FrameRateSelect } from './FrameRateSelect';
import { getPs5ViewerMode, setPs5ViewerMode, usePs5ViewerMode } from './ps5ViewerStore';
import { StreamVisionOverlay } from './StreamVisionOverlay';

type Props = {
  profile: Partial<StreamSourceProfile>;
  onChange: (patch: Partial<StreamSourceProfile>) => void;
};

const RESOLUTIONS: Ps5StreamResolution[] = ['360p', '540p', '720p', '1080p'];
const BUTTON_ACTIONS = [
  ['1 · 叉', 'pressCross'],
  ['2 · 圆圈', 'pressCircle'],
  ['3 · 三角', 'pressTriangle'],
  ['4 · 方框', 'pressSquare'],
  ['L1', 'pressL1'],
  ['R1', 'pressR1'],
  ['L2', 'pressL2'],
  ['R2', 'pressR2'],
  ['Options', 'pressOptions'],
  ['Share', 'pressShare'],
  ['PS', 'pressPS'],
] as const;

const KEY_TO_ACTION: Record<string, string> = {
  1: 'pressCross',
  2: 'pressCircle',
  3: 'pressTriangle',
  4: 'pressSquare',
  Shift: 'pressL1',
  Control: 'pressR1',
  Alt: 'pressL2',
  Meta: 'pressR2',
  Home: 'pressPS',
  Insert: 'pressShare',
  Delete: 'pressOptions',
};

const STICK_KEYS: Record<string, { stick: 'left' | 'right'; x: number; y: number }> = {
  w: { stick: 'left', x: 0, y: -1 },
  a: { stick: 'left', x: -1, y: 0 },
  s: { stick: 'left', x: 0, y: 1 },
  d: { stick: 'left', x: 1, y: 0 },
  ArrowUp: { stick: 'right', x: 0, y: -1 },
  ArrowLeft: { stick: 'right', x: -1, y: 0 },
  ArrowDown: { stick: 'right', x: 0, y: 1 },
  ArrowRight: { stick: 'right', x: 1, y: 0 },
};

export function Ps5DirectPanel({ profile, onChange }: Props) {
  const [accounts, setAccounts] = useState<Ps5AccountProfile[]>([]);
  const [pairedHosts, setPairedHosts] = useState<Array<{ host: string; accountId: string; updatedAt: number }>>([]);
  const [devices, setDevices] = useState<Ps5HostInfo[]>([]);
  const [status, setStatus] = useState<Ps5RuntimeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [pin, setPin] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addOnlineId, setAddOnlineId] = useState('');
  const [addAccountId, setAddAccountId] = useState('');
  const [confirmAccountId, setConfirmAccountId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [hostNotice, setHostNotice] = useState('正在自动发现同一局域网中的 PS5…');
  const [showHostAdvanced, setShowHostAdvanced] = useState(false);

  const [preview, setPreview] = useState<Ps5Frame | null>(null);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [liveSlot, setLiveSlot] = useState<HTMLElement | null>(null);
  const viewerMode = usePs5ViewerMode();
  const previewToken = useRef(0);
  const autoDiscoveryStarted = useRef(false);
  const statusRef = useRef(status);
  const profileRef = useRef(profile);
  const onChangeRef = useRef(onChange);
  profileRef.current = profile;
  onChangeRef.current = onChange;
  statusRef.current = status;

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === profile.ps5AccountId || account.accountId === profile.ps5AccountId) ?? null,
    [accounts, profile.ps5AccountId],
  );

  const selectedPairing = useMemo(
    () => pairedHosts.find((item) =>
      item.host === profile.host &&
      (!selectedAccount || item.accountId === selectedAccount.accountId),
    ) ?? null,
    [pairedHosts, profile.host, selectedAccount],
  );

  const apiUnavailableMessage = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
    ? 'PS5 桌面桥接未加载，请完全退出并重新打开 NoBoWo 桌面应用。'
    : '当前是浏览器预览，未加载 Electron 桌面桥接。请运行 npm run dev，在 NoBoWo 桌面窗口中查询 Account ID。';

  const run = useCallback(async <T,>(label: string, task: () => Promise<T>): Promise<T | null> => {
    if (!window.ps5API) {
      setMessage(apiUnavailableMessage);
      return null;
    }
    setBusy(label);
    setMessage('');
    try {
      return await task();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, [apiUnavailableMessage]);

  const refresh = useCallback(async () => {
    const [accountResult, hostResult, statusResult] = await Promise.all([
      run('加载账号', () => window.ps5API!.listAccounts()),
      run('读取配对', () => window.ps5API!.listHosts()),
      run('读取状态', () => window.ps5API!.status()),
    ]);
    if (accountResult) setAccounts(accountResult.accounts);
    if (hostResult) setPairedHosts(hostResult.hosts);
    if (statusResult) setStatus(statusResult);
  }, [run]);

  const discoverHosts = useCallback(async (announce = true) => {
    if (!window.ps5API) {
      setHostNotice('桌面桥接未加载，无法自动发现 PS5。');
      return;
    }
    setDiscovering(true);
    setHostNotice('正在自动发现同一局域网中的 PS5…');
    try {
      const result = await window.ps5API.discover(2.5);
      setDevices(result.devices);
      const currentHost = profileRef.current.host;
      const currentStillExists = currentHost && result.devices.some((device) => device.host === currentHost);
      let selectedDevice = currentStillExists ? result.devices.find((device) => device.host === currentHost) : undefined;
      if (!currentHost && result.devices.length > 0) {
        selectedDevice = result.devices.find((device) => device.status === 'ready') ?? result.devices[0];
        onChangeRef.current({ host: selectedDevice.host });
      }
      if (result.devices.length > 0) {
        setHostNotice(`已自动发现 ${result.devices.length} 台 PS5，已选择 ${selectedDevice?.name || selectedDevice?.host || result.devices[0].host}。`);
      } else {
        setHostNotice('没有发现 PS5。请确认电脑与 PS5 在同一局域网，或手动配置主机地址。');
      }
    } catch (err) {
      setDevices([]);
      setHostNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!autoDiscoveryStarted.current) {
      autoDiscoveryStarted.current = true;
      void discoverHosts(false);
    }
  }, [discoverHosts, refresh]);

  useEffect(() => {
    if (pairedHosts.length === 0 || accounts.length === 0) return;
    const pairing = pairedHosts.find((item) => item.host === profileRef.current.host) ?? pairedHosts[0];
    const account = accounts.find((item) => item.accountId === pairing.accountId || item.id === pairing.accountId);
    const patch: Partial<StreamSourceProfile> = {};
    if (!profileRef.current.host && pairing.host) patch.host = pairing.host;
    if (!profileRef.current.ps5AccountId && account) patch.ps5AccountId = account.id;
    if (Object.keys(patch).length > 0) onChangeRef.current(patch);
  }, [accounts, pairedHosts]);

  useEffect(() => {
    setLiveSlot(document.getElementById('ps5-direct-live-slot'));
  }, []);

  useEffect(() => () => {
    if (statusRef.current?.connected && getPs5ViewerMode() === 'embedded') {
      setPs5ViewerMode('pip');
    }
  }, []);

  useEffect(() => {
    if (!status?.connected) {
      previewToken.current += 1;
      setPreview(null);
      return;
    }
    let stopped = false;
    const token = ++previewToken.current;
    const tick = async () => {
      if (stopped || token !== previewToken.current || !window.ps5API) return;
      try {
        const frame = await window.ps5API.getFrame();
        if (!stopped && token === previewToken.current) setPreview(frame);
      } catch {
        // keep polling; connection state is refreshed separately
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 250);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [status?.connected]);

  const loginAndLookup = async () => {
    const result = await run('PSN 登录查询', () => window.ps5API!.loginAndLookup());
    if (result) {
      setAddOnlineId(result.onlineId || addOnlineId);
      setAddAccountId(result.accountId);
      setMessage('PlayStation 登录成功，Account ID 已自动填入。');
    }
  };

  const addAccount = async () => {
    if (!addOnlineId.trim() || !addAccountId.trim()) {
      setMessage('请填写 Online ID 和 Account ID');
      return;
    }
    const result = await run('保存账号', () =>
      window.ps5API!.saveAccount({
        name: addName.trim() || addOnlineId.trim(),
        onlineId: addOnlineId.trim(),
        accountId: addAccountId.trim(),
        accountIdSource: 'lookup',
      }),
    );
    if (result) {
      const next = await window.ps5API!.listAccounts();
      setAccounts(next.accounts);
      onChange({ ps5AccountId: result.account.id });
      setShowAdd(false);
      setAddName('');
      setAddOnlineId('');
      setAddAccountId('');
      setMessage('PS5 账号已保存');
    }
  };

  const removeAccount = async (account: Ps5AccountProfile) => {
    const result = await run('删除账号', () => window.ps5API!.removeAccount(account.id));
    if (result) {
      const next = await window.ps5API!.listAccounts();
      setAccounts(next.accounts);
      setConfirmAccountId(null);
      if (profile.ps5AccountId === account.id || profile.ps5AccountId === account.accountId) {
        onChange({ ps5AccountId: undefined });
      }
    }
  };

  const testHost = async (host: string) => {
    const result = await run('测试主机', () => window.ps5API!.testHost(host));
    if (result) setMessage(`主机 ${result.host}：${result.status} · ${result.latencyMs}ms`);
  };

  const pair = async () => {
    if (!profile.host || !selectedAccount) {
      setMessage('请先选择主机和账号');
      return;
    }
    const result = await run('配对主机', () =>
      window.ps5API!.pair({ host: profile.host!, accountId: selectedAccount.accountId, pin }),
    );
    if (result) {
      setPin('');
      setMessage('PS5 配对成功，注册信息已保存');
    }
  };

  const connect = async () => {
    if (!profile.host || !selectedAccount) {
      setMessage('请先选择主机和账号');
      return;
    }
    const result = await run('连接 PS5', () =>
      window.ps5API!.connect({
        host: profile.host!,
        accountId: selectedAccount.id,
        resolution: profile.ps5Resolution ?? '720p',
        fps: profile.captureFps ?? profile.ps5Fps ?? 30,
        quality: 'high',
      }),
    );
    if (result) {
      setStatus(result);
      onChange({ transport: 'ps5Direct', type: 'ps5', host: profile.host, ps5AccountId: selectedAccount.id });
      setMessage('PS5 内置串流已连接');
    }
  };

  const disconnect = async () => {
    const result = await run('断开 PS5', () => window.ps5API!.disconnect());
    if (result) {
      const next = await window.ps5API!.status();
      setStatus(next);
      setMessage('PS5 串流已断开');
    }
  };

  const sendAction = async (action: string) => {
    await run(action, () => window.ps5API!.sendButton(action, true, 90));
  };

  const keyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardActive || event.repeat || !window.ps5API) return;
    event.preventDefault();
    const action = KEY_TO_ACTION[event.key.toLowerCase()];
    if (action) {
      await window.ps5API.sendButton(action, true, 0);
      return;
    }
    const stick = STICK_KEYS[event.key.toLowerCase()];
    if (stick) {
      await window.ps5API.setStick(stick.stick, stick.x, stick.y);
      return;
    }
    await window.ps5API.sendKey(event.key, true);
  };

  const keyUp = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardActive || !window.ps5API) return;
    event.preventDefault();
    const action = KEY_TO_ACTION[event.key.toLowerCase()];
    if (action) {
      await window.ps5API.sendButton(action, false, 0);
      return;
    }
    const stick = STICK_KEYS[event.key.toLowerCase()];
    if (stick) {
      await window.ps5API.setStick(stick.stick, 0, 0);
      return;
    }
    await window.ps5API.sendKey(event.key, false);
  };

  const openExpanded = () => setPs5ViewerMode('expanded');
  const shrinkToPip = () => setPs5ViewerMode('pip');

  const videoStage = (
    <div
      className={`ps5-video ps5-video--viewer ${keyboardActive ? 'ps5-video--active' : ''}`}
      tabIndex={0}
      onClick={openExpanded}
      onKeyDown={(event) => void keyDown(event)}
      onKeyUp={(event) => void keyUp(event)}
      onFocus={() => setKeyboardActive(true)}
      onBlur={() => setKeyboardActive(false)}
    >
      {preview ? (
        <>
          <img src={preview.frame} alt="PS5 串流画面" />
          <StreamVisionOverlay frameWidth={preview.width} frameHeight={preview.height} />
        </>
      ) : <span>{status?.connected ? '正在读取 PS5 协议画面…' : '连接后显示内置视频画面'}</span>}
    </div>
  );

  const inputControls = (
    <>
      <div className="ps5-input-row">
        <button type="button" className={`yolo-btn--compact ${keyboardActive ? 'yolo-btn--primary' : 'yolo-btn--ghost'}`} onClick={() => setKeyboardActive((value) => !value)}>
          {keyboardActive ? '键盘控制已开启' : '开启键盘控制'}
        </button>
        {BUTTON_ACTIONS.map(([label, action]) => (
          <button type="button" key={action} className="yolo-btn--ghost yolo-btn--compact" disabled={!status?.connected} onMouseDown={() => void sendAction(action)}>{label}</button>
        ))}
      </div>
      <p className="ps5-live-panel__hint">键盘 1 / 2 / 3 / 4 对应叉 / 圆圈 / 三角 / 方框；WASD 控制左摇杆，键盘小方向键控制右摇杆。十字 D-Pad 请使用屏幕按钮或 Gamepad 节点。</p>
    </>
  );

  const embeddedViewer = (
    <section className="ps5-live-panel">
      <div className="ps5-viewer-toolbar">
        <div>
          <strong>内置画面与输入</strong>
          <span>{status?.connected ? `正在接收 ${status.host ?? 'PS5'} 画面` : '连接 PS5 后显示协议画面'}</span>
        </div>
        <div className="ps5-viewer-toolbar__actions">
          <span className={`stream-card__pill ${status?.connected ? 'ok' : 'idle'}`}>{status?.connected ? '实况中' : '未连接'}</span>
          <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-viewer-icon-button" title="缩小到画中画" aria-label="缩小到画中画" onClick={shrinkToPip}>−</button>
          <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-viewer-icon-button" title="放大画面" aria-label="放大画面" onClick={openExpanded}>⤢</button>
        </div>
      </div>
      {videoStage}
      {inputControls}
    </section>
  );

  const rightSlotContent = viewerMode === 'embedded'
    ? embeddedViewer
    : (
      <div className="ps5-viewer-placeholder">
        <strong>{viewerMode === 'expanded' ? '画面已放大' : viewerMode === 'pip' ? '画面已缩小到画中画' : '内置画面已关闭'}</strong>
        <span>{viewerMode === 'pip' ? '画中画会在其他页面持续显示。' : '串流连接不会被关闭。'}</span>
        <button
          type="button"
          className="yolo-btn--ghost yolo-btn--compact"
          onClick={() => setPs5ViewerMode(viewerMode === 'hidden' ? 'embedded' : viewerMode === 'pip' ? 'embedded' : 'expanded')}
        >
          {viewerMode === 'expanded' ? '返回画面' : viewerMode === 'pip' ? '放回右栏' : '重新打开'}
        </button>
      </div>
    );

  return (
    <>
      <div className="stream-modal__test ps5-direct-panel">
      <div className="ps5-panel-header">
        <div className="ps5-panel-header__identity">
          <div>
            <strong>PS5 内置串流</strong>
            <span>· 通过 Remote Play 协议连接主机并读取画面</span>
          </div>
        </div>
        <div className="ps5-panel-header__actions">
          <div className="ps5-panel-header__status">
            <span className={`stream-card__pill ${status?.connected ? 'ok' : 'idle'}`}>
              {status?.connected ? '已连接' : '未连接'}
            </span>
            {status?.connected && status.host && <code>{status.host}</code>}
          </div>
          {status?.connected ? (
            <button type="button" className="yolo-btn--ghost yolo-btn--compact" disabled={busy !== null} onClick={() => void disconnect()}>断开连接</button>
          ) : (
            <button type="button" className="yolo-btn--primary yolo-btn--compact" disabled={busy !== null || !profile.host || !selectedAccount} onClick={() => void connect()}>
              {busy === '连接 PS5' ? '连接中…' : '连接 PS5'}
            </button>
          )}
        </div>
      </div>

      {status?.fake && <div className="ps5-mode-note">当前为 Fake 模拟数据，不会连接真实 PSN 或 PS5。</div>}
      {message && <div className="ps5-feedback" role="status">{message}</div>}

      <section className="ps5-section">
        <div className="ps5-section__header">
          <div className="ps5-section__title">
            <span className="ps5-section__step">1</span>
            <div>
              <h4>PSN 账号</h4>
              <p>选择配对 PS5 时使用的 PlayStation 账号</p>
            </div>
          </div>
        </div>

        {accounts.length > 0 ? (
          <div className="ps5-account-grid">
            {accounts.map((account) => {
              const selected = selectedAccount?.id === account.id;
              const confirming = confirmAccountId === account.id;
              return (
                <article key={account.id} className={`ps5-account-card ${selected ? 'ps5-account-card--active' : ''}`}>
                  <button type="button" className="ps5-account-card__select" onClick={() => onChange({ ps5AccountId: account.id })}>
                    <span className="ps5-account-card__avatar">{account.name.slice(0, 1).toUpperCase()}</span>
                    <span className="ps5-account-card__identity">
                      <strong>{account.name}</strong>
                      <span>@{account.onlineId}</span>
                    </span>
                    <span className="ps5-account-card__selected">{selected ? '已选择' : '选择'}</span>
                  </button>
                  <div className="ps5-account-card__footer">
                    <code title={account.accountId}>{account.accountId.slice(0, 12)}…</code>
                    <div className="delete-hover ps5-account-card__delete">
                      {confirming ? (
                        <div className="delete-confirm">
                          <button type="button" className="delete-confirm__ok" onClick={() => void removeAccount(account)}>确定</button>
                          <button type="button" className="delete-confirm__cancel" onClick={() => setConfirmAccountId(null)}>取消</button>
                        </div>
                      ) : (
                        <button type="button" className="delete-trigger delete-trigger--visible" onClick={() => setConfirmAccountId(account.id)}>删除</button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="ps5-empty-state">
            <div>
              <strong>还没有 PS5 账号</strong>
              <p>添加账号后才能配对主机并启动内置串流。</p>
            </div>
            <button type="button" className="yolo-btn--ghost yolo-btn--compact" onClick={() => setShowAdd(true)}>添加账号</button>
          </div>
        )}

        {showAdd && (
          <div className="ps5-account-editor">
            <div className="ps5-account-editor__heading">
              <strong>新增 PSN 账号</strong>
              <span>可登录 PlayStation 获取 Account ID，也可以手动填写。</span>
            </div>
            <div className="ps5-account-form">
              <label className="template-form__field">备注名称<input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="例如：客厅账号" /></label>
              <label className="template-form__field">PSN Online ID<input value={addOnlineId} onChange={(e) => setAddOnlineId(e.target.value)} placeholder="例如：PlayerName" /></label>
              <label className="template-form__field ps5-account-form__wide">Account ID<input value={addAccountId} onChange={(e) => setAddAccountId(e.target.value)} placeholder="Base64 或 19 位数字" /></label>
            </div>
            <button type="button" className="yolo-btn--primary yolo-btn--compact ps5-account-login-button" disabled={busy !== null} onClick={() => void loginAndLookup()}>
              {busy === 'PSN 登录查询' ? '正在登录 PlayStation…' : '登录 PlayStation 获取 Account ID'}
            </button>
            <div className="ps5-form-footer">
              <button type="button" className="yolo-btn--ghost yolo-btn--compact" onClick={() => setShowAdd(false)}>取消</button>
              <button type="button" className="yolo-btn--primary yolo-btn--compact" disabled={busy !== null} onClick={() => void addAccount()}>
                {busy === '保存账号' ? '保存中…' : '保存账号'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="ps5-section">
        <div className="ps5-section__header">
          <div className="ps5-section__title">
            <span className="ps5-section__step">2</span>
            <div>
              <h4>主机发现与连接</h4>
              <p>自动发现同一局域网中的 PS5，无需手动输入地址。</p>
            </div>
          </div>
        </div>
        <div className="ps5-host-auto">
          <div>
            <strong>{discovering ? '正在扫描 PS5' : profile.host ? '已自动选择 PS5' : '等待发现 PS5'}</strong>
            <p>{hostNotice}</p>
          </div>
          <div className="ps5-host-auto__actions">
            <button type="button" className="yolo-btn--ghost yolo-btn--compact" disabled={discovering || busy !== null} onClick={() => void discoverHosts(true)}>
              {discovering ? '扫描中…' : '重新扫描'}
            </button>
            <button type="button" className="yolo-btn--ghost yolo-btn--compact" disabled={!profile.host || busy !== null} onClick={() => void testHost(profile.host!)}>
              {busy === '测试主机' ? '测试中…' : '测试连接'}
            </button>
          </div>
        </div>
        {devices.length > 0 && (
          <div className="ps5-host-grid">
            {devices.map((device) => (
              <button
                type="button"
                key={`${device.host}-${device.hostId ?? ''}`}
                className={`ps5-host-card ${profile.host === device.host ? 'ps5-host-card--active' : ''}`}
                onClick={() => onChange({ host: device.host })}
              >
                <span className="ps5-host-card__head">
                  <strong>{device.name || 'PS5 主机'}</strong>
                  <span className={`stream-card__pill ${device.status === 'ready' ? 'ok' : 'idle'}`}>{device.status || 'unknown'}</span>
                </span>
                <code>{device.host}</code>
                <small>{device.systemVersion ? `系统 ${device.systemVersion}` : '点击选择此主机'}</small>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-host-manual-toggle" onClick={() => setShowHostAdvanced((value) => !value)}>
          {showHostAdvanced ? '收起高级设置' : '找不到主机？手动配置'}
        </button>
        {showHostAdvanced && (
          <div className="ps5-host-form">
            <div className="ps5-host-form__row">
              <label className="yolo-field ps5-host-form__field">
                <span className="yolo-field__label">主机 IP 地址</span>
                <input
                  value={profile.host ?? ''}
                  onChange={(e) => onChange({ host: e.target.value })}
                  placeholder="例如：192.168.1.50"
                  inputMode="decimal"
                  spellCheck={false}
                />
              </label>
              <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-host-form__test" disabled={!profile.host || busy !== null} onClick={() => void testHost(profile.host!)}>
                {busy === '测试主机' ? '测试中…' : '测试连接'}
              </button>
            </div>
            <span className="yolo-field__hint">高级兜底：电脑与 PS5 仍需能够通过局域网通信。</span>
          </div>
        )}
      </section>

      <section className="ps5-section">
        <div className="ps5-section__header">
          <div className="ps5-section__title">
            <span className="ps5-section__step">3</span>
            <div>
              <h4>配对与画质</h4>
              <p>{selectedPairing ? '已记住此主机的配对信息，下次无需再次输入配对码。' : '输入 PS5「添加设备」页面显示的 8 位配对码。'}</p>
            </div>
          </div>
        </div>
        <div className="ps5-pair-grid">
          {!selectedPairing && (
            <label className="template-form__field ps5-pair-grid__pin">
              8 位配对码
              <input value={pin} maxLength={8} inputMode="numeric" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="在 PS5「添加设备」中获取" />
            </label>
          )}
          {selectedPairing && (
            <div className="template-form__field ps5-pair-grid__pin">
              <span className="yolo-field__label">配对状态</span>
              <strong>已记住，可直接连接</strong>
            </div>
          )}
          <label className="template-form__field">
            分辨率
            <CustomSelect
              value={profile.ps5Resolution ?? '720p'}
              options={RESOLUTIONS.map((value) => ({ value, label: value }))}
              onChange={(value) => onChange({ ps5Resolution: value as Ps5StreamResolution })}
            />
          </label>
          <label className="template-form__field">
            采集帧率
            <FrameRateSelect
              value={profile.captureFps ?? profile.ps5Fps ?? 30}
              allowSource={false}
              onChange={(value) => onChange({
                captureFps: value === 'source' ? 30 : value,
                ps5Fps: value === 'source' ? 30 : value,
              })}
            />
          </label>
          {!selectedPairing && (
            <button type="button" className="yolo-btn--primary ps5-pair-grid__action" disabled={!profile.host || !selectedAccount || pin.length !== 8 || busy !== null} onClick={() => void pair()}>
              {busy === '配对主机' ? '配对中…' : '配对当前账号'}
            </button>
          )}
        </div>
      </section>
      </div>

      {liveSlot && createPortal(rightSlotContent, liveSlot)}
    </>
  );
}
