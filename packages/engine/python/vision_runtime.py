#!/usr/bin/env python3
"""NoBoWo 视觉 + 输入运行时 —— 模板匹配 / YOLO 推理 / 键鼠输入

用法: python3 vision_runtime.py <command> <config.json>

命令:
  check    检查依赖（cv2 / torch / yolox）
  template OpenCV 模板匹配
  yolo     YOLOX 模型推理
  input    键鼠输入（pyautogui：click / type / key / scroll / move）

输出: stdout 每行一个 JSON 事件，状态统一为 {"t":"done","ok":bool,...}
"""
import json
import os
import sys
import traceback


def emit(**kw):
    try:
        print(json.dumps(kw, ensure_ascii=False), flush=True)
    except Exception:
        pass


def fail(command, message):
    emit(t="done", command=command, ok=False, message=message)
    return 1


def run_check(cfg):
    info = {"cv2": None, "torch": None, "yolox": None, "cuda": False, "mps": False, "device": "none"}
    try:
        import cv2
        info["cv2"] = cv2.__version__
    except Exception:
        pass
    try:
        import torch
        info["torch"] = torch.__version__
        info["cuda"] = bool(torch.cuda.is_available())
        mps = getattr(torch.backends, "mps", None)
        info["mps"] = bool(mps is not None and mps.is_available())
        info["device"] = "cuda" if info["cuda"] else ("mps" if info["mps"] else "cpu")
    except Exception:
        pass
    yolox_path = cfg.get("yoloxPath")
    if yolox_path and os.path.isdir(yolox_path):
        sys.path.insert(0, yolox_path)
    try:
        import yolox
        info["yolox"] = getattr(yolox, "__version__", "?")
    except Exception:
        pass
    emit(t="done", command="check", ok=True, env=info)
    return 0


def run_template(cfg):
    try:
        import cv2
    except Exception as exc:
        return fail("template", "无法加载 OpenCV（cv2），请先安装：pip install opencv-python")

    image_path = cfg.get("imagePath")
    template_path = cfg.get("templatePath")
    if not image_path or not template_path:
        return fail("template", "缺少图片或模板路径")
    threshold = float(cfg.get("threshold", 60))

    img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
    tpl = cv2.imread(template_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return fail("template", "无法读取测试图片")
    if tpl is None:
        return fail("template", "无法读取模板文件")

    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif img.ndim == 3 and img.shape[2] == 4:
        img = img[:, :, :3]

    method = cv2.TM_CCOEFF_NORMED
    mask = None
    if tpl.ndim == 2:
        tpl = cv2.cvtColor(tpl, cv2.COLOR_GRAY2BGR)
    elif tpl.ndim == 3 and tpl.shape[2] == 4:
        # 带透明通道的模板：用 alpha 作为掩码
        mask = tpl[:, :, 3]
        tpl = tpl[:, :, :3]
        method = cv2.TM_CCORR_NORMED

    try:
        result = cv2.matchTemplate(img, tpl, method, mask=mask) if mask is not None else cv2.matchTemplate(img, tpl, method)
        min_val, max_val, min_loc, max_loc = cv2.minMaxLoc(result)
    except Exception as exc:
        return fail("template", "匹配失败：{0}".format(exc))

    confidence = max(0.0, float(max_val))
    confidence_pct = round(min(100.0, confidence * 100.0), 1)
    x, y = int(max_loc[0]), int(max_loc[1])
    w, h = int(tpl.shape[1]), int(tpl.shape[0])
    ok = confidence_pct >= threshold

    click_x, click_y = x + w // 2, y + h // 2
    # matchHotspot 与 sourceRect 都定义在原始截图上，相对模板的偏移 = (hotspot - sourceRect)
    source = cfg.get("sourceRect") or {}
    hotspot = cfg.get("hotspot") or {}
    if isinstance(source, dict) and isinstance(hotspot, dict) \
            and source.get("x") is not None and hotspot.get("x") is not None:
        click_x = x + int(hotspot.get("x", 0)) - int(source.get("x", 0))
        click_y = y + int(hotspot.get("y", 0)) - int(source.get("y", 0))
    offset = cfg.get("clickOffset") or {}
    if isinstance(offset, dict) and offset.get("x") is not None:
        click_x += int(offset.get("x", 0))
        click_y += int(offset.get("y", 0))

    emit(
        t="done",
        command="template",
        ok=ok,
        x=x,
        y=y,
        width=w,
        height=h,
        confidence=confidence_pct,
        clickX=click_x,
        clickY=click_y,
        message="匹配成功" if ok else "低于阈值（{0}% < {1}%）".format(confidence_pct, threshold),
    )
    return 0


def run_yolo(cfg):
    yolox_path = cfg.get("yoloxPath")
    if yolox_path and os.path.isdir(yolox_path):
        sys.path.insert(0, yolox_path)

    try:
        import cv2
        import torch
        from yolox.exp import get_exp
        from yolox.utils import postprocess
        from yolox.data.data_augment import preproc
    except Exception as exc:
        return fail("yolo", "无法加载 YOLOX / PyTorch：{0}".format(exc))

    model_path = cfg.get("modelPath")
    image_path = cfg.get("imagePath")
    if not model_path or not image_path:
        return fail("yolo", "缺少模型或图片路径")

    base = str(cfg.get("baseModel", "yolox_s"))
    num_classes = int(cfg.get("numClasses", 1))
    imgsz = int(cfg.get("imageSize", 640))
    conf_thre = float(cfg.get("confThre", 0.3))
    nms_thre = float(cfg.get("nmsThre", 0.45))

    try:
        exp = get_exp(None, base)
        exp.num_classes = num_classes
        exp.test_size = (imgsz, imgsz)

        model = exp.get_model()
        ckpt = torch.load(model_path, map_location="cpu")
        if "model" in ckpt:
            ckpt = ckpt["model"]
        model.load_state_dict(ckpt)
        model.eval()

        device = torch.device("cpu")
        if torch.cuda.is_available():
            device = torch.device("cuda:0")
        else:
            mps = getattr(torch.backends, "mps", None)
            if mps is not None and mps.is_available():
                device = torch.device("mps")
        model.to(device)

        origin = cv2.imread(image_path)
        if origin is None:
            return fail("yolo", "无法读取测试图片")

        img, ratio = preproc(origin, (imgsz, imgsz))
        tensor = torch.from_numpy(img).unsqueeze(0).float().to(device)
        with torch.no_grad():
            outputs = model(tensor)
            results = postprocess(outputs, num_classes, conf_thre, nms_thre, class_agnostic=False)
    except Exception as exc:
        return fail("yolo", "推理失败：{0}".format(traceback.format_exc()))

    class_names = cfg.get("classNames") or []
    detections = []
    dets = results[0] if results and len(results) > 0 else None
    if dets is not None and len(dets) > 0:
        dets = dets.cpu().numpy()
        for row in dets:
            x1, y1, x2, y2 = float(row[0]), float(row[1]), float(row[2]), float(row[3])
            obj_conf, cls_conf = float(row[4]), float(row[5])
            cls_idx = int(row[6])
            conf = obj_conf * cls_conf
            if conf < conf_thre:
                continue
            x = round(x1 / ratio)
            y = round(y1 / ratio)
            w = round((x2 - x1) / ratio)
            h = round((y2 - y1) / ratio)
            label = class_names[cls_idx] if cls_idx < len(class_names) else str(cls_idx)
            detections.append({
                "label": label,
                "confidence": round(min(1.0, conf) * 100, 1),
                "box": [x, y, w, h],
            })
    detections.sort(key=lambda d: -d["confidence"])

    emit(
        t="done",
        command="yolo",
        ok=True,
        detections=detections,
        message="检测到 {0} 个目标".format(len(detections)),
    )
    return 0


def run_input(cfg):
    """键鼠输入：click / type / key / scroll / move（pyautogui）"""
    try:
        import pyautogui
    except Exception as exc:
        return fail("input", "无法加载 pyautogui，请先安装：pip install pyautogui")

    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = float(cfg.get("pause", 0.05))
    action = cfg.get("action", "")

    try:
        if action == "click":
            x = float(cfg["x"]) if "x" in cfg else None
            y = float(cfg["y"]) if "y" in cfg else None
            button = cfg.get("button", "left")
            clicks = int(cfg.get("clicks", 1))
            duration = float(cfg.get("duration", 0))
            if x is not None and y is not None:
                pyautogui.click(x, y, clicks=clicks, interval=0.05, button=button, duration=duration)
            else:
                pyautogui.click(clicks=clicks, interval=0.05, button=button)
        elif action == "type":
            text = str(cfg.get("text", ""))
            interval = float(cfg.get("interval", 0.02))
            pyautogui.write(text, interval=interval)
        elif action == "key":
            keys = str(cfg.get("keys", ""))
            mode = cfg.get("mode", "tap")
            if not keys:
                return fail("input", "按键内容为空")
            if mode == "hold":
                pyautogui.keyDown(keys)
            elif mode == "release":
                pyautogui.keyUp(keys)
            else:
                pyautogui.press(keys)
        elif action == "scroll":
            amount = int(cfg.get("amount", 0))
            direction = cfg.get("direction", "down")
            if direction in ("left", "right"):
                pyautogui.hscroll(amount if direction == "right" else -amount)
            else:
                pyautogui.scroll(amount if direction == "up" else -amount)
        elif action == "move":
            x = float(cfg["x"])
            y = float(cfg["y"])
            pyautogui.moveTo(x, y, duration=float(cfg.get("duration", 0.2)))
        else:
            return fail("input", "未知动作：{0}".format(action))
    except Exception as exc:
        return fail("input", "输入执行失败：{0}".format(traceback.format_exc()))

    emit(t="done", command="input", ok=True, action=action, message="输入执行完成")
    return 0


def main():
    if len(sys.argv) < 3:
        emit(t="error", message="用法: vision_runtime.py <command> <config.json>")
        return 2
    command = sys.argv[1]
    config_path = sys.argv[2]
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as exc:
        emit(t="error", message="读取配置失败：{0}".format(exc))
        return 1
    if command == "check":
        return run_check(cfg)
    if command == "template":
        return run_template(cfg)
    if command == "yolo":
        return run_yolo(cfg)
    if command == "input":
        return run_input(cfg)
    emit(t="error", message="未知命令：{0}".format(command))
    return 2


if __name__ == "__main__":
    sys.exit(main())
