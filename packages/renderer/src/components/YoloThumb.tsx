import { useEffect, useState } from 'react';

const imageCache = new Map<string, string>();

type Props = {
  datasetId: string;
  imageId: string;
  className?: string;
};

export function YoloThumb({ datasetId, imageId, className }: Props) {
  const [src, setSrc] = useState<string>(() => imageCache.get(`${datasetId}:${imageId}`) ?? '');

  useEffect(() => {
    let cancelled = false;
    const key = `${datasetId}:${imageId}`;
    const cached = imageCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    if (!window.yoloAPI) return;
    window.yoloAPI
      .getImage(datasetId, imageId)
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
  }, [datasetId, imageId]);

  if (!src) {
    return <div className={className ? `${className} yolo-thumb yolo-thumb--empty` : 'yolo-thumb yolo-thumb--empty'} aria-hidden="true" />;
  }
  return <img className={className ? `${className} yolo-thumb` : 'yolo-thumb'} src={src} alt="" draggable={false} />;
}
