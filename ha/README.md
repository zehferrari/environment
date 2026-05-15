# Home Assistant System Context

This file contains hardware and Home Assistant configuration details for the HA OS environment on hostname `homeassistant`. Lives under [`environment/ha/`](../) in the unified `environment` repo.

---

## 🖥️ Hardware Information

### System Overview
- **OS**: Home Assistant OS 17.0 (Alpine Linux v3.23)
- **Kernel**: Linux 6.12.63-haos
- **Architecture**: x86_64 (amd64)
- **Machine**: generic-x86-64
- **Hostname**: homeassistant
- **Working Directory**: /etc (SSH/Terminal addon container)
- **Home Assistant Config**: /homeassistant (symlinked from /config)

### CPU
- **Model**: Intel(R) Core(TM) i5-7500T CPU @ 2.70GHz
- **Cores**: 4 physical cores, 4 threads
- **Virtualization**: VMX (Intel VT-x) supported

### Memory
- **Total RAM**: 7.7 GB
- **Used**: 2.4 GB
- **Available**: 5.3 GB
- **Swap**: 2.5 GB (1.3 GB used)

### Storage
- **Disk**: /dev/sda8 (SSD)
- **Size**: 234.0 GB
- **Used**: 79.2 GB (35%)
- **Available**: 145.3 GB

### Network
- **Primary Interface**: enp0s31f6 (Ethernet)
- **MAC Address**: 14:B3:1F:1A:C2:BC
- **IPv4**: 192.168.86.95/24
- **Gateway**: 192.168.86.1
- **External URL**: https://home.zeh.me
- **Internal URL**: https://moonlight.zeh.me

### USB Devices
- `10c4:8a2a` - Silicon Labs HubZ Smart Home Controller (ZigBee + Z-Wave)
- `0bda:a729` - Realtek Bluetooth 5.3 Radio

### Serial Devices
- `/dev/ttyUSB0` → HubZ Smart Home Controller (Z-Wave)
- `/dev/ttyUSB1` → HubZ Smart Home Controller (ZigBee)

---

## 🏠 Home Assistant Details

### Core Information
- **Home Assistant Version**: 2026.2.1
- **Supervisor**: 2026.02.1
- **Docker**: 29.1.3
- **HASS OS**: 17.0
- **Timezone**: Australia/Brisbane
- **Location**: Jubilee Pocket (-20.28, 148.73)

### Database
- **Type**: MariaDB (MySQL)
- **Host**: core-mariadb
- **Connection**: mysql://homeassistant:ha_mig_2026_secure!@core-mariadb/homeassistant

---

## 📦 Installed Add-ons (10)

| Add-on | Version | Description |
|--------|---------|-------------|
| Terminal & SSH | 10.0.1 | Remote SSH access (THIS addon) |
| Studio Code Server | 6.0.1 | VSCode in HA frontend |
| Z-Wave JS | 0.29.1 | Z-Wave network control |
| ESPHome Device Builder | 2026.1.5 | ESPHome device builder |
| Whisper | 3.1.0 | Speech-to-text |
| Piper | 2.2.2 | Text-to-speech |
| Matter Server | 8.2.2 | Matter WebSocket Server |
| MariaDB | 2.7.2 | SQL database server |
| GoSungrow | 3.0.7 | iSolarCloud solar data |
| Mosquitto broker | 6.5.2 | MQTT broker |

---

## 🔌 Key Integrations

### Radio/Protocol Controllers
- **zha** - ZigBee Home Automation (HubZ controller)
- **zwave_js** - Z-Wave JS (HubZ controller)
- **bluetooth** - Realtek Bluetooth 5.3 Radio (passive scanning)
- **matter** - Matter protocol support
- **thread** - Thread border router

### Cloud/External Services
- **smartthings** - Samsung SmartThings
- **ring** - Ring doorbell/cameras
- **nest** - Google Nest
- **homekit_controller** - HomeKit device control
- **openai_conversation** - ChatGPT voice assistant

### Local Protocols
- **tuya_local** - Local Tuya devices (primary lighting)
- **localtuya** - Additional local Tuya
- **esphome** - ESPHome devices
- **mqtt** - MQTT via Mosquitto
- **cast** - Google Cast devices

### Utilities
- **hacs** - Home Assistant Community Store
- **hassio** - Supervisor integration
- **adaptive_lighting** - Circadian lighting
- **bureau_of_meteorology** - Australian weather
- **group** - Entity groups
- **sun** - Sun position
- **met** - Met.no weather
- **mobile_app** - Companion app
- **ibeacon** - iBeacon tracking

---

## 🎨 Custom Components

| Component | Purpose |
|-----------|---------|
| adaptive_lighting | Circadian rhythm lighting |
| bureau_of_meteorology | BOM weather data |
| dreame_vacuum | Robot vacuum control |
| hacs | Community store |
| localtuya | Local Tuya control |
| tuya_local | Local Tuya devices |

---

## 📊 Statistics

| Metric | Count |
|--------|-------|
| **Total Devices** | 236 |
| **Total Entities** | 2,590 |
| **Areas** | 17 |
| **Automations** | ~161 |
| **Scripts** | ~21 |

### Top Device Manufacturers
- Tuya: 110 devices (lights, switches, sensors)
- Google: 17 devices (speakers, displays, Cast)
- Samsung: 12 devices (phones, tablets, SmartThings)
- Aqara: 4 devices (sensors)
- Ring: 4 devices (doorbell, cameras)
- SUNGROW: 4 devices (solar inverter)

### Entity Breakdown (Top 10)
| Domain | Count |
|--------|-------|
| sensor | 1,536 |
| binary_sensor | 314 |
| number | 180 |
| switch | 134 |
| select | 83 |
| light | 58 |
| automation | 50 |

---

## 🗺️ Areas (17)

Bathroom, Dinning, Front Bedroom, Garage, Hall, Kids Bedroom, Kitchen, Laundry, Local Tuya, Lounge, Master Bedroom, Office, Outside Lights, Switches, Toilet, zCameras, Roof

---

## 🔊 Voice Assistant Setup

- **STT**: Whisper (local)
- **TTS**: Piper (local)
- **AI**: OpenAI GPT-4o-mini
- **Protocol**: Wyoming

---

## ⚠️ Known Issues

- 1 corrupt HACS repository (f459db47) - non-critical

---

## 📁 Important File Locations

| Path | Description |
|------|-------------|
| /homeassistant/ | Main HA configuration |
| /homeassistant/configuration.yaml | Main config |
| /homeassistant/automations.yaml | Automations |
| /homeassistant/scripts.yaml | Scripts |
| /homeassistant/custom_components/ | Custom integrations |
| /homeassistant/.storage/ | Runtime storage |
| /homeassistant/esphome/ | ESPHome configs |
| /addons/ | Addon data (mostly empty) |
| /share/ | Shared data (Rhasspy, Taildrop) |
| /backup/ | Backup storage |

---

## 💡 Quick Commands

```bash
# Check HA status
ha info

# List addons
ha addons

# Network info
ha network info

# Resolution center
ha resolution info

# View config
cat /homeassistant/configuration.yaml

# Check logs
tail -f /homeassistant/home-assistant.log
```

---

*Last updated: 2026-02-12*
