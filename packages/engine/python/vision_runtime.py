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
import math
import os
import subprocess
import sys
import time
import traceback
from typing import Optional, Tuple


def emit(**kw):
    try:
        print(json.dumps(kw, ensure_ascii=False), flush=True)
    except Exception:
        pass


def fail(command, message):
    emit(t="done", command=command, ok=False, message=message)
    return 1


def run_check(cfg):
    info = {"cv2": None, "torch": None, "yolox": None, "pyautogui": None, "cuda": False, "mps": False, "device": "none"}
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
    try:
        import pyautogui
        info["pyautogui"] = getattr(pyautogui, "__version__", "?")
    except Exception:
        pass
    try:
        from importlib.util import find_spec
        if find_spec("paddleocr") is not None:
            try:
                import paddleocr
                info["paddleocr"] = getattr(paddleocr, "__version__", "已安装")
            except Exception:
                info["paddleocr"] = "已安装"
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
    debug_image_path = cfg.get("debugImagePath")
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
        template_h, template_w = tpl.shape[0], tpl.shape[1]
        image_h, image_w = img.shape[0], img.shape[1]
        if template_w <= 0 or template_h <= 0 or image_w <= 0 or image_h <= 0:
            return fail("template", "模板或截图尺寸非法")

        # 以模板自身尺寸为基准做多尺度搜索，允许模板和目标截图尺度不同。
        # scale 的含义：模板缩放后参与匹配的倍率。
        scale_candidates = []
        min_scale = max(0.08, min(image_w / template_w, image_h / template_h) * 0.08)
        max_scale = min(16.0, max(image_w / template_w, image_h / template_h) * 2.5)
        if min_scale >= max_scale:
            min_scale = 0.08
            max_scale = 16.0

        steps = 48
        log_min = math.log(min_scale)
        log_max = math.log(max_scale)
        for i in range(steps + 1):
            scale = math.exp(log_min + (log_max - log_min) * (i / steps))
            scale_candidates.append(scale)
        if 1.0 not in scale_candidates:
            scale_candidates.append(1.0)
        scale_candidates = sorted(set(scale_candidates))

        best = None
        for scale in scale_candidates:
            scaled_w = max(1, round(template_w * scale))
            scaled_h = max(1, round(template_h * scale))
            if scaled_w > image_w or scaled_h > image_h:
                continue
            interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
            scaled_tpl = cv2.resize(tpl, (scaled_w, scaled_h), interpolation=interp)
            scaled_mask = None
            if mask is not None:
                scaled_mask = cv2.resize(mask, (scaled_w, scaled_h), interpolation=cv2.INTER_NEAREST)
            matched = cv2.matchTemplate(img, scaled_tpl, method, mask=scaled_mask) if scaled_mask is not None else cv2.matchTemplate(img, scaled_tpl, method)
            _, candidate_score, _, candidate_loc = cv2.minMaxLoc(matched)
            candidate_x, candidate_y = int(candidate_loc[0]), int(candidate_loc[1])
            candidate_center = (candidate_x + scaled_w / 2, candidate_y + scaled_h / 2)
            # 优先选择相似度高的候选；若相似度接近，则偏向更接近全图中心的候选，减少背景误命中。
            center_bias = 1.0 - min(1.0, ((candidate_center[0] - image_w / 2) ** 2 + (candidate_center[1] - image_h / 2) ** 2) ** 0.5 / max(image_w, image_h))
            rank = float(candidate_score) * 0.92 + center_bias * 0.08
            candidate = {
                "rank": rank,
                "score": float(candidate_score),
                "scale": scale,
                "x": candidate_x,
                "y": candidate_y,
                "tpl": scaled_tpl,
                "mask": scaled_mask,
            }
            if best is None or candidate["rank"] > best["rank"]:
                best = candidate
        if best is None:
            return fail("template", "无法在任意尺度下匹配模板")
        max_val = float(best["score"])
        match_scale = float(best["scale"])
        x = int(best["x"])
        y = int(best["y"])
        matched_tpl = best["tpl"]
        matched_mask = best["mask"]
    except Exception as exc:
        return fail("template", "匹配失败：{0}".format(exc))

    confidence = max(0.0, float(max_val))
    confidence_pct = round(min(100.0, confidence * 100.0), 1)
    w, h = int(matched_tpl.shape[1]), int(matched_tpl.shape[0])
    ok = confidence_pct >= threshold

    click_x, click_y = x + w // 2, y + h // 2
    # 热点和点击偏移都按“最终匹配倍率后的模板”计算。
    source = cfg.get("sourceRect") or {}
    hotspot = cfg.get("hotspot") or {}
    if isinstance(source, dict) and isinstance(hotspot, dict) \
            and source.get("x") is not None and source.get("y") is not None \
            and hotspot.get("x") is not None and hotspot.get("y") is not None:
        hotspot_width = max(0.0, float(hotspot.get("width", 0) or 0))
        hotspot_height = max(0.0, float(hotspot.get("height", 0) or 0))
        click_x = round(x + (float(hotspot.get("x", 0)) - float(source.get("x", 0)) + hotspot_width / 2) * match_scale)
        click_y = round(y + (float(hotspot.get("y", 0)) - float(source.get("y", 0)) + hotspot_height / 2) * match_scale)
    offset = cfg.get("clickOffset") or {}
    if isinstance(offset, dict) and offset.get("x") is not None:
        click_x += int(offset.get("x", 0) * match_scale)
        click_y += int(offset.get("y", 0) * match_scale)

    if debug_image_path:
        try:
            dbg = img.copy()
            cv2.rectangle(dbg, (x, y), (x + w, y + h), (0, 0, 255), 2)
            cv2.circle(dbg, (click_x, click_y), 6, (0, 255, 0), -1)
            cv2.line(dbg, (click_x - 12, click_y), (click_x + 12, click_y), (0, 255, 0), 2)
            cv2.line(dbg, (click_x, click_y - 12), (click_x, click_y + 12), (0, 255, 0), 2)
            label = "{0:.1f}% {1}".format(confidence_pct, "hit" if ok else "miss")
            cv2.putText(dbg, label, (max(0, x), max(0, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2, cv2.LINE_AA)
            cv2.imwrite(debug_image_path, dbg)
        except Exception:
            pass

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
        matchScale=match_scale,
        imageSize={"width": int(img.shape[1]), "height": int(img.shape[0])},
        templateSize={"width": int(tpl.shape[1]), "height": int(tpl.shape[0])},
        debugImagePath=debug_image_path,
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


def _windows():
    try:
        import Quartz
    except Exception:
        return []
    options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    return Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID) or []


def _window_info(win):
    import Quartz
    owner = str(win.get(Quartz.kCGWindowOwnerName, ""))
    name = str(win.get(Quartz.kCGWindowName, ""))
    bounds = win.get(Quartz.kCGWindowBounds, {}) or {}
    return {
        "id": int(win.get(Quartz.kCGWindowNumber, 0) or 0),
        "pid": win.get(Quartz.kCGWindowOwnerPID),
        "owner": owner,
        "name": name,
        "title": f"{owner} {name}".strip(),
        "x": float(bounds.get("X", 0)),
        "y": float(bounds.get("Y", 0)),
        "width": float(bounds.get("Width", 0)),
        "height": float(bounds.get("Height", 0)),
        "onscreen": bool(win.get("kCGWindowIsOnscreen", False)),
        "alpha": float(win.get("kCGWindowAlpha", 1.0)),
        "layer": int(win.get("kCGWindowLayer", 0)),
    }


def _window_info_by_id(window_id):
    """按 CGWindowNumber 精确定位窗口（与 desktopCapturer 截图同一窗口）"""
    if window_id is None:
        return None
    try:
        target = int(window_id)
    except (TypeError, ValueError):
        return None
    for win in _windows():
        num = win.get("kCGWindowNumber", 0) or 0
        if int(num) == target:
            return _window_info(win)
    return None


def _window_info_by_hint(hint: str):
    target = (hint or "").strip().lower()
    if not target:
        return None
    matches = [_window_info(win) for win in _windows()]
    matches = [
        item for item in matches
        if target in item["title"].lower() or target in item["name"].lower()
    ]
    if not matches:
        return None
    # 优先取不在后台被遮挡、面积最大的窗口
    matches.sort(key=lambda item: (item["onscreen"], item["layer"], item["width"] * item["height"]), reverse=True)
    return matches[0]


def _activate_window(info) -> bool:
    if not info or not info.get("pid"):
        return False
    pid = int(info["pid"])
    title = str(info.get("title") or info.get("name") or info.get("owner") or "")
    activated = False

    try:
        subprocess.run(
            [
                "/usr/bin/osascript",
                "-e",
                f'tell application "System Events" to set frontmost of (first process whose unix id is {pid}) to true',
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        activated = True
    except Exception:
        pass

    try:
        import AppKit
        app = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
        if app is not None:
            app.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
            activated = True
    except Exception:
        pass

    try:
        subprocess.run(
            [
                "/usr/bin/osascript",
                "-e",
                f'tell application "{title}" to activate',
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass

    return activated


def _display_bounds(display_id):
    """取指定显示器的 Quartz 全局坐标边界（与 CGEvent 点击同一坐标系）"""
    try:
        import Quartz
    except Exception:
        return None
    try:
        did = int(float(str(display_id)))
    except (TypeError, ValueError):
        did = Quartz.CGMainDisplayID()
    bounds = Quartz.CGDisplayBounds(did)
    return {
        "x": float(bounds.origin.x),
        "y": float(bounds.origin.y),
        "width": float(bounds.size.width),
        "height": float(bounds.size.height),
    }


def _mouse_down_up(x, y, button="left"):
    try:
        import Quartz
    except Exception:
        return False
    btn_map = {
        "left": Quartz.kCGMouseButtonLeft,
        "right": Quartz.kCGMouseButtonRight,
        "middle": Quartz.kCGMouseButtonCenter,
    }
    ev_down_map = {
        "left": Quartz.kCGEventLeftMouseDown,
        "right": Quartz.kCGEventRightMouseDown,
        "middle": Quartz.kCGEventOtherMouseDown,
    }
    ev_up_map = {
        "left": Quartz.kCGEventLeftMouseUp,
        "right": Quartz.kCGEventRightMouseUp,
        "middle": Quartz.kCGEventOtherMouseUp,
    }
    btn = btn_map.get(button, Quartz.kCGMouseButtonLeft)
    point = (float(x), float(y))
    try:
        Quartz.CGWarpMouseCursorPosition(point)
    except Exception:
        pass
    move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, point, btn)
    down = Quartz.CGEventCreateMouseEvent(None, ev_down_map.get(button, Quartz.kCGEventLeftMouseDown), point, btn)
    up = Quartz.CGEventCreateMouseEvent(None, ev_up_map.get(button, Quartz.kCGEventLeftMouseUp), point, btn)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    return True


def _mouse_position():
    try:
        import Quartz
    except Exception:
        return None
    pos = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
    return {"x": float(pos.x), "y": float(pos.y)}


def run_input(cfg):
    """键鼠输入：click / click_window / type / key / scroll / move（pyautogui）"""
    try:
        import pyautogui
    except Exception as exc:
        return fail("input", "无法加载 pyautogui，请先安装：pip install pyautogui")

    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = float(cfg.get("pause", 0.05))
    action = cfg.get("action", "")

    try:
        if action == "click_window":
            window_id = cfg.get("windowId")
            hint = str(cfg.get("windowHint", ""))
            # 优先按窗口 ID 精确定位（与截图同一窗口），再退回标题关键字
            matched_by = "id"
            info = _window_info_by_id(window_id)
            if not info:
                matched_by = "hint"
                info = _window_info_by_hint(hint)
            if not info:
                return fail("input", "未找到目标窗口或窗口不在前台可见状态")
            if window_id is not None and int(info.get("id", 0) or 0) != int(window_id):
                return fail("input", "窗口 ID 没有精确匹配到目标窗口")
            if not _activate_window(info):
                return fail("input", "无法激活目标窗口，请确认已授予辅助功能权限")
            time.sleep(0.4)
            x = cfg.get("x")
            y = cfg.get("y")
            if x is None or y is None:
                rel_x = max(0.0, min(1.0, float(cfg.get("relX", 0.5))))
                rel_y = max(0.0, min(1.0, float(cfg.get("relY", 0.5))))
                x = info["x"] + info["width"] * rel_x
                y = info["y"] + info["height"] * rel_y
            else:
                x = float(x)
                y = float(y)
                rel_x = (x - info["x"]) / info["width"] if info["width"] else 0.5
                rel_y = (y - info["y"]) / info["height"] if info["height"] else 0.5
            button = cfg.get("button", "left")
            clicks = int(cfg.get("clicks", 1))
            duration = float(cfg.get("duration", 0))
            # 输出坐标换算过程，方便排查坐标系是否错位
            try:
                size = pyautogui.size()
                screen_w, screen_h = int(size.width), int(size.height)
            except Exception:
                screen_w, screen_h = 0, 0
            emit(
                t="done", command="input", ok=True, action=action,
                window=info, matchedBy=matched_by, windowId=info["id"],
                rel={"x": rel_x, "y": rel_y},
                target={"x": x, "y": y},
                screenSize={"width": screen_w, "height": screen_h},
                message="窗口已激活并计算点击坐标",
            )
            if not _mouse_down_up(x, y, button=button):
                return fail("input", "Quartz 鼠标事件发送失败")
            # 回读鼠标实际落点，验证坐标系是否一致
            actual = _mouse_position()
            emit(
                t="done", command="input", ok=True, action=action,
                window=info, matchedBy=matched_by, windowId=info["id"],
                target={"x": x, "y": y}, actual=actual,
                message="点击完成，实际鼠标位置 {0}".format(actual),
            )
            return 0
        elif action == "click_screen":
            db = _display_bounds(cfg.get("displayId"))
            if not db or db["width"] <= 0 or db["height"] <= 0:
                return fail("input", "无法获取显示器边界，请确认屏幕录制权限已授权")
            x = cfg.get("x")
            y = cfg.get("y")
            if x is None or y is None:
                rel_x = float(cfg.get("relX", 0.5))
                rel_y = float(cfg.get("relY", 0.5))
                x = db["x"] + db["width"] * rel_x
                y = db["y"] + db["height"] * rel_y
            else:
                x = float(x)
                y = float(y)
            button = cfg.get("button", "left")
            clicks = int(cfg.get("clicks", 1))
            duration = float(cfg.get("duration", 0))
            emit(t="done", command="input", ok=True, action=action, display=db, target={"x": x, "y": y}, message="屏幕点击坐标已计算")
            # 工作流坐标来自 Quartz 截图，点击也直接使用 Quartz，避免 pyautogui
            # 在 Retina 屏幕上再次进行坐标缩放。
            if clicks < 1:
                return fail("input", "点击次数必须大于 0")
            for index in range(clicks):
                if not _mouse_down_up(x, y, button=button):
                    return fail("input", "Quartz 鼠标事件发送失败")
                if index + 1 < clicks:
                    time.sleep(0.05)
            actual = _mouse_position()
            emit(t="done", command="input", ok=True, action=action, display=db, target={"x": x, "y": y}, actual=actual, message="屏幕点击完成")
            return 0
        elif action == "click":
            x = float(cfg["x"]) if "x" in cfg else None
            y = float(cfg["y"]) if "y" in cfg else None
            button = cfg.get("button", "left")
            clicks = int(cfg.get("clicks", 1))
            duration = float(cfg.get("duration", 0))
            if x is not None and y is not None:
                if clicks < 1:
                    return fail("input", "点击次数必须大于 0")
                for index in range(clicks):
                    if not _mouse_down_up(x, y, button=button):
                        return fail("input", "Quartz 鼠标事件发送失败")
                    if index + 1 < clicks:
                        time.sleep(0.05)
            else:
                pyautogui.click(clicks=clicks, interval=0.05, button=button, duration=duration)
        elif action == "type":
            text = str(cfg.get("text", ""))
            interval = float(cfg.get("interval", 0.02))
            pyautogui.write(text, interval=interval)
        elif action == "key":
            keys = str(cfg.get("keys", ""))
            mode = cfg.get("mode", "tap")
            interval = max(0, float(cfg.get("interval", 0.2)))
            if not keys:
                return fail("input", "按键内容为空")
            if mode == "hold":
                pyautogui.keyDown(keys)
            elif mode == "release":
                pyautogui.keyUp(keys)
            elif mode == "type":
                # 连续输入：逐字符输入，{enter}、{tab} 等花括号写法表示特殊按键
                import re
                tokens = re.split(r"(\{[^}]+\})", keys)
                for token in tokens:
                    if not token:
                        continue
                    if token.startswith("{") and token.endswith("}"):
                        name = token[1:-1].strip().lower()
                        if name:
                            pyautogui.press(name)
                            if interval > 0:
                                time.sleep(interval / 1000.0)
                    else:
                        pyautogui.typewrite(token, interval=interval / 1000.0)
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
    except Exception:
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
