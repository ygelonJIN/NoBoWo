import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OcrEngine, OcrResult } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';

const OCR_ENGINE_OPTIONS: { value: OcrEngine; label: string }[] = [
  { value: 'auto', label: '系统 OCR（自动）' },
  { value: 'macosVision', label: 'macOS Vision' },
  { value: 'windowsOcr', label: 'Windows OCR' },
  { value: 'tesseract', label: 'Tesseract' },
  { value: 'paddleOcr', label: 'PaddleOCR' },
];

type Props = {
  onClose: () => void;
  initialText?: string;
  initialEngine?: OcrEngine;
};

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

function clampText(text: string) {
  return text.trim().replace(/\s+/g, ' ');
}

export function OcrTestModal({ onClose, initialText = '', initialEngine = 'auto' }: Props) {
  const [engine, setEngine] = useState<OcrEngine>(initialEngine);
  const [targetText, setTargetText] = useState(initialText);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => result?.matches ?? [], [result]);

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

  const openPicker = () => fileRef.current?.click();

  const handleFile = useCallback(async (file?: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    const url = await readFileAsDataUrl(file);
    const size = await getImageSize(url);
    setImageUrl(url);
    setImageSize(size);
    setError(null);
    setResult(null);
    setHighlightId(null);
  }, []);

  const runOcr = async () => {
    if (!window.ocrAPI || !imageUrl || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await window.ocrAPI.run({
        engine,
        imageDataUrl: imageUrl,
        targetText: clampText(targetText),
        width: imageSize?.width ?? 0,
        height: imageSize?.height ?? 0,
      });
      setResult(res);
      setHighlightId(res.matches.find((m) => clampText(m.text).includes(clampText(targetText)))?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const searchMatches = () => {
    if (!targetText.trim()) return;
    const found = result?.matches.find((m) => clampText(m.text).includes(clampText(targetText)));
    setHighlightId(found?.id ?? null);
  };

  return (
    <div className="template-modal__overlay ocr-modal__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="template-modal ocr-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="template-modal__header ocr-modal__header">
          <div>
            <h2>OCR 测试台</h2>
            <p>拖入或上传截图，选择引擎后运行 OCR，并在结果中定位目标文字</p>
          </div>
          <div className="template-modal__header-actions">
            <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="ocr-modal__body">
          <section className="ocr-modal__stage">
            {!imageUrl ? (
              <button
                className={`ocr-modal__upload ${dragOver ? 'ocr-modal__upload--drag' : ''}`}
                onClick={openPicker}
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
                <div className="ocr-modal__upload-icon">＋</div>
                <div className="ocr-modal__upload-title">拖拽截图到这里，或点击上传</div>
                <div className="ocr-modal__upload-sub">支持 PNG / JPG / WebP · 建议上传完整屏幕或局部截图</div>
              </button>
            ) : (
              <div className="ocr-modal__preview-panel">
                <div className="ocr-modal__preview-shell">
                  <img src={imageUrl} alt="OCR 预览" className="ocr-modal__preview-image" />
                </div>
              </div>
            )}
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
          </section>

          <section className="ocr-modal__workspace">
            <div className="ocr-modal__stack ocr-modal__stack--top">
              <div className="template-modal__step">1 · 引擎与目标</div>
              <div className="template-form__field">
                <span>OCR 引擎</span>
                <CustomSelect
                  value={engine}
                  options={OCR_ENGINE_OPTIONS}
                  onChange={(v) => setEngine(v as OcrEngine)}
                  maxHeight={240}
                />
              </div>
              <label className="template-form__field">
                目标文字
                <input value={targetText} onChange={(e) => setTargetText(e.target.value)} placeholder="例如：同意、提交、搜索" />
              </label>

              <div className={`ocr-modal__status ${error ? 'bad' : result ? 'ok' : 'idle'}`}>
                {error ? error : result ? `识别完成 · ${result.matches.length} 个文本块` : '尚未运行'}
              </div>

              {result && (
                <div className="ocr-modal__result-card">
                  <div className="ocr-modal__result-head">
                    <span className="template-modal__section-title">识别结果</span>
                    <span className="ocr-modal__result-badge">{result.engine}</span>
                  </div>
                  <pre className="ocr-modal__result-text">{result.text || '未识别到文本'}</pre>
                </div>
              )}

              <div className="ocr-modal__actions ocr-modal__actions--single-line">
                <button className="yolo-btn--primary yolo-btn--compact" onClick={() => void runOcr()} disabled={!imageUrl || running}>
                  {running ? '识别中…' : '运行 OCR'}
                </button>
                <button className="yolo-btn--ghost yolo-btn--compact" onClick={searchMatches} disabled={!result || !targetText.trim()}>
                  搜索并高亮
                </button>
                <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => setHighlightId(null)} disabled={!highlightId}>
                  清除高亮
                </button>
              </div>
            </div>

            <div className="ocr-modal__stack ocr-modal__stack--bottom">
              <div className="template-modal__step">2 · 文字块与位置</div>
              <div className="ocr-modal__match-list">
                {matches.length === 0 ? (
                  <div className="ocr-modal__empty">识别后，这里会显示每个文字块的位置和坐标。</div>
                ) : (
                  matches.map((match) => {
                    const active = highlightId === match.id;
                    return (
                      <button
                        key={match.id}
                        className={`ocr-match ${active ? 'ocr-match--active' : ''}`}
                        onClick={() => setHighlightId(match.id)}
                      >
                        <div className="ocr-match__head">
                          <span className="ocr-match__text">{match.text}</span>
                          <span className="ocr-match__score">{typeof match.confidence === 'number' ? `${Math.round(match.confidence * 100)}%` : '—'}</span>
                        </div>
                        <div className="ocr-match__meta">x {match.box.x} · y {match.box.y} · {match.box.width} × {match.box.height}</div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
