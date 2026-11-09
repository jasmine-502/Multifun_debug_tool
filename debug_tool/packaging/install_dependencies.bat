@echo off
setlocal
REM 安装依赖：在项目根目录创建并使用 venv
pushd %~dp0\..

if not exist venv (
    echo 创建虚拟环境 venv...
    python -m venv venv
)

echo 激活虚拟环境...
call venv\Scripts\activate.bat

echo 安装依赖...
python -m pip install -r packaging\requirements.txt

echo.
echo 安装完成。运行程序: python qt_app.py
popd
pause
endlocal
