export type YoloImportBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type YoloImportLabel = {
  classIndex: number;
  box: YoloImportBox;
};

export type YoloImportImage = {
  path: string;
  labelPath: string | null;
};

export type YoloDatasetImportSelection = {
  images: YoloImportImage[];
  classFile: string | null;
  cocoFiles: string[];
  warnings: string[];
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);
const PARTITIONS = ['train', 'val', 'test'] as const;

export function normalizeYoloImportPath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/+/g, '/');
}

function extensionOf(filePath: string): string {
  const normalized = normalizeYoloImportPath(filePath);
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 ? normalized.slice(dot + 1).toLowerCase() : '';
}

function stemOf(filePath: string): string {
  const normalized = normalizeYoloImportPath(filePath);
  const slash = normalized.lastIndexOf('/');
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

function basenameOf(filePath: string): string {
  const normalized = normalizeYoloImportPath(filePath);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function isYoloImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(filePath));
}

export function isYoloLabelPath(filePath: string): boolean {
  const normalized = normalizeYoloImportPath(filePath);
  return extensionOf(normalized) === 'txt' && /(^|\/)labels\//i.test(normalized);
}

type ImageLayout = {
  name: string;
  match: (filePath: string) => RegExpMatchArray | null;
  labelPath: (filePath: string, match: RegExpMatchArray) => string;
};

const IMAGE_LAYOUTS: ImageLayout[] = [
  {
    name: 'flat',
    match: (filePath) => normalizeYoloImportPath(filePath).match(/^images\/(.+)$/i),
    labelPath: (_filePath, match) => `labels/${match[1].replace(/\.[^.]+$/, '')}.txt`,
  },
  {
    name: 'split',
    match: (filePath) => normalizeYoloImportPath(filePath).match(/^split\/images\/(train|val|test)\/(.+)$/i),
    labelPath: (_filePath, match) => `split/labels/${match[1]}/${match[2].replace(/\.[^.]+$/, '')}.txt`,
  },
  {
    name: 'image-partitions',
    match: (filePath) => normalizeYoloImportPath(filePath).match(/^images\/(train|val|test)\/(.+)$/i),
    labelPath: (_filePath, match) => `labels/${match[1]}/${match[2].replace(/\.[^.]+$/, '')}.txt`,
  },
  {
    name: 'source-partitions',
    match: (filePath) => normalizeYoloImportPath(filePath).match(/^(train|val|test)\/images\/(.+)$/i),
    labelPath: (_filePath, match) => `${match[1]}/labels/${match[2].replace(/\.[^.]+$/, '')}.txt`,
  },
];

function stripYamlScalar(value: string): string {
  let out = value.trim();
  out = out.replace(/\s+#.*$/, '').trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

function parseYamlFlowClassNames(value: string): Record<string, string> {
  const trimmed = value.trim();
  const result: Record<string, string> = {};
  if (!trimmed) return result;

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1);
    for (const item of body.split(',')) {
      const name = stripYamlScalar(item);
      if (name) result[String(Object.keys(result).length)] = name;
    }
    return result;
  }

  const body = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;
  const entryPattern = /(\d+)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}]+)/g;
  for (const match of body.matchAll(entryPattern)) {
    result[match[1]] = stripYamlScalar(match[2]);
  }
  return result;
}

export function parseYoloClassNames(yamlText: string): Record<string, string> {
  const lines = yamlText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)names\s*:\s*(.*)$/i);
    if (!match) continue;

    const inline = match[2].trim();
    if (inline && inline !== '|' && inline !== '>' && inline !== '|-' && inline !== '>-') {
      return parseYamlFlowClassNames(inline);
    }

    const baseIndent = match[1].length;
    const result: Record<string, string> = {};
    let listIndex = 0;
    for (let next = index + 1; next < lines.length; next += 1) {
      const child = lines[next];
      if (!child.trim() || child.trim().startsWith('#')) continue;
      const indent = child.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent) break;

      const entry = child.trim().match(/^(\d+)\s*:\s*(.+)$/);
      if (entry) {
        result[entry[1]] = stripYamlScalar(entry[2]);
        continue;
      }
      const listItem = child.trim().match(/^-\s*(.+)$/);
      if (listItem) {
        result[String(listIndex)] = stripYamlScalar(listItem[1]);
        listIndex += 1;
      }
    }
    return result;
  }
  return {};
}

export function parseYoloLabels(labelText: string): YoloImportLabel[] {
  const result: YoloImportLabel[] = [];
  for (const rawLine of labelText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;

    const classIndex = Number(parts[0]);
    const cx = Number(parts[1]);
    const cy = Number(parts[2]);
    const width = Number(parts[3]);
    const height = Number(parts[4]);
    if (!Number.isInteger(classIndex) || classIndex < 0) continue;
    if (![cx, cy, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;

    const x1 = Math.min(1, Math.max(0, cx - width / 2));
    const x2 = Math.min(1, Math.max(0, cx + width / 2));
    const y1 = Math.min(1, Math.max(0, cy - height / 2));
    const y2 = Math.min(1, Math.max(0, cy + height / 2));
    if (x2 <= x1 || y2 <= y1) continue;

    const roundNormalized = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    result.push({
      classIndex,
      box: {
        x: roundNormalized(x1),
        y: roundNormalized(y1),
        width: roundNormalized(x2 - x1),
        height: roundNormalized(y2 - y1),
      },
    });
  }
  return result;
}

export function parseCocoClassNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const categories = (value as { categories?: unknown }).categories;
  if (!Array.isArray(categories)) return {};

  const result: Record<string, string> = {};
  for (const category of categories) {
    if (!category || typeof category !== 'object') continue;
    const id = (category as { id?: unknown }).id;
    const name = (category as { name?: unknown }).name;
    if ((typeof id === 'number' || typeof id === 'string') && typeof name === 'string' && name.trim()) {
      result[String(id)] = name.trim();
    }
  }
  return result;
}

function partitionOf(filePath: string): string | null {
  const normalized = normalizeYoloImportPath(filePath).toLowerCase();
  return PARTITIONS.find((partition) =>
    normalized.includes(`/${partition}/`) || normalized.startsWith(`${partition}/`),
  ) ?? null;
}

function resolveLabelPath(
  imagePath: string,
  labelPaths: string[],
  exactLabels: Set<string>,
  labelsByStem: Map<string, string[]>,
): { labelPath: string | null; warning?: string } {
  const normalizedImage = normalizeYoloImportPath(imagePath);
  for (const layout of IMAGE_LAYOUTS) {
    const match = layout.match(normalizedImage);
    if (!match) continue;
    const expected = normalizeYoloImportPath(layout.labelPath(normalizedImage, match));
    if (exactLabels.has(expected)) return { labelPath: expected };
    break;
  }

  const stem = stemOf(normalizedImage).toLowerCase();
  const candidates = labelsByStem.get(stem) ?? [];
  const imagePartition = partitionOf(normalizedImage);
  const partitionMatches = candidates.filter((candidate) => {
    const labelPartition = partitionOf(candidate);
    return imagePartition && labelPartition ? imagePartition === labelPartition : true;
  });
  const matches = partitionMatches.length > 0 ? partitionMatches : candidates;
  if (matches.length === 1) return { labelPath: matches[0] };
  if (matches.length > 1) {
    return {
      labelPath: null,
      warning: `图片 ${normalizedImage} 匹配到多个同名标注，已跳过标注：${matches.join(', ')}`,
    };
  }
  return { labelPath: null };
}

export function selectYoloImportFiles(inputPaths: string[]): YoloDatasetImportSelection {
  const paths = [...new Set(inputPaths.map(normalizeYoloImportPath))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const pathSet = new Set(paths);
  const warnings: string[] = [];

  const imagePaths = paths.filter(isYoloImagePath);
  const labelPaths = paths.filter(isYoloLabelPath);
  const exactLabels = new Set(labelPaths.map(normalizeYoloImportPath));
  const labelsByStem = new Map<string, string[]>();
  for (const labelPath of labelPaths) {
    const stem = stemOf(labelPath).toLowerCase();
    const entries = labelsByStem.get(stem) ?? [];
    entries.push(labelPath);
    labelsByStem.set(stem, entries);
  }

  const hasImageFiles = (prefix: RegExp) => imagePaths.some((filePath) => prefix.test(normalizeYoloImportPath(filePath)));
  const flatPrefixes = /^images\/(?!(?:train|val|test)\/)/i;
  const layouts: Array<{ test: RegExp; accept: (filePath: string) => boolean }> = [
    { test: flatPrefixes, accept: (filePath) => flatPrefixes.test(normalizeYoloImportPath(filePath)) },
    { test: /^split\/images\/(?:train|val|test)\//i, accept: (filePath) => /^split\/images\/(?:train|val|test)\//i.test(normalizeYoloImportPath(filePath)) },
    { test: /^images\/(?:train|val|test)\//i, accept: (filePath) => /^images\/(?:train|val|test)\//i.test(normalizeYoloImportPath(filePath)) },
    { test: /^(?:train|val|test)\/images\//i, accept: (filePath) => /^(?:train|val|test)\/images\//i.test(normalizeYoloImportPath(filePath)) },
  ];

  let selectedImages = imagePaths;
  for (const layout of layouts) {
    if (!hasImageFiles(layout.test)) continue;
    selectedImages = imagePaths.filter(layout.accept);
    break;
  }

  const images: YoloImportImage[] = [];
  for (const imagePath of selectedImages) {
    const resolved = resolveLabelPath(imagePath, labelPaths, exactLabels, labelsByStem);
    if (resolved.warning) warnings.push(resolved.warning);
    images.push({ path: imagePath, labelPath: resolved.labelPath });
  }

  const metadataCandidates = paths.filter((filePath) => /^(data|dataset)\.(ya?ml)$/i.test(basenameOf(filePath)));
  const classFile = metadataCandidates.find((filePath) => !filePath.includes('/')) ?? metadataCandidates[0] ?? null;
  const cocoFiles = paths.filter((filePath) => /^annotations\/.+\.json$/i.test(normalizeYoloImportPath(filePath)));

  const missingLabels = images.filter((image) => !image.labelPath).length;
  if (images.length > 0 && labelPaths.length === 0) {
    warnings.push('未发现 labels 目录，图片将按未标注图片导入。');
  } else if (missingLabels > 0) {
    warnings.push(`${missingLabels} 张图片没有匹配到标注文件，将按未标注图片导入。`);
  }
  if (!classFile && cocoFiles.length === 0) {
    warnings.push('未发现 data.yaml 或 COCO 类别定义，将根据标注中的类别编号自动创建类别。');
  }

  return {
    images,
    classFile: classFile && pathSet.has(classFile) ? classFile : null,
    cocoFiles: cocoFiles.filter((filePath) => pathSet.has(filePath)),
    warnings,
  };
}

function clampDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasBytes = (offset: number, length: number) => offset >= 0 && offset + length <= bytes.length;
  const ascii = (offset: number, length: number) => hasBytes(offset, length)
    ? Array.from(bytes.subarray(offset, offset + length), (value) => String.fromCharCode(value)).join('')
    : '';

  if (hasBytes(0, 24) && ascii(0, 8) === '\x89PNG\r\n\x1a\n') {
    return { width: clampDimension(view.getUint32(16, false)), height: clampDimension(view.getUint32(20, false)) };
  }

  if (hasBytes(0, 10) && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { width: clampDimension(view.getUint16(6, true)), height: clampDimension(view.getUint16(8, true)) };
  }

  if (hasBytes(0, 26) && ascii(0, 2) === 'BM') {
    return {
      width: clampDimension(Math.abs(view.getInt32(18, true))),
      height: clampDimension(Math.abs(view.getInt32(22, true))),
    };
  }

  if (hasBytes(0, 30) && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    const payload = 20;
    if (chunk === 'VP8X' && hasBytes(payload + 4, 6)) {
      const width = 1 + bytes[payload + 4] + (bytes[payload + 5] << 8) + (bytes[payload + 6] << 16);
      const height = 1 + bytes[payload + 7] + (bytes[payload + 8] << 8) + (bytes[payload + 9] << 16);
      return { width: clampDimension(width), height: clampDimension(height) };
    }
    if (chunk === 'VP8 ' && hasBytes(payload + 10, 2)) {
      return {
        width: clampDimension(view.getUint16(payload + 6, true) & 0x3fff),
        height: clampDimension(view.getUint16(payload + 8, true) & 0x3fff),
      };
    }
    if (chunk === 'VP8L' && hasBytes(payload + 5, 1)) {
      const b1 = bytes[payload + 1];
      const b2 = bytes[payload + 2];
      const b3 = bytes[payload + 3];
      const b4 = bytes[payload + 4];
      const width = 1 + b1 + ((b2 & 0x3f) << 8);
      const height = 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
      return { width: clampDimension(width), height: clampDimension(height) };
    }
  }

  if (hasBytes(0, 4) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      if (!hasBytes(offset, 2)) break;
      const length = view.getUint16(offset, false);
      if (length < 2) break;
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && hasBytes(offset + 3, 4)) {
        return {
          width: clampDimension(view.getUint16(offset + 5, false)),
          height: clampDimension(view.getUint16(offset + 3, false)),
        };
      }
      offset += length;
    }
  }

  return { width: 0, height: 0 };
}
