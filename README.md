# NoBoWo

NoBoWo 是一个可视化、无代码的桌面自动化工具。你可以像搭积木一样编排鼠标、键盘、截图、判断、循环等节点，让计算机自动完成重复的桌面操作。

项目的核心设计理念是：**每个识别节点都可配置多级降级策略，优先使用快速、低成本的本地方案，识别失败时再逐步升级到更可靠的方案，必要时使用云端多模态模型兜底。**

> 当前项目处于开发阶段，功能、接口和数据格式仍可能发生变化。

## 主要功能

- **可视化工作流**
  - 使用 React Flow 搭建自动化流程
  - 支持节点拖拽、连线、缩放、禁用节点和运行状态查看
  - 支持保存、切换和管理多份工作流

- **自动化操作**
  - 鼠标点击、移动和拖拽
  - 键盘按键、组合键和连续输入
  - 页面或窗口滚动
  - 延时等待与条件等待
  - 条件判断、分支和循环

- **目标识别**
  - 截图与区域截图
  - OpenCV 图像模板匹配
  - YOLOX 目标检测
  - OCR 文字识别与定位
  - 云端多模态 API 识别兜底
  - 识别测试和结果调试

- **画面来源**
  - 本机屏幕
  - 指定本机窗口
  - 外部串流窗口
  - PS5 Direct Remote Play
  - 区域截图与画面预览

- **辅助能力**
  - 图像模板管理与裁剪
  - YOLO 数据标注、训练和模型管理
  - OCR 引擎测试
  - 云端 API 配置与连通性测试
  - 工作流运行、暂停、恢复、停止和调试
  - PS5 账号、主机、配对与串流管理

## 核心架构

```text
React + React Flow
        │
        │  编辑与展示工作流
        ▼
Electron Renderer
        │
        │  安全 IPC / preload API
        ▼
Electron Main Process
        │
        ├── 工作流执行器
        ├── 截图、窗口和输入控制
        ├── 模板、YOLO、OCR 管理
        ├── 云端 API 代理
        └── PS5 / Chiaki 串流运行时
                │
                ▼
        Python 视觉与输入引擎
        ├── OpenCV
        ├── PyAutoGUI
        ├── YOLOX / PyTorch
        ├── PaddleOCR
        └── pyremoteplay
```

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面应用 | Electron |
| 构建工具 | electron-vite、Vite |
| 界面 | React、TypeScript |
| 工作流画布 | React Flow |
| 视觉匹配 | OpenCV |
| OCR | macOS Vision、Windows OCR、Tesseract、PaddleOCR |
| 目标检测 | YOLOX、PyTorch |
| 键鼠输入 | PyAutoGUI |
| 截图 | 系统截图能力、Python 视觉运行时 |
| PS5 串流 | pyremoteplay、Chiaki-ng |
| 云端识别 | OpenAI 兼容的多模态 API |

## 环境要求

### 必需环境

- Node.js 20.19+ 或 22.12+
- npm 10.8.2 或兼容版本
- Python 3.x，并确保命令可用：
  - macOS / Linux：`python3`
  - Windows：`python`

### 按需环境

根据所使用的功能，还需要安装以下组件：

- 模板匹配与截图：OpenCV
- 鼠标和键盘操作：PyAutoGUI
- YOLO 目标检测：PyTorch、YOLOX
- OCR：Tesseract 或 PaddleOCR
- PS5 Direct Remote Play：`packages/engine/python/requirements-ps5.txt` 中列出的依赖
- 外部 PS5 串流：Chiaki-ng

部分系统能力需要额外授权。例如 macOS 使用屏幕录制和辅助功能时，需要在“系统设置 → 隐私与安全性”中授权终端、Electron 或最终打包后的应用。

## 安装

```bash
git clone <repository-url>
cd NoBoWo
npm install
```

如果需要 PS5 Direct Remote Play 功能：

```bash
python3 -m pip install -r packages/engine/python/requirements-ps5.txt
```

Windows 可以将命令中的 `python3` 替换为 `python`。

如果使用 YOLOX，请在应用的 YOLO 设置中指定 YOLOX 源码目录，并根据 YOLOX 的要求安装 PyTorch、训练和推理依赖。

如果使用外部 PS5 串流，请将 Chiaki-ng 可执行文件放入：

```text
packages/engine/bin/
├── mac/
├── win/
└── linux/
```

详细安装方式可参考 `packages/engine/bin/README.md`。

## 启动

开发模式：

```bash
npm run dev
```

仅运行浏览器界面：

```bash
npm run dev:web
```

> Web 模式主要用于开发和查看界面。截图、键鼠控制、窗口控制、PS5 串流等桌面能力需要在 Electron 中运行。

## 构建与检查

```bash
# 类型检查
npm run typecheck

# 构建 Electron 应用
npm run build

# 仅构建 Web 界面
npm run build:web

# 预览 Electron 构建结果
npm run preview
```

## 基本使用

1. 启动 NoBoWo。
2. 在工作流画布中添加节点。
3. 连接节点，确定执行顺序。
4. 配置每个节点的参数和识别策略。
5. 使用截图、模板裁剪或识别测试功能调试目标。
6. 保存工作流。
7. 运行并观察节点状态。
8. 如遇失败，查看调试信息并调整模板、OCR 引擎、匹配阈值或云端兜底策略。

## 降级识别策略

识别节点可以组合多种策略，典型流程如下：

```text
本机快速识别
    │
    ├── 成功 → 继续执行
    │
    └── 失败或置信度不足
            │
            ├── 更高精度的本地识别
            │
            └── 云端多模态模型兜底
```

建议优先使用成本低、速度快的本地方案：

1. 固定环境下优先使用图像模板匹配。
2. 分辨率、缩放或界面样式变化时升级到更稳定的特征匹配。
3. 适合文字定位的场景使用 OCR。
4. 样式变化较大或目标类别明确时使用 YOLO。
5. 仅在其他方案无法可靠判断时调用云端 API。

## 目录结构

```text
NoBoWo/
├── templates/                 # 用户上传的模板明文数据，已加入 .gitignore
│   ├── index.json             # 模板元数据
│   ├── images/                # 用于匹配的裁剪模板
│   └── sources/               # 创建模板时保存的原始截图
├── packages/
│   ├── core/                  # 工作流类型、节点模型和共享逻辑
│   ├── main/                  # Electron 主进程、IPC、执行器和运行时
│   ├── renderer/              # React 界面、工作流画布和管理面板
│   └── engine/
│       ├── python/            # 视觉、输入和 PS5 Python 运行时
│       ├── macos/             # macOS Vision OCR 桥接
│       └── bin/               # Chiaki-ng 等外部可执行文件目录
├── electron.vite.config.ts    # Electron 构建配置
├── vite.config.ts             # Web 构建配置
├── package.json
└── 桌面自动化管线-技术方案.md  # 产品调研和技术方案
```

## 数据与安全

### 模板图片存放位置

模板图片和元数据直接保存在项目根目录的 `templates/`：

```text
/Volumes/TUF ESD-T1A Media/NoBoWo/templates/
├── index.json
├── images/
└── sources/
```

- `templates/` 已写入 `.gitignore`，模板图片、原始截图和索引不会进入 Git 提交或 GitHub。
- 主进程和工作流执行器统一从该目录读取模板，删除、替换和识别使用同一份数据。
- 新上传的图片会立即保存到 `templates/images`，原始截图保存到 `templates/sources`。
- 模板数据不会复制到系统用户目录，也不会自动从旧用户目录导入。

### 其他安全说明

- 云端 API Key 可能保存在本地应用数据或浏览器本地存储中，请勿公开分享配置文件、截图或包含密钥的调试日志。
- 自动化流程可以控制鼠标和键盘。运行陌生工作流前，请确认节点操作，避免误触、输入或删除数据。
- 首次运行建议先使用测试窗口或虚拟机验证流程，再在真实桌面环境执行。
- 使用云端识别时，截图内容会发送给所配置的服务商，请确认符合你的隐私和合规要求。

## 常见问题

### Python 脚本找不到

确认系统已经安装 Python，并且 `python3` 或 `python` 可以直接执行：

```bash
python3 --version
```

### 模板匹配或 YOLO 不可用

打开环境检查面板，确认 OpenCV、PyTorch、YOLOX 和模型文件已经正确安装。YOLOX 还需要配置包含 `yolox` Python 包的源码目录。

### macOS 无法截图或控制鼠标

在系统隐私设置中授予屏幕录制和辅助功能权限，然后重新启动应用。

### OCR 中文识别效果不理想

可以改用 macOS Vision 或 PaddleOCR。Tesseract 更适合英文场景，中文效果取决于语言模型和图片质量。

### PS5 无法连接

检查主机网络、PSN 账号、Account ID、配对状态和防火墙设置。外部串流模式还需要正确安装 Chiaki-ng。

## 第三方许可注意

PS5 Direct Remote Play 运行时使用的 `pyremoteplay` 基于 GPLv3 发布。若将 NoBoWo 连同该组件一起分发，需要评估 GPLv3 对组合作品、源代码提供和版权声明的要求。

其他第三方组件也可能遵循各自的许可证。发布或商用前，请完整检查依赖及其传递依赖的许可条款。

## 开发说明

- 共享类型和工作流模型位于 `packages/core`。
- Electron 主进程和工作流执行逻辑位于 `packages/main`。
- React 界面和画布组件位于 `packages/renderer`。
- Python 视觉、输入和串流运行时位于 `packages/engine/python`。
- 新增节点时，需要同时处理节点类型、属性面板配置、执行器逻辑和界面展示。

更完整的技术选型、降级策略设计和阶段规划，参见 `桌面自动化管线-技术方案.md`。
