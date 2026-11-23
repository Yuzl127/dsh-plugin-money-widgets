# dsh-plugin-money-widgets

一个 DSH（DeepSeek Harness）聊天界面插件，把与钱有关的小部件合并在一起：

1. **余额格子** —— 输入框下方统计行里显示 DeepSeek 账户剩余额度（充值余额 + 赠金余额，按币种）。点击去用量页。需要账号登录态（纯 API key 不显示）。
2. **本轮价格** —— 每轮回复结束后，在操作栏右侧显示「本轮总消费 ¥x」，悬停/点击可看该轮每次模型调用的输入、缓存读、输出 token 与各自花费，以及模型 / 供应商。
3. **会话累计** —— 输入框下方常驻「总消费 ¥x · 输入 N · 输出 M · 峰谷」，随会话增长；点击打开**费用账单面板**。
4. **账单面板** —— 按模型分账、按供应商分账、每次调用明细、最近会话各自账单、峰谷状态；支持导出本会话 CSV / JSON 与全部会话账单 CSV（Blob 下载，CSV 带 BOM，Excel 直接打开）。
5. **预算**（可选）—— 每轮限额（本轮 ¥x / 限额 ¥y，超限变红）+ 整段会话预算（会话 ¥x / ¥y）。
6. **峰谷提醒** —— 在输入框下方与账单面板提示当前是「峰时·全价」还是「谷时·半价」，并在距切换 30 分钟内变色提醒（可在设置页关闭）。

价格按 DeepSeek 官方价目表计算，自动区分高峰/空闲时段（北京时间工作日 9–12、14–18 为高峰，其余时段半价）。

## 数据来源

- **实时小部件**（余额、本轮价格、会话累计）读的是宿主投影服务与账号服务。
- **侧边栏「费用账单」面板**读宿主新增的只读路由 `GET /plugins/money-widgets/bills`：宿主直接扫描
  `<DSH_HOME>/sessions/*/session-*/session.v4.jsonl.zstd`（多帧 zstd，逐帧解压），按
  `assistant/message` 的 usage 与 `message.source.provider/model` 聚合，因此**历史会话也能看到账单**，
  不依赖「会话是否被宿主加载过」。
- 该路由只读、仅 GET、校验同源 Origin，不写任何文件。

## 安装

```bash
dsh plugin add dsh-plugin-money-widgets
```

或在 DSH 插件市场里搜索安装。开发时也可用本地目录：

```bash
dsh plugin add file:/绝对路径/dsh-plugin-money-widgets
```

装完**完全退出客户端再重开**（客户端 bundle 变更不能用 F5 生效）。

## 配置

`cordis.patch.yml` 里 `money-widgets` 条目的 `config` 支持：

- `prices`：按模型覆盖单价（高峰价，元/百万 token；字段 `cacheHit` / `cacheMiss` / `output`）
- `peakMode`：`auto`（默认）| `peak`（全按高峰）| `off-peak`（全按空闲）
- `defaultModel`：未知模型回退到哪个价目（默认 `deepseek-flash`）
- `budget`：`{ enabled, perTurn, mode, session }` —— 每轮限额与整段会话预算（`session: 0` 表示不启用）
- `remind`：`{ peak, leadMinutes }` —— 峰谷切换前提醒

设置页（设置 → 插件 → 本插件）可直接改限额与提醒开关，保存即写入当前 profile，无需重启。

## 说明

- 余额格子依赖宿主 `remote.account` 服务；费用显示依赖宿主 `sessionProjections` 服务。
- 注册两个投影：`cost`（每次调用明细，`summary: false`，不进会话列表行）与 `costSummary`（按模型/供应商聚合，进会话列表行，供「会话账单」读取）。
- 供应商名取自 `assistant/message` 的 `message.source.provider`；旧日志没有该字段时记为 `unknown`（投影 `stateVersion` 变更会重算）。
- 不需要任何 token 或 API key；余额走账号登录态。
