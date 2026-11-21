---
title: "在树莓派上驱动 4.2 寸墨水屏：一个常亮的时钟日历看板"
author: "Lee"
pubDatetime: 2026-11-21T11:30:00Z
featured: false
draft: false
tags:
  - Raspberry-Pi
  - E-Paper
  - Python
  - Hardware
  - IoT
description: "用树莓派 3B+ 驱动 Waveshare 4.2 寸 400×300 墨水屏，把它做成床头常亮时钟：自绘版面、自己实现局部刷新（8 像素对齐 + 补码缓存）、每分钟只刷时钟区、整点全屏刷新，再挂成 systemd 服务。附驱动代码与踩坑记录。"
timezone: "Asia/Shanghai"
---

床头一直缺一个"抬头就能看"的钟：手机上滑一下也能看时间，但每次都要拿起手机，然后顺手刷二十分钟。

墨水屏很适合干这件事——断电保图、没有背光、阳光下反而更清楚，而且内容基本不变，一整天耗电不到一个手机的零头。唯一别扭的是刷新慢（整屏 2 秒左右），所以不能像 LCD 那样整屏重绘，得把"每分钟变化的时钟"和"基本不动的日历"分开刷。

这篇记录我在树莓派 3B+ 上把一块 Waveshare 4.2 寸墨水屏做成常亮看板的过程：驱动、版面、局部刷新、systemd 常驻，以及实际踩过的坑。成品现在每天 7×24 跑着，一分钟刷新一次时钟，整点全屏刷一次防残影。

<img src="/images/pi-epaper-clock/preview.png" alt="墨水屏看板渲染预览：顶部日期与天气，左侧大号时钟、农历与月相，右侧月历，底部设备信息" />

（上面这张是屏幕上 400×300 的实际渲染帧，用 Pi 上同一份 `render.py` 生成，不是后期拼的。）

---

## 1. 硬件清单

| 部件 | 型号 / 说明 |
| --- | --- |
| 主控 | Raspberry Pi 3 Model B+（926MB RAM，microSD 29G） |
| 屏幕 | Waveshare 4.2 寸 e-Paper，400×300，SPI 接口，驱动 `epd4in2` |
| 连线 | 母对母杜邦线 8 根 |
| 电源 | 5V 2.5A 官方电源（墨水屏刷新瞬间电流不小，劣质电源会花屏） |
| 系统 | Raspberry Pi OS / Debian 13 (trixie)，Python 3.13.5 + Pillow 11.1.0 |

一个容易买错的地方：**这条产品线按驱动分 4.2 寸和 4.3 寸两种**，外形几乎一样，丝印上也常写 4.3。我手上这块按驱动算是 4.2（`epd4in2`，400×300），买配件、查 wiki 时以驱动型号为准。

## 2. 接线

Waveshare 的 8 针排线，接树莓派 40Pin 的 SPI0：

| 屏幕引脚 | 树莓派（BCM） | 物理引脚 |
| --- | --- | --- |
| VCC | 3.3V | 1 |
| GND | GND | 6 |
| DIN | GPIO10（MOSI） | 19 |
| CLK | GPIO11（SCLK） | 23 |
| CS | GPIO8（CE0） | 24 |
| DC | GPIO25 | 22 |
| RST | GPIO17 | 11 |
| BUSY | GPIO24 | 18 |

CS 走硬件片选，其余是普通 GPIO。树莓派 3B+ 只有一组 SPI（SPI0），所以用 CE0 就够了。先开 SPI：

```bash
sudo raspi-config          # Interface Options → SPI → Yes
# 或者直接写 /boot/firmware/config.txt：dtparam=spi=on
ls /dev/spidev0.0          # 出现即正常
```

## 3. 驱动：先让屏幕亮一次

用 Waveshare 官方 Python 库（仓库里的 `RaspberryPi_JetsonNano/python`），依赖就三个：`python3-pil`、`python3-numpy`、`spidev`。

```python
from waveshare_epd import epd4in2
from PIL import Image, ImageDraw

epd = epd4in2.EPD()
epd.init()
epd.Clear()                        # 整屏刷白，约 2s

img = Image.new("1", (epd.width, epd.height), 255)   # 1bit：0=黑，255=白
d = ImageDraw.Draw(img)
d.text((20, 20), "hello e-paper", fill=0)

epd.display(epd.getbuffer(img))    # getbuffer：PIL 图 → 1bit 字节流
epd.sleep()                        # 进深睡眠，否则一直耗电
```

这里有两个约定值得先记住：

- **图像是 1bit 的**，`Image.new("1", ...)`，每个像素只有黑/白。所有灰色、抗锯齿都不要指望（灰度可以用二值化抖动模拟，但字号小的时候会很脏）。
- **`epd.sleep()` 不是可选项**。不睡的话屏幕会保持供电，长时间跑还容易留残影。

## 4. 版面：400×300 怎么分区

400×300 很小，又没有 CSS，所有位置都是像素坐标，所以我先把屏幕切成四块，再分别决定刷新频率：

<img src="/images/pi-epaper-clock/layout.png" alt="看板版面分区示意图：顶部栏、左侧时钟区（每分钟局部刷新）、右侧月历区、底部设备信息栏" />

| 区域 | 范围（像素） | 内容 | 刷新方式 |
| --- | --- | --- | --- |
| 顶部栏 | y ∈ [0, 56) | 日期、星期、城市天气（图标 + 温度 + 高低温/湿度） | 整点 / 跨天全刷 |
| 时钟区 | x ∈ [8, 176)，y ∈ [56, 220) | 大号时钟、日期周次、农历、月相 | **每分钟局部刷新** |
| 月历区 | x ≥ 177，y ∈ [58, 220) | 当月月历，今天反白 | 整点 / 跨天 / 30 分钟兜底全刷 |
| 底部信息栏 | y ∈ [222, 300) | 主机名/IP、CPU 温度、负载、内存/磁盘、运行时长、Python 版本 | 每 10 分钟采样 + 全刷 |

字体是这个版面能看清的关键，三套都放在 `pic/` 下：

- **文泉驿点阵宋体 16px / 14px**：点阵字体，小字号下笔画不糊；14px 给月历日期，16px 给农历、星期
- **digital-7**：数码管字体，只给时钟和数字用，一下就有"电子钟"的味道
- 其他尺寸由 16px 缩放而来——点阵字缩放会发虚，所以尽量用原生尺寸，不要频繁缩

农历和月相是自己在 `lunar.py` 里算的：农历月日名、闰月、干支生肖、节日（春节/中秋这类），月相按天文算法逐像素画半椭圆（盈月亮在右、亏月亮在左），不依赖第三方日历库。天气图标也是 Pillow 画的 24×24 像素图（sun/cloud/rain/thunder/snow/fog/wind），省掉了图片资源。

## 5. 局部刷新：官方示例为什么不能用

这是整个项目最花时间的部分。

Waveshare 官方 Python 库里的 `EPD_4IN2_PartialDisplay` 在 4.2 寸上是有问题的：索引越界、以及对 `Image` 逐字节取反在某些情况下得到负整数，调用会直接抛异常或者刷出乱码。官方示例里这段函数的调用被 `if(0)` 注释掉了——也就是说，**局部刷新的代码路径根本没在跑**。

但时钟场景必须局部刷新：整屏刷一次 2 秒，每分钟一次既慢又伤屏（全刷次数多了残影明显）。所以我按驱动手册的时序重写了一遍，核心就 5 条命令：

```python
# 1. 进入局部模式
epd.send_command(0x91)
# 2. 设置刷新窗口（0x90：x/y 像素坐标；x 必须 8 像素对齐）
epd.send_command(0x90)
epd.send_data(xs * 8 // 256); epd.send_data(xs * 8 % 256)      # x-start
epd.send_data(xe * 8 // 256); epd.send_data((xe * 8) % 256 - 1) # x-end
epd.send_data(y0 // 256);     epd.send_data(y0 % 256)           # y-start
epd.send_data(y1 // 256);     epd.send_data(y1 % 256 - 1)       # y-end
epd.send_data(0x28)
# 3. 旧帧数据（上一帧）→ 0x10；4. 新帧数据 → 0x13
epd.send_command(0x10); epd.send_data2(old)
epd.send_command(0x13); epd.send_data2(new)
# 5. 触发刷新并等 BUSY
epd.send_command(0x12)
epdconfig.delay_ms(200)
epd.ReadBusy()
```

三个关键点：

**（1）驱动不缓存"上一帧"。** 墨水屏局部刷新时，驱动需要知道哪些像素要翻转，官方库没帮我们存旧数据，所以自己在 `Display` 里维护 `epd.DATA`：每次全刷后用当前帧的补码覆盖它，局部刷新时从这里取旧帧、并把新帧写回去。

**（2）用 `^ 0xFF` 而不是 `~`。** Python 里对 `bytes`/`int` 做 `~` 会得到负数，驱动那边拼字节就错位了。按位异或 `^ 0xFF` 才是"取反"。

**（3）x 起点必须 8 像素对齐。** 0x90 窗口的 x 是按字节寻址的（每个字节 8 个像素），所以 `CLOCK_REGION` 的 x0 得是 8 的倍数，否则会被驱动截断，刷新区域和你想的不一样。`CLOCK_REGION = (8, 56, 176, 220)` 就是这么来的。

局部刷新的耗时只有零点几秒，观感上几乎"秒变"：

```text
[2026-11-21 19:14:02] INFO partial refresh x[8,176) y[56,220)
[2026-11-21 19:15:02] INFO partial refresh x[8,176) y[56,220)
[2026-11-21 19:16:02] INFO partial refresh x[8,176) y[56,220)
```

## 6. 调度：一分钟一次，整点全刷

主循环逻辑很直白：每秒醒一次，看有没有到点。

```python
while True:
    time.sleep(1)
    now = time.localtime()

    # 跨天 / 跨月 → 全刷
    if now.tm_mday != prev_day or now.tm_mon != prev_mon:
        changed = True

    # 每分钟：局部刷新时钟区；零点整点全刷
    if now.tm_min != prev_min:
        if now.tm_hour == 0 and now.tm_min == 0:
            changed = True
        else:
            epd.partial_update(render_frame(w, info), *config.CLOCK_REGION)

    # 天气 30 分钟一拉、设备信息 10 分钟一采
    if t - last_weather >= config.WEATHER_INTERVAL:
        w = weather.fetch_weather(); changed = True
    if t - last_sysinfo >= config.SYSINFO_INTERVAL:
        info = sysinfo_mod.get_sysinfo(); changed = True

    # 30 分钟兜底全刷，压残影
    if t - last_full >= config.FULL_REFRESH_INTERVAL:
        changed = True

    if changed:
        epd.full_update(render_frame(w, info))
        last_full = t
```

挂成 systemd 服务，开机自启：

```ini
[Unit]
Description=e-Paper Dashboard (4.2" 400x300, clock/weather/sysinfo)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/code/e-Paper/RaspberryPi_JetsonNano/python
ExecStart=/usr/bin/python3 .../dashboard/main.py
Restart=on-failure
RestartSec=10
# main.py 用 KeyboardInterrupt 触发 epd.shutdown()，SIGINT 让 systemd 停止时能优雅休眠屏幕
KillSignal=SIGINT
TimeoutStopSec=15
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

`KillSignal=SIGINT` 是专门为了退出时能进 `epd.sleep()`：默认的 SIGTERM 会直接杀进程，屏幕停在刷新中途，容易留残影。`PYTHONUNBUFFERED=1` 是为了让 `journalctl -u epaper-dashboard -f` 能实时看到日志。

日常维护就三条命令：

```bash
systemctl status epaper-dashboard --no-pager
journalctl -u epaper-dashboard -n 20              # 正常应该每分钟一条 partial refresh
sudo systemctl restart epaper-dashboard           # 改了代码/残影重时重启

cd ~/code/e-Paper/RaspberryPi_JetsonNano/python
python3 dashboard/main.py --once                  # 刷一帧后退出，改版式时用
python3 dashboard/main.py --headless              # 只渲染 preview.png，不驱动屏幕
```

## 7. 数据源与降级

- **天气**：`wttr.in/<city>?format=j1&lang=zh`，6 秒超时，取当前温度、体感、描述、湿度、今日高低温。成功时写 `.cache/weather.json`；失败（断网、限流）读缓存并在屏幕右上角标 `OFFLINE`——比显示"天气获取失败"体验好，至少昨天的数据也比空着强。
- **农历 / 月相**：纯本地计算，不联网。
- **设备信息**：`/sys/class/thermal/thermal_zone0/temp`（CPU 温度）、`/proc/loadavg`、`/proc/meminfo`、`shutil.disk_usage("/")`、`/proc/uptime`，每项都独立 try/except，单项失败只在屏幕上显示 `N/A`，不让主循环挂掉。

## 8. 踩过的坑

**残影是常态，不是 bug。** 局部刷新次数多了，屏幕上会留下淡淡的旧字。解决办法就是整点 + 每 30 分钟全刷兜底；另外关机/重启服务时要走 `SIGINT` 让屏幕 `sleep()`。

**GPIO busy。** 服务在跑的时候，你在 SSH 里再执行 `main.py --headless` 会加载驱动并申请 GPIO，直接报 `lgpio.error: 'GPIO busy'`。注意 `--headless` 也逃不掉——`display.py` 在 import 时就会初始化驱动。想手工预览就先把服务 `stop`，或者改成本地渲染那一套（我后来是在 Mac 上用同一份 `render.py` + Pi 上采的数据渲染预览图）。

**8 像素对齐和窗口边界。** `x0` 必须是 8 的倍数；y 方向的 end 要送 `y1 - 1`（窗口是闭区间）。不对齐不会报错，只会"刷错位置"，很难查。

**字体别乱缩放。** 点阵宋体在 14/16px 下最清楚，缩放到 18/20 就开始发虚；数码管字体只在数字上好看，中文会缺字。

**屏幕口径以驱动为准。** 买的时候商家写 4.3 寸，实际驱动是 `epd4in2`（400×300）。按 4.3 去找资料会拿错引脚定义。

**代码没有版本控制。** 当时图快直接改 Pi 上的文件，现在只能靠 `tar` 定期备份。下次重构打算把 `dashboard/` 抽成独立仓库，本地开发、Pi 上只 pull。

## 9. 现在的样子与后续

这就是它此刻的显示效果（2026-11-21 19:14，北京 3°C 霾，农历丙午年十月十三，盈凸月）：

<img src="/images/pi-epaper-clock/preview.png" alt="看板当前渲染效果：2026-11-21 19:14，北京 3 摄氏度，农历十月十三，月历高亮 21 号" />

后续想补的：

- **日程/待办区**：把月历下方那块空白用起来，显示今天和未来三天的日程（数据来自我的 Obsidian 库）
- **夜间模式**：23:00–07:00 降低刷新频率，或者干脆只显示时间（墨水屏不发光，其实放着也不刺眼）
- **电池化**：现在还是插着 5V 电源，理想状态是锂电 + 低功耗定时唤醒，放哪都行

总共花了两个周末，硬件成本不到 200 块，换来一个不用充电、不弹通知、抬头就能看的钟。这种"低技术、高频率"的小东西，比买一个成品更值。

---

## 参考

- Waveshare e-Paper 文档：[waveshare.com/wiki/4.2inch_e-Paper_Module](https://www.waveshare.com/wiki/4.2inch_e-Paper_Module)
- 官方 Python 驱动：[github.com/waveshare/e-Paper](https://github.com/waveshare/e-Paper)（`RaspberryPi_JetsonNano/python`）
- 天气数据：[wttr.in](https://wttr.in/)
- Pillow 文档：[pillow.readthedocs.io](https://pillow.readthedocs.io/)
