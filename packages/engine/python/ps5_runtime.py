"""
NoBoWo PS5 Remote Play runtime.

A long-lived JSON-lines sidecar that owns PS5 discovery, account lookup,
pairing, Remote Play sessions, decoded video frames, and protocol input.

Production mode uses pyremoteplay. NOBOWO_PS5_FAKE=1 enables a deterministic
local backend for UI and integration tests without a console.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import io
import json
import os
import socket
import struct
import sys
import threading
import time
import uuid
import zlib
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if _VENDOR_DIR.exists():
    sys.path.insert(0, str(_VENDOR_DIR))


APP_VERSION = "1.0.0"
DEFAULT_RESOLUTION = "720p"
DEFAULT_FPS = 60
DEFAULT_QUALITY = "high"


class RuntimeError2(Exception):
    pass


def _friendly_session_error(error: Any) -> str:
    text = str(error or "").strip()
    lowered = text.lower()
    if lowered in ("unknown", "unknown error type: 2148522751") or lowered.startswith("unknown error"):
        return (
            "PS5 拒绝 Remote Play 会话（Unknown）。请确认当前账号已在这台 PS5 上重新配对、"
            "PS5 已开启 Remote Play，并关闭其他 Remote Play 会话后重试。"
        )
    if "standby" in lowered:
        return "PS5 当前处于待机，已尝试唤醒；请等待主机完全启动后重试。"
    if "already in use" in lowered or "remote is already in use" in lowered:
        return (
            "PS5 已被其他 Remote Play 会话占用。请关闭其他串流项目、Remote Play 窗口或手机端连接，"
            "然后重新连接 NoBoWo。"
        )
    if "not reachable" in lowered:
        return "无法访问 PS5。请确认电脑与 PS5 在同一局域网，并关闭可能阻断 UDP/TCP 9295 的防火墙规则。"
    if "not registered" in lowered:
        return "当前账号尚未注册到这台 PS5，请重新执行配对并使用新的 8 位配对码。"
    return text or "PS5 Remote Play 会话启动失败"


def _now() -> int:
    return int(time.time() * 1000)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    return str(value)


def _normalize_account_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        raise RuntimeError2("Account ID 为空")
    if raw.isdigit():
        number = int(raw)
        if number >= 1 << 64:
            raise RuntimeError2("Account ID 数值超出 64 位范围")
        return base64.b64encode(number.to_bytes(8, "little")).decode("ascii")
    try:
        decoded = base64.b64decode(raw, validate=True)
        if len(decoded) != 8:
            raise ValueError()
        return base64.b64encode(decoded).decode("ascii")
    except Exception as exc:
        raise RuntimeError2("Account ID 必须是 19 位数字或 8 字节 Base64") from exc


def _lookup_account_id_from_redirect(redirect_url: str) -> Dict[str, str]:
    redirect_url = (redirect_url or "").strip()
    if not redirect_url:
        raise RuntimeError2("没有收到 PlayStation 登录回调地址")
    try:
        from pyremoteplay import oauth
        code = oauth._parse_redirect_url(redirect_url)
        if not code:
            raise RuntimeError2("PlayStation 登录回调无效或缺少授权码，请重新登录")
        token = oauth._get_token(code)
        if not token:
            raise RuntimeError2("PlayStation 没有返回访问令牌，授权码可能已过期或已被使用，请重新登录")
        account_info = oauth._fetch_account_info(token)
    except Exception as exc:
        if isinstance(exc, RuntimeError2):
            raise
        raise RuntimeError2(f"PlayStation 登录信息获取失败：{exc}") from exc
    if not account_info:
        raise RuntimeError2("PlayStation 登录成功但没有返回账号信息，请重新登录后重试")
    online_id = account_info.get("online_id") or account_info.get("onlineId") or ""
    account_id = account_info.get("user_rpid") or account_info.get("accountId") or account_info.get("account_id")
    if not account_id:
        raise RuntimeError2("PlayStation 账号信息中缺少 Account ID，请改用手动填写")
    return {
        "onlineId": str(online_id),
        "accountId": _normalize_account_id(str(account_id)),
        "source": "PlayStation OAuth",
    }


def _registration_from_result(result: Any, status: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    candidates: List[Dict[str, Any]] = []
    if isinstance(result, dict):
        candidates.append(result)
        for key in ("data", "result", "registration", "regist"):
            if isinstance(result.get(key), dict):
                candidates.append(result[key])
    for candidate in candidates:
        normalized = {str(k).lower().replace("_", "").replace("-", ""): v for k, v in candidate.items()}
        regist_key = None
        rp_key = None
        for key, value in normalized.items():
            if key.endswith("registkey") and value:
                regist_key = str(value)
            elif key.endswith("rpkey") and value:
                rp_key = str(value)
        if regist_key and rp_key:
            out = {"RegistKey": regist_key, "RP-Key": rp_key}
            host_status = status or {}
            host_id = normalized.get("hostid") or host_status.get("host-id")
            host_type = normalized.get("hosttype") or host_status.get("host-type") or "PS5"
            if host_id is not None:
                out["host-id"] = str(host_id)
            out["host-type"] = str(host_type)
            return out
    raise RuntimeError2("配对响应中缺少 RegistKey 或 RP-Key")


def _call_supported(func: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return func(*args, **kwargs)
    accepted = set(signature.parameters)
    has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values())
    filtered = kwargs if has_var_kw else {k: v for k, v in kwargs.items() if k in accepted}
    positional = list(args)
    while positional and len(positional) > len(signature.parameters):
        positional.pop()
    return func(*positional, **filtered)


class AccountStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.accounts_file = self.data_dir / "accounts.json"
        self.hosts_file = self.data_dir / "hosts.json"
        self.secrets_file = self.data_dir / "secrets.json"
        self._lock = threading.RLock()

    def _read(self, path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            return default

    def _write(self, path: Path, value: Any) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    def list_accounts(self) -> List[Dict[str, Any]]:
        with self._lock:
            value = self._read(self.accounts_file, [])
        return value if isinstance(value, list) else []

    def get_account(self, account_key: str) -> Dict[str, Any]:
        for account in self.list_accounts():
            if account.get("id") == account_key or account.get("accountId") == account_key:
                return account
        raise RuntimeError2("找不到 PS5 账号")

    def save_account(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        online_id = str(payload.get("onlineId") or "").strip()
        account_id = _normalize_account_id(str(payload.get("accountId") or ""))
        if not name:
            name = online_id or "PS5 账号"
        if not online_id:
            raise RuntimeError2("请填写 PSN Online ID")
        with self._lock:
            accounts = self.list_accounts()
            account_id_key = str(payload.get("id") or "")
            existing = next((a for a in accounts if a.get("id") == account_id_key or a.get("accountId") == account_id), None)
            now = _now()
            account = dict(existing or {})
            account.update({
                "id": account.get("id") or str(uuid.uuid4()),
                "name": name,
                "onlineId": online_id,
                "accountId": account_id,
                "accountIdSource": str(payload.get("accountIdSource") or "manual"),
                "createdAt": account.get("createdAt") or now,
                "updatedAt": now,
            })
            accounts = [a for a in accounts if a.get("id") != account["id"] and a.get("accountId") != account_id]
            accounts.append(account)
            self._write(self.accounts_file, accounts)
        return account

    def remove_account(self, account_key: str) -> None:
        with self._lock:
            accounts = self.list_accounts()
            account = next((a for a in accounts if a.get("id") == account_key or a.get("accountId") == account_key), None)
            if not account:
                return
            accounts = [a for a in accounts if a.get("id") != account.get("id")]
            self._write(self.accounts_file, accounts)
            hosts = self._read(self.hosts_file, {})
            if isinstance(hosts, dict):
                hosts = {k: v for k, v in hosts.items() if v.get("accountId") != account.get("accountId")}
                self._write(self.hosts_file, hosts)
            secrets = self._read(self.secrets_file, {})
            if isinstance(secrets, dict):
                secrets.pop(str(account.get("id")), None)
                secrets.pop(str(account.get("accountId")), None)
                self._write(self.secrets_file, secrets)

    def _host_key(self, host: str, account_id: str) -> str:
        return hashlib.sha256(f"{host}|{account_id}".encode("utf-8")).hexdigest()

    def save_registration(self, host: str, account_id: str, registration: Dict[str, str]) -> None:
        key = self._host_key(host, account_id)
        with self._lock:
            hosts = self._read(self.hosts_file, {})
            if not isinstance(hosts, dict):
                hosts = {}
            hosts[key] = {
                "host": host,
                "accountId": account_id,
                "registration": registration,
                "updatedAt": _now(),
            }
            self._write(self.hosts_file, hosts)

    def get_registration(self, host: str, account_id: str) -> Dict[str, str]:
        key = self._host_key(host, account_id)
        with self._lock:
            hosts = self._read(self.hosts_file, {})
        record = hosts.get(key) if isinstance(hosts, dict) else None
        if not record or not record.get("registration"):
            raise RuntimeError2("该主机尚未与当前账号配对")
        return dict(record["registration"])

    def list_hosts(self) -> List[Dict[str, Any]]:
        with self._lock:
            hosts = self._read(self.hosts_file, {})
        if not isinstance(hosts, dict):
            return []
        return sorted(hosts.values(), key=lambda item: item.get("updatedAt", 0), reverse=True)


def _parse_ddp_message(raw: bytes) -> Dict[str, str]:
    text = raw.decode("utf-8", errors="replace")
    lines = text.replace("\r\n", "\n").split("\n")
    result: Dict[str, str] = {"raw": text}
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        result[key.strip().lower()] = value.strip()
    return result


def _ddp_test_host(host: str, timeout: float = 1.5) -> Dict[str, Any]:
    message = b"GET /?proto=ddp HTTP/1.1\r\ndevice-discovery-protocol-version:00030010\r\n\r\n"
    started = time.monotonic()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        last_error = None
        raw = None
        for port in (9302, 987):
            try:
                sock.sendto(message, (host, port))
                raw, _addr = sock.recvfrom(4096)
                break
            except socket.timeout as exc:
                last_error = exc
        if raw is None:
            raise RuntimeError2(f"主机 {host} DDP 状态请求超时") from last_error
    parsed = _parse_ddp_message(raw)
    return {
        "host": host,
        "status": parsed.get("status-code") or parsed.get("status") or "ready",
        "online": parsed.get("status-code", "200") != "641",
        "latencyMs": int((time.monotonic() - started) * 1000),
    }


def _ddp_discover(timeout: float = 2.0) -> List[Dict[str, Any]]:
    message = b"SRCH * HTTP/1.1\r\ndevice-discovery-protocol-version:00030010\r\n\r\n"
    found: Dict[str, Dict[str, Any]] = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.25)
        for port in (987, 9302):
            sock.sendto(message, ("255.255.255.255", port))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                raw, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            parsed = _parse_ddp_message(raw)
            host = parsed.get("host-ip") or addr[0]
            found[host] = {
                "host": host,
                "hostId": parsed.get("host-id"),
                "hostType": parsed.get("host-type", "PS5"),
                "name": parsed.get("host-name") or parsed.get("running-app-name") or host,
                "status": parsed.get("status-code") or parsed.get("status"),
                "macAddress": parsed.get("mac-address"),
                "systemVersion": parsed.get("system-version"),
            }
    return list(found.values())


class PyRemotePlayBackend:
    def __init__(self, store: AccountStore):
        self.store = store
        self._lock = threading.RLock()
        self._session = None
        self._receiver = None
        self._controller = None
        self._loop = None
        self._thread = None
        self._connected_host = None
        self._connected_account = None

    def _modules(self):
        try:
            from pyremoteplay.const import FPS, Quality, Resolution
            from pyremoteplay.controller import Controller
            from pyremoteplay.ddp import get_status as ddp_get_status
            from pyremoteplay.ddp import search as ddp_search
            from pyremoteplay.profile import UserProfile
            from pyremoteplay.receiver import QueueReceiver
            from pyremoteplay.register import register as rp_register
            from pyremoteplay.session import Session
        except Exception as exc:
            raise RuntimeError2(
                "缺少 pyremoteplay 运行依赖，请执行：python3 -m pip install -r packages/engine/python/requirements-ps5.txt"
            ) from exc
        return {
            "Resolution": Resolution,
            "FPS": FPS,
            "Quality": Quality,
            "Controller": Controller,
            "ddp_get_status": ddp_get_status,
            "ddp_search": ddp_search,
            "UserProfile": UserProfile,
            "QueueReceiver": QueueReceiver,
            "rp_register": rp_register,
            "Session": Session,
        }

    @staticmethod
    def _device_from_status(status: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "host": status.get("host-ip"),
            "hostId": status.get("host-id"),
            "hostType": status.get("host-type", "PS5"),
            "name": status.get("host-name"),
            "status": str(status.get("status-code", "")),
            "macAddress": status.get("host-id"),
            "systemVersion": status.get("system-version"),
        }

    def discover(self, timeout: float = 2.5) -> List[Dict[str, Any]]:
        modules = self._modules()
        statuses = modules["ddp_search"](host_type="PS5", timeout=max(1, int(round(timeout))))
        return [self._device_from_status(status) for status in statuses or [] if status.get("host-ip")]

    def test_host(self, host: str) -> Dict[str, Any]:
        started = time.monotonic()
        modules = self._modules()
        status = modules["ddp_get_status"](host, host_type="PS5")
        if not status:
            raise RuntimeError2(f"主机 {host} 未响应 PS5 DDP 状态请求")
        return {
            "host": host,
            "status": str(status.get("status-code", "unknown")),
            "online": status.get("status-code") == 200,
            "latencyMs": int((time.monotonic() - started) * 1000),
        }

    def pair(self, host: str, account_id: str, pin: str) -> Dict[str, Any]:
        if not host:
            raise RuntimeError2("请填写或选择 PS5 主机地址")
        if not str(pin).isdigit() or len(str(pin)) != 8:
            raise RuntimeError2("配对码必须是 8 位数字")
        normalized_id = _normalize_account_id(account_id)
        modules = self._modules()
        status = modules["ddp_get_status"](host, host_type="PS5")
        if not status:
            raise RuntimeError2(f"主机 {host} 不可达，无法配对")
        result = modules["rp_register"](host, normalized_id, str(pin), timeout=5.0)
        registration = _registration_from_result(result, status)
        registration.setdefault("host-id", status.get("host-id") or host)
        registration.setdefault("host-type", status.get("host-type") or "PS5")
        self.store.save_registration(host, normalized_id, registration)
        return {"host": host, "accountId": normalized_id, "registration": registration}

    def connect(self, host: str, account_key: str, resolution: str = DEFAULT_RESOLUTION,
                fps: int = DEFAULT_FPS, quality: str = DEFAULT_QUALITY) -> Dict[str, Any]:
        with self._lock:
            if self._session is not None:
                return self.status()
            account = self.store.get_account(account_key)
            registration = self.store.get_registration(host, account["accountId"])
            try:
                regist_key = str(registration["RegistKey"]).strip()
                rp_key_text = str(registration["RP-Key"]).strip()
                rp_key = bytes.fromhex(rp_key_text)
            except (KeyError, TypeError, ValueError) as exc:
                raise RuntimeError2("PS5 配对信息格式无效，请重新配对") from exc
            if not regist_key or len(rp_key) != 16:
                raise RuntimeError2("PS5 配对信息格式无效，请重新配对")
            modules = self._modules()
            status = modules["ddp_get_status"](host, host_type="PS5")
            if not status:
                raise RuntimeError2(f"主机 {host} 不可达")
            host_id = registration.get("host-id") or status.get("host-id") or host
            host_type = registration.get("host-type") or status.get("host-type") or "PS5"
            host_keys = []
            for candidate in (registration.get("host-id"), status.get("host-id"), host):
                candidate = str(candidate or "").strip()
                if candidate and candidate not in host_keys:
                    host_keys.append(candidate)
            profile_data = {
                "id": account["accountId"],
                "hosts": {
                    candidate: {
                        "type": host_type,
                        "data": {"RegistKey": regist_key, "RP-Key": rp_key_text},
                    }
                    for candidate in host_keys
                },
            }
            profile = modules["UserProfile"](account["name"], profile_data)
            receiver = modules["QueueReceiver"](max_frames=4, max_video_frames=2, max_audio_frames=0)
            loop = asyncio.new_event_loop()
            session = modules["Session"](
                host,
                profile,
                loop=loop,
                receiver=receiver,
                resolution=resolution,
                fps=fps,
                quality=quality,
                codec="h264",
                hdr=False,
            )
            controller = modules["Controller"]()
            controller.connect(session)
            ready = threading.Event()
            errors: List[str] = []

            def run_loop() -> None:
                asyncio.set_event_loop(loop)

                async def boot() -> None:
                    started = await session.start(wakeup=True, autostart=True)
                    if not started and "Standby" in str(getattr(session, "error", "")):
                        await asyncio.sleep(3.0)
                        started = await session.start(wakeup=True, autostart=True)
                    if not started:
                        raise RuntimeError2(_friendly_session_error(getattr(session, "error", "")))
                    if not await session.async_wait(10.0):
                        raise RuntimeError2(_friendly_session_error(getattr(session, "error", "") or "PS5 视频会话等待超时"))

                try:
                    loop.run_until_complete(boot())
                    ready.set()
                    loop.run_forever()
                except Exception as exc:
                    errors.append(str(exc))
                    ready.set()
                finally:
                    try:
                        controller.stop()
                    except Exception:
                        pass
                    try:
                        session.stop()
                    except Exception:
                        pass
                    try:
                        loop.close()
                    except Exception:
                        pass

            thread = threading.Thread(target=run_loop, name="nobowo-ps5-session", daemon=True)
            self._session = session
            self._receiver = receiver
            self._controller = controller
            self._loop = loop
            self._thread = thread
            self._connected_host = host
            self._connected_account = account
            thread.start()
            if not ready.wait(18.0):
                self.disconnect()
                raise RuntimeError2("PS5 会话启动超时")
            if errors or not session.is_ready:
                message = _friendly_session_error(errors[0] if errors else getattr(session, "error", "") or "PS5 会话未就绪")
                self.disconnect()
                raise RuntimeError2(message)
            controller.start()
            return self.status()

    def disconnect(self) -> Dict[str, Any]:
        with self._lock:
            controller = self._controller
            session = self._session
            receiver = self._receiver
            loop = self._loop
            thread = self._thread
            self._controller = None
            self._session = None
            self._receiver = None
            self._loop = None
            self._thread = None
            self._connected_host = None
            self._connected_account = None
        if controller is not None:
            try:
                controller.stop()
                controller.disconnect()
            except Exception:
                pass
        if session is not None:
            try:
                session.stop()
            except Exception:
                pass
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=3.0)
        if receiver is not None:
            try:
                receiver.close()
            except Exception:
                pass
        return {"connected": False}

    def status(self) -> Dict[str, Any]:
        session = self._session
        connected = bool(session and session.is_running and not session.is_stopped)
        return {
            "connected": connected,
            "host": self._connected_host,
            "accountId": (self._connected_account or {}).get("accountId"),
            "state": str(getattr(session, "state", "STOP" if not session else "RUNNING")),
            "ready": bool(getattr(session, "is_ready", connected)),
            "frameCount": len(getattr(self._receiver, "video_frames", []) or []),
        }

    def get_frame(self) -> Dict[str, Any]:
        receiver = self._receiver
        frame = receiver.get_latest_video_frame() if receiver is not None else None
        if frame is None:
            raise RuntimeError2("PS5 串流尚未产生视频帧")
        image_bytes = None
        try:
            import cv2
            rgb = frame.to_ndarray(format="rgb24")
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            ok, encoded = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
            if ok:
                image_bytes = encoded.tobytes()
        except Exception:
            pass
        if image_bytes is None:
            try:
                image = frame.to_image()
                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=82)
                image_bytes = buffer.getvalue()
            except Exception as exc:
                raise RuntimeError2(f"视频帧编码失败：{exc}") from exc
        return {
            "frame": "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode("ascii"),
            "width": int(getattr(frame, "width", 0) or 0),
            "height": int(getattr(frame, "height", 0) or 0),
            "timestamp": _now(),
        }

    def send_key(self, key: str, down: bool) -> Dict[str, Any]:
        controller = self._controller
        if not controller:
            raise RuntimeError2("PS5 尚未连接")
        normalized_key = key.lower()
        if normalized_key in STICK_KEYS:
            stick, x, y = STICK_KEYS[normalized_key]
            if not down:
                x, y = 0.0, 0.0
            controller.stick(stick, point=(x, y))
            controller.update_sticks()
            return {"key": key, "button": f"stick:{stick}", "down": down}
        button = KEY_TO_BUTTON.get(normalized_key)
        if not button:
            raise RuntimeError2(f"未映射的键盘按键：{key}")
        controller.button(button, "press" if down else "release")
        return {"key": key, "button": button, "down": down}

    def send_button(self, action: str, pressed: Optional[bool] = None, duration_ms: int = 0) -> Dict[str, Any]:
        controller = self._controller
        if not controller:
            raise RuntimeError2("PS5 尚未连接")
        if action in GAMEPAD_STICKS:
            stick, x, y = GAMEPAD_STICKS[action]
            if pressed is None:
                controller.stick(stick, point=(x, y))
                controller.update_sticks()
                hold_ms = max(80, min(int(duration_ms or 120), 2000))
                time.sleep(hold_ms / 1000.0)
                controller.stick(stick, point=(0.0, 0.0))
                controller.update_sticks()
                return {"action": action, "button": f"stick:{stick}", "pressed": pressed, "durationMs": hold_ms}
            controller.stick(stick, point=(x, y) if pressed else (0.0, 0.0))
            controller.update_sticks()
            return {"action": action, "button": f"stick:{stick}", "pressed": pressed, "durationMs": 0}
        button = GAMEPAD_TO_BUTTON.get(action) or action.lower()
        if pressed is None:
            hold_ms = max(80, min(int(duration_ms or 120), 2000))
            controller.button(button, "tap", delay=hold_ms / 1000.0)
            return {"action": action, "button": button, "pressed": pressed, "durationMs": hold_ms}
        elif pressed:
            controller.button(button, "press")
            if duration_ms > 0:
                time.sleep(min(duration_ms, 2000) / 1000.0)
                controller.button(button, "release")
        else:
            controller.button(button, "release")
        return {"action": action, "button": button, "pressed": pressed, "durationMs": duration_ms}

    def set_stick(self, stick: str, x: float, y: float) -> Dict[str, Any]:
        controller = self._controller
        if not controller:
            raise RuntimeError2("PS5 尚未连接")
        if stick not in ("left", "right"):
            raise RuntimeError2("摇杆只能是 left 或 right")
        controller.stick(stick, point=(float(x), float(y)))
        controller.update_sticks()
        return {"stick": stick, "x": x, "y": y}


KEY_TO_BUTTON = {
    "1": "cross", "2": "circle", "3": "triangle", "4": "square",
    "shift": "l1", "control": "r1", "alt": "l2", "meta": "r2",
    "home": "ps", "insert": "share", "delete": "options",
}
STICK_KEYS = {
    "w": ("left", 0.0, -1.0),
    "a": ("left", -1.0, 0.0),
    "s": ("left", 0.0, 1.0),
    "d": ("left", 1.0, 0.0),
    "arrowup": ("right", 0.0, -1.0),
    "arrowleft": ("right", -1.0, 0.0),
    "arrowdown": ("right", 0.0, 1.0),
    "arrowright": ("right", 1.0, 0.0),
}
GAMEPAD_STICKS = {
    "pressLU": ("left", 0.0, -1.0),
    "pressLD": ("left", 0.0, 1.0),
    "pressLL": ("left", -1.0, 0.0),
    "pressLR": ("left", 1.0, 0.0),
    "pressRU": ("right", 0.0, -1.0),
    "pressRD": ("right", 0.0, 1.0),
    "pressRL": ("right", -1.0, 0.0),
    "pressRR": ("right", 1.0, 0.0),
}
GAMEPAD_TO_BUTTON = {
    "pressCross": "cross", "pressCircle": "circle", "pressTriangle": "triangle", "pressSquare": "square",
    "pressL1": "l1", "pressR1": "r1", "pressL2": "l2", "pressR2": "r2",
    "pressShare": "share", "pressOptions": "options", "pressPS": "ps",
    "pressDPADU": "dpad_up", "pressDPADD": "dpad_down",
    "pressDPADL": "dpad_left", "pressDPADR": "dpad_right",
    # 旧工作流兼容映射
    "pressA": "cross", "pressB": "circle", "pressX": "square", "pressY": "triangle",
    "pressLB": "l1", "pressRB": "r1", "pressLT": "l2", "pressRT": "r2",
    "pressBACK": "share", "pressSTART": "options", "pressHOME": "ps",
}


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _fake_png(width: int = 640, height: int = 360) -> bytes:
    phase = int(time.time() * 2) % 255
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(((x * 255 // max(1, width - 1)) & 255,
                         (y * 255 // max(1, height - 1)) & 255,
                         (phase + (x + y) // 4) & 255))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", header) + _png_chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + _png_chunk(b"IEND", b"")


class FakeBackend:
    def __init__(self, store: AccountStore):
        self.store = store
        self.connected = False
        self.host = None
        self.account = None
        self.frame_count = 0
        self.controller_buttons: List[Dict[str, Any]] = []

    def discover(self, timeout: float = 2.5):
        return [
            {"host": "192.168.1.50", "hostId": "PS5-FAKE-001", "hostType": "PS5", "name": "客厅 PS5", "status": "ready", "systemVersion": "fake"},
            {"host": "192.168.1.51", "hostId": "PS5-FAKE-002", "hostType": "PS5", "name": "书房 PS5", "status": "standby", "systemVersion": "fake"},
        ]

    def test_host(self, host: str):
        if not host:
            raise RuntimeError2("主机地址为空")
        return {"host": host, "status": "ready", "online": True, "latencyMs": 12}

    def pair(self, host: str, account_id: str, pin: str):
        if not str(pin).isdigit() or len(str(pin)) != 8:
            raise RuntimeError2("配对码必须是 8 位数字")
        normalized = _normalize_account_id(account_id)
        registration = {"RegistKey": "fake-regist-key", "RP-Key": "fake-rp-key", "host-id": host, "host-type": "PS5"}
        self.store.save_registration(host, normalized, registration)
        return {"host": host, "accountId": normalized, "registration": registration}

    def connect(self, host: str, account_key: str, resolution: str = DEFAULT_RESOLUTION, fps: int = DEFAULT_FPS, quality: str = DEFAULT_QUALITY):
        self.account = self.store.get_account(account_key)
        self.store.get_registration(host, self.account["accountId"])
        self.connected = True
        self.host = host
        return self.status()

    def disconnect(self):
        self.connected = False
        self.host = None
        self.account = None
        return {"connected": False}

    def status(self):
        return {"connected": self.connected, "host": self.host, "accountId": (self.account or {}).get("accountId"), "state": "RUNNING" if self.connected else "STOP", "ready": self.connected, "frameCount": self.frame_count}

    def get_frame(self):
        if not self.connected:
            raise RuntimeError2("PS5 尚未连接")
        self.frame_count += 1
        return {"frame": "data:image/png;base64," + base64.b64encode(_fake_png()).decode("ascii"), "width": 640, "height": 360, "timestamp": _now()}

    def send_key(self, key: str, down: bool):
        if not self.connected:
            raise RuntimeError2("PS5 尚未连接")
        normalized_key = key.lower()
        if normalized_key in STICK_KEYS:
            stick, x, y = STICK_KEYS[normalized_key]
            if not down:
                x, y = 0.0, 0.0
            self.controller_buttons.append({"type": "stick", "stick": stick, "x": x, "y": y, "fromKey": key})
            return {"key": key, "button": f"stick:{stick}", "down": down}
        button = KEY_TO_BUTTON.get(normalized_key)
        if not button:
            raise RuntimeError2(f"未映射的键盘按键：{key}")
        self.controller_buttons.append({"type": "key", "key": key, "button": button, "down": down})
        return {"key": key, "button": button, "down": down}

    def send_button(self, action: str, pressed: Optional[bool] = None, duration_ms: int = 0):
        if not self.connected:
            raise RuntimeError2("PS5 尚未连接")
        if action in GAMEPAD_STICKS:
            stick, x, y = GAMEPAD_STICKS[action]
            point = (x, y) if pressed is not False else (0.0, 0.0)
            self.controller_buttons.append({
                "type": "stick",
                "stick": stick,
                "x": point[0],
                "y": point[1],
                "pressed": pressed,
                "durationMs": duration_ms,
            })
            return {"action": action, "button": f"stick:{stick}", "pressed": pressed}
        button = GAMEPAD_TO_BUTTON.get(action) or action.lower()
        self.controller_buttons.append({"type": "button", "action": action, "button": button, "pressed": pressed, "durationMs": duration_ms})
        return {"action": action, "button": button, "pressed": pressed}

    def set_stick(self, stick: str, x: float, y: float):
        if not self.connected:
            raise RuntimeError2("PS5 尚未连接")
        self.controller_buttons.append({"type": "stick", "stick": stick, "x": x, "y": y})
        return {"stick": stick, "x": x, "y": y}


class RuntimeService:
    def __init__(self, data_dir: Path, fake: bool = False):
        self.store = AccountStore(data_dir)
        self.backend = FakeBackend(self.store) if fake else PyRemotePlayBackend(self.store)

    def dispatch(self, method: str, params: Dict[str, Any]) -> Any:
        if method == "status":
            return {"version": APP_VERSION, "fake": isinstance(self.backend, FakeBackend), **self.backend.status()}
        if method == "discover":
            return {"devices": self.backend.discover(float(params.get("timeout", 2.5)))}
        if method == "getPsnLoginUrl":
            if isinstance(self.backend, FakeBackend):
                return {"url": "https://example.invalid/psn-login?fake=1"}
            from pyremoteplay.oauth import get_login_url
            return {"url": get_login_url()}
        if method == "lookupAccountIdFromRedirect":
            if isinstance(self.backend, FakeBackend):
                digest = hashlib.sha256(str(params.get("redirectUrl") or "").encode("utf-8")).digest()[:8]
                return {"onlineId": "FakePsnUser", "accountId": base64.b64encode(digest).decode("ascii"), "source": "fake"}
            return _lookup_account_id_from_redirect(str(params.get("redirectUrl") or ""))
        if method == "listAccounts":
            return {"accounts": self.store.list_accounts()}
        if method == "saveAccount":
            return {"account": self.store.save_account(params)}
        if method == "removeAccount":
            self.store.remove_account(str(params.get("id") or params.get("accountId") or ""))
            return {"ok": True}
        if method == "listHosts":
            return {"hosts": self.store.list_hosts()}
        if method == "testHost":
            return self.backend.test_host(str(params.get("host") or ""))
        if method == "pair":
            return self.backend.pair(str(params.get("host") or ""), str(params.get("accountId") or ""), str(params.get("pin") or ""))
        if method == "connect":
            return self.backend.connect(
                str(params.get("host") or ""),
                str(params.get("accountId") or params.get("accountKey") or ""),
                str(params.get("resolution") or DEFAULT_RESOLUTION),
                int(params.get("fps") or DEFAULT_FPS),
                str(params.get("quality") or DEFAULT_QUALITY),
            )
        if method == "disconnect":
            return self.backend.disconnect()
        if method == "getFrame":
            return self.backend.get_frame()
        if method == "sendKey":
            return self.backend.send_key(str(params.get("key") or ""), bool(params.get("down", True)))
        if method == "sendButton":
            return self.backend.send_button(str(params.get("action") or ""), params.get("pressed"), int(params.get("durationMs") or 0))
        if method == "setStick":
            return self.backend.set_stick(str(params.get("stick") or "left"), float(params.get("x") or 0), float(params.get("y") or 0))
        raise RuntimeError2(f"未知命令：{method}")


def serve(data_dir: Path) -> int:
    fake = os.environ.get("NOBOWO_PS5_FAKE", "").lower() in ("1", "true", "yes")
    service = RuntimeService(data_dir, fake=fake)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = str(request.get("method") or "")
            params = request.get("params") or {}
            if not isinstance(params, dict):
                params = {}
            result = service.dispatch(method, params)
            response = {"id": request_id, "ok": True, "result": _json_safe(result)}
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


def main(argv: List[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: ps5_runtime.py serve [data_dir]"}, ensure_ascii=False))
        return 2
    command = argv[1]
    data_dir = Path(argv[2] if len(argv) > 2 else os.environ.get("NOBOWO_PS5_DATA_DIR", "./ps5_data"))
    if command == "serve":
        return serve(data_dir)
    if command == "check":
        fake = os.environ.get("NOBOWO_PS5_FAKE", "").lower() in ("1", "true", "yes")
        try:
            if not fake:
                import pyremoteplay  # noqa: F401
                import av  # noqa: F401
            print(json.dumps({
                "ok": True,
                "version": APP_VERSION,
                "fake": fake,
                "remotePlayAvailable": fake or not globals().get("_missing_remoteplay", False),
            }, ensure_ascii=False))
            return 0
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
            return 1
    print(json.dumps({"ok": False, "error": f"unknown command: {command}"}, ensure_ascii=False))
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
