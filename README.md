# genshin-tier

原神 **从夯到拉（TierMaker 风格排行）** 插件，适用于 [Yunzai-Bot](https://gitee.com/TimeRainStarSky/Yunzai) 系机器人。

## 安装

将本仓库克隆到机器人目录下的 `plugins/genshin-tier`：

```bash
cd plugins
git clone https://github.com/NotBadSlime/genshin-tier.git
```

重启机器人后加载插件。

## 依赖

- **喵喵插件**（`miao-plugin`）：角色头像、武器图标、命座图标（`icons/cons-*`）等  
- **原神插件**（`genshin`）：`resolveGsReleaseName` 角色别名解析  
- **Redis**：场次与档位状态存储  

## 使用

群内发送 `#夯拉帮助` 查看说明图（长图）。

支持角色榜 / 武器榜 / 命座榜（一群一场，开局时选择类型）。

## 作者

NotBadSlime

## 仓库

https://github.com/NotBadSlime/genshin-tier
