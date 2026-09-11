"""
ChiakiManager - 管理 Chiaki-ng 进程

功能：
1. 启动 Chiaki-ng 进程
2. 监控 Chiaki-ng 状态
3. 停止 Chiaki-ng 进程
"""

import subprocess
import os
import sys
import time
import signal
import threading
from typing import Optional, Callable
from pathlib import Path


class ChiakiManager:
    """管理 Chiaki-ng 进程"""
    
    def __init__(self):
        """初始化 ChiakiManager"""
        self.process: Optional[subprocess.Popen] = None
        self.is_running = False
        self.ps5_ip: Optional[str] = None
        self.ps5_port: int = 9295
        self.account_id: Optional[str] = None
        
        # 回调函数
        self.on_status_change: Optional[Callable[[str], None]] = None
        self.on_error: Optional[Callable[[str], None]] = None
        
        # 监控线程
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_monitor = False
        
    def find_chiaki_executable(self) -> Optional[str]:
        """
        查找 Chiaki-ng 可执行文件
        
        Returns:
            str: 可执行文件路径，未找到返回 None
        """
        # NoBoWo 内置路径（优先）
        base_dir = os.path.dirname(__file__)
        
        if sys.platform == 'darwin':
            # macOS
            possible_paths = [
                os.path.join(base_dir, '..', '..', 'bin', 'mac', 'chiaki'),
                '/Applications/Chiaki.app/Contents/MacOS/chiaki',
                '/usr/local/bin/chiaki',
                os.path.expanduser('~/Applications/Chiaki.app/Contents/MacOS/chiaki'),
            ]
        elif sys.platform == 'win32':
            # Windows
            possible_paths = [
                os.path.join(base_dir, '..', '..', 'bin', 'win', 'chiaki.exe'),
                r'C:\Program Files\Chiaki\chiaki.exe',
                r'C:\Program Files (x86)\Chiaki\chiaki.exe',
                os.path.expanduser(r'~\AppData\Local\Chiaki\chiaki.exe'),
            ]
        else:
            # Linux
            possible_paths = [
                os.path.join(base_dir, '..', '..', 'bin', 'linux', 'chiaki'),
                '/usr/bin/chiaki',
                '/usr/local/bin/chiaki',
                os.path.expanduser('~/.local/bin/chiaki'),
            ]
        
        for path in possible_paths:
            if os.path.exists(path):
                return path
        
        return None
    
    def connect(self, ps5_ip: str, ps5_port: int = 9295, account_id: Optional[str] = None) -> bool:
        """
        连接到 PS5
        
        Args:
            ps5_ip: PS5 IP 地址
            ps5_port: PS5 端口 (默认 9295)
            account_id: 账户 ID (可选)
            
        Returns:
            bool: 连接是否成功
        """
        if self.is_running:
            print("Chiaki-ng 已经在运行")
            return True
        
        # 查找 Chiaki-ng 可执行文件
        chiaki_path = self.find_chiaki_executable()
        if not chiaki_path:
            error_msg = "未找到 Chiaki-ng 可执行文件"
            print(error_msg)
            if self.on_error:
                self.on_error(error_msg)
            return False
        
        # 构建启动命令
        cmd = [chiaki_path]
        
        # 添加 PS5 连接参数
        if account_id:
            cmd.extend(['--ps5', ps5_ip, '--port', str(ps5_port), '--account', account_id])
        else:
            cmd.extend(['--ps5', ps5_ip, '--port', str(ps5_port)])
        
        try:
            # 启动 Chiaki-ng 进程
            if sys.platform == 'win32':
                # Windows: 隐藏窗口
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE
                self.process = subprocess.Popen(
                    cmd,
                    startupinfo=startupinfo,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
            else:
                # macOS/Linux
                self.process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
            
            self.ps5_ip = ps5_ip
            self.ps5_port = ps5_port
            self.account_id = account_id
            self.is_running = True
            
            # 启动监控线程
            self._stop_monitor = False
            self._monitor_thread = threading.Thread(target=self._monitor_process, daemon=True)
            self._monitor_thread.start()
            
            if self.on_status_change:
                self.on_status_change("connecting")
            
            print(f"Chiaki-ng 已启动 (PID: {self.process.pid})")
            return True
            
        except Exception as e:
            error_msg = f"启动 Chiaki-ng 失败: {e}"
            print(error_msg)
            if self.on_error:
                self.on_error(error_msg)
            return False
    
    def disconnect(self):
        """断开连接"""
        if not self.is_running or not self.process:
            return
        
        # 停止监控线程
        self._stop_monitor = True
        if self._monitor_thread:
            self._monitor_thread.join(timeout=2)
        
        try:
            # 发送终止信号
            if sys.platform == 'win32':
                self.process.terminate()
            else:
                self.process.send_signal(signal.SIGTERM)
            
            # 等待进程退出
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # 强制终止
                self.process.kill()
                self.process.wait()
            
            print("Chiaki-ng 已停止")
            
        except Exception as e:
            print(f"停止 Chiaki-ng 失败: {e}")
        
        finally:
            self.process = None
            self.is_running = False
            
            if self.on_status_change:
                self.on_status_change("disconnected")
    
    def _monitor_process(self):
        """监控 Chiaki-ng 进程状态"""
        while not self._stop_monitor and self.process:
            # 检查进程是否还在运行
            if self.process.poll() is not None:
                # 进程已退出
                exit_code = self.process.returncode
                print(f"Chiaki-ng 已退出 (退出码: {exit_code})")
                
                self.is_running = False
                
                if self.on_status_change:
                    if exit_code == 0:
                        self.on_status_change("disconnected")
                    else:
                        self.on_status_change("error")
                        if self.on_error:
                            self.on_error(f"Chiaki-ng 异常退出 (退出码: {exit_code})")
                
                break
            
            time.sleep(1)
    
    def get_status(self) -> str:
        """
        获取连接状态
        
        Returns:
            str: 状态字符串
        """
        if not self.is_running:
            return "disconnected"
        
        if self.process and self.process.poll() is not None:
            return "disconnected"
        
        return "connected"
    
    def wait_for_connection(self, timeout: int = 30) -> bool:
        """
        等待连接建立
        
        Args:
            timeout: 超时时间（秒）
            
        Returns:
            bool: 连接是否成功
        """
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            if not self.is_running:
                return False
            
            # 检查进程是否还在运行
            if self.process and self.process.poll() is not None:
                return False
            
            # 这里可以添加更精确的连接状态检测
            # 比如检查 Chiaki-ng 的输出或共享内存状态
            
            time.sleep(0.5)
        
        return True


# 测试代码
if __name__ == '__main__':
    manager = ChiakiManager()
    
    # 查找 Chiaki-ng
    chiaki_path = manager.find_chiaki_executable()
    if chiaki_path:
        print(f"找到 Chiaki-ng: {chiaki_path}")
    else:
        print("未找到 Chiaki-ng")
        sys.exit(1)
    
    # 测试连接
    ps5_ip = input("请输入 PS5 IP 地址: ")
    
    def on_status_change(status):
        print(f"状态变更: {status}")
    
    def on_error(error):
        print(f"错误: {error}")
    
    manager.on_status_change = on_status_change
    manager.on_error = on_error
    
    if manager.connect(ps5_ip):
        print("正在连接...")
        if manager.wait_for_connection(timeout=30):
            print("连接成功！")
            input("按回车键断开连接...")
        else:
            print("连接超时")
    else:
        print("连接失败")
    
    manager.disconnect()
    print("已断开连接")
