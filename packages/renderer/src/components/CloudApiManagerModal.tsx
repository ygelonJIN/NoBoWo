import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CloudApiProfile } from '@nobowo/core';

const blankProfile = (): Omit<CloudApiProfile, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  baseUrl: '',
  apiKey: '',
  defaultPrompt: '',
  lastTestAt: null,
  lastTestStatus: null,
  lastTestMessage: null,
});

type ApiMode = 'cascade' | 'parallel';

type Props = {
  onClose: () => void;
  onChanged: () => void;
};

export function CloudApiManagerModal({ onClose, onChanged }: Props) {
  const [profiles, setProfiles] = useState<CloudApiProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(blankProfile());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiMode, setApiMode] = useState<ApiMode>('cascade');
  const [order, setOrder] = useState<string[]>([]);
  const dragRef = useRef<{ id: string; index: number } | null>(null);

  const selected = useMemo(() => profiles.find((p) => p.id === selectedId) ?? null, [profiles, selectedId]);
  const isNew = !selected;

  const refresh = useCallback(async () => {
    if (!window.cloudApiAPI) return;
    try {
      const list = await window.cloudApiAPI.list();
      setProfiles(list);
      setSelectedId((cur) => (cur && list.some((p) => p.id === cur) ? cur : null));
    } catch (err) {
      setProfiles([]);
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
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        defaultPrompt: selected.defaultPrompt,
        lastTestAt: selected.lastTestAt ?? null,
        lastTestStatus: selected.lastTestStatus ?? null,
        lastTestMessage: selected.lastTestMessage ?? null,
      });
    } else {
      setDraft(blankProfile());
    }
    setConfirmDelete(false);
    setError(null);
  }, [selected]);

  const startNew = () => {
    setSelectedId(null);
    setDraft(blankProfile());
    setConfirmDelete(false);
    setError(null);
  };

  const save = async () => {
    if (!window.cloudApiAPI || saving) return;
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    if (!name || !baseUrl) {
      setError('请填写配置名称和 Base URL');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (selected) {
        await window.cloudApiAPI.update(selected.id, {
          name,
          baseUrl,
          apiKey: draft.apiKey,
          defaultPrompt: draft.defaultPrompt,
        });
      } else {
        const created = await window.cloudApiAPI.create({
          name,
          baseUrl,
          apiKey: draft.apiKey,
          defaultPrompt: draft.defaultPrompt,
        });
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
    if (!selected || !window.cloudApiAPI || saving) return;
    setSaving(true);
    try {
      await window.cloudApiAPI.remove(selected.id);
      setConfirmDelete(false);
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!window.cloudApiAPI || testing) return;
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      setError('请先填写 Base URL');
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const result = await window.cloudApiAPI.test({
        baseUrl,
        apiKey: draft.apiKey,
        name: draft.name.trim() || '未命名配置',
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

  const statusClass = draft.lastTestStatus === 'ok' ? 'ok' : draft.lastTestStatus === 'error' ? 'bad' : 'idle';
  const statusText = draft.lastTestStatus === 'ok' ? '连接成功' : draft.lastTestStatus === 'error' ? '连接失败' : '尚未测试';

  return (
    <div className="template-modal__overlay cloud-api-modal__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="template-modal cloud-api-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="template-modal__header cloud-api-modal__header">
          <div>
            <h2>云端 API 密钥管理</h2>
            <p>统一管理多组云端多模态配置，供识别节点与调试入口复用</p>
          </div>
          <div className="template-modal__header-actions">
            <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="cloud-api-modal__body">
          <aside className="cloud-api-modal__sidebar">
            <div className="cloud-api-modal__sidebar-head">
              <span className="template-modal__section-title">配置列表</span>
            </div>
            <button className="template-folder-new-card" onClick={startNew}>
              <span className="template-folder-new-card__icon">＋</span>
              <span className="template-folder-new-card__text">新建配置</span>
            </button>
            <div className="cloud-api-modal__cards">
              {profiles.map((profile) => {
                const active = profile.id === selectedId;
                const status = profile.lastTestStatus ?? null;
                return (
                  <button
                    key={profile.id}
                    className={`cloud-api-card ${active ? 'cloud-api-card--active' : ''}`}
                    onClick={() => setSelectedId(profile.id)}
                  >
                    <div className="cloud-api-card__head">
                      <span className="cloud-api-card__name">{profile.name}</span>
                      <span className={`cloud-api-card__pill ${status === 'ok' ? 'ok' : status === 'error' ? 'bad' : 'idle'}`}>
                        {status === 'ok' ? '已验证' : status === 'error' ? '失败' : '未测试'}
                      </span>
                    </div>
                    <div className="cloud-api-card__meta">{profile.baseUrl}</div>
                  </button>
                );
              })}
              {profiles.length === 0 && (
                <div className="cloud-api-modal__empty">还没有配置，点击「新建」添加一个。</div>
              )}
            </div>
          </aside>

          <section className="cloud-api-modal__editor">
            <div className="template-modal__step">1 · 基本信息</div>
            <div className="panel-card">
              <div className="cloud-api-form">
                <label className="template-form__field">
                  配置名称
                  <input value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} placeholder="例如：OpenAI 视觉 / 自建多模态" />
                </label>
                <label className="template-form__field">
                  Base URL
                  <input value={draft.baseUrl} onChange={(e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))} placeholder="https://api.example.com/v1" />
                </label>
                <label className="template-form__field cloud-api-form__wide">
                  API Key
                  <textarea
                    value={draft.apiKey}
                    onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
                    rows={2}
                    placeholder="粘贴你的密钥，仅保存在本地 userData"
                  />
                </label>
                <label className="template-form__field cloud-api-form__wide">
                  默认提示词
                  <textarea
                    value={draft.defaultPrompt}
                    onChange={(e) => setDraft((prev) => ({ ...prev, defaultPrompt: e.target.value }))}
                    rows={4}
                    placeholder="例如：找到截图中最像“登录”按钮的中心点，并返回 JSON 坐标"
                  />
                </label>
              </div>
            </div>

            <div className="template-modal__step">2 · 测试连接</div>
            <div className="cloud-api-modal__test">
              <p className="cloud-api-modal__status-msg">
                <span className={`cloud-api-modal__status ${statusClass}`}>{statusText}</span>
                {draft.lastTestAt && (
                  <span className="cloud-api-modal__status-sub">{new Date(draft.lastTestAt).toLocaleString()} · </span>
                )}
                {draft.lastTestMessage ?? '用当前填写的 URL 和 Key 发起一次请求，验证配置是否可用。'}
              </p>
              <button className="yolo-btn--ghost yolo-btn--compact" onClick={test} disabled={testing || saving}>
                {testing ? '测试中…' : '测试连接'}
              </button>
            </div>

            {error && <div className="cloud-api-modal__error">{error}</div>}

            <div className="template-modal__footer">
              {!isNew && (
                <span className="cloud-delete-controls" onClick={(e) => e.stopPropagation()}>
                  {confirmDelete ? (
                    <>
                      <button className="delete-confirm__ok" onClick={() => void remove()} disabled={saving}>确定</button>
                      <button className="delete-confirm__cancel" onClick={() => setConfirmDelete(false)} disabled={saving}>取消</button>
                    </>
                  ) : (
                    <button className="delete-trigger delete-trigger--visible" onClick={() => setConfirmDelete(true)} disabled={saving}>
                      删除配置
                    </button>
                  )}
                </span>
              )}
              <div className="cloud-api-modal__spacer" />
              <button className="template-modal__save" onClick={() => void save()} disabled={saving}>
                {saving ? '保存中…' : isNew ? '创建配置' : '保存修改'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
