import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  YoloAnnotation,
  YoloDataset,
  YoloEnvInfo,
  YoloEpochMetrics,
  YoloImage,
  YoloModel,
  YoloTrainConfig,
  YoloTrainingEvent,
  YoloTrainingState,
} from '@nobowo/core';
import { YoloAnnotationTab } from './YoloAnnotationTab';
import { YoloThumb } from './YoloThumb';
import { YoloTrainingTab } from './YoloTrainingTab';

type Props = {
  onClose: () => void;
  onChanged: () => void;
};

type YoloTab = 'dataset' | 'annotate' | 'train' | 'models' | 'env';

const TABS: { id: YoloTab; label: string; hint: string }[] = [
  { id: 'dataset', label: '数据集', hint: '上传与管理图片' },
  { id: 'annotate', label: '标注', hint: '框选目标并分类' },
  { id: 'train', label: '训练', hint: '参数与实时监控' },
  { id: 'models', label: '模型', hint: '训练产物管理' },
  { id: 'env', label: '环境', hint: 'Python 与依赖包' },
];

const formatBytes = (bytes: number) => {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};

// ===== 数据集页 =====

type DatasetTabProps = {
  datasets: YoloDataset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  apiAvailable: boolean;
};

function DatasetTab({ datasets, selectedId, onSelect, onChanged, apiAvailable }: DatasetTabProps) {
  const [images, setImages] = useState<YoloImage[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, YoloAnnotation[]>>({});
  const [search, setSearch] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmImageDelete, setConfirmImageDelete] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = datasets.find((d) => d.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    if (!selectedId || !window.yoloAPI) {
      setImages([]);
      setAnnotations({});
      return;
    }
    try {
      const [imgs, anns] = await Promise.all([
        window.yoloAPI.listImages(selectedId),
        window.yoloAPI.getAnnotations(selectedId),
      ]);
      setImages(imgs);
      setAnnotations(anns);
    } catch (err) {
      setError(String(err));
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!selectedId || files.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const payload: { name: string; dataUrl: string; width: number; height: number }[] = [];
        for (const file of files) {
          if (!file.type.startsWith('image/')) continue;
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error(`读取失败：${file.name}`));
            reader.readAsDataURL(file);
          });
          const dims = await new Promise<{ w: number; h: number }>((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => resolve({ w: 0, h: 0 });
            img.src = dataUrl;
          });
          payload.push({ name: file.name, dataUrl, width: dims.w, height: dims.h });
        }
        if (payload.length > 0) {
          await window.yoloAPI!.importImages(selectedId, payload);
          await refresh();
          onChanged();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [selectedId, refresh, onChanged],
  );

  const createDataset = async () => {
    const name = newName.trim();
    if (!name || !window.yoloAPI) return;
    try {
      const ds = await window.yoloAPI.createDataset({ name });
      setNewName('');
      setShowCreate(false);
      onSelect(ds.id);
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  };

  const removeDataset = async (id: string) => {
    if (!window.yoloAPI) return;
    try {
      await window.yoloAPI.removeDataset(id);
      setConfirmDelete(null);
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  };

  const startRename = (id: string, name: string) => {
    setRenameId(id);
    setRenameName(name);
  };

  const submitRename = async () => {
    const name = renameName.trim();
    if (!renameId || !name || !window.yoloAPI) return;
    try {
      await window.yoloAPI.updateDataset(renameId, { name });
      setRenameId(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeImage = async (imageId: string) => {
    if (!selectedId || !window.yoloAPI) return;
    try {
      await window.yoloAPI.removeImage(selectedId, imageId);
      await refresh();
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  };

  const exportDataset = async () => {
    if (!selectedId || !window.yoloAPI) return;
    try {
      await window.yoloAPI.exportDataset(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const filtered = datasets.filter((d) => d.name.toLowerCase().includes(search.toLowerCase()));
  const annotatedCount = images.filter((i) => (annotations[i.id]?.length ?? 0) > 0).length;
  const boxTotal = images.reduce((sum, i) => sum + (annotations[i.id]?.length ?? 0), 0);

  return (
    <div className="yolo-dataset">
      <aside className="yolo-dataset__list">
        <div className="yolo-panel-title">
          <span>数据集</span>
          <span className="yolo-panel-title__sub">{datasets.length} 个</span>
        </div>
        <input className="yolo-dataset__search" placeholder="搜索数据集…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {showCreate ? (
          <div className="yolo-dataset__create">
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter') void createDataset();
              if (e.key === 'Escape') setShowCreate(false);
            }} placeholder="数据集名称…" />
            <div className="yolo-dataset__create-actions">
              <button onClick={() => void createDataset()} disabled={!newName.trim()}>
                确定
              </button>
              <button onClick={() => setShowCreate(false)}>取消</button>
            </div>
          </div>
        ) : (
          <button className="yolo-dataset__new" onClick={() => setShowCreate(true)}>
            ＋ 新建数据集
          </button>
        )}
        <div className="yolo-dataset__items">
          {filtered.map((d) => (
            <div key={d.id} className={`yolo-dataset__item delete-hover ${selectedId === d.id ? 'active' : ''}`} onClick={() => onSelect(d.id)}>
              <div className="yolo-dataset__item-main">
                <div className="yolo-dataset__item-head">
                  {renameId === d.id ? (
                    <input
                      className="yolo-dataset__rename-input"
                      autoFocus
                      value={renameName}
                      onChange={(e) => setRenameName(e.target.value)}
                      onBlur={() => void submitRename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename();
                        if (e.key === 'Escape') setRenameId(null);
                      }}
                    />
                  ) : (
                    <span className="yolo-dataset__item-name">{d.name}</span>
                  )}
                  <span className="yolo-dataset__item-meta">
                    {d.imageCount} 图 · {d.annotatedCount} 已标注 · {d.classCount} 类
                  </span>
                </div>
                <div className="yolo-dataset__item-actions delete-hover">
                  {renameId === d.id ? (
                    <>
                      <button className="delete-confirm__ok" onClick={() => void submitRename()}>确定</button>
                      <button className="delete-confirm__cancel" onClick={() => setRenameId(null)}>取消</button>
                    </>
                  ) : confirmDelete === d.id ? (
                    <>
                      <button className="delete-confirm__ok" onClick={() => void removeDataset(d.id)}>确定</button>
                      <button className="delete-confirm__cancel" onClick={() => setConfirmDelete(null)}>取消</button>
                    </>
                  ) : (
                    <>
                      <button className="yolo-dataset__rename-btn" onClick={(e) => { e.stopPropagation(); startRename(d.id, d.name); }}>重命名</button>
                      <button className="delete-trigger" onClick={(e) => { e.stopPropagation(); setConfirmDelete(d.id); }} title="删除数据集">删除</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="yolo-annotate__empty-hint">没有匹配的数据集</div>}
        </div>
      </aside>

      <section className="yolo-dataset__main">
        {!selected ? (
          <div className="yolo-dataset__empty">
            <div className="yolo-dataset__empty-icon">◈</div>
            <p>创建或选择一个数据集，开始上传截图训练素材</p>
          </div>
        ) : images.length === 0 ? (
          <div className="yolo-dataset__empty yolo-dataset__empty--drop">
            <div
              className={`yolo-dataset__drop yolo-dataset__drop--full ${dragOver ? 'drag' : ''} ${busy ? 'busy' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (!busy) void importFiles(Array.from(e.dataTransfer.files));
              }}
              onClick={() => !busy && fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void importFiles(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
              <div className="yolo-dataset__drop-icon">⬆</div>
              <div className="yolo-dataset__drop-text">
                {busy ? '正在导入图片…' : '拖拽图片到这里，或点击选择文件（支持多选）'}
              </div>
              <div className="yolo-dataset__drop-sub">
                {selected.name} · 建议使用真实应用截图，每个目标至少 10~50 张
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="yolo-dataset__stats">
              <div className="yolo-stat-card">
                <span className="yolo-stat-card__value">{images.length}</span>
                <span className="yolo-stat-card__label">图片总数</span>
              </div>
              <div className="yolo-stat-card">
                <span className="yolo-stat-card__value">{annotatedCount}</span>
                <span className="yolo-stat-card__label">已标注</span>
              </div>
              <div className="yolo-stat-card">
                <span className="yolo-stat-card__value">{images.length - annotatedCount}</span>
                <span className="yolo-stat-card__label">未标注</span>
              </div>
              <div className="yolo-stat-card">
                <span className="yolo-stat-card__value">{selected.classCount}</span>
                <span className="yolo-stat-card__label">类别</span>
              </div>
              <div className="yolo-stat-card">
                <span className="yolo-stat-card__value">{boxTotal}</span>
                <span className="yolo-stat-card__label">标注框总数</span>
              </div>
            </div>

            <div
              className={`yolo-dataset__drop ${dragOver ? 'drag' : ''} ${busy ? 'busy' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (!busy) void importFiles(Array.from(e.dataTransfer.files));
              }}
              onClick={() => !busy && fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void importFiles(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
              <div className="yolo-dataset__drop-icon">⬆</div>
              <div className="yolo-dataset__drop-text">
                {busy ? '正在导入图片…' : '拖拽图片到这里，或点击选择文件（支持多选）'}
              </div>
              <div className="yolo-dataset__drop-sub">
                {selected.name} · 建议使用真实应用截图，每个目标至少 10~50 张
              </div>
            </div>

            {error && <div className="yolo-annotate__error">{error}</div>}

            <div className="yolo-dataset__grid-head">
              <span className="yolo-panel-title">
                <span>图片</span>
                <span className="yolo-panel-title__sub">{images.length} 张</span>
              </span>
              <div className="yolo-dataset__grid-actions">
                <button onClick={() => void exportDataset()} disabled={images.length === 0} title="导出 YOLO 格式（images + labels + data.yaml）到本地文件夹">
                  导出 YOLO 格式
                </button>
                <button className="yolo-btn--danger" onClick={() => setConfirmDelete(selected.id)} disabled={images.length === 0}>
                  删除数据集
                </button>
              </div>
            </div>

            <div className="yolo-dataset__grid">
              {images.map((img) => {
                const anns = annotations[img.id] ?? [];
                return (
                  <div key={img.id} className="yolo-dataset__cell delete-hover">
                    <YoloThumb datasetId={selected.id} imageId={img.id} className="yolo-dataset__cell-img" />
                    {anns.length > 0 && (
                      <span className="yolo-dataset__cell-count" title="标注框数量">
                        {anns.length}
                      </span>
                    )}
                    <span className="yolo-dataset__cell-delete-controls" onClick={(e) => e.stopPropagation()}>
                      {confirmImageDelete === img.id ? (
                        <>
                          <button className="delete-confirm__ok" onClick={() => { setConfirmImageDelete(null); void removeImage(img.id); }}>确定</button>
                          <button className="delete-confirm__cancel" onClick={() => setConfirmImageDelete(null)}>取消</button>
                        </>
                      ) : (
                        <button className="delete-trigger" title="删除这张图片" onClick={() => setConfirmImageDelete(img.id)}>删除</button>
                      )}
                    </span>
                    <div className="yolo-dataset__cell-info">
                      <span className="yolo-dataset__cell-name">{img.fileName}</span>
                      <span className={`yolo-dataset__cell-badge ${anns.length > 0 ? '' : 'empty'}`}>{anns.length > 0 ? '已标注' : '未标注'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {images.length === 0 && <div className="yolo-dataset__empty small">上传图片后，去「标注」页框选并分类</div>}
          </>
        )}
      </section>
    </div>
  );
}

// ===== 模型页 =====

type ModelsTabProps = {
  models: YoloModel[];
  onChanged: () => void;
  apiAvailable: boolean;
};

function ModelsTab({ models, onChanged, apiAvailable }: ModelsTabProps) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(models[0]?.id ?? null);
  const [confusionMatrix, setConfusionMatrix] = useState<string | null>(null);
  const [prCurve, setPrCurve] = useState<string | null>(null);

  const selected = models.find((m) => m.id === selectedId) ?? models[0] ?? null;

  useEffect(() => {
    setSelectedId(models.find((m) => m.id === selectedId)?.id ?? models[0]?.id ?? null);
  }, [models, selectedId]);

  useEffect(() => {
    let cancelled = false;
    if (!selected || !window.yoloAPI) {
      setConfusionMatrix(null);
      setPrCurve(null);
      return;
    }
    Promise.all([
      window.yoloAPI.getModelArtifact(selected.id, 'confusionMatrix'),
      window.yoloAPI.getModelArtifact(selected.id, 'prCurve'),
    ])
      .then(([cm, pr]) => {
        if (!cancelled) {
          setConfusionMatrix(cm);
          setPrCurve(pr);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfusionMatrix(null);
          setPrCurve(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const setActive = async (id: string) => {
    if (!window.yoloAPI || busy) return;
    setBusy(true);
    try {
      await window.yoloAPI.setActiveModel(id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const applyToWorkflow = async (id: string) => {
    const model = models.find((m) => m.id === id);
    if (!model?.path) return;
    window.dispatchEvent(new CustomEvent('nobowo:yolo-apply-model', { detail: { path: model.path, name: model.name } }));
  };

  const remove = async (id: string) => {
    if (!window.yoloAPI || busy) return;
    setBusy(true);
    try {
      await window.yoloAPI.removeModel(id);
      setConfirm(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const exportModel = async (id: string, format: 'onnx' | 'tflite' | 'openvino') => {
    if (!window.yoloAPI || busy) return;
    setBusy(true);
    try {
      await window.yoloAPI.exportModel(id, format, selected?.imageSize ?? 640);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  if (models.length === 0) {
    return (
      <div className="yolo-models yolo-models--empty">
        <div className="yolo-models__empty">
          <div className="yolo-models__empty-icon">◈</div>
          <p>还没有训练好的模型</p>
          <p className="yolo-models__empty-sub">去「训练」页配置参数并开始训练，完成后模型会出现在这里</p>
        </div>
      </div>
    );
  }

  return (
    <div className="yolo-models">
      <div className="yolo-models__head">
        <span className="yolo-panel-title">
          <span>已训练模型</span>
          <span className="yolo-panel-title__sub">{models.length} 个</span>
        </span>
        <span className="yolo-models__hint">设为「使用中」的模型可用于识别节点中的 YOLO 策略，也可直接一键应用到当前识别节点</span>
      </div>
      <div className="yolo-models__grid">
        {models.map((m) => (
          <div key={m.id} className={`yolo-model-card ${m.isActive ? 'active' : ''} ${selectedId === m.id ? 'selected' : ''}`} onClick={() => setSelectedId(m.id)}>
            <div className="yolo-model-card__head">
              <span className="yolo-model-card__name">{m.name}</span>
              {m.isActive && <span className="yolo-model-card__active">使用中</span>}
            </div>
            <div className="yolo-model-card__meta">
              <span>
                基座 <b>{m.baseModel}</b>
              </span>
              <span>数据集 {m.datasetName}</span>
              <span>
                {m.epochs} epochs · imgsz {m.imageSize} · batch {m.batch}
              </span>
              <span>大小 {formatBytes(m.sizeBytes)}</span>
              <span>{new Date(m.createdAt).toLocaleString()}</span>
            </div>
            <div className="yolo-model-card__metrics">
              <span>
                mAP50 <b className="green">{m.metrics ? `${m.metrics.mAP50}%` : '—'}</b>
              </span>
              <span>
                mAP50-95 <b className="blue">{m.metrics ? `${m.metrics.mAP50_95}%` : '—'}</b>
              </span>
              <span>
                Precision <b>{m.metrics ? `${m.metrics.precision}%` : '—'}</b>
              </span>
              <span>
                Recall <b>{m.metrics ? `${m.metrics.recall}%` : '—'}</b>
              </span>
            </div>
            <div className="yolo-model-card__actions">
              <button onClick={(e) => { e.stopPropagation(); void setActive(m.id); }} disabled={m.isActive || busy}>
                {m.isActive ? '当前使用中' : '设为使用中'}
              </button>
              <button onClick={(e) => { e.stopPropagation(); void applyToWorkflow(m.id); }} disabled={!m.path || busy}>
                应用到识别节点
              </button>
              <span className="yolo-model-card__delete-controls" onClick={(e) => e.stopPropagation()}>
                {confirm === m.id ? (
                  <>
                    <button className="delete-confirm__ok" onClick={() => void remove(m.id)}>确定</button>
                    <button className="delete-confirm__cancel" onClick={() => setConfirm(null)}>取消</button>
                  </>
                ) : (
                  <button className="delete-trigger delete-trigger--visible" onClick={(e) => { e.stopPropagation(); setConfirm(m.id); }} disabled={busy}>
                    删除
                  </button>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="yolo-model-detail">
          <div className="yolo-model-detail__head">
            <span className="yolo-panel-title">
              <span>模型详情</span>
              <span className="yolo-panel-title__sub">{selected.name}</span>
            </span>
            <div className="yolo-model-detail__actions">
              <button onClick={() => void exportModel(selected.id, 'onnx')} disabled={!apiAvailable || busy}>导出 ONNX</button>
              <button onClick={() => void exportModel(selected.id, 'tflite')} disabled={!apiAvailable || busy}>导出 TFLite</button>
              <button onClick={() => void exportModel(selected.id, 'openvino')} disabled={!apiAvailable || busy}>导出 OpenVINO</button>
            </div>
          </div>
          <div className="yolo-model-detail__content">
            <div className="yolo-model-detail__meta">
              <div>路径：<code>{selected.path ?? '—'}</code></div>
              <div>当前节点接入：点击「应用到识别节点」即可把该模型路径写入识别节点 YOLO 策略。</div>
              <div>训练产物：{selected.artifacts ? '已生成混淆矩阵 / PR 曲线' : '暂无产物图，可能是训练版本较旧或未完成验证阶段'}</div>
            </div>
            <div className="yolo-model-detail__plots">
              <div className="yolo-model-detail__plot">
                <span>混淆矩阵</span>
                {confusionMatrix ? <img src={confusionMatrix} alt="混淆矩阵" /> : <div className="yolo-model-detail__plot-empty">暂无</div>}
              </div>
              <div className="yolo-model-detail__plot">
                <span>PR 曲线</span>
                {prCurve ? <img src={prCurve} alt="PR曲线" /> : <div className="yolo-model-detail__plot-empty">暂无</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 环境页 =====

type EnvTabProps = {
  envInfo: YoloEnvInfo | null;
  onRefresh: () => Promise<void>;
  apiAvailable: boolean;
};

function EnvTab({ envInfo, onRefresh, apiAvailable }: EnvTabProps) {
  const [output, setOutput] = useState<YoloTrainingEvent[]>([]);
  const [installing, setInstalling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const consoleRef = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);

  useEffect(() => {
    if (!window.yoloAPI) return;
    return window.yoloAPI.onPackageOutput((ev) => {
      setOutput((prev) => [...prev.slice(-499), ev]);
      if (ev.t === 'log' && (ev.message.includes('安装完成') || ev.message.startsWith('pip 退出') || ev.level === 'error')) {
        setInstalling(false);
        void onRefresh();
      }
    });
  }, [onRefresh]);

  useEffect(() => {
    const el = consoleRef.current;
    if (el && stickBottom) el.scrollTop = el.scrollHeight;
  }, [output, stickBottom]);

  const installDeps = async () => {
    if (!window.yoloAPI || installing) return;
    setInstalling(true);
    try {
      const res = await window.yoloAPI.installYoloxDeps();
      if (!res.started) {
        setInstalling(false);
        setOutput((prev) => [...prev, { t: 'log', level: 'warn', message: res.message ?? '已有安装任务在进行中' }]);
      }
    } catch (err) {
      setInstalling(false);
      setOutput((prev) => [...prev, { t: 'log', level: 'error', message: String(err) }]);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const isMac = navigator.platform.toLowerCase().includes('mac');

  type EnvRow = {
    id: string;
    label: string;
    state: 'ok' | 'missing' | 'na' | 'info' | 'unknown';
    value: string;
    hint?: string;
    commands?: string[];
  };

  const rows = useMemo<EnvRow[]>(() => {
    if (!envInfo) {
      return [
        { id: 'python', label: 'Python', state: 'unknown', value: '检测中…' },
        { id: 'pip', label: 'pip', state: 'unknown', value: '检测中…' },
        { id: 'yolox', label: 'YOLOX', state: 'unknown', value: '检测中…' },
        { id: 'dir', label: 'YOLOX 目录', state: 'unknown', value: '检测中…' },
        { id: 'torch', label: 'PyTorch', state: 'unknown', value: '检测中…' },
        { id: 'cuda', label: 'CUDA (NVIDIA GPU)', state: 'unknown', value: '检测中…' },
        { id: 'mps', label: 'MPS (Apple 芯片)', state: 'unknown', value: '检测中…' },
        { id: 'device', label: '推荐设备', state: 'unknown', value: '检测中…' },
      ];
    }
    const list: EnvRow[] = [];

    if (envInfo.pythonAvailable) {
      list.push({ id: 'python', label: 'Python', state: 'ok', value: `${envInfo.pythonPath ?? ''}（v${envInfo.pythonVersion}）` });
    } else {
      list.push({ id: 'python', label: 'Python', state: 'missing', value: '未找到 Python',
        hint: 'YOLO 训练需要 Python 3.8+。macOS 自带 Python 可能缺少 pip，建议安装独立版本。',
        commands: isMac ? ['brew install python@3.12', '# 或从 https://python.org 下载安装'] : ['从 https://python.org 下载 Python 3.12 并安装，勾选 "Add to PATH"'],
      });
    }

    if (!envInfo.pythonAvailable) {
      list.push({ id: 'pip', label: 'pip', state: 'na', value: '需先安装 Python', hint: '安装 Python 后自动自带 pip，重新检测即可。' });
    } else if (envInfo.pip) {
      list.push({ id: 'pip', label: 'pip', state: 'ok', value: `v${envInfo.pip}` });
    } else {
      list.push({ id: 'pip', label: 'pip', state: 'missing', value: '未安装 pip',
        hint: 'pip 是 Python 的包管理器，安装 PyTorch、YOLOX 依赖都靠它。',
        commands: ['python3 -m ensurepip --upgrade'],
      });
    }

    if (envInfo.yoloxPath) {
      list.push({ id: 'dir', label: 'YOLOX 目录', state: 'ok', value: envInfo.yoloxPath });
    } else {
      list.push({ id: 'dir', label: 'YOLOX 目录', state: 'missing', value: '未配置',
        hint: '需要指向 YOLOX 源码目录（含 yolox 子目录）。可以点下方「选择 YOLOX 源码目录」，或用命令下载源码。',
        commands: ['git clone https://github.com/Megvii-BaseDetection/YOLOX'],
      });
    }

    if (envInfo.yolox) {
      list.push({ id: 'yolox', label: 'YOLOX', state: 'ok', value: `v${envInfo.yolox}` });
    } else if (envInfo.yoloxPath) {
      list.push({ id: 'yolox', label: 'YOLOX', state: 'missing', value: '未安装',
        hint: 'YOLOX 源码已就位，但依赖未安装。点下方「安装 YOLOX 依赖」按钮，或在 YOLOX 目录执行：',
        commands: ['pip3 install -r requirements.txt  # 在 YOLOX 目录下执行'],
      });
    } else {
      list.push({ id: 'yolox', label: 'YOLOX', state: 'na', value: '待目录', hint: '配置 YOLOX 源码目录后，自动检测 YOLOX 版本。' });
    }

    if (envInfo.torch) {
      list.push({ id: 'torch', label: 'PyTorch', state: 'ok', value: `v${envInfo.torch}` });
    } else {
      list.push({ id: 'torch', label: 'PyTorch', state: 'missing', value: '未安装',
        hint: 'PyTorch 是训练框架，带上 GPU 后端（MPS/CUDA）。安装后 App 自动启用加速。',
        commands: isMac ? ['pip3 install torch torchvision torchaudio'] : ['pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121'],
      });
    }

    if (isMac) {
      list.push({ id: 'cuda', label: 'CUDA (NVIDIA GPU)', state: 'na', value: '不适用（Mac）',
        hint: 'CUDA 只支持 NVIDIA 显卡。Mac 没有 NVIDIA GPU，属于正常情况。Apple 芯片的 GPU 加速走 MPS。',
      });
      if (envInfo.mps) {
        list.push({ id: 'mps', label: 'MPS (Apple 芯片)', state: 'ok', value: '可用' });
      } else if (envInfo.torch) {
        list.push({ id: 'mps', label: 'MPS (Apple 芯片)', state: 'missing', value: '不可用',
          hint: '已安装 PyTorch 但 MPS 未启用，可能是 PyTorch 版本或系统问题。运行以下命令确认：',
          commands: ['python3 -c "import torch; print(torch.backends.mps.is_available())"'],
        });
      } else {
        list.push({ id: 'mps', label: 'MPS (Apple 芯片)', state: 'na', value: '待 PyTorch',
          hint: 'MPS 是 PyTorch 在 Apple 芯片上的 GPU 加速后端。装好 PyTorch 后自动启用，无需单独安装。',
        });
      }
    } else {
      if (envInfo.cuda) {
        list.push({ id: 'cuda', label: 'CUDA (NVIDIA GPU)', state: 'ok', value: '可用' });
      } else {
        list.push({ id: 'cuda', label: 'CUDA (NVIDIA GPU)', state: 'missing', value: '不可用',
          hint: '需要 NVIDIA 显卡 + 驱动，并用 CUDA 版 PyTorch。',
          commands: ['pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121'],
        });
      }
      list.push({ id: 'mps', label: 'MPS (Apple 芯片)', state: 'na', value: '不适用（Windows）',
        hint: 'MPS 仅支持 Apple 芯片的 Mac，Windows 无需安装。',
      });
    }

    const deviceLabels: Record<string, string> = {
      cuda: 'CUDA（NVIDIA GPU 加速，最快）',
      mps: 'MPS（Apple 芯片加速）',
      cpu: 'CPU（无 GPU，训练较慢）',
      none: '无可用设备（需先安装 PyTorch）',
    };
    list.push({ id: 'device', label: '推荐设备', state: 'info', value: deviceLabels[envInfo.device] ?? envInfo.device,
      hint: '训练时自动选择最优计算后端，速度排序：CUDA（NVIDIA 显卡）> MPS（Apple 芯片）> CPU。有 GPU 会快很多；显示 CPU 表示当前没有 GPU 加速可用。',
    });

    return list;
  }, [envInfo, isMac]);

  const missingCount = rows.filter((r) => r.state === 'missing').length;
  const allDone = envInfo !== null && missingCount === 0 && Boolean(envInfo.torch);

  // ===== 权重 & 下载 =====
  const [weights, setWeights] = useState<{ name: string; present: boolean; sizeBytes: number }[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [weightsLoading, setWeightsLoading] = useState(false);

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

  useEffect(() => {
    void refreshWeights();
  }, [refreshWeights]);

  const pickYoloxDir = async () => {
    if (!window.yoloAPI) return;
    const picked = await window.yoloAPI.pickYoloxPath();
    if (picked) {
      await onRefresh();
      void refreshWeights();
    }
  };

  const downloadWeight = async (name: string) => {
    if (!window.yoloAPI || downloading) return;
    setDownloading(name);
    try {
      await window.yoloAPI.downloadWeights(name);
      await refreshWeights();
    } catch (err) {
      setOutput((prev) => [...prev, { t: 'log', level: 'error', message: String(err) }]);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="yolo-env">
      {/* ===== 左栏：运行环境 ===== */}
      <section className="yolo-env__col yolo-env__col--left">
        <div className="yolo-env__head">
          <span className="yolo-panel-title">
            <span>运行环境</span>
            <span className="yolo-panel-title__sub">YOLO 训练依赖检查</span>
          </span>
          <button onClick={() => void refresh()} disabled={refreshing || !apiAvailable}>
            {refreshing ? '检测中…' : '重新检测'}
          </button>
        </div>
        <div className="yolo-env__rows">
          {rows.map((r) => {
            const isOpen = Boolean(expanded[r.id]);
            const expandable = Boolean(r.hint || (r.commands && r.commands.length > 0));
            return (
              <div
                key={r.id}
                className={`yolo-env-row yolo-env-row--${r.state} ${expandable ? 'yolo-env-row--clickable' : ''} ${isOpen ? 'open' : ''}`}
                onClick={() => expandable && setExpanded((p) => ({ ...p, [r.id]: !p[r.id] }))}
              >
                <span className="yolo-env-row__label">{r.label}</span>
                <span className={`yolo-env-row__status ${r.state}`}>
                  {r.state === 'ok' ? '✓ 正常' : r.state === 'missing' ? '✗ 缺失' : r.state === 'na' ? '— 不适用' : r.state === 'info' ? 'ℹ' : '…'}
                </span>
                <span className="yolo-env-row__value">{r.value}</span>
                {expandable && (
                  <span className={`yolo-env-row__solve ${r.state === 'missing' ? 'missing' : r.state === 'na' ? 'na' : 'info'}`}>
                    {r.state === 'missing' ? '如何安装' : '说明'} {isOpen ? '▴' : '▾'}
                  </span>
                )}
                {isOpen && (r.hint || r.commands) && (
                  <div className="yolo-env-row__guide">
                    {r.hint && <div className="yolo-env-row__guide-hint">{r.hint}</div>}
                    {r.commands && r.commands.length > 0 && (
                      <pre className="yolo-env__guide-cmd">
                        <code>{r.commands.join('\n')}</code>
                        <button
                          className="yolo-env__guide-copy"
                          onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(r.commands!.join('\n')).catch(() => {}); }}
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
        <div className="yolo-env__actions">
          <button className="yolo-env__install" onClick={() => void installDeps()} disabled={installing || !apiAvailable}>
            {installing ? '安装中…' : '安装 YOLOX 依赖'}
          </button>
          <button className="yolo-env__pick" onClick={() => void pickYoloxDir()} disabled={!apiAvailable}>
            {envInfo?.yoloxPath ? '更换 YOLOX 源码目录' : '选择 YOLOX 源码目录'}
          </button>
          <span className="yolo-env__tip">按 YOLOX 仓库 requirements.txt 安装依赖。未手动配置时，会查找项目内 third_party/YOLOX。</span>
        </div>
        {allDone && <div className="yolo-env__all-done">所有依赖已就绪，可以开始训练 ✓</div>}
      </section>

      {/* ===== 中栏：预训练权重 ===== */}
      <section className="yolo-env__col yolo-env__col--mid">
        <div className="yolo-env__weights">
          <div className="yolo-env__weights-head">
            <span className="yolo-env__guide-title">YOLOX 预训练权重</span>
          </div>
          <div className="yolo-env__weights-note">
            预训练权重是模型在 COCO 大规模数据集上预先训练好的参数。下载后，训练会作为初始权重（迁移学习 / 微调），只需少量轮次即可达到不错效果，比从零开始训练快很多、准很多。
          </div>
          {weightsLoading ? (
            <div className="yolo-env__weights-empty">检查中…</div>
          ) : weights.length === 0 ? (
            <div className="yolo-env__weights-empty">暂无权重信息，请先配置 YOLOX 目录</div>
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
                    <button className="yolo-btn yolo-btn--compact yolo-btn--primary" onClick={() => void downloadWeight(w.name)} disabled={downloading !== null}>
                      {downloading === w.name ? '下载中…' : '下载'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ===== 右栏：安装输出 ===== */}
      <section className="yolo-env__col yolo-env__col--right">
        <div className="yolo-console__head">
          <span>安装输出</span>
          <span className="yolo-console__count">{output.length} 条</span>
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
          {output.length === 0 && <div className="yolo-console__placeholder">点击安装按钮后，pip 输出会实时显示在这里…</div>}
          {output.map((ev, i) => (
            <div key={i} className={`yolo-console__line yolo-console__line--${ev.t === 'log' ? ev.level : 'info'}`}>
              {ev.t === 'log' ? ev.message : JSON.stringify(ev)}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ===== 弹窗外壳 =====

export function YoloManagerModal({ onClose, onChanged }: Props) {
  const [tab, setTab] = useState<YoloTab>('dataset');
  const [datasets, setDatasets] = useState<YoloDataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [models, setModels] = useState<YoloModel[]>([]);
  const [envInfo, setEnvInfo] = useState<YoloEnvInfo | null>(null);
  const [trainingState, setTrainingState] = useState<YoloTrainingState>({ running: false, jobId: null });
  const [trainingEvents, setTrainingEvents] = useState<YoloTrainingEvent[]>([]);
  const [epochHistory, setEpochHistory] = useState<{ epoch: number; lr: number; metrics: YoloEpochMetrics }[]>([]);
  const apiAvailable = Boolean(window.yoloAPI);

  const refreshDatasets = useCallback(async () => {
    if (!window.yoloAPI) return;
    try {
      const list = await window.yoloAPI.listDatasets();
      setDatasets(list);
      setSelectedDatasetId((cur) => (cur && list.some((d) => d.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch {
      setDatasets([]);
    }
  }, []);

  const refreshModels = useCallback(async () => {
    if (!window.yoloAPI) return;
    try {
      setModels(await window.yoloAPI.listModels());
    } catch {
      setModels([]);
    }
  }, []);

  const refreshEnv = useCallback(async () => {
    if (!window.yoloAPI) return;
    try {
      setEnvInfo(await window.yoloAPI.getEnvInfo());
    } catch {
      setEnvInfo(null);
    }
  }, []);

  useEffect(() => {
    void refreshDatasets();
    void refreshModels();
    void refreshEnv();
    if (!window.yoloAPI) return;
    const unsubs = [
      window.yoloAPI.onTrainingState((s) => setTrainingState(s)),
      window.yoloAPI.onTrainingEvent((ev) => {
        if (ev.t === 'epoch') setEpochHistory((h) => [...h.slice(-499), { epoch: ev.epoch, lr: ev.lr, metrics: ev.metrics }]);
        if (ev.t === 'done') void refreshModels();
        setTrainingEvents((prev) => {
          const next = [...prev, ev];
          return next.length > 3000 ? next.slice(next.length - 3000) : next;
        });
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
  }, [refreshDatasets, refreshModels, refreshEnv]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const handleStart = useCallback(async (cfg: YoloTrainConfig, datasetId: string) => {
    if (!window.yoloAPI) return;
    try {
      const res = await window.yoloAPI.startTraining(cfg, datasetId);
      if (!res.started) {
        setTrainingEvents((prev) => [...prev, { t: 'log', level: 'error', message: res.message ?? '训练未启动' }]);
      }
    } catch (err) {
      setTrainingEvents((prev) => [...prev, { t: 'log', level: 'error', message: String(err) }]);
    }
  }, []);

  const handleStop = useCallback(async () => {
    await window.yoloAPI?.stopTraining();
  }, []);

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId) ?? null;
  const annotatedCount = selectedDataset?.annotatedCount ?? 0;

  return (
    <div className="yolo-modal__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="yolo-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="yolo-modal__header">
          <div className="yolo-modal__title">
            <h2>YOLO 训练中心</h2>
            <p>一站式数据集管理 · 标注 · 训练 · 模型与依赖包管理</p>
          </div>
          <div className="yolo-modal__training-pill">
            <span className={`status-dot ${trainingState.running ? 'status-dot--saving' : 'status-dot--saved'}`} />
            {trainingState.running ? '训练中' : '空闲'}
          </div>
          <button className="yolo-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <nav className="yolo-modal__tabs">
          {TABS.map((t) => {
            const badge =
              t.id === 'annotate' ? (selectedDataset ? `${annotatedCount}/${selectedDataset.imageCount}` : undefined) : t.id === 'models' ? (models.length ? `${models.length}` : undefined) : undefined;
            return (
              <button key={t.id} className={`yolo-modal__tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                <span className="yolo-modal__tab-label">{t.label}</span>
                {badge && <span className="yolo-modal__tab-badge">{badge}</span>}
                <span className="yolo-modal__tab-hint">{t.hint}</span>
              </button>
            );
          })}
        </nav>

        <div className="yolo-modal__body">
          {!apiAvailable && (
            <div className="yolo-modal__web-notice">浏览器预览模式：数据管理功能可用，训练功能需通过 npm run dev 启动桌面版。</div>
          )}
          {tab === 'dataset' && (
            <DatasetTab
              key="dataset"
              datasets={datasets}
              selectedId={selectedDatasetId}
              onSelect={setSelectedDatasetId}
              onChanged={() => {
                void refreshDatasets();
                onChanged();
              }}
              apiAvailable={apiAvailable}
            />
          )}
          {tab === 'annotate' &&
            (selectedDatasetId ? (
              <YoloAnnotationTab
                key={`annotate-${selectedDatasetId}`}
                datasetId={selectedDatasetId}
                onDatasetChanged={() => {
                  void refreshDatasets();
                  onChanged();
                }}
              />
            ) : (
              <div className="yolo-modal__hint">
                还没有数据集。请先到「数据集」页创建数据集并上传图片。
              </div>
            ))}
          {tab === 'train' && (
            <YoloTrainingTab
              key="train"
              datasets={datasets}
              selectedDatasetId={selectedDatasetId}
              onSelectDataset={setSelectedDatasetId}
              envInfo={envInfo}
              trainingState={trainingState}
              trainingEvents={trainingEvents}
              epochHistory={epochHistory}
              onStart={handleStart}
              onStop={handleStop}
            />
          )}
          {tab === 'models' && (
            <ModelsTab
              key="models"
              models={models}
              onChanged={() => {
                void refreshModels();
                onChanged();
              }}
              apiAvailable={apiAvailable}
            />
          )}
          {tab === 'env' && (
            <EnvTab key="env" envInfo={envInfo} onRefresh={refreshEnv} apiAvailable={apiAvailable} />
          )}
        </div>
      </div>
    </div>
  );
}
