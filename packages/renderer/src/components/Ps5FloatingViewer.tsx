import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Ps5RuntimeStatus } from '@nobowo/core';
import { setPs5ViewerMode, usePs5ViewerMode } from './ps5ViewerStore';

const BUTTON_ACTIONS = [
  ['A / Cross', 'pressA'],
  ['B / Circle', 'pressB'],
  ['X / Square', 'pressX'],
  ['Y / Triangle', 'pressY'],
  ['LB', 'pressLB'],
  ['RB', 'pressRB'],
  ['LT', 'pressLT'],
  ['RT', 'pressRT'],
  ['Start', 'pressSTART'],
  ['Back', 'pressBACK'],
  ['Home', 'pressHOME'],
] as const;

const KEY_TO_ACTION: Record<string, string> = {
  Enter: 'pressA',
  Escape: 'pressB',
  Backspace: 'pressX',
  Tab: 'pressY',
  ArrowUp: 'pressDPADU',
  ArrowDown: 'pressDPADD',
  ArrowLeft: 'pressDPADL',
  ArrowRight: 'pressDPADR',
  Shift: 'pressLB',
  Control: 'pressRB',
  Alt: 'pressLT',
  Meta: 'pressRT',
  Home: 'pressHOME',
  Insert: 'pressBACK',
  Delete: 'pressSTART',
};

const STICK_KEYS: Record<string, { stick: 'left' | 'right'; x: number; y: number }> = {
  w: { stick: 'left', x: 0, y: -1 },
  s: { stick: 'left', x: 0, y: 1 },
  a: { stick: 'left', x: -1, y: 0 },
  d: { stick: 'left', x: 1, y: 0 },
  i: { stick: 'right', x: 0, y: -1 },
  k: { stick: 'right', x: 0, y: 1 },
  j: { stick: 'right', x: -1, y: 0 },
  l: { stick: 'right', x: 1, y: 0 },
};

type Position = { x: number; y: number };

export function Ps5FloatingViewer() {
  const mode = usePs5ViewerMode();
  const [status, setStatus] = useState<Ps5RuntimeStatus | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const previewToken = useRef(0);

  const openExpanded = useCallback(() => setPs5ViewerMode('expanded'), []);
  const shrinkToPip = useCallback(() => {
    setPosition((current) => current ?? {
      x: Math.max(12, window.innerWidth - 372),
      y: Math.max(12, window.innerHeight - 260),
    });
    setPs5ViewerMode('pip');
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!window.ps5API || cancelled) return;
      try {
        const next = await window.ps5API.status();
        if (!cancelled) setStatus(next);
      } catch {
        // status is refreshed on the next interval
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (mode !== 'expanded' && mode !== 'pip') {
      previewToken.current += 1;
      setPreview(null);
      return;
    }
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
        if (!stopped && token === previewToken.current) setPreview(frame.frame);
      } catch {
        // keep polling while the session is connected
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 250);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [mode, status?.connected]);

  useEffect(() => {
    if (mode !== 'pip') return;
    const clamp = () => setPosition((current) => current && ({
      x: Math.min(Math.max(12, current.x), Math.max(12, window.innerWidth - 372)),
      y: Math.min(Math.max(12, current.y), Math.max(12, window.innerHeight - 160)),
    }));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [mode]);

  const keyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardActive || event.repeat || !window.ps5API) return;
    event.preventDefault();
    const action = KEY_TO_ACTION[event.key];
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
    const action = KEY_TO_ACTION[event.key];
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

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const current = position ?? { x: Math.max(12, window.innerWidth - 372), y: Math.max(12, window.innerHeight - 260) };
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: current.x, y: current.y };
    setPosition(current);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const maxX = Math.max(12, window.innerWidth - 372);
    const maxY = Math.max(12, window.innerHeight - 160);
    setPosition({
      x: Math.min(maxX, Math.max(12, state.x + event.clientX - state.startX)),
      y: Math.min(maxY, Math.max(12, state.y + event.clientY - state.startY)),
    });
  };

  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const video = (
    <div
      className={`ps5-video ps5-video--viewer ${keyboardActive ? 'ps5-video--active' : ''}`}
      tabIndex={0}
      onClick={mode !== 'expanded' ? openExpanded : undefined}
      onKeyDown={(event) => void keyDown(event)}
      onKeyUp={(event) => void keyUp(event)}
      onFocus={() => setKeyboardActive(true)}
      onBlur={() => setKeyboardActive(false)}
    >
      {preview ? <img src={preview} alt="PS5 串流画面" /> : <span>{status?.connected ? '正在读取 PS5 协议画面…' : '连接后显示内置视频画面'}</span>}
    </div>
  );

  const controls = (
    <>
      <div className="ps5-input-row">
        <button type="button" className={`yolo-btn--compact ${keyboardActive ? 'yolo-btn--primary' : 'yolo-btn--ghost'}`} onClick={() => setKeyboardActive((value) => !value)}>
          {keyboardActive ? '键盘控制已开启' : '开启键盘控制'}
        </button>
        {BUTTON_ACTIONS.map(([label, action]) => (
          <button type="button" key={action} className="yolo-btn--ghost yolo-btn--compact" disabled={!status?.connected} onMouseDown={() => void window.ps5API?.sendButton(action, true, 90)}>{label}</button>
        ))}
      </div>
      <p className="ps5-live-panel__hint">WASD 左摇杆，IJKL 右摇杆，方向键 D-Pad，Enter / Escape / Backspace / Tab 对应 A / B / X / Y。</p>
    </>
  );

  if (mode === 'embedded' || mode === 'hidden') return null;

  if (mode === 'expanded') {
    return createPortal(
      <div className="ps5-viewer-overlay" onMouseDown={(event) => event.target === event.currentTarget && shrinkToPip()}>
        <section className="ps5-viewer-window ps5-viewer-window--expanded" role="dialog" aria-label="PS5 内置串流画面">
          <div className="ps5-viewer-toolbar">
            <div>
              <strong>PS5 内置串流</strong>
              <span>Remote Play 实况画面</span>
            </div>
            <div className="ps5-viewer-toolbar__actions">
              <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-viewer-icon-button" title="缩小到画中画" aria-label="缩小到画中画" onClick={shrinkToPip}>−</button>
              <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-viewer-icon-button" title="缩小到画中画" aria-label="缩小到画中画" onClick={shrinkToPip}>×</button>
            </div>
          </div>
          {video}
          {controls}
        </section>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <section
      className="ps5-viewer-window ps5-viewer-window--pip"
      style={position ? { left: position.x, top: position.y } : undefined}
      aria-label="PS5 画中画"
    >
      <div className="ps5-viewer-toolbar ps5-viewer-toolbar--drag" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
        <strong>内置画面</strong>
        <div className="ps5-viewer-toolbar__actions">
          <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-viewer-icon-button" title="放大画面" aria-label="放大画面" onClick={openExpanded}>⤢</button>
          <button type="button" className="yolo-btn--ghost yolo-btn--compact ps5-viewer-icon-button" title="关闭画面" aria-label="关闭画面" onClick={() => setPs5ViewerMode('hidden')}>×</button>
        </div>
      </div>
      {video}
    </section>,
    document.body,
  );
}
