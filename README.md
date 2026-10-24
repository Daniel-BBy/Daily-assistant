# 每日简报（天气增强版 + 自算风险 + 今日课程）

太仓的每日简报：气温、降水、风、紫外线、穿衣建议，加一层**自算风险提示**，再加**今日课程**。
纯 Node 内置能力，**零依赖、零密钥**（除了将来要接官方预警时才需要）。

同一套纯逻辑跑三个地方：命令行、Windows 定时任务、手机网页。业务代码只有一份。

## 目录

```
data/brief.config.json     城市坐标、阈值、投递方式、文件路径
data/term.json             校历周次表（学期 / 周次 / 假期）
course_schedule.csv        课表（Day,Time,Course,Weeks,Teacher,Room）

scripts/openmeteo.js       天气取数（纯函数，浏览器可用）
scripts/risks.js           阈值判定（纯函数，浏览器可用）
scripts/courses.js         课表解析 + 周次定位 + 渲染（纯函数，浏览器可用）
scripts/render.js          文本渲染（纯函数，浏览器可用）
scripts/courses-cli.js     课表 CLI（唯一含 node: 依赖的部分已拆到这类文件）
scripts/brief.js           简报 CLI 入口
scripts/build-web.js       把可复用模块和数据收进 web/
scripts/run-brief.cmd      Windows 启动包装（固定 Node 路径）

web/                       手机页（可直接部署到静态托管）
  index.html  app.js  style.css  icon.svg  manifest.webmanifest
  lib/        构建产物：浏览器可用的四个模块
  data/       构建产物：term.json / 课表 / 配置

test/risks.test.js         18 个单测，不联网
test/courses.test.js       21 个单测，不联网
```

> 为什么分 `courses.js` 和 `courses-cli.js`：ES 模块在加载时就会解析所有 import。只要 `courses.js` 顶上有一行 `node:fs`，浏览器就会整包加载失败。纯逻辑留在 `courses.js`，读文件的事挪进 CLI。

## 运行

```bat
scripts\run-brief.cmd
```

或直接：

```powershell
& "C:\Users\daniel\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" scripts\brief.js
```

输出示例（真实拉取）：

```
【太仓 · 10-23 周五】
气温 14.7~23.5℃（体感 13.9~22.8℃）
天气 阵雨 · 降水概率 98%
降水 全天 8.6mm，小雨量级，最大 12h 8.6mm
风 东北风，5.4 m/s，阵风 10.9 m/s（6 级）
紫外线 UV 4.2
穿衣 薄外套 + 长袖；早晚略凉，备一件外搭；带伞；风大，注意防风

风险提示（自算，非官方预警）
⚠ 风力偏大：阵风 10.9 m/s（6 级）

官方预警：未接入（本简报不含官方气象预警信息，台风、暴雨红色预警等请以气象台发布为准）
```

其他用法：

| 命令 | 作用 |
|---|---|
| `--json` | 输出结构化 JSON（含 `items`、`derived`、`text`），给下游程序用 |
| `--webhook` | 按配置 POST 到 webhook（也可在配置里把 `delivery.mode` 改成 `webhook`） |
| `--config <path>` | 换一份配置（比如给别的城市） |

退出码：`0` 成功；`2` 天气取不到（已输出降级文本）；`1` 配置错误。

## 数据来源与字段

Open-Meteo `/v1/forecast`，坐标写死在配置里（`31.4478, 121.0939`）——**不用地名查**，因为"太仓"会命中安徽马鞍山和河南洛阳的同名地点。

请求的字段：

```
current: temperature_2m, apparent_temperature, relative_humidity_2m, weather_code,
         wind_speed_10m, wind_gusts_10m, is_day
hourly:  temperature_2m, apparent_temperature, precipitation, precipitation_probability,
         weather_code, visibility, wind_gusts_10m, snowfall
daily:   weather_code, temperature_2m_max/min, apparent_temperature_max/min,
         precipitation_sum, precipitation_probability_max, rain_sum, showers_sum,
         snowfall_sum, wind_speed_10m_max, wind_gusts_10m_max,
         wind_direction_10m_dominant, uv_index_max, sunrise, sunset
```

风速统一 `m/s`（`wind_speed_unit=ms`），否则风级换算会错。时区固定 `Asia/Shanghai`，不用 `auto`——"今天"的定义不该随宿主机器变。

## 自算风险：判什么、按什么标准

| 项 | 触发条件 | 依据 |
|---|---|---|
| 大风 | 阵风 ≥10.8 m/s（6 级）提示，≥13.9（7 级）告警 | 蒲福风级 GB/T 28591 |
| 降水 | 24h 累计 ≥10mm 提示，≥50 暴雨量级，≥100 强降水 | 降水量等级 GB/T 28592 |
| 降雪 | `snowfall_sum > 0` | — |
| 高温 | 最高 ≥35℃ 提示，≥37℃ 告警 | 气象学高温日定义 |
| 寒潮 | 48h 降温 ≥8℃ 且第 3 天最低 ≤4℃ | 寒潮定义 |
| 大雾 | 06–10 点最低能见度 <1000m | 雾的等级 GB/T 27964 |
| 道路结冰 | 最低 ≤0℃ 且有降水 | — |
| 雷电 | 天气代码 95/96/99 | WMO |
| 紫外线 | UV ≥8 | WHO UV 指数 |

阈值都在 `data/brief.config.json` 的 `thresholds` 里，按需改。

**边界（重要）**：
- 这些是**风险提示**，不是气象预警信号，颜色等级（蓝黄橙红）在本模块中**不存在**。
- 台风算不了：Open-Meteo 没有热带气旋路径产品。太仓靠海，台风季请以气象台为准。
- 自算的误报率高于官方会商，尤其局地强对流。

## 降级与"沉默不等于安全"

| 情况 | 输出 |
|---|---|
| 接口超时/5xx（重试 2 次后） | `⚠️ 天气数据获取失败` + `今日天气未知，请勿据此安排出行`，**不出现任何温度/降水数字** |
| 某项字段缺失 | 跳过该项判定，不猜测 |
| 没有风险项 | 明确写 `今日无明显风险项` |
| 官方预警 | 恒输出 `官方预警：未接入（…）`——不会因为没写就等于"没事" |

## 加官方预警（预留位）

`--json` 输出里已固定带一个字段：

```json
"alerts": { "official": false, "reason": "未接入官方预警源" }
```

要接官方源，最小改动是：在 `brief.mjs` 里给 `alerts` 赋值，并在 `render.mjs` 的风险段落前插一行官方预警原文。推荐和风天气 `GET /weatheralert/v1/current/{lat}/{lon}`（就是 CMA 预警的授权转发，无预警时 `zeroResult: true`）。

## 定时（每天 08:30）

Windows 任务计划程序：

```bat
schtasks /create /tn "DailyWeatherBrief" /sc daily /st 08:30 ^
  /tr "\"C:\Users\daniel\Desktop\Assistant\scripts\run-brief.cmd\" > \"C:\Users\daniel\Desktop\Assistant\data\brief.log\" 2>&1"
```

查看：`schtasks /query /tn "DailyWeatherBrief" /v /fo list`
删除：`schtasks /delete /tn "DailyWeatherBrief" /f`

注意：`schtasks` 的 `/tr` 对引号敏感，若报错，改用「任务计划程序」图形界面新建"启动程序"，程序填 `run-brief.cmd` 的完整路径即可。

## 今日课程

数据：`course_schedule.csv`（6 列）+ `data/term.json`（校历周次表）。

```
今天日期 → 查 term.json 找到学期块 → 得到第几周 / 是否教学周
        → 按「星期 + 周次」过滤 CSV → 排序 → 渲染
```

**周次是查表得来的，不是算出来的。** 用 `(今天 - 开学日) / 7` 会因为国庆那周（9/28–10/04）没有周次编号而从 10/05 起整体错位一周，之后全错。

`term.json` 里两类"不上课"必须分开表达：

| 写法 | 含义 | 输出 |
|---|---|---|
| `week: null` + `teaching: false` | 该段不属于任何教学周（国庆、阅读周、考试周、寒暑假） | `今天没有课：国庆假期（学校关闭）` |
| 教学周 + `holidays` 命中 | 教学周里的单日假日（中秋 9/25、清明 4/5、劳动节 5/3 与 5/4） | `今天没有课：中秋节放假` |

两者不能都当成"跳过一周"，否则要么少算一周、要么把整周误判为放假。

其他规则：

- **周次字段支持自由写法**：`5, 11`、`1, 4, 8, 10`、`1-3, 4-5`、`8-13`、`1, 3, 4-6, 8-10`。解析失败**报错并带行号**，绝不静默跳过（跳过会让某门课在几周里凭空消失）。
- **CSV 走真正的最小解析器**：`Weeks` 含逗号且被引号包裹，`split(',')` 会切错。
- **跨校区标出来**：`SIP-*` 在苏州校区、`TC-*` 在太仓校区。
- **同时段两门课**并列输出并标 `⚠ 时间冲突`，不替你选。
- **下一节**：往后 21 天内找最近一天有课的日子。

单独预览：

```bat
node scripts\courses.mjs                    :: 今天
node scripts\courses.mjs --date 2027-05-05  :: 指定日期
node scripts\courses.mjs --json             :: 结构化
```

## 手机页

`web/` 是一个纯静态站点：打开就显示今天（或任选一天）的课程与天气，手机浏览器直接可用。

### 构建

```bat
node scripts\build-web.js
```

它把四个浏览器安全的模块和数据复制进 `web/lib`、`web/data`。改动 `scripts/` 后要重新跑一次。

### 本地预览

```bat
:: 只在本机看
python -m http.server 8099 --bind 127.0.0.1 --directory web

:: 手机同 WiFi 下访问（会暴露给局域网，看完记得关）
python -m http.server 8099 --bind 0.0.0.0 --directory web
```

手机打开 `http://<电脑的局域网 IP>:8099`（本机示例：`192.168.1.101`）。Windows 防火墙首次会弹窗，允许即可。

> 注意：不能用 `file://` 直接打开 —— ES 模块在 file 协议下会被跨域策略拦住。

### 部署

`web/` 里有两类东西，分清楚才好换托管：

|  | 是什么 | 进 git 吗 |
|---|---|---|
| `web/index.html`、`app.js`、`style.css`、`icon.svg`、`manifest.webmanifest` | **源文件**，手写 | ✅ 进 |
| `web/lib/`、`web/data/` | **构建产物**，由 `npm run build:web` 从 `scripts/`、`data/` 复制 | ❌ 不进（`.gitignore` 已排除） |

所以线上发布前必须先构建。CI 里已经写好了这套流程。

#### 目标 A：GitHub Pages（零配置，5 分钟）

1. 把仓库推到 GitHub（public；private 仓库需要 Pro 才能用 Pages）
2. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**
3. 之后每次 push 到 `main`，`.github/workflows/deploy-pages.yml` 会自动测试 → 构建 → 发布
4. 地址是 `https://<用户名>.github.io/<仓库名>/`

⚠️ 中国大陆访问 `*.github.io` 时快时慢。如果发现不稳定，只换部署目标，前面几步都不变。

#### 目标 B：腾讯云开发 CloudBase（国内可达，需实名）

国内可直接访问、并且**默认域名不需要备案**的静态托管。

1. 注册腾讯云并实名
2. 开通「云开发 CloudBase」→ 新建环境
3. 本地构建后，用 CloudBase CLI 上传 `web/`：

```bash
npm i -g @cloudbase/cli
tcb login
tcb hosting deploy web -e <你的环境ID>
```

4. 拿到默认域名 `https://<环境ID>.tcloudbaseapp.com`，国内直连可用

想绑自己的域名：CloudBase 支持，但**绑自定义域名就需要备案**（因为落在大陆节点）。不绑就免备案。

#### 目标 C：自己的服务器（需备案域名才好看）

```bash
rsync -avz --delete web/ user@your-server:/var/www/brief/
```

没有域名也能先用 `http://<IP>/` 访问，只是没有 HTTPS、浏览器会提示不安全。

#### 三个容易踩的坑

1. **`web/lib` 没构建就上传** → 页面空白，控制台报 404 或 MIME 错误。
2. **CDN 缓存了旧的 `index.html`** → 改了课表但手机上还是旧的。强制刷新（长按刷新 / 无痕窗口）能验证是不是缓存。
3. **仓库是 private** → GitHub Pages 免费版不支持，需要 Pro 或改成 public。

放好之后在手机浏览器里"添加到主屏幕"，就有了图标和全屏，效果接近原生 App，不用打包 APK。

### 与命令行版的关系

| | 命令行 | 手机页 |
|---|---|---|
| 逻辑 | `scripts/*.js` | `web/lib/*.js`（同一份文件的复制） |
| 渲染 | 纯文本（给消息用） | HTML（给屏幕用） |
| 天气 | Node `fetch` | 浏览器 `fetch` |
| 时区 | `Asia/Shanghai` | 同 |

浏览器里没有 `process`、不能读本地文件，所以数据走 `fetch`、函数保持纯 —— 这一点从第一版就是这么设计的，所以搬到浏览器几乎零改动。

## 测试

```bat
"%NODE%" test\risks.test.js
"%NODE%" test\courses.test.js
```

共 39 个用例：风级/雨量/能见度边界、四项风险同时命中、降级不输出数字；周次表的 13 个关键日期（含 `10/05 必须是第 4 周`、`5/3 与 5/4 放假但 5/5 上课`）、7 种周次写法、坏数据报错、真课表 30 行零冲突。

> 注意：`node --test test/` 在本环境会因沙箱禁止派生子进程而报 `EPERM`，直接执行测试文件即可（node:test 会在同进程内运行）。

## 下一步（可选）

1. **接 QQ**：`delivery.mode` 改成 `webhook` 并填一个推送服务的 URL；或走小号 NapCat。
2. **接官方预警**：见上一节。
3. **接待办**：再加一个数据源和一段渲染即可，`renderBrief` 已经是纯函数。
4. **接行程**：与课程并列，复用同一套"日期 → 今天"的定位逻辑。
