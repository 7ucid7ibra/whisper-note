#!/usr/bin/env python3
"""
WhisperNote - Floating Voice-to-Text Pad
Quick installer for macOS and Windows
"""

import os
import sys
import subprocess
import shutil
import urllib.request
import zipfile
import tarfile

def get_platform():
    if sys.platform == "darwin":
        return "macos"
    elif sys.platform == "win32":
        return "windows"
    return "linux"

def run_command(cmd, env=None):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        print(f"Error: {result.stderr}")
        return False
    return True

def check_python():
    version = sys.version_info
    if version.major < 3 or (version.major == 3 and version.minor < 8):
        print("Python 3.8+ required")
        return False
    print(f"Python {version.major}.{version.minor}.{version.micro} detected")
    return True

def install_dependencies():
    print("\nInstalling Python dependencies...")
    packages = [
        "faster-whisper",
        "sounddevice",
        "numpy",
        "httpx",
        "pywebview",
    ]
    cmd = f"{sys.executable} -m pip install {' '.join(packages)}"
    return run_command(cmd)

def create_launcher():
    platform = get_platform()
    if platform == "windows":
        launcher = """@echo off
python -m src.app %*
"""
        with open("run.bat", "w") as f:
            f.write(launcher)
        print("Created run.bat")
    else:
        launcher = """#!/bin/bash
cd "$(dirname "$0")"
python3 -m src.app "$@"
"""
        with open("run.sh", "w") as f:
            f.write(launcher)
        os.chmod("run.sh", 0o755)
        print("Created run.sh")

def main():
    print("=== WhisperNote Setup ===")
    print(f"Platform: {get_platform()}")

    if not check_python():
        sys.exit(1)

    if not install_dependencies():
        print("Failed to install dependencies")
        sys.exit(1)

    create_launcher()

    print("\n=== Setup Complete! ===")
    print("\nTo run WhisperNote:")
    if get_platform() == "windows":
        print("  run.bat")
    else:
        print("  ./run.sh")
    print("\nOr simply: python -m src.app")

if __name__ == "__main__":
    main()