"""把 public/samples/scan.las 压成 scan.laz（需要 pip install laspy lazrs）。

    python tools/make-laz.py

laz-perf 只能解压不能压缩，所以 LAZ 样本靠这个脚本生成。
"""
import laspy

las = laspy.read("public/samples/scan.las")
las.write("public/samples/scan.laz", do_compress=True)
print("已生成 public/samples/scan.laz")
