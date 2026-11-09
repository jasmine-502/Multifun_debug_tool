@echo off
setlocal
REM 打包为 onedir 目录版（启动最快），产物: dist\TcpTool\TcpTool.exe
REM 前置: pip install pyinstaller
REM
REM 说明: 早期用 --onefile，每次启动都要把 ~70MB 解压到 %TEMP%，
REM       冷启动 5 秒以上；onedir 就地运行，启动约 1 秒。

pushd %~dp0\..

echo [1/2] 处理图标（去白边 + 生成多尺寸 ico）...
python packaging\convert_icon.py

echo [2/2] 使用 spec 打包（onedir）...
python -m PyInstaller --noconfirm packaging\TcpTool.spec

if exist "dist\TcpTool\TcpTool.exe" (
    echo.
    echo 打包完成: dist\TcpTool\TcpTool.exe
    echo 分发时请把整个 dist\TcpTool 目录压缩成 zip
) else (
    echo.
    echo 打包失败，请查看上方日志
)

popd
pause
endlocal
