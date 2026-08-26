#!/usr/bin/env osascript -l JavaScript
/**
 * macOS Vision OCR（JXA 脚本）
 * 用法: osascript -l JavaScript vision_ocr.js <imagePath> <languages>
 * languages 以逗号分隔，如 zh-Hans,en-US
 * 输出: JSON { width, height, blocks: [{ text, confidence, box: { x, y, width, height } }] }
 * 坐标基于图片像素，原点在左上角（与 Tesseract 输出保持一致）。
 */
ObjC.import('AppKit');
ObjC.import('Vision');
ObjC.import('Foundation');
ObjC.import('ImageIO');
ObjC.import('CoreGraphics');

function run(argv) {
  var imagePath = argv[0] || '';
  var langs = (argv[1] || 'zh-Hans,en-US').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  var url = $.NSURL.fileURLWithPath($(imagePath));
  var source = $.CGImageSourceCreateWithURL(url, $());
  if (source === null || source === undefined) {
    return JSON.stringify({ error: '无法读取图片：' + imagePath });
  }
  var cgImage = $.CGImageSourceCreateImageAtIndex(source, 0, $());
  if (cgImage === null || cgImage === undefined) {
    return JSON.stringify({ error: '图片解码失败：' + imagePath });
  }
  var width = $.CGImageGetWidth(cgImage);
  var height = $.CGImageGetHeight(cgImage);

  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  if (langs.length > 0) {
    request.recognitionLanguages = $(langs);
  }

  var handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cgImage, $());
  var err = Ref();
  handler.performRequestsError($([request]), err);

  var results = request.results;
  var blocks = [];
  if (results !== null && results !== undefined) {
    var count = results.count;
    for (var i = 0; i < count; i++) {
      try {
        var obs = results.objectAtIndex(i);
        var candidate = obs.topCandidates(1).objectAtIndex(0);
        var text = candidate.string.js;
        var confidence = candidate.confidence;
        var box = obs.boundingBox;
        if (!text || text.trim().length === 0) { continue; }
        blocks.push({
          text: text,
          confidence: Math.round(confidence * 100) / 100,
          box: {
            x: Math.round(box.origin.x * width),
            y: Math.round((1 - box.origin.y - box.size.height) * height),
            width: Math.round(box.size.width * width),
            height: Math.round(box.size.height * height)
          }
        });
      } catch (e) {
        // 跳过无法解析的结果
      }
    }
  }

  return JSON.stringify({
    width: Math.round(width),
    height: Math.round(height),
    blocks: blocks
  });
}
