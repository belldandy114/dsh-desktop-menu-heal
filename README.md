# dsh-desktop-menu-heal

DeepSeek Harness 桌面版的「应用」菜单补丁自愈插件。

## 安装

不用克隆，直接把 git 地址交给 DSH 的插件管理器即可（GUI 的「插件」页填地址，
或让 agent 调 `plugin_manager`）：

```
plugin_manager { action: "install_bundle", target: "github:belldandy114/dsh-desktop-menu-heal" }
```

等价的完整地址写法：

```
plugin_manager { action: "install_bundle", target: "https://github.com/belldandy114/dsh-desktop-menu-heal" }
```

DSH 会用 pnpm 把仓库拉进 profile 的 `node_modules` 并登记到
`dsh.profile.bundles`，`cordis.patch.yml` 里的挂载行由本包自带的 patch 提供，
不需要手工改 profile 配置。装完即为启用状态，无需管理员权限、无需重启
（下一次启动起每次都会自检）。

> 想锁定版本就把地址换成带 commit 的写法：
> `github:belldandy114/dsh-desktop-menu-heal#<40 位 commit>`。
> 只有这种 pin 到完整 commit 的形式，插件管理器才认得出「可更新」。

## 它解决什么问题

桌面版标题栏的「应用」下拉菜单里本该有：

- 刷新页面（重载整个界面，等同 F5）
- 重启应用（关闭并自动重新启动 DeepSeek Harness）

上游其实已经实现了这两项，只是被 `const development = !app.isPackaged` 挡住，
正式安装版永远不显示。以前的安装包通过改写 `resources/app.asar` 里
`lib/main.js` 的这几个字节把菜单放出来，但**每次应用自动更新都会把 app.asar
整体替换掉**，补丁随之消失，于是又得手动跑一遍安装脚本。

本插件在每次 Host 启动时检查 app.asar：

| 情况 | 行为 |
| --- | --- |
| 补丁还在 | 一个字节都不写 |
| 补丁被更新覆盖 | 自动按等长字节补回 |
| 上游自己放开了这两项 | 不写任何东西，日志提示可以移除本插件 |
| 找不到目标代码（版本大改） | 不写任何东西，日志说明哪一项没匹配上 |
| 没有写入权限 | 只记日志，不影响启动 |

写入方式与安装脚本一致：只改写 `lib/main.js` 那一段字节，每处替换前后字节数
严格相等，归档头与其它文件偏移全部不变，对正在运行的其他进程零影响。

## 生效时机

补丁是在 Electron 主进程启动时读进内存的，而自愈发生在 Host 启动之后，
所以**修好的是下一次启动**。应用更新会自己重启一次，之后你再正常关掉重开
一次，「应用」菜单就回来了 —— 全程不需要点任何安装脚本。

## 状态文件

```
%LOCALAPPDATA%\DSHMenuPatch\last-run.txt    最近一次检查结果（中文）
%LOCALAPPDATA%\DSHMenuPatch\disabled        存在则完全跳过（停用开关）
```

## 停用 / 卸载

- 临时停用：新建空文件 `%LOCALAPPDATA%\DSHMenuPatch\disabled`
- 重新启用：删掉它
- 彻底卸载：在插件管理里移除 `dsh-desktop-menu-heal`

## 说明

- 只在 Windows 桌面版有意义（`os: win32`）。
- Host 以 `ELECTRON_RUN_AS_NODE=1` 运行，Electron 会把 `*.asar` 当成目录，
  直接 `fs.open()` 会报 `ENOENT, not found in ...app.asar`；插件在所有归档读写
  期间临时设置 `process.noAsar = true`。
- 本插件不改动 DSH 的任何代码与配置，只维护 app.asar 里的那几十个字节。
