# Charlie ESP32 固件

## 分发固件

**文件**: `charlie-esp32-flash-16MB.bin` (16MB 全量 flash 镜像，通过 GitHub Release 分发，不进 git)

| 属性 | 值 |
|------|-----|
| 固件版本 | xiaozhi v2.1.0 |
| 板子 | lc-s3-wifi-1.54tft (LC-S3 1.54寸 TFT WiFi) |
| Flash 大小 | 16MB |
| 屏幕 | ST7789 240x240 SPI, 1.54寸 TFT |
| NVS | 已擦除（不含任何 WiFi / 服务器信息） |

固件内置 `esp-wifi-connect` AP 热点配网门户，烧录后用手机连热点即可配置 WiFi 和 Charlie 服务器地址，
无需在固件里硬编码任何凭证。

## 烧录

推荐在 Charlie 应用内的「ESP32 配置向导」一键烧录（已内置 esptool）。
也可手动烧录：

```bash
pip install esptool
python -m esptool --chip esp32s3 -p COM3 -b 115200 \
  --before=default_reset --after=hard_reset \
  write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 charlie-esp32-flash-16MB.bin
```

## 配网

1. 烧录后设备通电，手机连名为 `lc-s3-wifi-1.54tft-XXXX` 的 WiFi 热点（无密码）
2. 浏览器访问 `http://192.168.4.1`
3. 选择你家 WiFi 并输入密码
4. 点「高级设置 / Advanced」，在 OTA URL 填入 Charlie 的 OTA 地址：
   `http://<运行Charlie的电脑IP>:<端口，默认8000>/xiaozhi/ota`
5. 保存后设备自动重启并连接 Charlie，屏幕显示时间即成功

> 电脑和 ESP32 必须连同一个路由器。长按开发板复位键可重新进入热点配网模式。

## 分区布局

| 分区 | 偏移 | 大小 | 说明 |
|------|------|------|------|
| nvs | 0x9000 | 16KB | WiFi 配置、设备参数（分发固件已擦除） |
| otadata | 0xD000 | 8KB | OTA 状态 |
| phy_init | 0xF000 | 4KB | 射频校准 |
| ota_0 | 0x20000 | 4032KB | 固件镜像 |
| ota_1 | 0x410000 | 4032KB | 备用分区 |
| assets | 0x800000 | 8MB | 字体/表情/语音模型 |
