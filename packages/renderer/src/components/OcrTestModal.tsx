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

type OcrLogLine = { level: 'info' | 'warn' | 'error' | 'debug'; message: string; percent?: number; time: number };

type Props = {
  onClose: () => void;
  initialText?: string;
  initialEngine?: OcrEngine;
};

type OcrLang = 'auto' | 'eng' | 'chi_sim';

const OCR_LANG_OPTIONS: { value: OcrLang; label: string }[] = [
  { value: 'auto', label: '自动（按目标文字判断）' },
  { value: 'eng', label: '英文（eng）' },
  { value: 'chi_sim', label: '中文（chi_sim，含英文）' },
];

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
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasChinese(text: string) {
  return /[\u4e00-\u9fff]/.test(text);
}

function normalizeForMatch(text: string) {
  return clampText(text)
    .normalize('NFKC')
    .replace(/[·•]/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTextMatch(texts: string[], target: string) {
  const normTarget = normalizeForMatch(target);
  if (!normTarget) return null;
  return texts.find((text) => normalizeForMatch(text).includes(normTarget)) ?? null;
}


export function OcrTestModal({ onClose, initialText = '', initialEngine = 'auto' }: Props) {
  const [engine, setEngine] = useState<OcrEngine>(initialEngine);
  const [lang, setLang] = useState<OcrLang>('auto');
  const [targetText, setTargetText] = useState(initialText);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [logs, setLogs] = useState<OcrLogLine[]>([]);
  const [highlightHint, setHighlightHint] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const previewShellRef = useRef<HTMLDivElement>(null);
  const [previewBox, setPreviewBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const matches = useMemo(() => result?.matches ?? [], [result]);
  const highlightMatch = useMemo(() => matches.find((m) => m.id === highlightId) ?? null, [matches, highlightId]);

  // 用容器尺寸 + 原图尺寸计算 contain 之后的真实显示区域
  useEffect(() => {
    const shell = previewShellRef.current;
    if (!shell || !imageUrl || !imageSize || imageSize.width <= 0 || imageSize.height <= 0) return;
    const update = () => {
      const rect = shell.getBoundingClientRect();
      const scale = Math.min(rect.width / imageSize.width, rect.height / imageSize.height);
      const width = imageSize.width * scale;
      const height = imageSize.height * scale;
      setPreviewBox({
        x: (rect.width - width) / 2,
        y: (rect.height - height) / 2,
        width,
        height,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [imageUrl, imageSize]);

  useEffect(() => {
    if (!window.ocrAPI?.onProgress) return;
    return window.ocrAPI.onProgress((data) => {
      setLogs((current) => [...current.slice(-199), { level: data.level, message: data.message, percent: data.percent, time: data.timestamp }]);
    });
  }, []);

  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);

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
    setHighlightHint(null);
  }, []);

  const runOcr = async () => {
    if (!window.ocrAPI || !imageUrl || running) return;
    setRunning(true);
    setError(null);
    setLogs([]);
    setHighlightHint(null);
    setHighlightId(null);
    try {
      const res = await window.ocrAPI.run({
        engine,
        lang: lang === 'auto' ? (hasChinese(targetText) ? 'chi_sim' : 'eng') : lang,
        imageDataUrl: imageUrl,
        targetText: clampText(targetText),
        width: imageSize?.width ?? 0,
        height: imageSize?.height ?? 0,
      });
      const foundMatch = res.matches.find((m) => normalizeForMatch(m.text).includes(normalizeForMatch(targetText)));
      setHighlightId(foundMatch?.id ?? null);
      setHighlightHint(foundMatch ? `已高亮「${foundMatch.text}」` : `未找到「${targetText}」，请检查目标文字或识别结果`);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
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
                <div className="ocr-modal__preview-shell" ref={previewShellRef}>
                  <img src={imageUrl} alt="OCR 预览" className="ocr-modal__preview-image" />
                  {highlightMatch && previewBox && imageSize && (
                    <div
                      className="ocr-modal__preview-highlight"
                      style={{
                        left: previewBox.x + (highlightMatch.box.x / imageSize.width) * previewBox.width,
                        top: previewBox.y + (highlightMatch.box.y / imageSize.height) * previewBox.height,
                        width: Math.max(2, (highlightMatch.box.width / imageSize.width) * previewBox.width),
                        height: Math.max(2, (highlightMatch.box.height / imageSize.height) * previewBox.height),
                      }}
                      title={highlightMatch.text}
                    />
                  )}
                  {highlightHint && (
                    <div className={`ocr-modal__preview-hint ${highlightMatch ? 'ocr-modal__preview-hint--ok' : ''}`}>
                      {highlightHint}
                    </div>
                  )}
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
              <div className="template-form__field">
                <span>识别语言</span>
                <CustomSelect
                  value={lang}
                  options={OCR_LANG_OPTIONS}
                  onChange={(v) => setLang(v as OcrLang)}
                  maxHeight={240}
                />
              </div>
              <label className="template-form__field">
                目标文字
                <input value={targetText} onChange={(e) => setTargetText(e.target.value)} placeholder="例如：同意、提交、搜索" />
              </label>

              <div className={`ocr-modal__status ${error ? 'bad' : highlightMatch ? 'ok' : 'idle'}`}>
                {error ? error : highlightHint ?? '尚未运行'}
              </div>

              <div className="ocr-modal__actions ocr-modal__actions--single-line">
                <button className="yolo-btn--primary yolo-btn--compact" onClick={() => void runOcr()} disabled={!imageUrl || running}>
                  {running ? '识别中…' : '运行 OCR'}
                </button>
              </div>
            </div>

            <div className="ocr-modal__debug">
              <div className="ocr-modal__debug-head">
                <span>调试信息</span>
                {running && <span className="ocr-modal__debug-spinner" aria-hidden="true" />}
              </div>
              <div className="ocr-modal__debug-body" ref={logBoxRef}>
                {logs.length === 0 ? (
                  <div className="ocr-modal__debug-empty">运行 OCR 后，这里会显示引擎进度与错误信息。</div>
                ) : (
                  logs.map((line, index) => (
                    <div key={index} className={`ocr-modal__debug-line ocr-modal__debug-line--${line.level}`}>
                      <span className="ocr-modal__debug-time">{new Date(line.time).toLocaleTimeString()}</span>
                      <span className="ocr-modal__debug-text">{line.message}</span>
                      {typeof line.percent === 'number' && (
                        <span className="ocr-modal__debug-percent">{line.percent}%</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
