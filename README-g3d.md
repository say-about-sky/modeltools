# g3d —— Paradox `.mesh` → libGDX `g3dj` / `g3db` 转换器

把游戏单位的 `.mesh` 模型直接转换为 libGDX g3d 格式,给 `HotG3DArmyTest` 等兵模插件使用
(放置为 `hotplugins/resources/<插件>/model.g3dj` 或 `model.g3db`,贴图放同目录)。

- **网格解析**:移植自 **JoroDox** 的「Convert to Collada (.dae)」数据通路
  (`js/pdxDataService.js` 的 pdx 二进制解析 + `js/rendererService.js` 的顶点/蒙皮/骨骼提取)。
- **输出格式**:移植自 **fbx-conv** (`src/modeldata/Serialization.cpp`、`json/JSONWriter.h`、
  `json/UBJSONWriter.h`)——g3dj 文本 JSON 与 g3db 二进制 UBJSON 均与 libgdx 读取器兼容
  (`UBJsonReader` 的 `oldFormat=true` 语义)。

与旧的「mesh → JoroDox 导出 dae → DaeToG3dj.java」两步流程相比:
一步完成、支持**蒙皮/骨骼**(逆绑定矩阵)与**动画**(`--anim`)、输出格式与 fbx-conv 对齐。

## 构建

```
cd modeltools
cargo build --release
:: 产物 target\release\g3d.exe
```

## Web 调试器（g3d-web）

`g3d-web` 是一个零外部依赖的本地 Web 工具，用 **G3DArmy 的渲染管线规则**
（正交相机/自动适配/光照/蒙皮/接触阴影/染色/脚底 AO/四态动画映射）在浏览器里查看
模型项目里的 g3dj 与 `待机/移动/战斗/撤退` 四态动画，并自动做绑定矩阵、
蒙皮权重、动画轨道结构自检。

服务会递归发现 root 下的项目：`combos`、`ww1`/`ww2`、`_work/preview_*` 等；
每个模型带 `project/category/group`，前端按这些字段动态生成分组标签。
也支持 G3DArmy v4.2+ 的 `G3DArmy/models/main/g3d/` 布局，并始终读取
`models/assembly.json` / `models/parts/` / `models/attachments.json` / `loadSelect.json` /
`civilization/`，复刻 v4.7 的宗教块数组、unitgroup 文化组、byId/religion/religionGroup/
group/level/default、文明覆盖、shipSelect、strip、`<part>@<bone>` 挂载和武器动画 donor。

```
cargo build --release --bin g3d-web
target\release\g3d-web.exe --root ..\age3mudels\G3DArmy --open
:: 一战模型使用同样格式：..\ww1models\G3DArmy
:: 工作区根 .. 会同时发现 age3mudels/G3DArmy 与 ww1models/G3DArmy
:: G3DArmy 装配始终开启，无需 -runtime
:: --all 同时列出 runtime/parts、library；--dev 前端资源实时读 web/
```

详见 [`web/README.md`](web/README.md)（含与 `G3DArmyMin`/libGDX 的逐项对应表、URL 深链、
无头截图、已知差异）。

**可折叠 / 可调布局**：左侧模型栏、右侧动画状态/属性栏、底部日志均可拖动边缘调整大小，
双击重置；顶部 `模型标签` 与 `模型列表` 各自可折叠，折叠状态保存在 localStorage；
AI 可用 `window.__g3dweb.layout`（或 `window.__g3dwebLayout`）调整抽屉。

**AI 无视觉调试**：页面暴露 `window.__g3dweb.diagnose()` / `scanAnimation()` / `set()`，
返回 JSON + ASCII 部件图 + 边长扭曲指标（`badPct`、`p99`、`badBones`、`seat`），
适合没有截图的 Copilot/自动化流程；详见 `web/README.md` 的「AI 无视觉调试」章节。
逐帧循环请用 `probeFrames()`（绑定顶点/尺度/调色板缓存，避免每帧完整 `diagnose`）；
AI 放置/旋转用 `placeModel()` / `moveModel()` / `rotateModel()`，
骨架/绑定检查用 `skeleton()` / `highlightBones()`，UI 也有「骨架高亮」开关。

重复/AI 调用用 `tools\g3d-web-serve.ps1`：优先复用已有同 root 服务；没有服务时脚本会自动从
8787 起选一个空闲端口启动（旧端口关闭后再次调用即可重新打开），避免端口自增和
`cargo build` 的 `target\release\g3d-web.exe` 文件锁（`os error 5`）。启动默认
`--idle-timeout 300`，页面心跳停止后自动退出回收端口；`-Check` 仅用于只探测不启动。

## 用法

```
g3d <输入.mesh> [选项]
```

常用示例:

```
:: 默认输出 g3db(与输入同目录同名)
g3d unit_weapon_zweihander.mesh

:: 输出 g3dj 文本,并附加 3 个动画(动画 id 取文件名)
g3d unit_skeleton.mesh -j --anim unit_x_idle.anim --anim unit_x_walk.anim --anim unit_x_attack.anim

:: 查看文件内容(shape/骨骼/网格/LOD),不转换
g3d unit_torso_armor.mesh --list
```

| 选项 | 说明 |
| --- | --- |
| `-o, --output <文件>` | 输出路径(默认与输入同目录同名,扩展名 `.g3dj`/`.g3db`) |
| `-j, --g3dj` | 输出文本 g3dj(默认输出二进制 g3db) |
| `-b, --g3db` | 输出二进制 g3db(默认) |
| `-f, --force` | 覆盖已存在的输出文件 |
| `-v, --verbose` | 详细日志(输出选中 shape、动画概要等) |
| `-l, --lod <0\|1\|2\|all>` | 导出的 LOD(默认 0;`all` = 全部 shape;无 LOD 属性时导出全部) |
| `--id <ID>` | 模型 id(默认取输入文件名) |
| `--flip-v` | 翻转纹理 V 坐标(v → 1-v);默认不翻转(mesh 纹理为左上原点) |
| `--tangents` | 输出 TANGENT 切线属性(丢弃原 w 分量) |
| `--no-normals` | 不输出 NORMAL(缺法线的网格会自动计算平滑法线) |
| `--tex <FILE>` | 强制所有材质的漫反射贴图文件名 |
| `--tex-ext <EXT>` | 替换贴图扩展名(如 `png`) |
| `--no-textures` | 不输出贴图 |
| `--diffuse r,g,b` | 材质漫反射颜色(默认 0.8,0.8,0.8) |
| `--anim <FILE>` | 附加 `.anim` 动画(可重复;动画 id = 文件名) |
| `--max-verts <N>` | 顶点数超过 N 时拆分(默认 32767,保证 16 位索引;0 = 不拆) |
| `--list` | 列出 mesh 文件内容后退出 |

## 输出结构(g3dj / g3db)

- `meshes[]`:每个 `.mesh` 网格对象一个,`attributes` 依次为
  `POSITION, NORMAL, [TANGENT], TEXCOORD0, BLENDWEIGHT0..n`
  (每个 BLENDWEIGHT = 2 float:骨骼索引 + 权重;影响数 1~4 对应 1~4 个属性)。
- `nodes[]`:每个 shape 一个网格节点(parts 引用 meshpart + 材质 + 逆绑定骨骼表)
  和一个 `*_skeleton` 骨骼节点树;骨骼节点局部变换由骨骼世界矩阵推导,
  逆绑定矩阵 `invBind = txᵀ`(.mesh 的 tx 存的是骨骼世界矩阵的逆)。
- `materials[]`:`id` + `diffuse` + 贴图(`diff → DIFFUSE`、`n → NORMAL`、`spec → SPECULAR`;
  同名材质自动去重)。
- `animations[]`(`--anim` 时):按骨骼名匹配节点,关键帧 `keytime` 毫秒,
  直接透传 `.anim` 的局部 T/Q/S(样本主序解码,含 s 标量/vec3 两种存储)。

多 shape(`--lod all` / 无 LOD 文件)时,第 2 个及之后的 shape 骨骼节点 id 会加
`<shape名>.` 前缀以避免重名(此时动画只会匹配第 1 个 shape 的骨骼)。

## 校验

`tools/validate-g3d.py` 可对一对 g3dj/g3db 做结构校验、绑定姿态一致性
(节点全局变换 × invBind ≈ 单位阵)与双格式逐字段对照:

```
python modeltools\tools\validate-g3d.py out.g3dj out.g3db
```

## 实现备注

- 全部为纯 Rust(仅依赖 clap)。源码结构:`src/bin/g3d.rs` 为二进制入口(仅装载模块并调用 `cli_main`),
  实现在 `src/bin/g3d_mod/` 模块树:`matrix`(矩阵/四元数/TRS)、`pdx`(容器解析)、`mesh`(.mesh 提取)、
  `model`(g3d 模型构建)、`writer`(序列化入口)+ `json`(g3dj)/`ubjson`(g3db)写入器、
  `anim`(.anim 解析与转换)、`app`(命令行与主流程);单元测试在 `g3d_mod/mod.rs`(`cargo test --bin g3d`)。
- g3dj 数值格式复刻 fbx-conv:C 的 `"% 8f"`(正数带前导空格)、`" %3i"`、
  NaN/Inf 先按 `0xFEFFFFFF` 掩码;容器/换行(vertices 按顶点换行、indices 每 12 个换行)。
- g3db 复刻 UBJSONWriter:大端 `'i'`(i16)/`'I'`(i32)/`'d'`(f32)、
  `'a'/'A'` 强类型数组(计数 <255 用 1 字节)、字符串 `'s'/'S'`。
- `tx`(12 float)= 骨骼世界矩阵的逆,布局为
  `[3x3 行主序 | 平移](即 3 个 float 一组共 4 组)`;`invBind = txᵀ`、
  世界矩阵 `C = (txᵀ)⁻¹`、节点局部 = `C_parent⁻¹·C_child`。
