#!/bin/bash
# hi-log WSLg 启动脚本
# 背景:WSLg 默认设置 WAYLAND_DISPLAY=wayland-0,GTK3 会优先选 Wayland 后端,
# 而 WebKitGTK 2.52 在 WSLg Wayland 下 EGL/Mesa(ZINK)初始化失败,窗口不出现。
# 强制 GDK_BACKEND=x11 后走 X11 后端,渲染正常(详见 docs/DESIGN.md §9.4)。
set -e

# 非 WSL 环境不强制 x11,按真实桌面(GNOME/KDE Wayland)默认行为
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  export GDK_BACKEND=x11
  # 可选:WSLg 下 WebKitGTK 花屏/卡顿时再解除注释
  # export WEBKIT_DISABLE_DMABUF_RENDERER=1
  # export WEBKIT_DISABLE_COMPOSITING_MODE=1
fi

# 脚本位置 -> 仓库根
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 优先 release,退 debug;可用 HILOG_BIN 覆盖
BIN="${HILOG_BIN:-$ROOT/target/release/hi-log}"
[ -x "$BIN" ] || BIN="$ROOT/target/debug/hi-log"
[ -x "$BIN" ] || { echo "未找到构建产物,请先构建: cargo build --features tauri/custom-protocol"; exit 1; }

echo "[hi-log] 启动: $BIN (GDK_BACKEND=${GDK_BACKEND:-未设置})"
exec "$BIN" "$@"
