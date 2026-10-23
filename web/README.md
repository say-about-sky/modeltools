# g3d-web —— age3mudels / G3DArmy 管线复刻调试器

在浏览器里加载 `age3mudels/G3DArmy`、`ww1models/G3DArmy` 等资源目录（也兼容旧的 `combos`、`ww1` 项目），用 **G3DArmy（G3DArmyMin）同一套渲染规则** 查看模型与
`待机 / 移动 / 战斗 / 撤退` 四态动画。没有外部 CDN、没有 npm 依赖：前端静态模块在编译时内嵌进
`g3d-web.exe`，运行时由 Rust 内置的轻量 HTTP 服务提供。

## 快速开始

```bat
cd modeltools
cargo build --release --bin g3d-web
target\release\g3d-web.exe --root ..\age3mudels\G3DArmy --open
:: 一战模型使用同样的 G3DArmy 目录格式：
target\release\g3d-web.exe --root ..\ww1models\G3DArmy --open
:: 也可以直接指向工作区（同时列出两个 G3DArmy 项目）：
target\release\g3d-web.exe --root .. --open
:: 检测到 G3DArmy 资源目录时自动解析 loadSelect/attachments/assembly（无需开关）
```

> 重复启动 / AI 调用请用 `tools\g3d-web-serve.ps1`：优先复用已有同 root 服务；
> 没有服务时**脚本会自动从 8787 起找一个空闲端口启动**（旧端口已关闭也能重新打开）。
> `-Check` 仅用于“只想探测、不想启动”的场景。避免端口自增和 `cargo build` 的 exe 文件锁。
> G3DArmy 装配始终开启，无需额外参数。
> 见「AI 无视觉调试」。

### 可折叠 / 可调布局

- **左侧模型栏、右侧动画状态/属性栏、底部运行日志**都是抽屉：拖动边缘的分隔线调整大小（双击重置），
  点 `‹` / `›` / `收起` 折叠；折叠后从屏幕边缘的 `模型` / `属性` / `日志` 标签重新展开。
- **模型标签**（顶部筛选）和**模型列表**各自有 `▾` 折叠按钮；标签改为单行横向滚动，避免分组很多时占满侧栏。
- 尺寸与折叠状态保存在 `localStorage`（键 `g3dweb.layout.v2`），刷新页面自动恢复。
- AI / 自动化可直接使用 `window.__g3dwebLayout`（也在 `window.__g3dweb.layout`）：
  `setWidth('sidebar'|'inspector'|'bottom', px)`、`collapse(kind)`、`expand(kind)`、
  `toggleTags()`、`toggleList()`、`reset()`、`state`。

打开后自动发现 root 下的模型项目并动态分组；直接指向 `age3mudels/G3DArmy` 或 `ww1models/G3DArmy` 时扫描 `models/main/g3d`（分别为 21 / 33 个主模型）。同一父目录下的旧 `combos`、`ww1`、`ww1_climate` 等只是导出源，已有 `G3DArmy` 时不再重复列出。

| 参数 | 说明 |
| --- | --- |
| `-r, --root <DIR>` | 模型根目录/工作区；默认优先探测 `./G3DArmy`、`../G3DArmy`，再回退 `age3mudels`；可直接指向 `age3mudels/G3DArmy` 或 `ww1models/G3DArmy` |
| `-p, --port <PORT>` | 监听端口，默认 `8787`（被占用时自动向后尝试 20 个） |
| `--host <HOST>` | 监听地址，默认 `127.0.0.1` |
| `--open` | 启动后打开默认浏览器 |
| `--all` | 扫描整个 root（含 `runtime/parts` 368 件、`library` 72 件），并保留自动项目发现 |
| `--dev` | 前端资源从源码目录 `web/` 实时读取（改 UI 不用重新编译） |
| `--idle-timeout <SEC>` | 无请求多少秒后自动退出并回收端口；默认 300，0=关闭 |
| `-v` | 打印每个 HTTP 请求 |

### 自动项目发现 / 分类

默认不再硬编码 `<root>/combos`，而是递归发现 root 下的模型项目（最多 3 层）：

- 有 `combos/` 子目录的目录；
- 有 `README.md` / `parts.json` / `report.txt` / `*unitSelect.json` 且含 g3dj 的目录；
- `ww1`、`ww2`… 命名的目录且含 g3dj；
- `_work/` 下的预览项目也会被发现（`_probe`、`target`、`node_modules` 等跳过）。
- `--root` 既可以是工作区（多个项目），也可以直接是单个 `G3DArmy` 资源目录。
- `.../G3DArmy` 会以 **`父目录/G3DArmy`** 作为 project 标签，例如
  `age3mudels/G3DArmy`、`ww1models/G3DArmy`；直接指向该目录时也不会退化成裸 `G3DArmy`。
- 某个父目录下已有 `G3DArmy` 时，同级旧目录（`ww1`、`ww1_climate`、`combos` 等）只是导出源，
  不会作为独立项目重复列出；`runtime/`、`parts/` 也不会进入模型列表。

| 路径 | project | category | UI 分组 |
| --- | --- | --- | --- |
| `age3mudels/G3DArmy/models/main/g3d/foot_x.g3dj` | age3mudels/G3DArmy | foot | age3mudels/G3DArmy · 步兵 |
| `ww1models/G3DArmy/models/main/g3d/tank_x.g3dj` | ww1models/G3DArmy | tank | ww1models/G3DArmy · 坦克 |
| `combos/foot/foot_x/...` | default | foot | 步兵 |
| `combos/artillery/...` | default | artillery | 炮兵 |
| `ww1/foot_ww1_afr/...` | ww1 | foot | WW1 · 步兵 |
| `ww1/cavalry_ww1_horse/...` | ww1 | mounted | WW1 · 骑兵 |
| `ww1/tank_ww1_a7v/...` | ww1 | tank | WW1 · 坦克 |
| `ww1/combos/foot/...` | ww1 | foot | WW1 · 步兵 |
| `combos/ww1/...` | ww1 | foot/… | WW1 · … |
| `_work/preview_ww1/combos/unit_x/...` | preview_ww1 | unit | WW1 预览 · 部件 |
| `runtime/parts/...`（--all） | runtime | runtime | 零件 |
| `library/...`（--all） | library | library | 库 |

- 分类优先用路径里的类别目录（`foot/mounted/cavalry/artillery/ship/tank/mech/logistics/mg/vehicle`）；
  没有类别目录时，用模型目录名前缀：`foot_ww1_afr`→foot、`cavalry_ww1_horse`→mounted、
  `tank_ww1_a7v`→tank、`mg_ww1_ger`→mg、`logistics_ww1_truck`→logistics。
- `/api/models` 每项带 `project / category / group`；UI 标签是**动态生成**的，
  不再写死 `foot/mounted/artillery/ship`，新加 `ww2` 或新类别不需要改前端。
- 服务启动时扫描；新增/移动项目后重启服务（或用 `g3d-web-serve.ps1 -Build`）即可刷新列表。
- 支持 G3DArmy v4.2+ 布局：`<项目>/G3DArmy/models/main/g3d/*.g3dj` 会自动识别为项目
  `<项目>/G3DArmy`（如 `age3mudels/G3DArmy`），`models/parts` 作为挂件库，
  不会把 parts 当成独立模型列出。

### G3DArmy 自动装配

检测到 G3DArmy 资源目录后，每加载一个模型都会按游戏同款规则解析（始终开启）：

- 优先找模型上层的 **G3DArmy v4.2+ 布局**：
  `models/attachments.json`、`models/parts/{g3d,png,index.json}`、
  `models/assembly.json`、`models/main/g3d`、`loadSelect.json`、
  `loadSelect.override.json`、`civilization/<tag>.json`；旧
  `runtime/attachments.json + runtime/parts` 仍兼容；
- **v4.7 规则**（`web/runtime_rules.js`，与 `G3DArmyPlugin` v4.7.0 同步）：
  `loadSelect.json` 的 `unitSelect` 可以是**宗教块数组**（`[{ "religion": "Catholic", "0:Warior": {...} }]`）
  或旧格式对象；`unitgroup` 是文化组兜底（`unitgroup.<文化组>.<兵种>.level` 或直接按兵种写）；
  条目内优先级 `byId > religion > religionGroup > group > level > default`，
  `level` 支持 `0-3` / `7+` / `3` 三种写法，`@fallback_foot` / `@fallback_none` 按原版处理；
  模型整体顺序为 `civilization 文件 > 全局 unitSelect（宗教块）> unitgroup`；
- `civilization/<tag>.json` 使用**顶层 `unitSelect` / `shipSelect`**（数组或对象），
  旧写法 `loadSelect.unitSelect` / 扁平 `loadSelect` 仍兼容；
  `attachments` 下同样支持 `unitSelect` / `unitgroup` / `shipSelect`；
  `loadSelect.override.json` 的 `unitSelect` 数组块会**排在基础块之前**（与游戏合并顺序一致）；
- 按 token `<part>` 或 `<part>@<bone>` 加载 `parts/g3d/<part>.g3dj`；
  无 `@bone` 时用 `parts/index.json` 的 `mount.bone`，`skin` 模式按同名骨匹配；
  `@wea/@left/@spine1/@spine2` 别名与 G3DArmy 一致；
- 把 part 的 `bones[].invBind` 保持为单位阵（G3DArmy runtime attachment 约定）并改绑到目标骨骼；
- 应用 `attachments.strip`：combo 命中 `strip.combos` 时，先删除名字含 `strip.tokens`
  的 baked 武器/盾，再挂装配件；
- 按 G3DArmy v4.4 的 **武器决定动画**：读 `assembly.animDonors[<rig>.<武器族>]`，把 donor
  的动画轨道按 boneId 重绑到当前模型并替换动画；例如 `foot_euro_line` 挂弓会借
  `foot_eastasia_medieval` 的弓动画；
- 船模走 `attachments.shipSelect`，陆战走 `unitSelect / unitgroup`；旧字段 `rules` 仍兼容；
- 部件跟随目标骨架动画矩阵运动，但不参与本体包围盒/接触阴影；
- 右侧「G3DArmy 装配」面板显示规则、Group、文明覆盖、`religion / religionGroup`、
  `partsPng`、动画 donor 和已挂载部件；手动选择只用于调试，自动结果默认按模型反推。
- 攻击粒子首帧规则与游戏 `tickBattle(prev<0)` 一致：**进入战斗的第一次 tick 只补 `t≈0` 事件**，
  不补随机起始相位之前的历史事件；深链直接跳到事件时间时，先播放/回绕一帧即可触发。

示例：`ww1models/G3DArmy` 下加载 `foot_ww1_afr` 会自动匹配 `3:Archer / German`，
挂载 `weapon_ww1_rifle_ger`。
`G3DArmy` 资源目录可以用 `age3mudels/tools/export_g3darmy_layout.py` 从项目源目录生成。

### URL 深链 / 无头截图

```
/?model=combos/foot/foot_euro_ancient/foot_euro_ancient.g3dj&state=battle&t=1.0
/?model=...&state=battle&frame=42          :: 直接跳到第 42 帧
/?model=...&state=battle&frame=42&fps=30   :: 固定 30fps 的第 42 帧
/?model=...&state=idle&t=1.2&shot=1
```

`state` = `idle|move|battle|retreat`；`t` 为秒，`frame` 为帧索引（优先于 `t`）；
`fps` = `auto`（默认，源关键帧网格）或数字；`shot=1` 隐藏全部 UI，只留画布，
方便 `msedge --headless --screenshot` 或 Playwright 做回归截图。

## 界面

- **左侧**：模型列表（按 `project/category` 动态分组，可搜索；`--all` 时多出「零件/库」）。
- **中间**：3D 视口 + 运行日志/诊断。点击「管线自检」输出绑定矩阵、动画轨道、贴图、四态映射报告。
- **右侧**：
  - 四个状态按钮 + 当前状态的手动动画覆盖（下拉选择任意动画 ID）。
  - 播放/暂停/**±1 帧**/**按帧拖动**/速度/帧率；每个状态独立计时（与 G3DArmy 的 4 个控制器一致）。
  - 模型朝向、相机缩放、环绕/俯仰、自动适配占比、`fitByMax`、`worldH`。
  - 染色（玩家/敌/友/中立/自定义 + 强度）、脚底 AO、接触阴影、骨架线框、地面网格、全白模型。
  - 模型信息、绑定矩阵误差、警告列表。
- **快捷键**：`1–4` 切状态，空格播放/暂停，`←`/`→`（或 `,`/`.`）上一帧/下一帧，
  `R` 回到起点，`[`/`]` 上/下一个模型，`G` 网格，`S` 骨架，`W` 全白。

### 精确到帧

- 进度条是**整数帧滑块**（不是 0..1000 百分比）；拖动会**自动暂停**并吸附到帧。
  帧索引从 **0** 开始（`帧 0 / N-1`），与 g3dj 关键帧数组下标一致。
- 帧率默认 `源`：取动画**所有轨道关键帧时间的并集**，帧索引与 g3dj 关键帧严格对应；
  面板会显示源帧率（这批模型约 30.29fps）。骑乘/短轨道模型也覆盖完整动画时长。
- 也可切 24/25/30/50/60 固定帧率；时间 = 帧号 / fps。
- `-1f` / `+1f`（或 `←`/`→`、`,`/`.`）单帧步进：自动暂停，并跳到精确的帧时间。
- HUD 和播放面板同时显示 `帧 i / N`、当前秒数与帧率；无动画状态会禁用进度条。

## AI 无视觉调试（诊断 JSON / 文本摘要）

AI 没有屏幕时不要依赖截图。页面暴露 `window.__g3dweb`，`diagnose()` 会返回结构化 JSON
和一份带 **ASCII 部件图** 的文本摘要；`scanAnimation()` 会逐帧找最差帧。适用于 Copilot、
Playwright、CI 回归。

### 启动与深链（幂等复用 / 自动新端口）

AI 可以自行启动 `g3d-web`：没有可复用服务时，脚本会自动选择一个空闲端口（默认 8787 起 +20 扫描）
并启动独立后台进程；**旧端口关闭后再次调用即可重新打开**。如果只想探测不启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File modeltools\tools\g3d-web-serve.ps1 -Check
```

- `REUSE http://127.0.0.1:8787/ ...`：已有同 root 服务，直接用这个 URL。
- `STARTED http://127.0.0.1:8788/ ...`：脚本在空闲端口新启动的进程；用打印的端口。
- `NO_SERVICE`：仅 `-Check` 模式输出；如果确实需要调试，可去掉 `-Check` 让脚本自动选新端口启动。
- `-Build`：改了 Rust 才用；`-Dev`：只改 `web/*` 时用；`-Stop`：只停脚本记录在
  `target\g3d-web-serve.json` 的 PID。
- 所有启动默认带 `--idle-timeout 300`；页面每 20s 发 `/api/ping` 心跳，页面关闭/无人使用 5 分钟后进程
  自动退出并回收端口。需要更短可用 `-IdleTimeout 60`，0=关闭回收。
- **不要 `Stop-Process` 未知 `g3d-web.exe`**：并行会话/用户页面可能仍在用。
- 手动启动前先 `Invoke-RestMethod http://127.0.0.1:8787/api/health`；有匹配 root 的服务就复用。

```bat
:: 仅在没有服务时手动启动
target\release\g3d-web.exe --root ..\age3mudels\G3DArmy --port 8787
```

```
http://127.0.0.1:8787/?model=combos/mounted/mounted_arab_musket/mounted_arab_musket.g3dj&state=idle&frame=0&diag=1
```

端口以脚本输出的 `REUSE`/`STARTED` URL 为准。`diag=1` 会自动打开「AI 诊断」面板；
`state/frame/fps` 与普通深链一致。面板里的 `#ai-summary` 是可读摘要，`#ai-report` 是完整
JSON；`#btn-ai` 生成当前帧报告，`#btn-ai-scan` 扫描当前状态。

### 控制台 API

```js
// 1) 当前帧完整诊断（默认先渲染一次，保证投影 / ASCII 图有效）
const d = window.__g3dweb.diagnose();
console.log(d.summary);                       // 先看这段文本
console.log(d.verdict);                       // { level, reasons }
console.log(d.pose.distortion);               // 全局边长指标
console.log(d.pose.parts);                    // 每部件 badPct/level/badBones + type/socket/绑定偏移
console.log(d.pose.rig);                      // { roots, boneParts, tree }：骨→部件、绑定骨骼树
console.log(d.pose.binding);                  // 位置关系：rigid 挂件的 socket/local/world 偏移
console.log(d.pose.parts.map((x) => [x.char, x.type, x.accessory, x.relativeToBody])); // 配件相对 body 的位置
console.log(d.pose.relations);                // 配件-身体/配件-配件：centerDelta/gap/aabbOverlap/penetration
console.log(d.pose.clip);                     // AABB 近似穿模：suspectedCount/suspected；expected=同挂点/同骨架
console.log(d.pose.issues);                   // [{ kind: deformation|boneScale|clip|seat|data, severity, ... }]
console.log(d.verdict.scope);                 // 'deformation'：verdict 只针对边长变形
console.log(d.pose.seat);                     // 骑乘模型的坐点指标

// 2) 扫描当前状态所有帧；maxFrames 默认 240，完整扫描传 2000
const s = window.__g3dweb.scanAnimation({ state: 'battle', maxFrames: 2000 });
console.log(s.summary);
console.log(s.topFrames);

// 2b) AI 逐帧快速探测：只算绑定/边长变形，复用 bind 顶点与调色板缓存
// 比每帧调用 diagnose() 快很多；默认不生成 ASCII / 关系 / 穿模分析。
const p = window.__g3dweb.probeFrames({
  state: 'battle',
  maxFrames: 600,          // 最多采样帧数；默认 240
  maxTriangles: 600,      // 每部件最多抽样三角形
  includeParts: true,     // 每帧附带 parts 的 badPct/p99/maxDeform/badBones
  includeBones: true,     // 每帧附带 animatedBones
});
console.log(p.summary);
console.log(p.frames);      // [{ frame, time, badPct, p99, maxDeform, ... }]
console.log(p.worst);

// 也可以只探测指定时间/帧
window.__g3dweb.probeFrames({ state: 'battle', times: [0, 0.1, 0.2] });
window.__g3dweb.probeFrames({ state: 'battle', frames: [0, 30, 60] });

// 3) 跳帧 / 改状态 / 固定帧率，并立即返回诊断
const d2 = window.__g3dweb.set({ state: 'battle', frame: s.worst.frame, fps: 'auto' });
console.log(d2.summary);

// 4) 显示面板（参数缺省时重新 diagnose）
window.__g3dweb.showAiReport(d);
```

`diagnose({ render: false })` 可跳过渲染（但投影矩阵需已经由帧循环或上一次
`diagnose()` 建立）。`set()` 支持 `state / override / fps / playing / time / frame / placement / skeleton`。

**逐帧性能建议**：AI 不要对每个帧调用完整 `diagnose()`（它包含 CPU 蒙皮、ASCII
栅格化、部件相对位置/穿模关系、纹理/骨架树等全量数据）。用 `probeFrames()`：
绑定顶点 (`part._bindPositions`)、绑定尺度 (`part._bindStats`)、姿势缓冲
(`part._posePositions`) 和骨骼调色板 (`part._palette`) 都会复用，只重新采样动画和计算
抽样三角形变形；`maxTriangles` 控制单部件采样上限，`maxFrames` 控制帧采样上限。
需要完整诊断时只在**最差帧**调用一次 `diagnose()`/`scanAnimation()`；单帧快速检查可用
`diagnose({ light: true, includeParts: true })`（不生成 ASCII/relations/骨骼树）。

### AI 放置 / 三维移动旋转

坐标约定：自动适配完成后，模型脚底中心在场景原点；`position` / `pivot` 是场景单位（默认
`worldH=2.2` 时模型高约 `2.2 × fitPct`），`rotation` 是 XYZ 欧拉角（度），`scale` 支持
数字或 `[sx,sy,sz]`。旋转/缩放默认围绕脚底中心；可传 `pivot:'center'` 或自定义 `[x,y,z]`。

```js
// 绝对放置（未写的字段保持不变）
window.__g3dweb.placeModel({
  position: [0.3, 0, -0.2],
  rotation: [0, 90, 0],
  scale: 1.15,
  pivot: 'feet',
});

// 相对移动/旋转/缩放（便于逐帧脚本）
window.__g3dweb.moveModel([0, 0.1, 0]);       // 世界坐标
window.__g3dweb.moveModel([0, 0, -0.2], { space: 'local' });
window.__g3dweb.rotateModel([15, 0, 0]);       // XYZ 累加角度
window.__g3dweb.scaleModel(0.9);
window.__g3dweb.getPlacement();                // 返回矩阵 + 当前值
window.__g3dweb.resetPlacement();

// 直接写 16 元素列主序矩阵（高级用法；会覆盖 position/rotation/scale）
window.__g3dweb.setModelMatrix(matrix16);

// 世界点 → 屏幕像素（用于把 AI 想放置的位置换算到 canvas）
window.__g3dweb.worldToScreen([0, 1, 0]);
```

`window.__g3dweb.set({ position, rotation, scale, pivot, skeleton, bones })` 也可一次应用；
放置变换同时作用于骨架、接触阴影、攻击粒子锚点和 `diagnose()` 的屏幕投影。

### 骨架 / 绑定检查 + 高亮

UI「渲染」面板有 **骨架高亮** 开关和 **骨架模式**（全部 / 仅动画骨 / 选中骨 / 问题骨）；
高亮线跟随当前动画姿势，动画骨为橙色、未动画骨为青色、问题骨为红色、API 选中骨为黄色。
也可以完全用 API：

```js
const sk = window.__g3dweb.skeleton(); // 等价 getSkeleton()/bindings()
console.log(sk.summary);
console.log(sk.bindMaxError);          // 全局绑定误差
console.log(sk.bindBadParts);          // 绑定帧不一致的部件
console.log(sk.missingBones);          // g3dj bones[] 中不存在于节点树的骨（libGDX 会崩溃）
console.log(sk.bones);                 // id/parent/children/usedBy/animated/poseWorld/restWorld/delta
console.log(sk.parts);                 // 每部件 bones/bindError/bindTransform/runtimeAttachment

// 开骨架高亮并只显示指定骨（也可传 mode:'problems' 看 diagnose() 标记的问题骨）
window.__g3dweb.highlightBones(['Unit_Base_Rig_RightHand', 'Unit_Wea_Right_Hand01']);
window.__g3dweb.setSkeletonHighlight({ enabled: true, mode: 'problems' });
window.__g3dweb.setSkeletonHighlight({ enabled: false });
```

### 先看什么

1. `verdict.scope`（固定为 `deformation`）与摘要里的 `VERDICT ... (deformation only; ...)`；`level` 只针对边长变形。
2. `pose.distortion`：`badPct`、`p99Deform`、`nonFinite`、`collapsedEdges`；
   **不要只看 `maxDeform`**。单条缝合边可能很大，但 `badPct` 很低。
3. `pose.parts[].distortion`：每个部件的 `badPct / level / badBones / maxDispBone`，以及
   `deformMechanism`（`skinning / rigid / boneScale / node`）。
4. `pose.parts[].type`：`rigid`（1 骨挂件）/ `skinned`（多骨蒙皮）/ `static`；
   rigid 看 `socket`、`bindOffsetLocal`，skinned 看 `boneIds / usedBones / boneUsage`。
5. `pose.parts[].accessory` / `relativeToBody`：配件相对身体的距离/offset/AABB 关系；
   `pose.relations` 是配件与身体、配件与配件的成对关系；`pose.clip` 汇总疑似穿模。
6. `pose.binding`（位置）、`pose.issues`（按 `kind` 分类）与 `pose.rig` 的 `boneParts/tree`。
7. `pose.seat`（有 saddle 时）：`hipsAboveSaddleTop`、`hipsHorizontalFromSaddleCenter`（位置）。
8. 摘要末尾的 ASCII 部件图（字符对应 `legend`）与 `screenBBox/clipped`。

### 位置 vs 变形（必须区分）

**只有 `pose.distortion` / `parts[].distortion` 是边长变形。**
`type/socket/bindOffsetLocal/bindOffsetWorld/currentOffsetWorld/centerDelta` 是**绑定位置或运动**；
`seat.*` 是**坐点位置**。

| 部件类型 | 合法位置关系 | 变形判据 / 机制 |
| --- | --- | --- |
| `rigid`（1 骨） | 挂点 offset 可以很大（武器/帽子/头） | `badPct≈0`；若 >0 看 `mech=boneScale/rigidAnomaly`，不是蒙皮 |
| `skinned`（多骨） | 关节处少量 badPct 正常 | `badPct/p99/badBones` + `boneUsage` = 蒙皮拉伸 |
| `static`（无骨） | 仅节点变换 | `mech=node`；看节点缩放 |

- `verdict.scope='deformation'`；`level` 只由边长变形/非有限/投影决定；
  `BINDING`/`SEAT` 是 info，不升级 error。
- `pose.issues[].kind`：`deformation | boneScale | clip | seat | data`；先分类再回答。
- 回答“模型扭曲”前必须找到 `DEFORMATION` 行或 `parts[].distortion.badPct` 的高值；
  **不能因为 `BINDING` 的 local offset、`SEAT` 的 horizontal 或 `RELATIONS` 的 AABB overlap 就说扭曲**。

### 配件相对位置 / 穿模（relations / clip）

- `pose.parts[].accessory`：`true` 表示刚性/静态/运行时挂件（武器、帽子、装备）或 `!isBody` 部件。
- `pose.parts[].relativeToBody`：最近身体部件的 `centerDelta`（身体→配件的世界向量）、
  `centerDistance`、`gapDistance`、`aabbOverlap`、`penetration`、`expected`、`relation`。
- `pose.relations[]`：每对配件-身体/配件-配件都有：
  - `centerDelta / centerDistance`：相对位置（世界坐标，单位与模型一致）；
  - `gap / gapDistance`：AABB 分离距离（0 = 包围盒相交/接触）；
  - `aabbOverlap`、`overlap`、`penetration`、`overlapRatio`、`overlapVolume`；
  - `screenOverlap`：屏幕投影包围盒重叠率（用于判断是否“看起来”重叠）；
  - `expected` / `expectedReason`：`same-socket`、`socket-on-other-part`、`same-skeleton-group`
    表示同挂点/手持/同骨架，不等于穿模；
  - `suspectedClip` / `relation`：`possible-clip` 是疑似穿模，`expected-overlap` 是预期重叠，
    `separate`/`touching` 是分离/接触。
- `pose.clip`：`suspectedCount`、`relationsTotal`、`suspected[]`、`method='aabb'`。
  **AABB 相交不是精确三角形碰撞**（尤其会受长武器/大包围盒影响）；
  先看 `expected=false` + `screenOverlap.ratio` + `centerDelta/gap` 再下结论。
- `pose.issues[].kind='clip'` 只把 `suspectedClip` 加入 issues，不会改变 `verdict.scope='deformation'`。

### 绑定 / 挂点位置关系

- **rigid 挂件**（1 骨）：`socket` 是挂点骨；`bindCenter` 是绑定姿态包围盒中心；
  `bindOffsetLocal` 是**骨骼局部坐标下的挂点偏移**（最关键）；`bindOffsetWorld` 是模型空间
  （绑定姿态）的偏移；`currentOffsetWorld`/`centerDelta` 是当前动画帧相对挂点/绑定的变化。
- **skinned 蒙皮件**（多骨）：`boneIds` 是声明的骨骼，`usedBones` 是实际有权重的骨，
  `distortion.boneUsage` 是 dominant 骨占顶点百分比；`rig.boneParts` 可反查骨影响哪些部件。
- **骨骼树**：`pose.bones[]` 有 `rest/bindWorldPos`（绑定世界位置）、`pos`（当前）、
  `bindLocal`（绑定局部 TRS）、`parent/children/depth/usedBy`；`rig.tree` 是缩进文本版。

示例（`foot_arab_line` move frame0）：

```text
BINDING(rigid; position; not deformation): 3=head@Unit_Base_Rig_Head local=[0,-12.247,-2.082] ;
  4=hat@Unit_Base_Rig_Head local=[-0.871,11.289,-0.759] ;
  5=weapon@Unit_Wea_Right_Hand01 local=[-2.48,0.168,-36.114]
RIG(skinning bones): 1=torso bones=24 usage=LeftHand/RightHand/... ;
  2=legs bones=10 usage=LeftFoot/RightFoot/...
```

这表示 head 与 hat 都挂在 Head 骨（hat 在局部 Y 上更高），火枪挂在右手骨，
沿手骨局部 -Z 方向约 36 单位。它们都是**位置关系**，不是边长变形。

当前文件 `mounted_arab_musket` idle 的示例（文件可能被重新生成，以 live 为准）：

```text
VERDICT WARN (deformation only; binding/seat are position): badPct≈0.698%
DEFORMATION(parts): 1=torso mech=skinning bad=1.381% ; 2=legs mech=skinning bad=2.222%
BINDING: 6=hat@Unit_Base_Rig_Head local=[...] ; 7=pistol@Unit_Wea_Right_Hand01 local=[-0.157,0.195,-9.613]
SEAT(position; not deformation): ... hipsHorizontalFromSaddleCenter≈65
issues: deformation/warn[1], deformation/warn[2], seat/info
```

躯干/腿的 `badPct` 是蒙皮变形；鞍座/手的 offset 是位置；坐点 horizontal 大也只是位置。

当前判定阈值（`app.js`）：

- **error**：`nonFinite`，或总 `badPct >= 2%`，或（`badPct >= 0.5%` 且 `p99 >= 15`）。
- **warn**：总 `badPct >= 0.2%`，或 `p99 >= 5`，或（`maxDeform >= 8` 且坏三角形 >= 2），
  或存在完全压扁的边（`minSquash <= 1e-6`）。
- **部件级**：`nonFinite` / `badPct >= 5%` /（`badPct >= 1%` 且 `p99 >= 10`）为 error；
  `badPct >= 1%` / `p99 >= 5` / `maxDeform >= 8` 为 warn。
- 微小缝合边（小于部件绑定尺度的 0.2%）会忽略；完全压扁的边用 `maxDeform=1e6` 作为哨兵，
  同时给出 `minSquash≈0` 与 `collapsedEdges`，不会写入 `Infinity`。

### 常见故障对照

- `badBones` 集中在 `...RightForeArm / RightHand / RightArm`，而 `cavalry_horse` 很干净：
  优先怀疑 **骑手动画重定向 / 骨骼绑定**，不是坐点。
- `seat.hipsHorizontalFromSaddleCenter` 接近或超过鞍座长度的一半、`hipsAboveSaddleTop`
  明显偏离：这是**位置**，不是边长变形；用 `_probe` 变体比较坐点。坐点通常只改变位置，
  不改变 `badPct`；如果所有坐点变体都 error，问题在骨骼/动画。
- `rigid` 部件 `badPct>0` 时看 `deformMechanism`：`boneScale` = 挂点骨缩放，`rigidAnomaly` = 矩阵/权重异常；
  没有 `skinning` 的刚性件不应该有蒙皮拉伸。
- `bindMaxError > 0.01`：`node.parts[].bones[]` 很可能写成了 `inv(C)`；正常应写绑定世界矩阵 `C`。
- `shortTailTracks > 0` / 当前帧处于短轨道尾段：libGDX 会回卷外插；用「尾帧钳制」对比。
- `gridCells = 0` / `nonFinite = true`：投影失败、NaN/Inf 顶点或零尺度；后台标签页可能没有
  有效画布尺寸，先把页面切到前台或等一帧再 `diagnose()`（`pose.rig`/`parts` 数据仍有效）。
- `sourceFps` 是**单条轨道的中位关键帧率**；`gridFrames` 是**所有轨道关键帧的并集**。
  骑乘模型可能有骑手/马两套网格（例如 33.2ms + 26.9ms），`gridFrames` 会大于
  `duration * sourceFps`。要严格对应 g3dj 关键帧用 `auto`；要均匀帧用固定 fps。

> 2026-10-17 这批 combo 的实测：`mounted_arab_musket` idle 为 error，`badPct≈12.4%`，
> `badBones` 为 `RightForeArm/RightHand/RightArm`，`maxDispBone=RightHand disp≈192`，
> 同时 `seat.horizontal≈65`；`foot_*` 多为 warn（0.2%–0.8%，关节/手部少量三角形）；
> `ship_galley` 为 warn（收帆导致 `minSquash=0`、`collapsedEdges>0`）。这是数据诊断，
> 不代表渲染器崩溃。

## 与 G3DArmy 的逐项对应

| G3DArmy / libGDX | 本工具实现 |
| --- | --- |
| `G3DArmyMin.init()` 正交相机 `pos=(0,0.886H,1.136H)`、`lookAt=(0,0.432H,0)`、`viewportHeight=H` | `renderer.js` `render()` 中的 `mat4LookAt/mat4Ortho`（默认参数完全一致，额外滑杆只用于调试） |
| 环境光 `(0.52,0.49,0.44)` + 平行光 `(0.85,0.79,0.66)`、方向 `(-0.9,-1.3,-0.7)` | 主着色器 `AMBIENT` / `LIGHT_COLOR` / `LIGHT_DIR`，片元 `diffuse * (ambient + NdotL * light) + emissive` |
| `buildUserInstances/buildModelSet` 自动适配：`worldH*fitPct/ref`、脚底贴地、水平居中 | `renderer.js` 每帧根据 `bounds` 计算 `fit = T*S`，`modelFitBy=height/max` |
| `bounds` = `computeBodyBounds()`：第一根骨骼的 `bindWorld * invBind`、脚底 12% 带锚点、±35% 限幅 | `g3dj.js` `computeBodyBounds()`，逐顶点两遍扫描 |
| `buildSoftShadow()` 64×64 `(1-d)^2*0.42`、直径 1.24、主阴影 0.75 + 0.6 核心 | `renderer.js` `createShadowTexture()` + `drawShadow()`（深度写入关闭，视觉等价） |
| `applyVerticalShade()`：全局 Y 范围、`k=bottom+(1-bottom)*pow(t,1.3)`、有顶点色的网格跳过 | `renderer.js` `setModel()` 生成每顶点颜色；`isUniformVertexColor()` 复刻均匀顶点色剥离 |
| `applyTint()/resetTint()`：`base+(tint-base)*strength`、跳过 `head/skin` 材质 | `renderer.js` 绘制循环中的材质漫反射色计算 |
| `resolveAnim()`：`idle/stand/...`、`walk/run/move/...`、`attack/battle/...`、`retreat/flee/run/...`；撤退回退移动 | `g3dj.js` `KW_*` 与 `resolveAnim()` 逐字复刻；UI 显示“回退” |
| 每帧更新 **4 个状态控制器**，切状态相位连续；`setAnimation(id,0,-1,-1,speed)` 无限循环 | `app.js` 每个状态独立 `times[]`，所有状态同时推进，按 `duration` 回卷 |
| `AnimationController` 关键帧：`keytime/1000`、线性 T/S、四元数 slerp（`1-|dot|<=0.1` 退化为 nlerp） | `g3dj.js` `sampleVector/sampleQuat`，逐行对照反编译的 `BaseAnimationController`/`Quaternion` |
| `getFirstKeyframeIndexAtTime()` 时间超出尾帧返回 0 → 后续外插 | 默认严格复刻；勾选「尾帧钳制」可改为停最后一帧 |
| `NodePart.bones[i] = bone.globalTransform * inv(bones[i].TRS)` | `renderer.js` 每部件调色板；`u_bones` uniform 数组，着色器按权重累加 |
| 静态部件 `world = instance * node.globalTransform`；蒙皮部件只用 `instance` | 绘制循环里按 `part.bones.length` 区分 |
| 纹理 `Gdx.files.absolute(modelDir/file)` → `png/` → `basename`；Linear、Repeat；占位白贴图 | `g3dj.js` 候选路径 + `renderer.resolveTexture()`；缺贴图用 1×1 白 |
| `applyVerticalShade` 前先 `stripUniformVertexColors` | `renderer.isUniformVertexColor()` |
| 灰白自发光（`cccccc`）归零 | `g3dj.js` 材质解析时归零 |

## 自检能发现什么

加载时会自动检查并写入日志/右栏：

1. **绑定矩阵**：每个 `node.parts[].bones[]` 的 TRS 组合矩阵是否等于节点树绑定世界矩阵。
   `>0.01` 时标红并提示“可能把 `inv(C)` 写进了 `bones[]`”（真机“细长竖条”的根因）。
2. **权重**：每个部件的权重索引是否越界、权重和是否 ≈1。
3. **动画轨道**：`idle/move/battle` 的时长、轨道数；**尾帧早于动画时长**的轨道数
   （libGDX 会在尾段回卷到第一段做外插，可能出现扭曲）。
4. **结构**：缺失节点/骨骼/材质/贴图、重复 id、未引用 meshpart、非 TRIANGLES 图元等。
5. **四态映射**：哪个关键词命中、哪些状态是回退、哪些状态只能程序化动作。

> 实测 `mounted_euro_knight` 有 **286 条短轨道**（骑手 3.23s、`root` 4.30s）→ 默认严格模式会复现
> libGDX 的尾段外插；勾选「尾帧钳制」可直接对比“设计意图”和“引擎实际”。

## 已知差异 / 边界

- **只支持 g3dj**；g3db 需要 UBJSON 解析，暂未实现。
- 我们的资产只有 DIFFUSE 贴图；法线/镜面/反射贴图与 fog/shadowMap 未实现（默认着色器在这些 Attribute
  存在时才会有额外分支）。
- WebGL1 + 非 2 的幂贴图：libGDX 的 `REPEAT` 在 GLES2 下不完整，本工具改用 `CLAMP_TO_EDGE` 并提示。
- **长模型自动 `fitByMax`**（马/象/船）是本工具的便利默认；G3DArmy 默认是 `height`。
  取消勾选「按最大边适配」即可回到默认。
- 默认「模型朝向 180°」是为了直接看正面；G3DArmy 的朝向来自行军方向（`modelYaw=0`）。
  点击「朝向 0°（G3DArmy）」恢复。
- 阴影/骨架/网格是调试辅助；阴影关闭深度写入以避免与核心阴影互相遮挡。

## 文件结构

```
modeltools/
  src/bin/g3d_web.rs      本地 HTTP 服务（内嵌资源、模型扫描、路径穿越防护）
  web/index.html          页面骨架
  web/style.css           深色 UI
  web/app.js              模型列表 / 四态控制器 / 控件 / 自检
  web/g3dj.js             g3dj 解析、绑定/动画采样、四态映射、包围盒
  web/renderer.js         WebGL 渲染器（蒙皮/光照/阴影/骨架/网格）
  web/math.js             列主序矩阵 / 四元数（对齐 libGDX 约定）
```
