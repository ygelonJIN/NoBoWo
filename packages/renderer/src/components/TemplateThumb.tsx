import { useEffect, useState } from 'react';

const imageCache = new Map<string, string>();

type Props = {
  id: string;
  className?: string;
  kind?: 'template' | 'source';
};

export function TemplateThumb({ id, className, kind = 'template' }: Props) {
  const [src, setSrc] = useState<string>(() => imageCache.get(`${id}:${kind}`) ?? '');

  useEffect(() => {
    let cancelled = false;
    const key = `${id}:${kind}`;
    const cached = imageCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    if (!window.templateAPI) return;
    window.templateAPI
      .getImage(id, kind)
      .then((url) => {
        if (url && !cancelled) {
          imageCache.set(key, url);
          setSrc(url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, kind]);

  if (!src) {
    return <div className={className ? `${className} template-thumb template-thumb--empty` : 'template-thumb template-thumb--empty'} aria-hidden="true" />;
  }
  return <img className={className ? `${className} template-thumb` : 'template-thumb'} src={src} alt="" draggable={false} />;
}
