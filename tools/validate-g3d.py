#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""validate-g3d.py —— 校验 g3d 产出的 g3dj / g3db。

用法:
    python validate-g3d.py 模型.g3dj 模型.g3db

校验内容:
  1. 结构:attributes 与 vertices 步长一致、索引不越界、动画关键帧时间递增且通道等长;
  2. 绑定姿态:节点全局变换 × 逆绑定矩阵 ≈ 单位阵(容差 5e-3);
  3. 对照:g3dj 与 g3db 两个文件解析出的模型逐字段一致。

g3db 解析镜像 libgdx UBJsonReader(oldFormat=true):
  'i'=int16(2B 大端)、'I'=int32(4B)、'l'=int32、'L'=int64、'd'=float32(4B)、
  'D'=float64(8B)、's'=1字节长度字符串、'S'=4字节长度字符串、
  'a'/'A'=强类型数组(1/4 字节元素计数)、对象 '{}'、数组 '[]'。
"""
import struct
import sys
import os
import json
import math

# ---------------------------------------------------------------- UBJSON reader


class UBJson:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def u8(self):
        v = self.d[self.p]
        self.p += 1
        return v

    def i16(self):
        v = struct.unpack_from(">h", self.d, self.p)[0]
        self.p += 2
        return v

    def i32(self):
        v = struct.unpack_from(">i", self.d, self.p)[0]
        self.p += 4
        return v

    def i64(self):
        v = struct.unpack_from(">q", self.d, self.p)[0]
        self.p += 8
        return v

    def f32(self):
        v = struct.unpack_from(">f", self.d, self.p)[0]
        self.p += 4
        return v

    def f64(self):
        v = struct.unpack_from(">d", self.d, self.p)[0]
        self.p += 8
        return v

    def parse(self, t=None):
        if t is None:
            t = self.u8()
        c = chr(t)
        if c == "{":
            return self.parse_object()
        if c == "[":
            return self.parse_array()
        if c == "Z":
            return None
        if c == "T":
            return True
        if c == "F":
            return False
        if c in "BU":
            return self.u8()
        if c == "i":
            return self.i16()
        if c == "I":
            return self.i32()
        if c == "l":
            return self.i32()
        if c == "L":
            return self.i64()
        if c == "d":
            return self.f32()
        if c == "D":
            return self.f64()
        if c in "sS":
            return self.parse_string(t)
        if c in "aA":
            return self.parse_data(t)
        raise ValueError("unrecognized type %r at %d" % (c, self.p - 1))

    def parse_string(self, t):
        n = self.i32() if t == ord("S") else self.u8()
        s = self.d[self.p:self.p + n].decode("utf-8")
        self.p += n
        return s

    def parse_object(self):
        obj = {}
        while self.p < len(self.d):
            t = self.u8()
            if t == ord("}"):
                break
            key = self.parse_string(t)
            obj[key] = self.parse()
        return obj

    def parse_array(self):
        arr = []
        while self.p < len(self.d):
            t = self.u8()
            if t == ord("]"):
                break
            arr.append(self.parse(t))
        return arr

    def parse_data(self, block):
        ty = self.u8()
        n = self.i32() if block == ord("A") else self.u8()
        return [self.parse(ty) for _ in range(n)]


def read_g3db(path):
    with open(path, "rb") as f:
        data = f.read()
    r = UBJson(data)
    v = r.parse()
    if r.p != len(data):
        print("  [warn] %d trailing bytes" % (len(data) - r.p))
    return v


# ---------------------------------------------------------------- structural checks

ATTR_SIZE = {"POSITION": 3, "NORMAL": 3, "TANGENT": 3, "TEXCOORD0": 2,
             "TEXCOORD1": 2, "COLORPACKED": 1, "COLOR": 4}


def attr_size(a):
    return 2 if a.startswith("BLENDWEIGHT") else ATTR_SIZE[a]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def trs(t, q, s):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w)
    if n < 1e-12:
        x, y, z, w = 0, 0, 0, 1
    else:
        x, y, z, w = x / n, y / n, z / n, w / n
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
        [0, 0, 0, 1],
    ]
    for i in range(3):
        for j in range(3):
            r[i][j] *= s[j]
    r[0][3], r[1][3], r[2][3] = t
    return r


def node_local(n):
    t = [float(v) for v in n.get("translation", [0, 0, 0])[:3]]
    q = [float(v) for v in n.get("rotation", [0, 0, 0, 1])]
    s = [float(v) for v in n.get("scale", [1, 1, 1])[:3]]
    return trs(t, q, s)


def collect_globals(nodes):
    out = {}

    def rec(n, parent):
        g = mat_mul(parent, node_local(n))
        out[n["id"]] = g
        for c in n.get("children", []):
            rec(c, g)

    ident = [[1 if i == j else 0 for j in range(4)] for i in range(4)]
    for n in nodes:
        rec(n, ident)
    return out


def check_model(m, label, verbose=True):
    ok = True
    meshpart_sizes = {}
    for mesh in m.get("meshes", []):
        stride = sum(attr_size(a) for a in mesh["attributes"])
        if stride == 0 or len(mesh["vertices"]) % stride != 0:
            print("  [FAIL] %s: vertices %d 与步长 %d 不整除" % (label, len(mesh["vertices"]), stride))
            ok = False
            continue
        nv = len(mesh["vertices"]) // stride
        for p in mesh["parts"]:
            if not p["indices"] or max(p["indices"]) >= nv or min(p["indices"]) < 0:
                print("  [FAIL] %s: 部件 %s 索引越界(nv=%d)" % (label, p["id"], nv))
                ok = False
            meshpart_sizes[p["id"]] = (nv, stride)
    globals_ = collect_globals(m.get("nodes", []))
    ident = [[1 if i == j else 0 for j in range(4)] for i in range(4)]
    worst, worst_where, bone_total = 0.0, "", 0
    for n in m.get("nodes", []):
        stack = [n]
        while stack:
            node = stack.pop()
            stack += node.get("children", [])
            for part in node.get("parts", []):
                if part["meshpartid"] not in meshpart_sizes:
                    print("  [FAIL] %s: meshpartid %s 不存在" % (label, part["meshpartid"]))
                    ok = False
                for b in part.get("bones", []):
                    bone_total += 1
                    g = globals_.get(b["node"])
                    if g is None:
                        print("  [FAIL] %s: 骨骼节点 '%s' 不存在" % (label, b["node"]))
                        ok = False
                        continue
                    inv = trs(b["translation"][:3], b["rotation"], b["scale"][:3])
                    p = mat_mul(g, inv)
                    dev = max(abs(p[i][j] - ident[i][j]) for i in range(4) for j in range(4))
                    if dev > worst:
                        worst, worst_where = dev, b["node"]
    for anim in m.get("animations", []):
        for na in anim["bones"]:
            lens = set()
            for ch in ("translation", "rotation", "scale"):
                if ch in na:
                    lens.add(len(na[ch]))
                    times = [k["keytime"] for k in na[ch]]
                    if times != sorted(times):
                        print("  [FAIL] %s: 动画 %s/%s 通道 %s 时间未递增" % (label, anim["id"], na["boneId"], ch))
                        ok = False
            if len(lens) > 1:
                print("  [FAIL] %s: 动画 %s/%s 通道长度不一致 %s" % (label, anim["id"], na["boneId"], lens))
                ok = False
    if verbose:
        nv = sum(len(x["vertices"]) for x in m.get("meshes", []))
        print("  %s: 网格=%d 顶点数据=%d 部件=%d 节点=%d 骨骼引用=%d 绑定姿态最大偏差=%.2e(%s)" % (
            label, len(m.get("meshes", [])), nv,
            sum(len(x["parts"]) for x in m.get("meshes", [])), len(globals_), bone_total,
            worst, worst_where or "-"))
    if bone_total > 0 and worst > 5e-3:
        print("  [FAIL] %s: 绑定姿态偏差过大 %.4f" % (label, worst))
        ok = False
    return ok


def compare(a, b, path="$", tol=1e-5):
    diffs = []

    def rec(x, y, p):
        if isinstance(x, dict) and isinstance(y, dict):
            for k in set(x) | set(y):
                if k not in x:
                    diffs.append("%s.%s 仅 g3db 有" % (p, k))
                elif k not in y:
                    diffs.append("%s.%s 仅 g3dj 有" % (p, k))
                else:
                    rec(x[k], y[k], "%s.%s" % (p, k))
        elif isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                diffs.append("%s: 长度 %d vs %d" % (p, len(x), len(y)))
                return
            for i, (xi, yi) in enumerate(zip(x, y)):
                rec(xi, yi, "%s[%d]" % (p, i))
        elif isinstance(x, float) and isinstance(y, float):
            if math.isnan(x) and math.isnan(y):
                return
            if abs(x - y) > tol * max(1.0, abs(x), abs(y)):
                diffs.append("%s: %r vs %r" % (p, x, y))
        elif x != y:
            diffs.append("%s: %r vs %r" % (p, x, y))

    rec(a, b, path)
    return diffs


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    g3dj_path, g3db_path = sys.argv[1], sys.argv[2]
    ok = True
    with open(g3dj_path, "r", encoding="utf-8") as f:
        a = json.load(f)
    b = read_g3db(g3db_path)
    print("== g3dj ==")
    ok &= check_model(a, os.path.basename(g3dj_path))
    print("== g3db ==")
    ok &= check_model(b, os.path.basename(g3db_path))
    print("== 对照 ==")
    diffs = compare(a, b)
    if diffs:
        ok = False
        print("  差异 %d 条:" % len(diffs))
        for d in diffs[:20]:
            print("   ", d)
    else:
        print("  g3dj 与 g3db 解析结果一致")
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
