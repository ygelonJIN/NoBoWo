import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { YoloAnnotation, YoloBox, YoloClassDefinition, YoloImage } from '@nobowo/core';
import { YoloThumb } from './YoloThumb';

type Props = {
  datasetId: string;
  onDatasetChanged: () => void;
};

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type DragState =
  | { kind: 'draw'; start: { x: number; y: number }; current: { x: number; y: number } }
  | { kind: 'move'; id: string; start: { x: number; y: number }; orig: YoloBox }
  | { kind: 'resize'; id: string; corner: ResizeCorner; start: { x: number; y: number }; orig: YoloBox }
  | null;

type StageProps = {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  annotations: YoloAnnotation[];
  classes: YoloClassDefinition[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (annotations: YoloAnnotation[]) => void;
  tool: 'draw' | 'move';
};

function AnnotationStage({ imageUrl, imageWidth, imageHeight, annotations, classes, selectedId, onSelect, onChange, tool }: StageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<DragState>(null);

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setBoxSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale =
    imageWidth > 0 && imageHeight > 0 && boxSize.w > 0 && boxSize.h > 0
      ? Math.min(boxSize.w / imageWidth, boxSize.h / imageHeight)
      : 1;
  const displayW = Math.max(1, Math.round(imageWidth * scale));
  const displayH = Math.max(1, Math.round(imageHeight * scale));

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }, []);

  const clampBox = useCallback((b: YoloBox): YoloBox => {
    const width = Math.min(1, Math.max(0.004, b.width));
    const height = Math.min(1, Math.max(0.004, b.height));
    return { x: Math.min(1 - width, Math.max(0, b.x)), y: Math.min(1 - height, Math.max(0, b.y)), width, height };
  }, []);

  const normBox = useCallback(
    (a: { x: number; y: number }, b: { x: number; y: number }): YoloBox => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return clampBox({ x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
    },
    [clampBox],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const pt = toNorm(e.clientX, e.clientY);
      if (d.kind === 'draw') {
        setDrag({ ...d, current: pt });
      } else if (d.kind === 'move') {
        const dx = pt.x - d.start.x;
        const dy = pt.y - d.start.y;
        onChange(
          annotationsRef.current.map((a) =>
            a.id === d.id
              ? { ...a, box: clampBox({ x: d.orig.x + dx, y: d.orig.y + dy, width: d.orig.width, height: d.orig.height }) }
              : a,
          ),
        );
      } else if (d.kind === 'resize') {
        const { orig, corner } = d;
        const min = 0.004;
        let next: YoloBox = { ...orig };
        switch (corner) {
          case 'nw':
            next = {
              x: Math.min(orig.x + orig.width - min, Math.max(0, pt.x)),
              y: Math.min(orig.y + orig.height - min, Math.max(0, pt.y)),
              width: orig.x + orig.width - Math.min(orig.x + orig.width - min, Math.max(0, pt.x)),
              height: orig.y + orig.height - Math.min(orig.y + orig.height - min, Math.max(0, pt.y)),
            };
            break;
          case 'ne':
            next = {
              x: orig.x,
              y: Math.min(orig.y + orig.height - min, Math.max(0, pt.y)),
              width: Math.max(min, Math.min(1 - orig.x, pt.x - orig.x)),
              height: orig.y + orig.height - Math.min(orig.y + orig.height - min, Math.max(0, pt.y)),
            };
            break;
          case 'sw':
            next = {
              x: Math.min(orig.x + orig.width - min, Math.max(0, pt.x)),
              y: orig.y,
              width: orig.x + orig.width - Math.min(orig.x + orig.width - min, Math.max(0, pt.x)),
              height: Math.max(min, Math.min(1 - orig.y, pt.y - orig.y)),
            };
            break;
          case 'se':
            next = {
              x: orig.x,
              y: orig.y,
              width: Math.max(min, Math.min(1 - orig.x, pt.x - orig.x)),
              height: Math.max(min, Math.min(1 - orig.y, pt.y - orig.y)),
            };
            break;
        }
        onChange(annotationsRef.current.map((a) => (a.id === d.id ? { ...a, box: next } : a)));
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d?.kind === 'draw') {
        const box = normBox(d.start, d.current);
        if (box.width >= 0.005 && box.height >= 0.005) {
          const ann: YoloAnnotation = {
            id: `ann-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            classId: null,
            box,
          };
          onChange([...annotationsRef.current, ann]);
          onSelect(ann.id);
        }
      }
      setDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, toNorm, clampBox, normBox, onChange, onSelect]);

  const handleStageDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const pt = toNorm(e.clientX, e.clientY);
    if (toolRef.current === 'draw') {
      setDrag({ kind: 'draw', start: pt, current: pt });
      return;
    }
    const hit = [...annotationsRef.current]
      .reverse()
      .find((a) => pt.x >= a.box.x && pt.x <= a.box.x + a.box.width && pt.y >= a.box.y && pt.y <= a.box.y + a.box.height);
    if (hit) {
      onSelect(hit.id);
      setDrag({ kind: 'move', id: hit.id, start: pt, orig: hit.box });
    } else {
      onSelect(null);
    }
  };

  const handleBoxDown = (e: React.MouseEvent, ann: YoloAnnotation) => {
    e.stopPropagation();
    const pt = toNorm(e.clientX, e.clientY);
    if (toolRef.current === 'draw') {
      setDrag({ kind: 'draw', start: pt, current: pt });
    } else {
      onSelect(ann.id);
      setDrag({ kind: 'move', id: ann.id, start: pt, orig: ann.box });
    }
  };

  const handleResizeDown = (e: React.MouseEvent, id: string, corner: ResizeCorner) => {
    e.stopPropagation();
    e.preventDefault();
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (!ann) return;
    onSelect(id);
    setDrag({ kind: 'resize', id, corner, start: toNorm(e.clientX, e.clientY), orig: ann.box });
  };

  const px = (v: number) => `${v * displayW}px`;
  const py = (v: number) => `${v * displayH}px`;

  return (
    <div className={`yolo-stage ${tool === 'draw' ? 'yolo-stage--draw' : 'yolo-stage--move'}`} ref={wrapRef} onMouseDown={handleStageDown}>
      {imageUrl ? (
        <div ref={boxRef} className="yolo-stage__surface" style={{ width: displayW, height: displayH }}>
          <img className="yolo-stage__image" src={imageUrl} alt="" draggable={false} style={{ width: displayW, height: displayH }} />
          {annotations.map((ann) => {
            const cls = classes.find((c) => c.id === ann.classId);
            const color = cls?.color ?? '#8b9dc9';
            const selected = ann.id === selectedId;
            return (
              <div
                key={ann.id}
                className={`yolo-stage__box ${selected ? 'yolo-stage__box--selected' : ''} ${ann.classId ? '' : 'yolo-stage__box--unclassified'}`}
                style={{
                  left: px(ann.box.x),
                  top: py(ann.box.y),
                  width: px(ann.box.width),
                  height: py(ann.box.height),
                  borderColor: color,
                }}
                onMouseDown={(e) => handleBoxDown(e, ann)}
              >
                <span className="yolo-stage__label" style={{ background: color }}>
                  {cls?.name ?? '未分类'}
                </span>
                {selected &&
                  (['nw', 'ne', 'sw', 'se'] as ResizeCorner[]).map((corner) => (
                    <span
                      key={corner}
                      className={`yolo-stage__handle yolo-stage__handle--${corner}`}
                      style={{ borderColor: color }}
                      onMouseDown={(e) => handleResizeDown(e, ann.id, corner)}
                    />
                  ))}
              </div>
            );
          })}
          {drag?.kind === 'draw' && (
            <div
              className="yolo-stage__drawing"
              style={{
                left: px(Math.min(drag.start.x, drag.current.x)),
                top: py(Math.min(drag.start.y, drag.current.y)),
                width: px(Math.abs(drag.current.x - drag.start.x)),
                height: py(Math.abs(drag.current.y - drag.start.y)),
              }}
            />
          )}
        </div>
      ) : (
        <div className="yolo-stage__empty">等待加载图片…</div>
      )}
    </div>
  );
}

export function YoloAnnotationTab({ datasetId, onDatasetChanged }: Props) {
  const [classes, setClasses] = useState<YoloClassDefinition[]>([]);
  const [images, setImages] = useState<YoloImage[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, YoloAnnotation[]>>({});
  const [currentImageId, setCurrentImageId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageDims, setImageDims] = useState({ w: 0, h: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<'draw' | 'move'>('draw');
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
  const [newClass, setNewClass] = useState('');
  const [confirmClass, setConfirmClass] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!window.yoloAPI) return;
    try {
      const [cls, imgs, anns] = await Promise.all([
        window.yoloAPI.listClasses(datasetId),
        window.yoloAPI.listImages(datasetId),
        window.yoloAPI.getAnnotations(datasetId),
      ]);
      setClasses(cls);
      setImages(imgs);
      setAnnotations(anns);
      setCurrentImageId((cur) => (cur && imgs.some((i) => i.id === cur) ? cur : (imgs[0]?.id ?? null)));
    } catch (err) {
      setError(String(err));
    }
  }, [datasetId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!currentImageId) {
      setImageUrl(null);
      setImageDims({ w: 0, h: 0 });
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setSelectedId(null);
    setImageUrl(null);
    if (!window.yoloAPI) return;
    window.yoloAPI
      .getImage(datasetId, currentImageId)
      .then((url) => {
        if (!url || cancelled) return;
        setImageUrl(url);
        const img = new Image();
        img.onload = () => {
          if (!cancelled) setImageDims({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.src = url;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [datasetId, currentImageId]);

  const currentAnnotations = currentImageId ? (annotations[currentImageId] ?? []) : [];
  const selectedAnnotation = currentAnnotations.find((a) => a.id === selectedId) ?? null;

  const commitAnnotations = useCallback(
    (next: YoloAnnotation[]) => {
      if (!currentImageId) return;
      setAnnotations((prev) => ({ ...prev, [currentImageId]: next }));
      setSaveState('saving');
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        if (window.yoloAPI) {
          window.yoloAPI
            .saveAnnotations(datasetId, currentImageId, next)
            .then(() => {
              setSaveState('saved');
              onDatasetChanged();
            })
            .catch(() => setSaveState('saved'));
        } else {
          setSaveState('saved');
        }
      }, 450);
    },
    [currentImageId, datasetId, onDatasetChanged],
  );

  const addClass = async () => {
    const name = newClass.trim();
    if (!name || !window.yoloAPI) return;
    try {
      await window.yoloAPI.createClass(datasetId, { name });
      setNewClass('');
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const removeClass = async (classId: string) => {
    if (!window.yoloAPI) return;
    try {
      await window.yoloAPI.removeClass(datasetId, classId);
      setConfirmClass(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const assignClass = (classId: string | null) => {
    if (!selectedId) return;
    commitAnnotations(currentAnnotations.map((a) => (a.id === selectedId ? { ...a, classId } : a)));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    const next = currentAnnotations.filter((a) => a.id !== selectedId);
    setSelectedId(null);
    commitAnnotations(next);
  };

  const clearAll = () => {
    setSelectedId(null);
    commitAnnotations([]);
  };

  const removeCurrentImage = async () => {
    if (!currentImageId || !window.yoloAPI) return;
    try {
      await window.yoloAPI.removeImage(datasetId, currentImageId);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const currentIndex = images.findIndex((i) => i.id === currentImageId);
  const goPrev = () => currentIndex > 0 && setCurrentImageId(images[currentIndex - 1].id);
  const goNext = () => currentIndex >= 0 && currentIndex < images.length - 1 && setCurrentImageId(images[currentIndex + 1].id);
  const goNextUnannotated = () => {
    for (let i = 1; i <= images.length; i++) {
      const img = images[(currentIndex + i) % images.length];
      if ((annotations[img.id]?.length ?? 0) === 0) {
        setCurrentImageId(img.id);
        return;
      }
    }
  };

  const classCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const cls of classes) counts.set(cls.id, 0);
    for (const imageId of Object.keys(annotations)) {
      for (const ann of annotations[imageId]) {
        if (ann.classId) counts.set(ann.classId, (counts.get(ann.classId) ?? 0) + 1);
      }
    }
    return counts;
  }, [annotations, classes]);

  const annotatedImages = images.filter((i) => (annotations[i.id]?.length ?? 0) > 0).length;
  const boxCount = currentAnnotations.length;

  return (
    <div className="yolo-annotate">
      <aside className="yolo-annotate__classes">
        <div className="yolo-panel-title">
          <span>类别</span>
          <span className="yolo-panel-title__sub">这个是什么？</span>
        </div>
        <div className="yolo-annotate__add">
          <input
            value={newClass}
            onChange={(e) => setNewClass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addClass()}
            placeholder="新类别名称，如 按钮…"
          />
          <button onClick={() => void addClass()} disabled={!newClass.trim()}>
            添加
          </button>
        </div>
        <div className="yolo-annotate__class-list">
          {classes.length === 0 && <div className="yolo-annotate__empty-hint">还没有类别。先添加类别（例如「按钮」「输入框」「图标」），再框选图片并给它命名。</div>}
          {classes.map((cls) => (
            <div key={cls.id} className={`yolo-annotate__class delete-hover ${selectedAnnotation?.classId === cls.id ? 'active' : ''}`}>
              <span className="yolo-annotate__class-dot" style={{ background: cls.color }} />
              <button className="yolo-annotate__class-name" onClick={() => assignClass(cls.id)} title="点击把当前选框归为该类别">
                {cls.name}
              </button>
              <span className="yolo-annotate__class-count">{classCounts.get(cls.id) ?? 0}</span>
              <span className="yolo-annotate__delete-controls" onClick={(e) => e.stopPropagation()}>
                {confirmClass === cls.id ? (
                  <>
                    <button className="delete-confirm__ok" onClick={() => void removeClass(cls.id)}>确定</button>
                    <button className="delete-confirm__cancel" onClick={() => setConfirmClass(null)}>取消</button>
                  </>
                ) : (
                  <button className="delete-trigger" onClick={() => setConfirmClass(cls.id)} title="删除类别（会同时删除对应选框）">
                    删除
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </aside>

      <section className="yolo-annotate__canvas">
        <div className="yolo-annotate__toolbar">
          <div className="yolo-seg">
            <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>
              框选
            </button>
            <button className={tool === 'move' ? 'active' : ''} onClick={() => setTool('move')}>
              移动
            </button>
          </div>
          <div className="yolo-annotate__nav">
            <button onClick={goPrev} disabled={currentIndex <= 0}>
              上一张
            </button>
            <span className="yolo-annotate__pos">
              {currentIndex + 1} / {images.length}
            </span>
            <button className="yolo-btn--primary" onClick={goNext} disabled={currentIndex >= images.length - 1}>
              下一张
            </button>
            <button onClick={goNextUnannotated} disabled={annotatedImages >= images.length}>
              跳转未标注
            </button>
          </div>
          <div className="yolo-annotate__actions">
            <span className={`yolo-annotate__savestate ${saveState === 'saving' ? 'saving' : ''}`}>
              {saveState === 'saving' ? '保存中…' : '已保存'}
            </span>
            <button onClick={clearAll} disabled={boxCount === 0}>
              清空本图
            </button>
            <button className="yolo-btn--danger" onClick={() => void removeCurrentImage()} disabled={!currentImageId}>
              删除图片
            </button>
          </div>
        </div>

        <div className="yolo-annotate__stage-wrap">
          <AnnotationStage
            imageUrl={imageUrl}
            imageWidth={imageDims.w}
            imageHeight={imageDims.h}
            annotations={currentAnnotations}
            classes={classes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChange={commitAnnotations}
            tool={tool}
          />
        </div>

        <div className="yolo-annotate__classbar">
          <span className="yolo-annotate__classbar-title">这个是什么？</span>
          {classes.map((cls) => (
            <button
              key={cls.id}
              className={`yolo-annotate__classchip ${selectedAnnotation?.classId === cls.id ? 'active' : ''}`}
              style={
                selectedAnnotation?.classId === cls.id
                  ? { borderColor: cls.color, background: `${cls.color}26`, color: cls.color }
                  : undefined
              }
              onClick={() => assignClass(cls.id)}
            >
              <span className="yolo-annotate__class-dot" style={{ background: cls.color }} />
              {cls.name}
            </button>
          ))}
          <button className="yolo-annotate__classchip" onClick={() => assignClass(null)}>
            清除分类
          </button>
          <button className="yolo-annotate__classchip danger" onClick={deleteSelected} disabled={!selectedId}>
            删除选框
          </button>
        </div>

        <div className="yolo-annotate__status">
          {selectedAnnotation ? (
            selectedAnnotation.classId ? (
              <>已选中框：{classes.find((c) => c.id === selectedAnnotation.classId)?.name ?? ''}</>
            ) : (
              <>该选框尚未分类，点击下方类别给它命名</>
            )
          ) : (
            <>当前图片 {boxCount} 个框 · 已标注 {annotatedImages}/{images.length} 张</>
          )}
        </div>
        {error && <div className="yolo-annotate__error">{error}</div>}
      </section>

      <aside className="yolo-annotate__thumbs">
        <div className="yolo-panel-title">
          <span>图片</span>
          <span className="yolo-panel-title__sub">
            {annotatedImages}/{images.length} 已标注
          </span>
        </div>
        <div className="yolo-annotate__thumb-list">
          {images.length === 0 && <div className="yolo-annotate__empty-hint">这个数据集还没有图片，请先到「数据集」页上传。</div>}
          {images.map((img) => {
            const anns = annotations[img.id] ?? [];
            const clsNames = [...new Set(anns.map((a) => classes.find((c) => c.id === a.classId)?.name).filter((n): n is string => Boolean(n)))];
            return (
              <div
                key={img.id}
                className={`yolo-annotate__thumb ${currentImageId === img.id ? 'active' : ''}`}
                onClick={() => setCurrentImageId(img.id)}
              >
                <YoloThumb datasetId={datasetId} imageId={img.id} className="yolo-annotate__thumb-img" />
                <div className="yolo-annotate__thumb-info">
                  <span className="yolo-annotate__thumb-name">{img.fileName}</span>
                  <span className={`yolo-annotate__thumb-meta ${clsNames.length > 0 ? '' : 'empty'}`}>
                    {clsNames.length > 0 ? `包含：${clsNames.join('、')}` : '未标注'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
