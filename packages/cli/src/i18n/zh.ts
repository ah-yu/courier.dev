/**
 * The CLI's Chinese catalog. This object is the source of truth for every key: the
 * English catalog is typed against `MessageKey`, so a key added here without a
 * translation is a compile error rather than a missing string at runtime.
 *
 * Keys are flat and namespaced (`cli.command.*`, `cli.status.*`, …) so a call site
 * can be found by searching the source for its key. Values use `{name}`
 * placeholders, replaced by `t()` in one pass.
 */
export const zh = {
  "common.none": "（无）",
  "common.listSeparator": "、",

  "cli.description": "Courier 无头同步 CLI（把 Obsidian 库文件夹与服务器同步）",
  "cli.option.lang": "输出语言：zh 或 en（默认跟随系统语言，无法识别时用英文）",
  "cli.command.vault.description": "管理远程库绑定",
  "cli.command.register.description": "保存服务器地址、用户密钥，以及这台设备同步时使用的设备名称",
  "cli.command.logout.description": "清除本机的服务器地址、用户密钥和所有 Vault 绑定",
  "cli.command.vaultConnect.description": "把这台设备绑定到一个远程库（在本地派生并保存库密钥）",
  "cli.command.vaultCreate.description":
    "创建一个远程库，并把它绑定到本地文件夹（用库密码派生它的密钥）",
  "cli.command.vaultUpdate.description":
    "修改一个已绑定远程库的设置（设备名称、文件类型、排除文件夹），不需要库密码",
  "cli.command.vaultDisconnect.description": "解除一个远程库绑定并删除它的本机同步状态",
  "cli.command.run.description":
    "启动一个 Vault 的无头同步（文件监听 + WebSocket + 周期 reconcile）",
  "cli.command.status.description": "查看同步状态",
  "cli.command.version.description": "输出版本与构建信息",
  "cli.command.device.description": "管理这台设备同步时使用的名称",
  "cli.command.deviceRename.description": "设置之后写入同步历史的设备名称",

  "cli.option.server": "服务器地址，例如 http://vps.example.com",
  "cli.option.userKey": "用户密钥 ck_（同一账号的所有设备共用）",
  "cli.option.name": "同步历史中显示的设备名称（默认：主机名）",
  "cli.option.vaultId": "远程库 id",
  "cli.option.vaultName": "新远程库的名称",
  "cli.option.vaultPath": "本地库文件夹的绝对路径",
  "cli.option.deviceName":
    "这个 Vault 同步时显示的设备名称（每个 Vault 各自一个；不填则沿用这台设备的名称）",
  "cli.option.vault": "要操作的 Vault id（绑定多个 Vault 时 run/status 用它选择）",
  "cli.option.password": "库密码（也可以通过 COURIER_VAULT_PASSWORD 设置）",
  "cli.option.syncFileTypes":
    "同步这些库文件类型（不带值 = 默认：images,video,audio,pdf；空 = 仅 Markdown 与 Canvas；" +
    "逗号分隔 images,video,audio,pdf,otherTypes）",
  "cli.option.syncOtherTypes": "同时同步所有其他文件类型（.base、.excalidraw、压缩包等）",
  "cli.option.excludeFolders": "把这些库文件夹排除在同步之外（逗号分隔；--exclude-folders= 清空）",
  "cli.option.historyLimitDocuments":
    "远程库为每个 Markdown 笔记和 Canvas 文件保留的历史版本数（默认 200）",
  "cli.option.historyLimitAttachments": "远程库为其他每个文件保留的历史版本数（默认 10）",
  "cli.option.once": "只执行一次 reconcile 后退出",
  "cli.option.interval": "完整 reconcile 的间隔，单位分钟（默认 30）",
  "cli.option.takeOver": "在第一次被拒时，从占用者手中接管这个 Vault（只尝试一次）",
  "cli.option.json": "以 JSON 输出",

  "cli.error.invalidLanguage": "不支持的语言「{value}」。可选值：zh、en。",
  "cli.error.missingLanguage": "`--lang` 需要一个值：zh 或 en。",
  "cli.error.notConfigured": "尚未配置。请先运行 `courier-cli register`。",
  "cli.error.invalidUserKey": "注册失败：用户密钥无效（{error}）。",
  "cli.error.vaultPasswordRequired":
    "需要库密码：请使用 `--password`，或设置 `COURIER_VAULT_PASSWORD`。",
  "cli.error.incorrectVaultPassword": "库密码不正确。",
  "cli.error.vaultNameRequired": "请用 `--name` 给新远程库起一个名字。",
  "cli.error.vaultNameTooLong": "远程库名称最多 {max} 个字符。",
  "cli.error.deviceNameRequired": "设备名称不能为空。",
  "cli.error.vaultNotBound": "本机没有绑定 id 为 {id} 的远程库。",
  "cli.error.notBound": "尚未绑定远程库。请先运行 `courier-cli vault connect`。",
  "cli.error.connectFirst": "请先运行 `courier-cli vault connect`。",
  "cli.error.pathEscapes": "路径超出库根目录：{path}",
  "cli.error.unknownVault":
    "没有绑定 Vault「{vaultId}」。运行 `courier-cli vault connect` 添加它。",
  "cli.error.multipleVaults":
    "本机绑定了 {count} 个 Vault。每个 Vault 由独立进程同步，请用 `--vault <id>` 指定其中一个。",
  "cli.error.vaultPathOverlap":
    "本地文件夹「{path}」与已绑定的 {other} 重叠。一个文件夹只能属于一个 Vault，请换一个路径。",
  "cli.error.syncLocked":
    "另一个同步进程（Obsidian 插件或其他 CLI）正在写这个 Vault。等它停止后再试。",
  "cli.error.takeOverFailed": "无法从对方手中接管这个 Vault（--take-over）。",
  "cli.error.leaseFailed":
    "无法访问同步锁：{error}。这是文件系统错误（权限、空间或文件损坏），不是另一个同步进程。",
  "cli.error.contractServerOutdated":
    "服务端（{server}）比本 CLI（{cli}）能用的版本旧。请升级服务端，然后重新执行这条命令。",
  "cli.error.contractClientOutdated":
    "本 CLI（{cli}）比这台服务端还支持的版本旧（服务端 {server}）。请更新 courier-cli，然后重新执行这条命令。",

  "cli.register.saved": "已保存设备名称「{deviceName}」。",
  "cli.register.vaultCount": "本机当前绑定 {count} 个 Vault。",
  "cli.logout.done": "已退出登录，并清除了本机 {count} 个 Vault 绑定。",
  "cli.logout.none": "本机尚未登录，没有可清除的配置。",
  "cli.create.created": "已创建远程库「{name}」（{id}）。",
  "cli.connect.connected": "已绑定远程库 {vaultId}（{path}）；本机共 {count} 个 Vault。",
  "cli.connect.deviceName": "设备名称：{value}。",
  "cli.update.saved":
    "已更新 {vaultId}：设备名称 {device}，文件类型 {fileTypes}，排除的文件夹 {folders}。",
  "cli.disconnect.done": "已解除远程库 {vaultId} 的绑定；本机还剩 {count} 个 Vault。",
  "cli.disconnect.running":
    "该 Vault 的同步进程仍在运行。请停止它（或结束对应 `courier-cli run --vault` 进程）。",
  "cli.connect.fileTypes": "文件类型：{value}。",
  "cli.connect.excludedFolders": "排除的文件夹：{value}。",
  "cli.connect.historyLimits": "历史版本数：{value}。",
  "cli.run.stopping": "正在停止…",
  "cli.run.started":
    "无头同步已启动：{vault}，{vaultPath} → {serverUrl}（设备「{deviceName}」）；详细状态见 `courier-cli status --vault {vaultId}`。",
  "cli.version.line": "版本 {version}（{gitSha}，构建于 {buildTime}，运行时 {runtime}）",
  "cli.device.renamed": "设备名称已改为「{deviceName}」。",

  "cli.status.label.server": "服务器",
  "cli.status.label.contract": "契约",
  "cli.status.contract.serverTooOld":
    "服务端（{server}）比本 CLI（{cli}）能用的版本旧 —— 请升级服务端",
  "cli.status.contract.clientTooOld":
    "本 CLI（{cli}）比这台服务端还支持的版本旧（服务端 {server}）—— 请更新 courier-cli",
  "cli.status.label.defaultDevice": "默认设备",
  "cli.status.label.device": "设备",
  "cli.status.label.vaults": "Vault 数量",
  "cli.status.label.vault": "远程库",
  "cli.status.label.path": "路径",
  "cli.status.label.daemon": "同步进程",
  "cli.status.label.lease": "同步锁",
  "cli.status.lease.free": "空闲（先到先得）",
  "cli.status.lease.cli": "CLI 进程（PID {pid}）",
  "cli.status.lease.plugin": "Obsidian 插件",
  "cli.status.label.obsidian": "Obsidian",
  "cli.status.label.state": "状态",
  "cli.status.label.fileTypes": "文件类型",
  "cli.status.label.historyLimit": "历史版本",
  "cli.status.label.excluded": "排除的文件夹",
  "cli.status.label.conflicts": "冲突副本",
  "cli.status.label.tooLarge": "超出上限",
  "cli.status.label.hint": "提示",

  "cli.status.value.notConnected": "（未连接）",
  "cli.status.value.tracked": "已记录",
  "cli.status.value.noState": "（尚无同步状态）",
  "cli.status.fileTypes.value": "{types}（{cap}）",
  "cli.status.fileTypes.valueOnly": "仅 {types}（{cap}）",
  "cli.status.cap.unlimited": "上限不限，由管理员设置",
  "cli.status.cap.limited": "上限 {megabytes} MB，由管理员设置",
  "cli.status.historyLimit.value": "笔记/Canvas {documents}，附件 {attachments}",
  "cli.status.historyLimit.unknown": "（无法从服务器读取）",
  "cli.status.conflicts.one": "{count} 个冲突副本：{files}",
  "cli.status.conflicts.other": "{count} 个冲突副本：{files}",
  "cli.status.tooLarge.one": "{count} 个文件超过上限：{files}",
  "cli.status.tooLarge.other": "{count} 个文件超过上限：{files}",
  "cli.status.hint": "运行 `courier-cli run --vault <id>` 开始同步",
  "cli.status.hintWithDaemon":
    "每个 Vault 由独立进程同步：运行 `courier-cli run --vault <id>` 启动其中一个；先取得该 Vault 同步锁的进程负责同步，另一个等待。",
  "cli.status.hintNotBound": "尚未绑定 Vault：运行 `courier-cli vault connect` 添加一个。",
  "cli.status.vaults.count": "{count} 个",
  "cli.status.daemon.stopped": "未运行",
  "cli.status.daemon.starting": "正在启动（PID {pid}）",
  "cli.status.daemon.running": "运行中（PID {pid}）",
  "cli.status.daemon.runningSince": "运行中（PID {pid}），最近同步活动 {time}",
  "cli.status.daemon.otherWriter": "等待另一个同步进程释放锁（PID {pid}）",
  "cli.status.daemon.failed": "已停止（PID {pid}）：{error}",
  "cli.status.obsidian.closed": "未打开；由 CLI 同步",
  "cli.status.obsidian.plugin": "已打开，Courier 插件已配置同步",
  "cli.status.obsidian.pluginOff": "已打开，但插件未配置同步",

  "cli.config.error.unknownFileType": "未知文件类型「{name}」。有效类型：{valid}。",
  "cli.config.error.historyLimit": "历史版本数必须是 1 到 {max} 之间的整数，当前为「{value}」。",
  "cli.options.error.interval":
    "`--interval` 需要非负的分钟数，当前为「{value}」（0 表示关闭周期同步）。",

  "cli.log.conflict.remoteDelete": "「{path}」发生冲突：已应用远程删除，本地没有需要保留的内容。",
  "cli.log.conflict.remoteAdopted": "「{path}」发生冲突：已采用远程版本（本地没有内容）。",
  "cli.log.conflict.parked":
    "「{path}」发生冲突：已采用远程版本，你的内容保存在「{conflictPath}」。",
  "cli.log.tooLarge":
    "已跳过「{path}」（{megabytes} MB）：超过同步大小上限。该上限由管理员按密钥设置，请联系管理员调整。",
  "cli.log.limitsUnavailable": "无法读取账号的文件大小上限（{error}）；暂按 {megabytes} MB 处理。",
  "cli.log.reconciled.one": "同步完成，用时 {milliseconds}ms；库中有 1 个冲突副本。",
  "cli.log.reconciled.other": "同步完成，用时 {milliseconds}ms；库中有 {count} 个冲突副本。",
  "cli.log.connected": "已连接服务器（设备「{deviceName}」）。",
  "cli.log.bindFailed": "首次同步失败（{error}）；稍后重试。",
  "cli.log.progress": "同步中：已完成 {done} / {total} 个文件（{percent}%）。",
  "cli.log.rateLimited": "已达服务器限流，等待 {seconds} 秒后继续。",
  "cli.log.keyRevoked": "同步已停止：用户密钥已被撤销。",
  "cli.log.keyExpired": "同步已停止：用户密钥已过期。",
  "cli.log.keyDisabled": "同步已停止：用户密钥已被停用（数据仍保留在服务器上）。",
  "cli.log.vaultDeleted": "同步已停止：远程库已在服务器上被删除。",
  "cli.log.watching.one": "正在监视 {vaultPath}；库中有 1 个冲突副本。",
  "cli.log.watching.other": "正在监视 {vaultPath}；库中有 {count} 个冲突副本。",
  "cli.log.fileSkipped": "已跳过「{path}」：路径超过服务器长度限制。",
  "cli.log.eventFailed": "处理 {path} 的事件失败：{error}",
  "cli.log.watchUnavailable": "无法监听文件变化（{error}）；改为依赖轮询间隔。",
  "cli.log.obsidianWaiting":
    "Obsidian 正在打开「{vault}」，Courier 插件正在同步；该 Vault 的 CLI 进程暂停，关闭 Obsidian 后会自动继续。",
  "cli.log.obsidianResumed": "Obsidian 已关闭或插件已暂停；「{vault}」的 CLI 继续同步。",
  "cli.log.leaseWaiting": "另一个同步进程持有「{vault}」的同步锁；本进程等待，不会启动引擎。",
  "cli.log.leaseResumed": "同步锁已释放；「{vault}」的 CLI 继续同步。",
  "cli.log.takingOver":
    "正在从{holder}接管「{vault}」的同步锁（--take-over）。对方会在数秒内停止，但它已经开始的那一趟同步会先跑完。",
  "cli.lease.holderUnknown": "另一个同步进程",
  "cli.lease.ownerCli": "CLI 进程",
  "cli.lease.ownerPlugin": "Obsidian 插件",
  "cli.lease.pid": "进程号 {pid}",
  "cli.lease.host": "位于 {host}",
  "cli.log.coexistenceFailed": "无法判断 Obsidian 是否在同步（{error}）；按未打开处理。",
  "cli.log.startFailed": "同步进程启动失败（{error}）；稍后重试。",
} as const;

/** Every key the CLI catalogs must provide. */
export type MessageKey = keyof typeof zh;
