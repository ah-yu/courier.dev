# Courier

[English](README.md) · 简体中文

端到端加密、实时同步，让你的 Obsidian 仓库在所有设备间保持一致。

Courier 是面向 Obsidian 的开源同步方案：桌面端与移动端插件、供从不打开 Obsidian 的机器使用的
无头 CLI，以及一个由你自己运行的服务器。

## Courier 能做什么

- **端到端加密。** 笔记内容与路径在离开设备前，就用由仓库密码派生出的密钥加密。服务器保存的是密文、
  大小和时间戳，以及你自己填写的账号名、仓库名和设备名称；它永远看不到你的密码和笔记。
- **改动即时送达。** 一台设备上的修改会实时同步到其他设备。
- **每台设备，同一个引擎。** Obsidian 插件运行在桌面端与移动端，`courier-cli` 在 NAS 或 VPS 上运行
  同一个同步引擎 —— 即使 Obsidian 已关闭，它仍会继续同步。
- **可以回溯的历史。** 每个文件都保留一条版本链：浏览它的各个版本、恢复旧版本，或在服务器的保留期内
  从回收站找回已删除的笔记。
- **冲突被搁置，而不是合并。** 发生冲突时没有隐式合并：远程版本胜出，本地版本以
  `note-2026-10-31-120000.conflict.md` 的形式搁置在它旁边；比较两者，一键替换。
- **同步什么由你决定。** Markdown 与 Canvas 始终同步。其他文件类型、排除的文件夹以及 Obsidian 的
  配置文件夹按设备、按仓库分别配置。

## 环境要求

- Obsidian 1.13.0 或更新版本。

## 快速开始

五步即可完成；[快速开始指南](docs/quick-start.md) 走的是同一个流程，并附上 Obsidian 中会看到的界面
文字。

1. **运行服务器。** 从[最新发布](https://github.com/ah-yu/courier.dev/releases/latest)下载适合你
   机器的构建，然后创建数据库并启动 —— 让它保持运行：数据库与内容存储就在二进制旁边的 `data/`。

   Linux（x64）：

   ```bash
   chmod +x courier-server-linux-x64
   ./courier-server-linux-x64 migrate
   ./courier-server-linux-x64 start --port 3002
   ```

   Linux（arm64）：

   ```bash
   chmod +x courier-server-linux-arm64
   ./courier-server-linux-arm64 migrate
   ./courier-server-linux-arm64 start --port 3002
   ```

   macOS（Apple Silicon）：

   ```bash
   chmod +x courier-server-darwin-arm64
   ./courier-server-darwin-arm64 migrate
   ./courier-server-darwin-arm64 start --port 3002
   ```

   Windows（x64，PowerShell）：

   ```powershell
   .\courier-server-win-x64.exe migrate
   .\courier-server-win-x64.exe start --port 3002
   ```

   `--port 3002` 只用于本机第一次试用；要让其他机器访问，需要启用 TLS 并使用客户端可达的地址，见
   [快速开始指南](docs/quick-start.md#1-run-a-server)。

2. **创建主机密钥。** 用同一个二进制运行 `apikey create admin`：Linux
   `./courier-server-linux-x64 apikey create admin`，macOS
   `./courier-server-darwin-arm64 apikey create admin`，Windows
   `.\courier-server-win-x64.exe apikey create admin`。它输出主机密钥 `ak_...` —— 管理员凭据，
   留在服务器上，不要填进客户端。
3. **创建账号并复制用户密钥。** 服务器运行中，调用一次用户接口 —— `{server-url}` 在服务器本机上是
   `http://127.0.0.1:3002`（其他机器填客户端可达的地址，启用 TLS 后是
   `https://{your-domain}:8443`）；`{host-key}` 是第 2 步输出的 `ak_...` 主机密钥；`{user-name}`
   是你给账号起的任意名称，会显示在插件的账号栏里。

   Linux 和 macOS：

   ```bash
   curl -fsS -X POST {server-url}/api/users \
     -H "Authorization: Bearer {host-key}" \
     -H "Content-Type: application/json" \
     -d '{"name":"{user-name}"}'
   ```

   Windows（PowerShell）：

   ```powershell
   Invoke-RestMethod -Method Post -Uri "{server-url}/api/users" `
     -Headers @{ Authorization = "Bearer {host-key}" } `
     -ContentType "application/json" `
     -Body '{"name":"{user-name}"}'
   ```

   返回里的 `key` 就是用户密钥（`ck_...`），账号下所有设备都用它登录 —— 请像对待密码一样保管。

4. **安装插件。** 在 Obsidian 中：设置 → 第三方插件 → 浏览 → 搜索 **Courier** → 安装 → 启用。
   （或者把发布包中的 `main.js`、`manifest.json` 和 `styles.css` 复制到
   `<vault>/.obsidian/plugins/courier/`。）
5. **连接仓库。** 设置 → Courier：输入 `{server-url}` 和 `{user-key}`，登录，然后创建或选择一个
   远程仓库并输入它的密码 —— **密码一旦丢失就无法找回**。

## 隐私与网络使用

- **网络使用。** 插件只会联系你输入的服务器地址（以及 Obsidian 自身的第三方插件更新检查）。它发送
  加密的文件内容、加密的路径、大小、时间戳，以及你设置的设备名称。没有遥测、没有分析、没有崩溃
  上报，也不会联系任何第三方服务。
- **服务器能看到什么。** 其运营者可以看到你填写的账号名和仓库名、存在哪些仓库、它们的大小、版本时间戳和
  设备名称 —— 但看不到你的笔记、路径或密码。
- **设备上的凭据。** 用户密钥与插件设置保存在仓库内插件的 `data.json` 中；派生出的仓库密钥保存在
  Obsidian 的设备本地存储里，不会进入仓库，因此仓库级同步（iCloud、Dropbox、Git）无法把它带离
  设备。

## 支持

- 入手 [Courier 桌面端](https://couriersync.dev/) 是支持 Courier 开发最直接的方式。
- 如果 Courier 对你有帮助，请给仓库点个 star 并分享它 —— 两者都能帮助更多人发现这个项目。

## 文档

- [快速开始](docs/quick-start.md) —— 服务器、第一台设备、第二台设备。
- [文档索引](docs/README.md) —— 同步引擎规则、同步范围、插件、服务器、API、CLI 以及发布流程。

## 许可证

[Apache License 2.0](LICENSE)
