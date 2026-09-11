"""
SharedMemoryGamepad - 通过共享内存发送手柄按键

共享内存结构：
- 控制信号 (1 byte): 0=空闲, 1=有新按键, 2=停止
- 按键状态 (32 bytes): 每个按键一个字节，0=松开, 1=按下
- 摇杆状态 (16 bytes): 左摇杆X/Y, 右摇杆X/Y, 各4字节float
- 触发器状态 (8 bytes): L2/R2, 各4字节float
"""

import mmap
import struct
import os
import sys
import time
from typing import Optional, Dict, Tuple

# 共享内存大小
SHM_SIZE = 1 + 32 + 16 + 8  # 57 bytes

# 按键索引映射
BUTTON_INDEX = {
    'cross': 0,      # A/X
    'circle': 1,     # B/O
    'square': 2,     # X/□
    'triangle': 3,   # Y/△
    'l1': 4,         # LB
    'r1': 5,         # RB
    'l2': 6,         # LT
    'r2': 7,         # RT
    'share': 8,      # BACK/Share
    'options': 9,    # START/Options
    'ps': 10,        # HOME/PS
    'l3': 11,        # 左摇杆按下
    'r3': 12,        # 右摇杆按下
    'dpad_up': 13,
    'dpad_down': 14,
    'dpad_left': 15,
    'dpad_right': 16,
    'touchpad': 17,
    'mute': 18,
}

# NoBoWo 手柄按键到 Chiaki 按键的映射
GAMEPAD_MAP = {
    'pressA': 'cross',
    'pressB': 'circle',
    'pressX': 'square',
    'pressY': 'triangle',
    'pressLB': 'l1',
    'pressRB': 'r1',
    'pressLT': 'l2',
    'pressRT': 'r2',
    'pressBACK': 'share',
    'pressSTART': 'options',
    'pressHOME': 'ps',
    'pressDPADU': 'dpad_up',
    'pressDPADD': 'dpad_down',
    'pressDPADL': 'dpad_left',
    'pressDPADR': 'dpad_right',
}

# 摇杆映射
STICK_MAP = {
    'pressLU': ('left_y', -1.0),
    'pressLD': ('left_y', 1.0),
    'pressLL': ('left_x', -1.0),
    'pressLR': ('left_x', 1.0),
}


class SharedMemoryGamepad:
    """通过共享内存发送手柄按键"""
    
    def __init__(self, shm_name: str = 'nobowo_gamepad'):
        """
        初始化共享内存手柄
        
        Args:
            shm_name: 共享内存名称
        """
        self.shm_name = shm_name
        self.shm: Optional[mmap.mmap] = None
        self.is_connected = False
        
        # 按键状态
        self.buttons = [0] * 19
        self.left_x = 0.0
        self.left_y = 0.0
        self.right_x = 0.0
        self.right_y = 0.0
        self.l2_value = 0.0
        self.r2_value = 0.0
        
    def connect(self) -> bool:
        """
        连接到共享内存
        
        Returns:
            bool: 连接是否成功
        """
        try:
            if sys.platform == 'darwin':
                # macOS: 使用文件映射
                shm_path = f'/tmp/{self.shm_name}'
                # 创建或打开共享内存文件
                if not os.path.exists(shm_path):
                    with open(shm_path, 'wb') as f:
                        f.write(b'\x00' * SHM_SIZE)
                self.shm_fd = os.open(shm_path, os.O_RDWR)
                self.shm = mmap.mmap(self.shm_fd, SHM_SIZE)
            elif sys.platform == 'win32':
                # Windows: 使用命名共享内存
                self.shm = mmap.mmap(-1, SHM_SIZE, tagname=self.shm_name)
            else:
                # Linux: 使用POSIX共享内存
                shm_path = f'/dev/shm/{self.shm_name}'
                if not os.path.exists(shm_path):
                    with open(shm_path, 'wb') as f:
                        f.write(b'\x00' * SHM_SIZE)
                self.shm_fd = os.open(shm_path, os.O_RDWR)
                self.shm = mmap.mmap(self.shm_fd, SHM_SIZE)
            
            self.is_connected = True
            return True
        except Exception as e:
            print(f"连接共享内存失败: {e}")
            return False
    
    def disconnect(self):
        """断开共享内存连接"""
        if self.shm:
            self.shm.close()
            self.shm = None
        if hasattr(self, 'shm_fd'):
            os.close(self.shm_fd)
        self.is_connected = False
    
    def _write_state(self):
        """写入手柄状态到共享内存"""
        if not self.shm or not self.is_connected:
            return
        
        try:
            # 写入控制信号
            self.shm[0] = 1  # 有新按键
            
            # 写入按键状态
            for i, state in enumerate(self.buttons):
                self.shm[1 + i] = state
            
            # 写入摇杆状态
            offset = 33
            struct.pack_into('f', self.shm, offset, self.left_x)
            struct.pack_into('f', self.shm, offset + 4, self.left_y)
            struct.pack_into('f', self.shm, offset + 8, self.right_x)
            struct.pack_into('f', self.shm, offset + 12, self.right_y)
            
            # 写入触发器状态
            offset = 49
            struct.pack_into('f', self.shm, offset, self.l2_value)
            struct.pack_into('f', self.shm, offset + 4, self.r2_value)
            
        except Exception as e:
            print(f"写入共享内存失败: {e}")
    
    def press_button(self, button_name: str, duration_ms: int = 0):
        """
        按下按钮
        
        Args:
            button_name: 按钮名称 (如 'pressA', 'pressB')
            duration_ms: 按下持续时间（毫秒），0表示瞬间按下
        """
        if not self.is_connected:
            return
        
        # 映射到Chiaki按钮
        chiaki_button = GAMEPAD_MAP.get(button_name)
        if not chiaki_button:
            return
        
        button_index = BUTTON_INDEX.get(chiaki_button)
        if button_index is None:
            return
        
        # 按下按钮
        self.buttons[button_index] = 1
        self._write_state()
        
        if duration_ms > 0:
            time.sleep(duration_ms / 1000.0)
            self.buttons[button_index] = 0
            self._write_state()
        else:
            # 短按：稍后松开
            time.sleep(0.05)
            self.buttons[button_index] = 0
            self._write_state()
    
    def press_button_down(self, button_name: str):
        """
        按下按钮（不松开）
        
        Args:
            button_name: 按钮名称
        """
        if not self.is_connected:
            return
        
        chiaki_button = GAMEPAD_MAP.get(button_name)
        if not chiaki_button:
            return
        
        button_index = BUTTON_INDEX.get(chiaki_button)
        if button_index is None:
            return
        
        self.buttons[button_index] = 1
        self._write_state()
    
    def press_button_up(self, button_name: str):
        """
        松开按钮
        
        Args:
            button_name: 按钮名称
        """
        if not self.is_connected:
            return
        
        chiaki_button = GAMEPAD_MAP.get(button_name)
        if not chiaki_button:
            return
        
        button_index = BUTTON_INDEX.get(chiaki_button)
        if button_index is None:
            return
        
        self.buttons[button_index] = 0
        self._write_state()
    
    def move_stick(self, stick_name: str, x: float, y: float):
        """
        移动摇杆
        
        Args:
            stick_name: 'left' 或 'right'
            x: X轴值 (-1.0 到 1.0)
            y: Y轴值 (-1.0 到 1.0)
        """
        if not self.is_connected:
            return
        
        if stick_name == 'left':
            self.left_x = max(-1.0, min(1.0, x))
            self.left_y = max(-1.0, min(1.0, y))
        elif stick_name == 'right':
            self.right_x = max(-1.0, min(1.0, x))
            self.right_y = max(-1.0, min(1.0, y))
        
        self._write_state()
    
    def press_stick(self, stick_action: str):
        """
        按下摇杆方向
        
        Args:
            stick_action: 摇杆动作 (如 'pressLU', 'pressLD')
        """
        if not self.is_connected:
            return
        
        stick_info = STICK_MAP.get(stick_action)
        if not stick_info:
            return
        
        axis, value = stick_info
        if axis == 'left_x':
            self.left_x = value
        elif axis == 'left_y':
            self.left_y = value
        elif axis == 'right_x':
            self.right_x = value
        elif axis == 'right_y':
            self.right_y = value
        
        self._write_state()
        
        # 短按后恢复
        time.sleep(0.1)
        if axis.startswith('left'):
            self.left_x = 0.0
            self.left_y = 0.0
        else:
            self.right_x = 0.0
            self.right_y = 0.0
        self._write_state()
    
    def set_trigger(self, trigger_name: str, value: float):
        """
        设置触发器值
        
        Args:
            trigger_name: 'l2' 或 'r2'
            value: 值 (0.0 到 1.0)
        """
        if not self.is_connected:
            return
        
        value = max(0.0, min(1.0, value))
        
        if trigger_name == 'l2':
            self.l2_value = value
        elif trigger_name == 'r2':
            self.r2_value = value
        
        self._write_state()
    
    def reset(self):
        """重置所有按键状态"""
        self.buttons = [0] * 19
        self.left_x = 0.0
        self.left_y = 0.0
        self.right_x = 0.0
        self.right_y = 0.0
        self.l2_value = 0.0
        self.r2_value = 0.0
        self._write_state()
    
    def send_action(self, action: str, duration_ms: int = 0):
        """
        发送手柄动作
        
        Args:
            action: 手柄动作 (如 'pressA', 'pressB')
            duration_ms: 按下持续时间（毫秒）
        """
        if action in GAMEPAD_MAP:
            self.press_button(action, duration_ms)
        elif action in STICK_MAP:
            self.press_stick(action)
        else:
            print(f"未知的手柄动作: {action}")


# 测试代码
if __name__ == '__main__':
    gamepad = SharedMemoryGamepad()
    
    if gamepad.connect():
        print("已连接到共享内存")
        
        # 测试按键
        print("按下 A 按钮...")
        gamepad.press_button('pressA')
        time.sleep(0.5)
        
        print("按下 B 按钮...")
        gamepad.press_button('pressB')
        time.sleep(0.5)
        
        print("移动左摇杆...")
        gamepad.move_stick('left', 0.5, 0.5)
        time.sleep(0.5)
        gamepad.move_stick('left', 0.0, 0.0)
        
        gamepad.disconnect()
        print("已断开连接")
    else:
        print("连接共享内存失败")
