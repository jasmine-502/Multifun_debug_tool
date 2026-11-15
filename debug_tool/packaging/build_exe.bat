@echo off
setlocal
REM 打包为单文件版，产物: dist\TcpTool.exe（下载双击即用）
REM 前置: pip install pyinstaller
REM
REM 想要目录版（启动快 3~4 秒，适合反复调试）：
REM   set TCPTOOL_ONEDIR=1 && packaging\build_exe.bat
REM   产物变为 dist\TcpTool\TcpTool.exe + 同级依赖目录
REM
REM 说明: onefile 每次启动都要把 ~70MB 解压到 %TEMP%，冷启动 3~5 秒；
REM       onedir 就地运行，启动约 1 秒。打包形态由 TcpTool.spec 里的 ONEFILE 开关决定。

pushd %~dp0\..

echo [1/2] 处理图标（去白边 + 生成多尺寸 ico）...
python packaging\convert_icon.py

echo [2/2] 使用 spec 打包（形态由 TCPTOOL_ONEDIR 决定，默认单文件）...
python -m PyInstaller --noconfirm packaging\TcpTool.spec

if exist "dist\TcpTool.exe" (
    echo.
    echo 打包完成: dist\TcpTool.exe（单文件，直接分发这一个文件）
) else if exist "dist\TcpTool\TcpTool.exe" (
    echo.
    echo 打包完成: dist\TcpTool\TcpTool.exe（目录版，分发时压缩整个 dist\TcpTool）
) else (
    echo.
    echo 打包失败，请查看上方日志
)

popd
pause
endlocal
