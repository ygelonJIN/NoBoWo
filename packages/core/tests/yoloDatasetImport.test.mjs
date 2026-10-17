import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseYoloClassNames,
  parseYoloLabels,
  readImageDimensions,
  selectYoloImportFiles,
} from '../dist/yoloDatasetImport.js';

test('parses class names from YOLO YAML mappings and lists', () => {
  assert.deepEqual(
    parseYoloClassNames('path: ./dataset\nnames:\n  0: button\n  1: "dialog icon"\n'),
    { 0: 'button', 1: 'dialog icon' },
  );
  assert.deepEqual(
    parseYoloClassNames('names: [button, dialog, icon]\n'),
    { 0: 'button', 1: 'dialog', 2: 'icon' },
  );
});

test('selects top-level export images and ignores duplicate split copies', () => {
  const selection = selectYoloImportFiles([
    'data.yaml',
    'images/a.png',
    'labels/a.txt',
    'split/images/train/a.png',
    'split/labels/train/a.txt',
  ]);
  assert.deepEqual(selection.images, [{ path: 'images/a.png', labelPath: 'labels/a.txt' }]);
  assert.equal(selection.classFile, 'data.yaml');
});

test('matches labels for train/val directory layouts', () => {
  const selection = selectYoloImportFiles([
    'dataset.yaml',
    'train/images/a.png',
    'train/labels/a.txt',
    'val/images/b.png',
    'val/labels/b.txt',
  ]);
  assert.deepEqual(selection.images, [
    { path: 'train/images/a.png', labelPath: 'train/labels/a.txt' },
    { path: 'val/images/b.png', labelPath: 'val/labels/b.txt' },
  ]);
});

test('converts normalized YOLO center boxes and rejects invalid rows', () => {
  assert.deepEqual(
    parseYoloLabels('0 0.5 0.5 0.2 0.4\nbad row\n1 0.9 0.5 0.4 0.2 # comment\n2 0 0 0 0\n'),
    [
      { classIndex: 0, box: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 } },
      { classIndex: 1, box: { x: 0.7, y: 0.4, width: 0.3, height: 0.2 } },
    ],
  );
});

test('reads PNG and JPEG dimensions without an image decoder', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(360, 20);
  assert.deepEqual(readImageDimensions(png), { width: 640, height: 360 });

  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x68, 0x02, 0x80,
  ]);
  assert.deepEqual(readImageDimensions(jpeg), { width: 640, height: 360 });
});
