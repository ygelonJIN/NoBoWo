import { useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateDefinition, TemplateFolder } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';
import { TemplateThumb } from './TemplateThumb';

type Props = {
  templates: TemplateDefinition[];
  folders?: TemplateFolder[];
  value?: string;
  onChange: (templateId: string) => void;
};

type FolderFilter = 'all' | 'none' | string;

export function TemplatePicker({ templates, folders = [], value, onChange }: Props) {
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all');
  const selected = templates.find((t) => t.id === value) ?? null;

  useEffect(() => {
    setFolderFilter('all');
  }, [templates, folders]);

  const folderIds = useMemo(() => new Set(folders.map((folder) => folder.id)), [folders]);
  const isUnclassified = (template: TemplateDefinition) => !template.folderId || !folderIds.has(template.folderId);

  const filtered = useMemo(() => {
    if (folderFilter === 'all') return templates;
    if (folderFilter === 'none') return templates.filter(isUnclassified);
    return templates.filter((t) => t.folderId === folderFilter && folderIds.has(t.folderId));
  }, [templates, folders, folderFilter, folderIds]);

  const groups = useMemo(() => {
    if (folderFilter !== 'all') return [{ label: null, items: filtered }];
    const result: { label: string | null; items: TemplateDefinition[] }[] = [];
    const noneItems = filtered.filter(isUnclassified);
    if (noneItems.length > 0) result.push({ label: '未分类历史模板', items: noneItems });
    for (const folder of folders) {
      const items = filtered.filter((t) => t.folderId === folder.id);
      if (items.length > 0) result.push({ label: folder.name, items });
    }
    return result;
  }, [filtered, folders, folderFilter, folderIds]);

  const folderOptions = [
    { value: 'all', label: '全部' },
    ...(templates.some(isUnclassified) ? [{ value: 'none', label: `未分类历史模板（${templates.filter(isUnclassified).length}）` }] : []),
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  const options = useMemo(
    () => [
      { value: '', label: selected ? selected.name : value ? '模板已被删除' : '未选择模板' },
      ...groups.flatMap((group) => [
        ...(group.label ? [{ value: `__label:${group.label}`, label: `— ${group.label} —` }] : []),
        ...group.items.map((tpl) => ({
          value: tpl.id,
          label: `${tpl.name}${tpl.app ? ` · ${tpl.app}` : ''} · ${tpl.resolution.width}×${tpl.resolution.height}`,
        })),
      ]),
    ],
    [groups, selected, value],
  );

  return (
    <div className="template-picker">
      {folders.length > 0 && (
        <div className="template-picker__filter">
          <CustomSelect value={folderFilter} options={folderOptions} onChange={(v) => setFolderFilter(v as FolderFilter)} maxHeight={220} />
        </div>
      )}
      <div className="template-picker__main">
        <CustomSelect
          value={value ?? ''}
          options={options}
          onChange={(templateId) => {
            if (!templateId || templateId.startsWith('__label:')) return;
            onChange(templateId);
          }}
          maxHeight={320}
        />
      </div>
    </div>
  );
}
