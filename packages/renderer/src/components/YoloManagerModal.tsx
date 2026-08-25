import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EngineEnvInfo,
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
import { PipMirrorControl, GithubProxyControl } from './EnvPanel';

type Props = {
  onClose: () => void;
  onChanged: () => void;
};

type YoloTab = 'dataset' | 'annotate' | 'train' | 'models';

const TABS: { id: YoloTab; label: string; hint: string }[] = [
  { id: 'dataset', label: '数据集', hint: '上传与管理图片' },
  { id: 'annotate', label: '标注', hint: '框选目标并分类' },
  { id: 'train', label: '训练', hint: '参数与实时监控' },
  { id: 'models', label: '模型', hint: '训练产物管理' },
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
        </div>
      </div>
    </div>
  );
}


