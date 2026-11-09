#!/usr/bin/env python3
"""把 icon.png 处理成带透明圆角的 icon.ico，供 PyInstaller 与窗口图标使用。

处理内容：
1. 从图像四角向内做连通填充，把圆角外侧的白色背景变为透明。
   只删除与边缘连通的白色，图标内部的白（内框、齿轮中心等）会完整保留。
2. 边缘按亮度做 alpha 渐变，保留原图的抗锯齿过渡，避免出现硬锯齿/白边。
3. 输出包含 16/24/32/48/64/128/256 多尺寸的 ico。

用法：python packaging/convert_icon.py
"""

from collections import deque
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PNG_PATH = os.path.join(HERE, 'icon.png')
ICO_PATH = os.path.join(HERE, 'icon.ico')
PNG_OUT = os.path.join(HERE, 'icon_transparent.png')

LOW = 200    # 亮度 <= 200 视为完全不透明
HIGH = 250   # 亮度 >= 250 视为完全透明
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def flood_from_corners(mask):
    """从四个角出发，标记所有与边缘连通的 True 区域"""
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    queue = deque()

    for y, x in ((0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1)):
        if mask[y, x] and not visited[y, x]:
            visited[y, x] = True
            queue.append((y, x))

    while queue:
        y, x = queue.popleft()
        if y > 0 and mask[y - 1, x] and not visited[y - 1, x]:
            visited[y - 1, x] = True
            queue.append((y - 1, x))
        if y < h - 1 and mask[y + 1, x] and not visited[y + 1, x]:
            visited[y + 1, x] = True
            queue.append((y + 1, x))
        if x > 0 and mask[y, x - 1] and not visited[y, x - 1]:
            visited[y, x - 1] = True
            queue.append((y, x - 1))
        if x < w - 1 and mask[y, x + 1] and not visited[y, x + 1]:
            visited[y, x + 1] = True
            queue.append((y, x + 1))

    return visited


def strip_outer_white(img):
    """去掉圆角外侧白色背景，返回 RGBA 图像"""
    rgba = img.convert('RGBA')
    arr = np.array(rgba)
    rgb = arr[:, :, :3].astype(np.int16)
    brightness = rgb.min(axis=2)          # 用通道最小值判定“白”

    # 与边缘连通的浅色区域（含抗锯齿过渡像素）
    outer = flood_from_corners(brightness >= LOW)

    # alpha 随亮度渐变：越白越透明，保留抗锯齿
    span = max(HIGH - LOW, 1)
    fade = (HIGH - brightness).astype(np.float32) / span
    fade = np.clip(fade * 255.0, 0, 255)

    alpha = arr[:, :, 3].astype(np.float32)
    alpha[outer] = np.minimum(alpha[outer], fade[outer])
    arr[:, :, 3] = alpha.astype(np.uint8)

    # 被判定为透明的像素把 RGB 也归一，避免缩放时出现白色晕边
    arr[arr[:, :, 3] == 0, 0:3] = 0

    return Image.fromarray(arr, 'RGBA'), int(outer.sum())


def main():
    if not os.path.exists(PNG_PATH):
        print(f'错误: 找不到 {PNG_PATH}')
        return 1

    src = Image.open(PNG_PATH)
    result, cleared = strip_outer_white(src)

    # ico 以 256x256 为基准图，其余尺寸由 Pillow 缩放生成
    ico_src = result if result.size == (256, 256) else result.resize((256, 256), Image.LANCZOS)

    result.save(PNG_OUT)
    ico_src.save(ICO_PATH, format='ICO', sizes=ICO_SIZES)

    total = src.size[0] * src.size[1]
    print(f'输入: {PNG_PATH} ({src.size[0]}x{src.size[1]}, {src.mode})')
    print(f'清除圆角外背景: {cleared} 像素 ({cleared / total * 100:.1f}%)')
    print(f'输出: {PNG_OUT}')
    print(f'输出: {ICO_PATH}  尺寸: {", ".join(f"{w}x{h}" for w, h in ICO_SIZES)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
