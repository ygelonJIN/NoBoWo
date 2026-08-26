#!/usr/bin/env swift
/**
 * macOS Vision OCR（Swift 脚本）
 * 用法: swift vision_ocr.swift <imagePath> [languages]
 * languages 以逗号分隔，如 zh-Hans,en-US
 * 输出: JSON { width, height, blocks: [{ text, confidence, box: { x, y, width, height } }] }
 * 坐标基于图片像素，原点在左上角（与 Tesseract 输出保持一致）。
 */
import Foundation
import Vision
import CoreGraphics
import ImageIO

func ocr(imagePath: String, languages: [String]) {
    let url = URL(fileURLWithPath: imagePath)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        print("{\"error\": \"无法读取图片：\(imagePath)\"}")
        return
    }
    guard let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        print("{\"error\": \"图片解码失败：\(imagePath)\"}")
        return
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if !languages.isEmpty {
        request.recognitionLanguages = languages
    }

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        let results = request.results ?? []
        let width = cgImage.width
        let height = cgImage.height
        let blocks: [[String: Any]] = results.compactMap { obs in
            guard let candidate = obs.topCandidates(1).first else { return nil }
            let text = candidate.string
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let box = obs.boundingBox
            let x = Int((box.origin.x * CGFloat(width)).rounded())
            let y = Int(((1 - box.origin.y - box.size.height) * CGFloat(height)).rounded())
            let w = Int((box.size.width * CGFloat(width)).rounded())
            let h = Int((box.size.height * CGFloat(height)).rounded())
            return [
                "text": text,
                "confidence": candidate.confidence,
                "box": ["x": x, "y": y, "width": w, "height": h],
            ]
        }
        let payload: [String: Any] = ["width": width, "height": height, "blocks": blocks]
        let data = try JSONSerialization.data(withJSONObject: payload)
        if let output = String(data: data, encoding: .utf8) {
            print(output)
        } else {
            print("{\"error\": \"JSON 序列化失败\"}")
        }
    } catch {
        print("{\"error\": \"Vision 识别失败：\(error.localizedDescription)\"}")
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("{\"error\": \"缺少图片路径参数\"}")
    exit(1)
}
let langs = args.count >= 3 ? args[2].split(separator: ",").map(String.init) : []
ocr(imagePath: args[1], languages: langs)
