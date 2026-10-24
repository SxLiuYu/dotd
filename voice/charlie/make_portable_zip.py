"""把 dist/charlie/ 打包成单文件便携版 Charlie-Portable.zip。

用法: py -3.12 make_portable_zip.py
- 顶层目录统一为 Charlie/，解压即用
- 排除 __pycache__
- 若 dist/charlie 里残留 .env / data/ / logs/（测试产生），一并排除，避免泄露个人密钥
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "dist", "charlie")
OUT = os.path.join(HERE, "dist", "Charlie-Portable.zip")

# 这些是运行时生成的个人数据，不应进分发包
EXCLUDE_NAMES = {"__pycache__", ".env", "data", "logs", "conversation_history.json",
                 "conversation_history.json.lock", "decision_engine.runner.lock",
                 "preferences.json.lock", "tunnel_url.txt"}


def main():
    if not os.path.isdir(SRC):
        raise SystemExit(f"找不到 {SRC}，请先 pyinstaller 构建")
    if os.path.exists(OUT):
        os.remove(OUT)

    n = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
        for root, dirs, files in os.walk(SRC):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_NAMES]
            for f in files:
                if f in EXCLUDE_NAMES:
                    continue
                full = os.path.join(root, f)
                rel = os.path.relpath(full, SRC).replace("\\", "/")
                z.write(full, "Charlie/" + rel)
                n += 1

    size_mb = os.path.getsize(OUT) / 1024 / 1024
    print(f"已添加 {n} 个文件")
    print(f"输出: {OUT}")
    print(f"大小: {size_mb:.1f} MB")


if __name__ == "__main__":
    main()
