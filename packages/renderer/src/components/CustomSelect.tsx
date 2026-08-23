import { useRef, useState, useEffect, useCallback, type KeyboardEvent, type CSSProperties } from 'react';

type Option = { value: string; label: string };

type Props = {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  maxHeight?: number;
};

// 选定选项后短时间内忽略 trigger 的点击，防止转发/双击把刚收起的下拉框重新打开
const REOPEN_GUARD_MS = 250;

export function CustomSelect({ value, options, onChange, maxHeight = 280 }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const justSelectedAt = useRef(0);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close, true);
    document.addEventListener('touchstart', close, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('touchstart', close, true);
    };
  }, [open]);

  const handleSelect = useCallback(
    (v: string) => {
      justSelectedAt.current = Date.now();
      onChange(v);
      setOpen(false);
    },
    [onChange],
  );

  const handleTriggerClick = useCallback(() => {
    if (Date.now() - justSelectedAt.current < REOPEN_GUARD_MS) return;
    if (!open) {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) {
        const margin = 6;
        const estimated = Math.min(options.length * 40 + 12, maxHeight);
        const fitsBelow = rect.bottom + margin + estimated <= window.innerHeight;
        setPos({
          position: 'fixed',
          top: fitsBelow ? `${rect.bottom + margin}px` : undefined,
          bottom: !fitsBelow ? `${window.innerHeight - rect.top + margin}px` : undefined,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          maxHeight,
          zIndex: 1000,
        });
      }
    }
    setOpen((o) => !o);
  }, [open, options.length, maxHeight]);

  const handleOptionClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, v: string) => {
      e.stopPropagation();
      handleSelect(v);
    },
    [handleSelect],
  );

  const handleOptionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, v: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(v);
      }
    },
    [handleSelect],
  );

  return (
    <div className="custom-select" ref={ref}>
      <button
        type="button"
        className={`custom-select__trigger ${open ? 'custom-select__trigger--open' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          handleTriggerClick();
        }}
      >
        <span>{current?.label ?? value}</span>
        <svg className="custom-select__arrow" width="12" height="12" viewBox="0 0 12 12">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && pos && (
        <div className="custom-select__dropdown" style={{ ...pos, maxHeight }}>
          {options.map((opt) => (
            <button
              type="button"
              key={opt.value}
              className={`custom-select__option ${opt.value === value ? 'custom-select__option--active' : ''}`}
              onClick={(e) => handleOptionClick(e, opt.value)}
              onKeyDown={(e) => handleOptionKeyDown(e, opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
