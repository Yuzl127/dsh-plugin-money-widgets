/**
 * dsh-plugin-money-widgets —— 把「余额格子」和「费用显示」合并成一个客户端插件。
 *
 * 显示：
 *   1. conversation.composer.dock  order 2  —— 余额格子（充值+赠金，点击去用量页）
 *   2. conversation.input.dock     order 5  —— 运行中「本轮 ¥x / 限额 ¥y（· 会话 ¥z / ¥w）」
 *   3. conversation.chat.assistant-actions order 10 —— 每轮结束「本轮总消费 ¥x」芯片 + 明细浮层
 *   4. conversation.composer.dock  order 30 —— 「总消费 ¥x · 输入 N · 输出 M」+ 峰谷提示，点击打开账单面板
 *
 * 账单面板：按模型 / 按供应商分账、每条会话账单、峰谷状态、CSV/JSON 导出、预算读数。
 * 宿主半身见 lib/index.js（注册 key = "cost" 的明细投影与 key = "costSummary" 的会话摘要投影）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-money-widgets",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const react = React;
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");

		/**
		 * 弹层挂到 body 上：composer 卡片常带 transform/overflow，
		 * 普通 `position: fixed` 子节点会被裁掉或错位。
		 */
		let _react_dom_createPortal = null;
		try {
			_react_dom_createPortal = require("react-dom").createPortal;
		} catch {
			_react_dom_createPortal = null;
		}
		function portalize(node) {
			if (node === null || node === void 0) return node;
			if (_react_dom_createPortal === null) return node;
			if (typeof document === "undefined") return node;
			return _react_dom_createPortal(node, document.body);
		}

		//#region 余额格子
		/**
		 * Platform rejects an account query that carries no client identity. The
		 * Host forwards these fields as `x-client-*` headers, so the version has to
		 * look like a DeepSeek Harness client build; update it when the Platform
		 * stops accepting this one.
		 */
		const BAL_CLIENT_VERSION = "0.2.1-rc.3";
		/** Wallet refresh period while the page is visible. */
		const BAL_REFRESH_MS = 60_000;
		/** Dock cell key; the shipped cache-hit pill is `usage` at order 1. */
		const BAL_CELL = "account-balance";

		const COPY = {
			zh: { label: "剩余额度", balance: "充值余额", bonus: "赠金余额", unavailable: "前往开放平台查看" },
			en: { label: "Remaining balance", balance: "Topped-up balance", bonus: "Granted balance", unavailable: "View on Platform" },
		};
		const SYMBOL = { CNY: "¥", USD: "$" };

		/** @returns copy for the browser's current language. */
		function copy() {
			const language = (typeof navigator === "undefined" ? "" : navigator.language || "").toLowerCase();
			return language.startsWith("zh") ? COPY.zh : COPY.en;
		}

		/** @returns the identity the Host turns into Platform request headers. */
		function clientMetadata() {
			return {
				version: BAL_CLIENT_VERSION,
				locale: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
			};
		}

		/**
		 * Format one amount the way the Platform Web client does: two decimals,
		 * rounded down, sub-cent values shown as `<0.01`. Display-only arithmetic.
		 */
		function format(amount, symbol) {
			if (!(amount > 0)) return `${symbol}0.00`;
			if (amount < 0.01) return `<${symbol}0.01`;
			const value = Math.floor(amount * 100) / 100;
			return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
		}

		/** Sum a wallet list per currency in first-seen order. */
		function totals(wallets) {
			const sums = new Map();
			for (const wallet of wallets) {
				const amount = Number(wallet.balance);
				if (!Number.isFinite(amount)) continue;
				sums.set(wallet.currency, (sums.get(wallet.currency) || 0) + amount);
			}
			return sums;
		}

		/** @returns per-currency readings joined by a space. */
		function readings(sums) {
			return [...sums].map(([currency, amount]) => format(amount, SYMBOL[currency] || "")).join(" ");
		}

		/**
		 * Total remaining across both wallets. A currency with nothing left drops
		 * out, unless the whole account is empty — then the first currency still
		 * reads `0.00` instead of the cell disappearing.
		 */
		function remaining(balance) {
			const sums = totals([...balance.value, ...balance.bonusWallets]);
			if (sums.size === 0) return undefined;
			const funded = new Map([...sums].filter(([, amount]) => amount > 0));
			return readings(funded.size > 0 ? funded : new Map([...sums].slice(0, 1)));
		}

		/**
		 * The dock reading. Rendered by the slot after `inject` binds the plugin's
		 * `hooks.balance` snapshot to this component's `useBalance` seat.
		 */
		function Pill({ useBalance }) {
			const state = useBalance((value) => value);
			if (state === undefined || state.signedIn !== true) return null;
			const text = copy();
			const amount = state.amount === undefined ? "--" : state.amount;
			return React.createElement(
				"a",
				{
					href: state.href,
					target: "_blank",
					rel: "noreferrer",
					title: state.breakdown === "" ? text.unavailable : state.breakdown,
					"aria-label": `${text.label} ${amount}`,
					style: {
						display: "inline-flex",
						alignItems: "center",
						minWidth: 0,
						padding: "1px 8px",
						borderRadius: "var(--dsw-radius-sm)",
						color: "var(--dsw-alias-label-tertiary)",
						fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
						fontVariantNumeric: "tabular-nums",
						lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
						textDecoration: "none",
						whiteSpace: "nowrap",
					},
				},
				React.createElement("span", null, amount),
			);
		}

		/** The snapshot the component renders; replaced only when a read changes it. */
		function createStore() {
			let snapshot;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				publish(next) {
					if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
					snapshot = next;
					for (const listener of listeners) listener();
				},
			};
		}
		//#endregion

		//#region 限额设置页
		const DEFAULT_ENABLED = false;
		const DEFAULT_PERTURN = 1;
		const DEFAULT_SESSION = 0;
		const DEFAULT_REMIND = true;
		const TOKENS = {
			descColor: "var(--dsw-alias-label-secondary, #8a8f98)",
			danger: "var(--dsw-alias-state-error-primary, var(--dsw-alias-danger, #e5484d))",
			warning: "var(--dsw-alias-state-warn-label, var(--dsw-alias-warning, #e8a33d))"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap"
		};
		const footerStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8,
			marginTop: 2
		};
		/** 从表单段读出资额与提醒设置（缺省取 schema 默认值）。 */
		function settingsOf(input) {
			const cfg = typeof input === "object" && input !== null ? input : void 0;
			const budget = cfg?.budget;
			const remind = cfg?.remind;
			return {
				enabled: budget?.enabled ?? DEFAULT_ENABLED,
				perTurn: typeof budget?.perTurn === "number" ? budget.perTurn : DEFAULT_PERTURN,
				session: typeof budget?.session === "number" ? budget.session : DEFAULT_SESSION,
				remindPeak: remind?.peak ?? DEFAULT_REMIND
			};
		}
		/** 序列化 resolved 值，用于判断快照是否被外部改动。 */
		function resolvedKey(section) {
			return `${section.enabled}|${section.perTurn}|${section.session}|${section.remindPeak}`;
		}
		/** 摘要行：当前状态。 */
		function summaryText(enabled, perTurn, session) {
			const parts = [];
			parts.push(enabled ? `每轮 ¥${perTurn.toFixed(2)}` : "每轮限额未启用");
			if (session > 0) parts.push(`会话预算 ¥${session.toFixed(2)}`);
			return parts.join(" · ");
		}
		/** 本插件在 Plugins 页的限额 / 提醒表单。 */
		function BudgetSettingsPage({ view, budgetForm }) {
			const subscribe = (listener) => budgetForm.subscribe(listener);
			const getSnapshot = () => budgetForm.getSnapshot();
			const snapshot = (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
			const value = settingsOf(snapshot.value);
			const base = settingsOf(snapshot.base);
			const writable = snapshot.writable;
			const [draftEnabled, setDraftEnabled] = (0, react.useState)(value.enabled);
			const [draftText, setDraftText] = (0, react.useState)(String(value.perTurn));
			const [draftSession, setDraftSession] = (0, react.useState)(String(value.session));
			const [draftRemind, setDraftRemind] = (0, react.useState)(value.remindPeak);
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const lastResolved = (0, react.useRef)(resolvedKey(value));
			(0, react.useEffect)(() => {
				const key = resolvedKey(value);
				if (key === lastResolved.current) return;
				lastResolved.current = key;
				setDraftEnabled(value.enabled);
				setDraftText(String(value.perTurn));
				setDraftSession(String(value.session));
				setDraftRemind(value.remindPeak);
			}, [value.enabled, value.perTurn, value.session, value.remindPeak]);
			if (view === "summary") return null;
			if (snapshot.status === "unavailable") return null;
			if (snapshot.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: 0,
					color: TOKENS.descColor,
					fontSize: 13
				},
				children: "限额设置加载中…"
			});
			const draftPerTurn = Number(draftText);
			const draftSessionValue = Number(draftSession);
			const draftValid = Number.isFinite(draftPerTurn) && draftPerTurn >= 0 && Number.isFinite(draftSessionValue) && draftSessionValue >= 0;
			const dirty = draftEnabled !== value.enabled || !draftValid || draftPerTurn !== value.perTurn || draftSessionValue !== value.session || draftRemind !== value.remindPeak;
			const commit = async (enabled, perTurn, session, remindPeak) => {
				if (!draftValid) return;
				setSaving(true);
				setError(null);
				try {
					const ops = [];
					if (enabled === base.enabled) ops.push({ op: "unset", path: ["budget", "enabled"] });
					else ops.push({ op: "set", path: ["budget", "enabled"], value: enabled });
					if (perTurn === base.perTurn) ops.push({ op: "unset", path: ["budget", "perTurn"] });
					else ops.push({ op: "set", path: ["budget", "perTurn"], value: perTurn });
					if (session === base.session) ops.push({ op: "unset", path: ["budget", "session"] });
					else ops.push({ op: "set", path: ["budget", "session"], value: session });
					if (remindPeak === base.remindPeak) ops.push({ op: "unset", path: ["remind", "peak"] });
					else ops.push({ op: "set", path: ["remind", "peak"], value: remindPeak });
					if (!await budgetForm.mutate(ops, snapshot.revision)) setError("宿主拒绝了本次保存（settings 可能已被其它窗口修改），请稍后重试。");
				} catch (cause) {
					setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
				} finally {
					setSaving(false);
				}
			};
			const onReset = async () => {
				if (saving) return;
				setSaving(true);
				setError(null);
				try {
					if (!await budgetForm.mutate([{
						op: "unset",
						path: ["budget", "enabled"]
					}, {
						op: "unset",
						path: ["budget", "perTurn"]
					}, {
						op: "unset",
						path: ["budget", "session"]
					}, {
						op: "unset",
						path: ["remind", "peak"]
					}], snapshot.revision)) {
						setError("宿主拒绝了本次恢复（settings 可能已被其它窗口修改），请稍后重试。");
						return;
					}
					setDraftEnabled(base.enabled);
					setDraftText(String(base.perTurn));
					setDraftSession(String(base.session));
					setDraftRemind(base.remindPeak);
				} catch (cause) {
					setError(`恢复失败：${cause instanceof Error ? cause.message : String(cause)}`);
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 10,
					fontSize: 13,
					lineHeight: "20px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
								checked: draftEnabled,
								label: "启用每轮消费限额",
								disabled: !writable || saving,
								onChange: (next) => {
									setDraftEnabled(next);
									setError(null);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "启用每轮消费限额" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { color: TOKENS.descColor },
								children: [summaryText(value.enabled, value.perTurn, value.session), dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										color: TOKENS.warning,
										marginLeft: 6
									},
									children: "未保存"
								}) : null]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: rowStyle,
						children: [
							"每轮限额（元）",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								type: "number",
								min: 0,
								step: .1,
								value: draftText,
								disabled: !writable || saving,
								onChange: (event) => {
									setDraftText(event.target.value);
									setError(null);
								},
								style: { width: 110 }
							}),
							!draftValid && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: TOKENS.danger },
								children: "请输入 ≥0 的金额"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: rowStyle,
						children: [
							"整段会话预算（元，0=不启用）",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								type: "number",
								min: 0,
								step: 1,
								value: draftSession,
								disabled: !writable || saving,
								onChange: (event) => {
									setDraftSession(event.target.value);
									setError(null);
								},
								style: { width: 110 }
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
								checked: draftRemind,
								label: "峰谷切换前提醒",
								disabled: !writable || saving,
								onChange: (next) => {
									setDraftRemind(next);
									setError(null);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "峰谷切换前提醒（北京时间，距切换 30 分钟内）" })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							lineHeight: "18px",
							color: TOKENS.descColor
						},
						children: "超限行为：仅提示。agent 运行中会在聊天区下方显示“本轮 x / 限额 y（超限变红）”； 每轮结束后“本轮总消费”芯片标红并注明超限。峰谷按北京时间周一至周五 9–12、14–18 为高峰，其余半价。保存即写入当前 profile 的 cordis.patch.yml，无需重启。"
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { color: TOKENS.danger },
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: footerStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: !writable || saving,
							onClick: () => void onReset(),
							children: "恢复组合层默认"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: !writable || saving || !dirty || !draftValid,
							onClick: () => void commit(draftEnabled, draftPerTurn, draftSessionValue, draftRemind),
							children: saving ? "保存中…" : "保存"
						})]
					})
				]
			});
		}
		//#endregion

		//#region 费用显示
		const fmt = (n) => n.toLocaleString("zh-CN");
		/** 金额格式：≥1 元两位小数，否则四位（避免出现 0.0000）。 */
		function formatMoney(n) {
			if (n <= 0) return "¥0";
			return `¥${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
		}
		/** 限额行/警示用金额：固定两位小数（元）。 */
		function formatYuan(n) {
			return `¥${n.toFixed(2)}`;
		}
		/** 主题 danger 文本色（0.2 的 state-error-primary；旧版本/缺省时逐级兜底）。 */
		const DANGER = "var(--dsw-alias-state-error-primary, var(--dsw-alias-danger, #e5484d))";
		const MUTED = "var(--dsw-alias-label-secondary, #8a8f98)";
		/** 该条消息的内容形状标签（与宿主记录的 text/tools 对应）。 */
		function kindLabel(m) {
			if (m.text) return "文本";
			if (m.tools.length > 0) {
				const name = m.tools[0];
				return m.tools.length > 1 ? `工具 ${name} 等${m.tools.length}个` : `工具 ${name}`;
			}
			return "推理/其它";
		}
		/** 时刻 → 本地 HH:MM:SS。 */
		function clock(ms) {
			return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
		}
		/**
		 * 是否处于高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00。
		 */
		function isPeakHour(date = /* @__PURE__ */ new Date()) {
			const bj = new Date(date.getTime() + 288e5);
			const day = bj.getUTCDay();
			if (day === 0 || day === 6) return false;
			const h = bj.getUTCHours();
			return h >= 9 && h < 12 || h >= 14 && h < 18;
		}
		/** 下一个峰谷切换时刻（毫秒），未来 6 天内找不到则 null。 */
		function nextPeakBoundary(now) {
			const t = now.getTime();
			for (let d = 0; d < 6; d++) {
				const day = new Date(t + 288e5 + d * 864e5);
				const dow = day.getUTCDay();
				if (dow === 0 || dow === 6) continue;
				const y = day.getUTCFullYear();
				const mo = day.getUTCMonth();
				const da = day.getUTCDate();
				for (const h of [9, 12, 14, 18]) {
					const at = Date.UTC(y, mo, da, h) - 288e5;
					if (at > t + 1000) return at;
				}
			}
			return null;
		}
		/** 当前峰谷状态 + 距下次切换的分钟数。 */
		function peakStatus(now = /* @__PURE__ */ new Date()) {
			const at = nextPeakBoundary(now);
			return {
				peak: isPeakHour(now),
				mins: at === null ? null : Math.max(0, Math.round((at - now.getTime()) / 6e4))
			};
		}
		/** 进行中步骤已流出的字符数（正文 + 思考 + 工具参数），用于估算输出 token。 */
		function partialChars(partial) {
			if (partial === null || partial === void 0) return 0;
			let chars = 0;
			for (const block of partial.blocks) if (block.kind === "tool-call") chars += block.argsRaw?.length ?? 0;
			else if (block.kind === "text" || block.kind === "reasoning") chars += block.text?.length ?? 0;
			return chars;
		}
		/**
		 * 按 estimation 口径估算进行中步骤的输出费用（元）。
		 */
		function estimateLiveCost(partial, estimation, model) {
			const chars = partialChars(partial);
			if (chars <= 0) return 0;
			const outputPrice = estimation.outputPrices[model] ?? estimation.outputPrices[estimation.defaultModel] ?? 0;
			const rate = estimation.peakMode === "peak" || estimation.peakMode === "auto" && isPeakHour() ? 1 : .5;
			return chars / estimation.charsPerToken / 1e6 * outputPrice * rate;
		}
		/** 按某个键把消息聚合成账单行（按费用降序）。 */
		function groupMessages(messages, keyOf) {
			const map = new Map();
			for (const m of messages) {
				const key = keyOf(m) || "未知";
				const cur = map.get(key) ?? { cost: 0, input: 0, cacheRead: 0, output: 0, messages: 0 };
				cur.cost += m.cost;
				cur.input += m.input;
				cur.cacheRead += m.cacheRead;
				cur.output += m.output;
				cur.messages += 1;
				map.set(key, cur);
			}
			return [...map].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.cost - a.cost);
		}
		/** CSV 单元转义。 */
		function csvCell(value) {
			const text = String(value ?? "");
			return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
		}
		/** 组装 CSV（带 BOM，Excel 直接打开不乱码）。 */
		function toCsv(header, rows) {
			return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
		}
		/** 触发浏览器下载。 */
		function download(filename, text, mime) {
			const blob = new Blob([text], { type: mime });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			setTimeout(() => {
				URL.revokeObjectURL(url);
				anchor.remove();
			}, 0);
		}
		/** 导出文件名用的短会话 id。 */
		function shortId(id) {
			return String(id ?? "session").slice(0, 8);
		}
		/** 会话列表行 → 账单行（只取摘要投影，不读明细）。 */
		function sessionBillRows(snapshot) {
			const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
			return items.map((item) => {
				const sum = item.projectionValues?.costSummary?.totals;
				return {
					id: String(item.sessionId ?? item.id ?? ""),
					title: String(item.title ?? item.displayTitle ?? ""),
					updatedAt: Number(item.updatedAt ?? 0),
					cost: Number(sum?.cost ?? 0),
					input: Number(sum?.input ?? 0),
					cacheRead: Number(sum?.cacheRead ?? 0),
					output: Number(sum?.output ?? 0),
					messages: Number(sum?.messages ?? 0)
				};
			}).filter((row) => row.id !== "").sort((a, b) => b.updatedAt - a.updatedAt);
		}
		/** 账单面板里的小表格。 */
		function BillTable({ rows, empty }) {
			if (rows.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { fontSize: 12, color: MUTED },
				children: empty
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { fontSize: 12, lineHeight: "18px" },
				children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						justifyContent: "space-between",
						gap: 8,
						borderTop: "1px solid rgba(255,255,255,.08)",
						padding: "1px 0"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
						children: [row.key ?? row.title ?? row.id, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .65 },
							children: [" · ", row.messages, " 次"]
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
						children: formatMoney(row.cost)
					})]
				}))
			});
		}
		/** 订阅式弹层：费用账单主面板。 */
		function CostPanel({ view, sessionId, sessions, onClose }) {
			const messages = Object.values(view.messages).sort((a, b) => a.turn - b.turn || a.step - b.step || a.time - b.time);
			const t = view.totals;
			const byModel = groupMessages(messages, (m) => m.model);
			const byProvider = groupMessages(messages, (m) => m.provider);
			const billRows = sessionBillRows(sessions);
			const status = peakStatus();
			const remindOn = view.remind?.peak !== false;
			const lead = view.remind?.leadMinutes ?? 30;
			const nearSwitch = status.mins !== null && status.mins <= lead;
			const peakText = `${status.peak ? "峰时 · 全价" : "谷时 · 半价"}${status.mins === null ? "" : `（${status.mins} 分钟后转${status.peak ? "谷时" : "峰时"}）`}`;
			const budgetSession = view.budget.session ?? 0;
			const overSession = budgetSession > 0 && t.cost > budgetSession;
			const exportSessionCsv = () => {
				download(`费用明细-${shortId(sessionId)}.csv`, toCsv([
					"轮次", "步骤", "时间", "模型", "供应商", "类型", "未命中输入", "缓存读", "输出", "峰谷", "费用(元)"
				], messages.map((m) => [
					m.turn, m.step, clock(m.time), m.model, m.provider, kindLabel(m), m.input, m.cacheRead, m.output, m.peak ? "峰" : "谷", m.cost.toFixed(6)
				])), "text/csv;charset=utf-8");
			};
			const exportSessionJson = () => {
				download(`费用明细-${shortId(sessionId)}.json`, JSON.stringify({
					sessionId, exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
					totals: t, budget: view.budget, estimation: view.estimation, messages
				}, null, 2), "application/json;charset=utf-8");
			};
			const exportSessionsCsv = () => {
				download("会话账单.csv", toCsv([
					"会话ID", "标题", "更新时间", "费用(元)", "未命中输入", "缓存读", "输出", "调用次数"
				], billRows.map((row) => [
					row.id, row.title, row.updatedAt === 0 ? "" : new Date(row.updatedAt).toLocaleString("zh-CN"), row.cost.toFixed(6), row.input, row.cacheRead, row.output, row.messages
				])), "text/csv;charset=utf-8");
			};
			const section = (title, children) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 6 },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: { fontSize: 12, opacity: .8, marginTop: 2 },
					children: title
				}), children]
			});
			const buttonStyle = {
				fontSize: 12, lineHeight: "18px", padding: "1px 8px",
				borderRadius: 6, cursor: "pointer", color: "inherit",
				background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.16)"
			};
			return /* @__PURE__ */ portalize(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					position: "fixed", left: "50%", top: "10vh", transform: "translateX(-50%)",
					zIndex: 400, width: 560, maxWidth: "min(94vw, 560px)", maxHeight: "76vh",
					overflowY: "auto", boxSizing: "border-box", padding: "10px 12px",
					borderRadius: 12, background: "var(--dsw-alias-tooltip-bg, #23272e)",
					color: "var(--dsw-static-neutral-bluish-00, #f5f6f8)",
					boxShadow: "0 12px 32px rgba(0,0,0,.35)", fontVariantNumeric: "tabular-nums",
					pointerEvents: "auto", whiteSpace: "normal", overflowWrap: "break-word"
				},
				role: "dialog",
				"data-cost-panel": true,
				onClick: (e) => e.stopPropagation(),
				onMouseDown: (e) => e.stopPropagation(),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", {
							style: { fontSize: 13 },
							children: ["费用账单", sessionId === undefined ? "" : ` · ${shortId(sessionId)}`]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: { ...buttonStyle, border: "none", background: "transparent", fontSize: 14 },
							onClick: onClose,
							children: "✕"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { fontSize: 12, lineHeight: "18px", marginTop: 4 },
						children: ["合计 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: formatMoney(t.cost) }),
							" · 未命中输入 ", fmt(t.input), " · 缓存读 ", fmt(t.cacheRead), " · 输出 ", fmt(t.output),
							" · ", t.messages, " 次调用"]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { fontSize: 12, lineHeight: "18px", marginTop: 2, color: nearSwitch && remindOn && !status.peak ? TOKENS.warning : MUTED },
						children: ["峰谷：", peakText, remindOn && nearSwitch ? " · 即将切换，注意计费" : ""]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { fontSize: 12, lineHeight: "18px", marginTop: 2, color: overSession ? DANGER : MUTED },
						children: ["预算：", view.budget.enabled ? `每轮 ${formatYuan(view.budget.perTurn)}` : "每轮未启用",
							budgetSession > 0 ? ` · 会话 ${formatYuan(t.cost)} / ${formatYuan(budgetSession)}${overSession ? "（已超）" : ""}` : " · 会话预算未启用"]
					}),
					section("按模型分账", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BillTable, { rows: byModel, empty: "暂无模型调用" })),
					section("按供应商分账", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BillTable, { rows: byProvider, empty: "暂无供应商调用" })),
					section("会话账单（最近 12 条）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BillTable, {
						rows: billRows.slice(0, 12).map((row) => ({
							...row,
							key: row.title === "" ? row.id : row.title
						})),
						empty: "暂无其它会话账单"
					})),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", { style: buttonStyle, onClick: exportSessionCsv, children: "导出本会话 CSV" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", { style: buttonStyle, onClick: exportSessionJson, children: "导出本会话 JSON" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", { style: buttonStyle, onClick: exportSessionsCsv, children: "导出全部会话账单 CSV" })]
					}),
					section("调用明细（" + messages.length + " 次）", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { maxHeight: 200, overflowY: "auto", fontSize: 12, lineHeight: "18px" },
						children: messages.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", justifyContent: "space-between", gap: 8, borderTop: "1px solid rgba(255,255,255,.08)" },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								children: ["#", m.step, " ", clock(m.time), " ", kindLabel(m), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: { opacity: .7 },
									children: [" ", m.provider, "/", m.model, " 入", fmt(m.input), "·缓存读", fmt(m.cacheRead), "·出", fmt(m.output)]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { flexShrink: 0, opacity: m.cost > 0 ? 1 : .5 },
								children: formatMoney(m.cost)
							})]
						}, `${m.turn}-${m.step}-${m.time}`))
					}))
				]
			}));
		}
		const LiveBudgetLine = (0, react.memo)(function LiveBudgetLine({ useProjection, useSession, useChat }) {
			const running = useSession?.((s) => s.running) === true;
			const view = useProjection("cost");
			const partial = useChat?.((s) => s.legacy?.partial);
			const budgetOn = view?.budget.enabled === true;
			const sessionBudget = view?.budget.session ?? 0;
			if (!running || view === void 0 || (!budgetOn && sessionBudget <= 0)) return null;
			let turn = view.openTurn ?? partial?.turn ?? null;
			if (turn === null) {
				for (const m of Object.values(view.messages)) if (turn === null || m.turn > turn) turn = m.turn;
				if (turn === null) return null;
			}
			let spend = 0;
			let lastStep = -1;
			let lastTime = -1;
			let lastModel = "";
			for (const m of Object.values(view.messages)) {
				if (m.turn !== turn) continue;
				spend += m.cost;
				if (m.step > lastStep || m.step === lastStep && m.time >= lastTime) {
					lastModel = m.model;
					lastStep = m.step;
					lastTime = m.time;
				}
			}
			const estimateModel = lastModel === "" ? view.estimation.defaultModel : lastModel;
			const live = partial !== null && partial !== void 0 && partial.turn === turn ? estimateLiveCost(partial, view.estimation, estimateModel) : 0;
			const estimating = live > 0;
			if (estimating) spend += live;
			const over = budgetOn && spend > view.budget.perTurn;
			const sessionSpend = view.totals.cost;
			const overSession = sessionBudget > 0 && sessionSpend > sessionBudget;
			const color = over || overSession ? DANGER : "var(--dsw-alias-label-secondary, #8a8f98)";
			const spendText = estimating || spend < .005 ? `¥${spend.toFixed(4)}` : formatYuan(spend);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "status",
				"aria-live": "polite",
				style: {
					boxSizing: "border-box",
					margin: "0 auto",
					width: "calc(100% - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))",
					maxWidth: "calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))",
					fontSize: 12,
					lineHeight: "18px",
					color,
					fontVariantNumeric: "tabular-nums",
					padding: "2px 0"
				},
				children: [
					(over || overSession) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						children: "⚠ "
					}),
					budgetOn && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, {
						children: ["本轮 ", estimating ? "≈" : "", spendText, " / 限额 ", formatYuan(view.budget.perTurn)]
					}),
					budgetOn && sessionBudget > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: " · " }),
					sessionBudget > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, {
						children: ["会话 ", formatYuan(sessionSpend), " / ", formatYuan(sessionBudget)]
					}),
					estimating && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							opacity: .75,
							marginLeft: 6
						},
						children: "（含流式估算）"
					}),
					over && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { marginLeft: 6 },
						children: "已超本轮限额"
					}),
					overSession && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { marginLeft: 6 },
						children: "已超会话预算"
					})
				]
			});
		});
		/** 离开芯片/浮层后关闭的容差（毫秒），避免光标在两者间移动时闪烁。 */
		const HIDE_GRACE_MS = 180;
		const TurnCostSummary = (0, react.memo)(function TurnCostSummary({ messageId, useProjection }) {
			const cost = useProjection("cost");
			const closing = cost?.messages[messageId];
			const [open, setOpen] = (0, react.useState)(false);
			const [anchor, setAnchor] = (0, react.useState)(null);
			const [placement, setPlacement] = (0, react.useState)("bottom");
			const chipRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const hideTimer = (0, react.useRef)(null);
			const MARGIN = 8;
			(0, react.useLayoutEffect)(() => {
				if (!open || anchor === null) return;
				const el = panelRef.current;
				/* v8 ignore next -- anchor 只在面板挂载期间非空。 */
				if (el === null) return;
				const r = el.getBoundingClientRect();
				el.style.left = `${Math.min(Math.max(anchor.x, MARGIN), window.innerWidth - r.width - MARGIN)}px`;
				if (placement === "bottom") {
					el.style.top = `${anchor.bottom + 6}px`;
					const fitsBelow = anchor.bottom + 6 + r.height <= window.innerHeight - MARGIN;
					const fitsAbove = anchor.top - 6 - r.height >= MARGIN;
					if (!fitsBelow && fitsAbove) setPlacement("top");
				} else {
					el.style.top = `${anchor.top - 6 - r.height}px`;
					const fitsAbove = anchor.top - 6 - r.height >= MARGIN;
					const fitsBelow = anchor.bottom + 6 + r.height <= window.innerHeight - MARGIN;
					if (!fitsAbove && fitsBelow) setPlacement("bottom");
				}
			}, [
				open,
				anchor,
				placement
			]);
			if (cost === void 0 || closing === void 0 || closing.turn === 0) return null;
			const steps = Object.values(cost.messages).filter((m) => m.turn === closing.turn).sort((a, b) => a.step - b.step || a.time - b.time);
			if (steps.length === 0) return null;
			const totalCost = steps.reduce((s, m) => s + m.cost, 0);
			const totalInput = steps.reduce((s, m) => s + m.input, 0);
			const totalRead = steps.reduce((s, m) => s + m.cacheRead, 0);
			const totalOut = steps.reduce((s, m) => s + m.output, 0);
			const models = new Set(steps.map((m) => m.model));
			const modelLine = models.size === 1 ? [...models][0] : [...models].join(" / ");
			const providers = new Set(steps.map((m) => m.provider));
			const providerLine = providers.size === 1 ? [...providers][0] : [...providers].join(" / ");
			const dialogue = closing.cost;
			const overBudget = cost.budget.enabled && totalCost > cost.budget.perTurn;
			const overLimitNote = overBudget ? `（限额 ${formatYuan(cost.budget.perTurn)}）` : "";
			const cancelHide = () => {
				if (hideTimer.current !== null) {
					clearTimeout(hideTimer.current);
					hideTimer.current = null;
				}
			};
			const scheduleHide = () => {
				cancelHide();
				hideTimer.current = setTimeout(() => {
					hideTimer.current = null;
					setOpen(false);
					setAnchor(null);
				}, HIDE_GRACE_MS);
			};
			const show = () => {
				cancelHide();
				const el = chipRef.current;
				if (el === null) return;
				const r = el.getBoundingClientRect();
				setPlacement("bottom");
				setAnchor({
					x: r.left,
					top: r.top,
					bottom: r.bottom
				});
				setOpen(true);
			};
			const hideNow = () => {
				cancelHide();
				setOpen(false);
				setAnchor(null);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: chipRef,
				style: {
					cursor: "help", fontSize: 12, lineHeight: "18px",
					color: overBudget ? DANGER : "var(--dsw-alias-label-secondary, #8a8f98)",
					fontVariantNumeric: "tabular-nums"
				},
				onMouseEnter: show,
				onMouseLeave: scheduleHide,
				onClick: open ? hideNow : show,
				children: [
					overBudget && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						children: "⚠ "
					}),
					"本轮总消费 ",
					formatMoney(totalCost),
					open && anchor !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						ref: panelRef,
						style: {
							position: "fixed",
							zIndex: 300,
							width: 460,
							maxWidth: `min(92vw, 460px)`,
							boxSizing: "border-box",
							padding: "8px 10px",
							borderRadius: 10,
							background: "var(--dsw-alias-tooltip-bg, #23272e)",
							color: "var(--dsw-static-neutral-bluish-00, #f5f6f8)",
							boxShadow: "0 8px 24px rgba(0,0,0,.28)",
							fontVariantNumeric: "tabular-nums",
							pointerEvents: "auto",
							whiteSpace: "normal",
							overflowWrap: "break-word"
						},
						role: "tooltip",
						onMouseEnter: cancelHide,
						onMouseLeave: scheduleHide,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 12,
									lineHeight: "18px",
									opacity: .85
								},
								children: [
									"第 ",
									closing.turn,
									" 轮 · ",
									steps.length,
									" 次模型调用 · ",
									modelLine
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 12,
									lineHeight: "18px",
									opacity: .7
								},
								children: ["供应商 ", providerLine]
							}),
							overBudget && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 12,
									lineHeight: "18px",
									marginTop: 2,
									color: DANGER
								},
								children: ["⚠ 已超本轮限额 ", formatYuan(cost.budget.perTurn)]
							}),
							steps.length > 1 && dialogue > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									justifyContent: "space-between",
									gap: 8,
									fontSize: 12,
									lineHeight: "18px",
									marginTop: 4
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"对话费用（本条回复 #",
									closing.step,
									"）",
									overLimitNote
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { opacity: .85 },
									children: formatMoney(dialogue)
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
								borderTop: "1px solid rgba(255,255,255,.1)",
								margin: "5px 0"
							} }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 12,
									lineHeight: "16px",
									opacity: .75,
									marginBottom: 2
								},
								children: [
									"调用明细（",
									steps.length,
									" 次）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									maxHeight: 260,
									overflowY: "auto"
								},
								children: steps.map((m) => {
									const isClosing = m.step === closing.step && m.time === closing.time;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											justifyContent: "space-between",
											gap: 8,
											fontSize: 12,
											lineHeight: "20px",
											borderTop: "1px solid rgba(255,255,255,.08)"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap"
											},
											children: [
												"#",
												m.step,
												" ",
												clock(m.time),
												" ",
												kindLabel(m),
												isClosing && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: { opacity: .65 },
													children: "（本条回复）"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: { opacity: .7 },
													children: [
														" ",
														"入",
														fmt(m.input),
														"·缓存读",
														fmt(m.cacheRead),
														"·出",
														fmt(m.output)
													]
												})
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flexShrink: 0,
												opacity: m.cost > 0 ? 1 : .5
											},
											children: formatMoney(m.cost)
										})]
									}, `${m.turn}-${m.step}-${m.time}`);
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									justifyContent: "space-between",
									gap: 8,
									fontSize: 12,
									lineHeight: "18px",
									marginTop: 4,
									borderTop: "1px solid rgba(255,255,255,.14)",
									paddingTop: 4
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"本轮合计 · 入 ",
									fmt(totalInput),
									" · 缓存读 ",
									fmt(totalRead),
									" · 出 ",
									fmt(totalOut)
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: formatMoney(totalCost) })]
							})
						]
					})
				]
			});
		});
		const CostTotalBar = (0, react.memo)(function CostTotalBar({ useProjection, useSessions, sessionId }) {
			const cost = useProjection("cost");
			const [open, setOpen] = (0, react.useState)(false);
			/** 会话列表（全局标准 props）；缺省时面板里只显示本会话。 */
			const sessions = typeof useSessions === "function" ? useSessions((snapshot) => snapshot) : void 0;
			if (cost === void 0 || cost.totals.messages === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontSize: "12px",
					color: "var(--dsw-alias-label-secondary, #8a8f98)"
				},
				children: "消费统计：等待数据…"
			});
			const t = cost.totals;
			const status = peakStatus();
			const remindOn = cost.remind?.peak !== false;
			const nearSwitch = remindOn && status.mins !== null && status.mins <= (cost.remind?.leadMinutes ?? 30);
			const peakLabel = status.peak ? "峰时·全价" : "谷时·半价";
			const overSession = (cost.budget.session ?? 0) > 0 && t.cost > cost.budget.session;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				title: `${t.messages} 条模型消息 · 输入 ${fmt(t.input)}（缓存读 ${fmt(t.cacheRead)}）· 输出 ${fmt(t.output)}${status.mins === null ? "" : ` · ${status.mins} 分钟后切换峰谷`} · 点击查看账单`,
				onClick: (event) => {
					if (event.target && event.target.closest && event.target.closest("[data-cost-panel]")) return;
					setOpen((value) => !value);
				},
				style: {
					fontSize: "12px",
					lineHeight: "18px",
					color: overSession ? DANGER : "var(--dsw-alias-label-secondary, #8a8f98)",
					fontVariantNumeric: "tabular-nums",
					cursor: "pointer",
					pointerEvents: "auto"
				},
				children: [
					"总消费 ",
					formatMoney(t.cost),
					" · 输入 ",
					fmt(t.input + t.cacheRead),
					" · 输出 ",
					fmt(t.output),
					" · ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: nearSwitch ? TOKENS.warning : void 0 },
						children: peakLabel
					}),
					" · ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { textDecoration: "underline" },
						children: open ? "收起账单" : "账单明细"
					}),
					open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CostPanel, {
						view: cost,
						sessionId,
						sessions,
						onClose: () => setOpen(false)
					})
				]
			});
		});
		/** 侧边栏「费用账单」整页面板的 key（同时用作 sidebar.panellist 的 id）。 */
		const PANEL_ID = "money-widgets";
		const inputStyle = {
			width: 96, fontSize: 12, lineHeight: "18px", padding: "1px 6px",
			borderRadius: 6, border: "1px solid rgba(255,255,255,.16)",
			background: "rgba(255,255,255,.06)", color: "inherit"
		};
		const panelButtonStyle = {
			fontSize: 12, lineHeight: "18px", padding: "2px 10px",
			borderRadius: 6, cursor: "pointer", color: "inherit",
			background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.16)"
		};

		/** 把 costSummary 里的 models/providers 桶合并进 target。 */
		function mergeBuckets(target, source) {
			for (const [key, bucket] of Object.entries(source ?? {})) {
				const cur = target[key] ?? (target[key] = { input: 0, cacheRead: 0, output: 0, cost: 0, messages: 0 });
				cur.input += Number(bucket.input ?? 0);
				cur.cacheRead += Number(bucket.cacheRead ?? 0);
				cur.output += Number(bucket.output ?? 0);
				cur.cost += Number(bucket.cost ?? 0);
				cur.messages += Number(bucket.messages ?? 0);
			}
			return target;
		}

		/** 侧栏图标（¥ 形状，跟随 currentColor）。 */
		function MoneyWidgetsIcon({ size }) {
			const s = typeof size === "number" ? size : 18;
			return (0, react_jsx_runtime.jsx)("svg", {
				width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M8 1.6v12.8M3.4 4.4h6.9a2.1 2.1 0 0 1 0 4.2H5.7a2.1 2.1 0 0 0 0 4.2h6.9",
					stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round"
				})
			});
		}

		function exportRows(header, rows, filename) {
			download(filename, toCsv(header, rows), "text/csv;charset=utf-8");
		}

		/** 面板里的预算编辑器（独立组件，保证 hooks 无条件调用）。 */
		function PanelBudget({ budgetForm, saveSettings }) {
			const subscribe = (listener) => budgetForm.subscribe(listener);
			const getSnapshot = () => budgetForm.getSnapshot();
			const snapshot = (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
			const value = settingsOf(snapshot.value);
			const base = settingsOf(snapshot.base);
			const [enabled, setEnabled] = (0, react.useState)(value.enabled);
			const [perTurn, setPerTurn] = (0, react.useState)(String(value.perTurn));
			const [session, setSession] = (0, react.useState)(String(value.session));
			const [remind, setRemind] = (0, react.useState)(value.remindPeak);
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const perTurnValue = Number(perTurn);
			const sessionValue = Number(session);
			const valid = Number.isFinite(perTurnValue) && perTurnValue >= 0 && Number.isFinite(sessionValue) && sessionValue >= 0;
			const commit = async () => {
				if (!valid || saving) return;
				setSaving(true);
				setError(null);
				try {
					const ops = [
						enabled === base.enabled ? { op: "unset", path: ["budget", "enabled"] } : { op: "set", path: ["budget", "enabled"], value: enabled },
						perTurnValue === base.perTurn ? { op: "unset", path: ["budget", "perTurn"] } : { op: "set", path: ["budget", "perTurn"], value: perTurnValue },
						sessionValue === base.session ? { op: "unset", path: ["budget", "session"] } : { op: "set", path: ["budget", "session"], value: sessionValue },
						remind === base.remindPeak ? { op: "unset", path: ["remind", "peak"] } : { op: "set", path: ["remind", "peak"], value: remind }
					];
					const written = await budgetForm.mutate(ops, snapshot.revision);
					if (!written) {
						let detail = "";
						if (typeof saveSettings === "function") {
							const result = await saveSettings(ops, snapshot.revision);
							if (result?.ok) return;
							detail = result?.message ? `：${result.message}` : "";
						}
						setError(`宿主拒绝了本次保存${detail}`);
					}
				} catch (cause) {
					setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
				} finally {
					setSaving(false);
				}
			};
			if (snapshot.status === "unavailable") return null;
			if (snapshot.status === "loading") return (0, react_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: MUTED }, children: "预算加载中…" });
			const rowStyle = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { display: "flex", flexDirection: "column", gap: 8, fontSize: 12, lineHeight: "18px" },
				children: [
					(0, react_jsx_runtime.jsxs)("label", { style: rowStyle, children: [
						(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: enabled, onChange: (e) => setEnabled(e.currentTarget.checked) }),
						"启用每轮限额"
					] }),
					(0, react_jsx_runtime.jsxs)("label", { style: rowStyle, children: [
						"每轮限额（元）",
						(0, react_jsx_runtime.jsx)("input", { type: "number", min: 0, step: 0.01, value: perTurn, onChange: (e) => setPerTurn(e.currentTarget.value), style: inputStyle })
					] }),
					(0, react_jsx_runtime.jsxs)("label", { style: rowStyle, children: [
						"整段会话预算（元，0=不启用）",
						(0, react_jsx_runtime.jsx)("input", { type: "number", min: 0, step: 0.01, value: session, onChange: (e) => setSession(e.currentTarget.value), style: inputStyle })
					] }),
					(0, react_jsx_runtime.jsxs)("label", { style: rowStyle, children: [
						(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked: remind, onChange: (e) => setRemind(e.currentTarget.checked) }),
						"峰谷切换前提醒"
					] }),
					(0, react_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
						(0, react_jsx_runtime.jsx)("button", { style: panelButtonStyle, disabled: saving || !valid, onClick: commit, children: saving ? "保存中…" : "保存预算" }),
						error === null ? null : (0, react_jsx_runtime.jsx)("span", { style: { color: DANGER }, children: error })
					] })
				]
			});
		}

		/** 侧边栏「费用账单」整页：跨会话汇总 / 按模型 / 按供应商 / 会话账单 / 预算 / 导出。 */
		/** 从宿主路由读取会话账单台账（宿主直接聚合会话日志，覆盖历史会话）。 */
		function useBills() {
			const [state, setState] = (0, react.useState)({ status: "loading", data: null, error: null });
			const load = (0, react.useCallback)(async (force) => {
				try {
					const response = await fetch(`/plugins/money-widgets/bills${force ? "?refresh=1" : ""}`, {
						credentials: "same-origin",
						cache: "no-store"
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					if (data !== null && typeof data === "object" && typeof data.error === "string") throw new Error(data.error);
					setState({ status: "ready", data, error: null });
				} catch (error) {
					setState((prev) => ({ status: "error", data: prev.data, error: String(error?.message ?? error) }));
				}
			}, []);
			(0, react.useEffect)(() => {
				void load(false);
				const timer = setInterval(() => {
					void load(false);
				}, 20_000);
				return () => clearInterval(timer);
			}, [load]);
			return [state, load];
		}

		/** 每日账单：每天一行，点开看当天的会话 / 模型 / 供应商分账。 */
		function DayBills({ days, empty }) {
			const [openDate, setOpenDate] = (0, react.useState)(null);
			if (!Array.isArray(days) || days.length === 0) return (0, react_jsx_runtime.jsx)("div", {
				style: { fontSize: 12, color: MUTED },
				children: empty
			});
			const toRows = (map) => Object.entries(map ?? {}).map(([key, bucket]) => ({
				key,
				cost: Number(bucket?.cost ?? 0),
				messages: Number(bucket?.messages ?? 0)
				})).sort((a, b) => b.cost - a.cost);
			return (0, react_jsx_runtime.jsx)("div", {
				style: { fontSize: 12, lineHeight: "18px" },
				children: days.map((day) => {
					const open = openDate === day.date;
					const sessions = (Array.isArray(day.sessions) ? day.sessions : []).map((s) => ({
						key: s.title ? String(s.title) : shortId(s.id),
						cost: Number(s.cost ?? 0),
						messages: Number(s.messages ?? 0)
					}));
					return (0, react_jsx_runtime.jsxs)("div", {
						key: day.date,
						children: [(0, react_jsx_runtime.jsxs)("div", {
							onClick: () => setOpenDate(open ? null : day.date),
							style: { display: "flex", justifyContent: "space-between", gap: 8, cursor: "pointer", borderTop: "1px solid rgba(255,255,255,.08)", padding: "1px 0" },
							children: [(0, react_jsx_runtime.jsxs)("span", {
								style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
								children: [(0, react_jsx_runtime.jsx)("span", { style: { opacity: .65 }, children: open ? "▾ " : "▸ " }), day.date, (0, react_jsx_runtime.jsxs)("span", {
									style: { opacity: .65 },
									children: [" · ", Number(day.totals?.messages ?? 0), " 次"]
								})]
							}), (0, react_jsx_runtime.jsx)("span", {
								style: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
								children: formatMoney(Number(day.totals?.cost ?? 0))
							})]
						}), open ? (0, react_jsx_runtime.jsxs)("div", {
							style: { padding: "2px 0 8px 14px", display: "flex", flexDirection: "column", gap: 4 },
							children: [
								(0, react_jsx_runtime.jsx)("div", { style: { opacity: .75 }, children: "按会话" }),
								(0, react_jsx_runtime.jsx)(BillTable, { rows: sessions, empty: "当天无会话记录" }),
								(0, react_jsx_runtime.jsx)("div", { style: { opacity: .75 }, children: "按模型" }),
								(0, react_jsx_runtime.jsx)(BillTable, { rows: toRows(day.models), empty: "当天无模型调用" }),
								(0, react_jsx_runtime.jsx)("div", { style: { opacity: .75 }, children: "按供应商" }),
								(0, react_jsx_runtime.jsx)(BillTable, { rows: toRows(day.providers), empty: "当天无供应商调用" })
							]
						}) : null]
					});
				})
			});
		}
		function MoneyWidgetsPage({ useSessions, budgetForm, saveSettings }) {
			const [bills, reload] = useBills();
			const snapshot = typeof useSessions === "function" ? useSessions((s) => s) : undefined;
			const fallbackRows = sessionBillRows(snapshot);
			const ledger = bills.data;
			const rows = Array.isArray(ledger?.sessions) ? ledger.sessions.map((row) => ({
				id: String(row.sessionId ?? ""),
				title: String(row.title ?? ""),
				updatedAt: Number(row.updatedAt ?? 0),
				cost: Number(row.totals?.cost ?? 0),
				input: Number(row.totals?.input ?? 0),
				cacheRead: Number(row.totals?.cacheRead ?? 0),
				output: Number(row.totals?.output ?? 0),
				messages: Number(row.totals?.messages ?? 0)
			})).sort((a, b) => b.updatedAt - a.updatedAt).filter((row) => row.id !== "") : fallbackRows;
			const totals = ledger?.totals ? {
				input: Number(ledger.totals.input ?? 0),
				cacheRead: Number(ledger.totals.cacheRead ?? 0),
				output: Number(ledger.totals.output ?? 0),
				cost: Number(ledger.totals.cost ?? 0),
				messages: Number(ledger.totals.messages ?? 0)
			} : rows.reduce((acc, row) => ({
				input: acc.input + row.input,
				cacheRead: acc.cacheRead + row.cacheRead,
				output: acc.output + row.output,
				cost: acc.cost + row.cost,
				messages: acc.messages + row.messages
			}), {
				input: 0,
				cacheRead: 0,
				output: 0,
				cost: 0,
				messages: 0
			});
			const models = {};
			const providers = {};
			if (ledger?.models) mergeBuckets(models, ledger.models);
			if (ledger?.providers) mergeBuckets(providers, ledger.providers);
			if (ledger === null || ledger === undefined) {
				for (const item of Array.isArray(snapshot?.items) ? snapshot.items : []) {
					const sum = item.projectionValues?.costSummary;
					if (sum === undefined) continue;
					mergeBuckets(models, sum.models);
					mergeBuckets(providers, sum.providers);
				}
			}
			const modelRows = Object.entries(models).map(([key, bucket]) => ({
				key,
				...bucket
			})).sort((a, b) => b.cost - a.cost);
			const providerRows = Object.entries(providers).map(([key, bucket]) => ({
				key,
				...bucket
			})).sort((a, b) => b.cost - a.cost);
			const status = peakStatus();
			const dayRows = Array.isArray(ledger?.days) ? ledger.days.map((day) => ({
				key: String(day.date ?? ""),
				cost: Number(day.totals?.cost ?? 0),
				input: Number(day.totals?.input ?? 0),
				cacheRead: Number(day.totals?.cacheRead ?? 0),
				output: Number(day.totals?.output ?? 0),
				messages: Number(day.totals?.messages ?? 0)
			})).filter((row) => row.key !== "").sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)) : [];
			const todayKey = String(ledger?.today ?? new Date(Date.now() + 288e5).toISOString().slice(0, 10));
			const todayRow = dayRows.find((row) => row.key === todayKey);
			const weekCost = dayRows.slice(0, 7).reduce((sum, row) => sum + row.cost, 0);
			const weekMessages = dayRows.slice(0, 7).reduce((sum, row) => sum + row.messages, 0);
			const exportAll = () => exportRows([
				"会话ID",
				"标题",
				"更新时间",
				"费用(元)",
				"未命中输入",
				"缓存读",
				"输出",
				"调用次数"
			], rows.map((r) => [
				r.id,
				r.title,
				r.updatedAt === 0 ? "" : new Date(r.updatedAt).toLocaleString("zh-CN"),
				r.cost.toFixed(6),
				r.input,
				r.cacheRead,
				r.output,
				r.messages
			]), "会话账单.csv");
			const exportModels = () => exportRows([
				"模型",
				"费用(元)",
				"未命中输入",
				"缓存读",
				"输出",
				"调用次数"
			], modelRows.map((r) => [
				r.key,
				r.cost.toFixed(6),
				r.input,
				r.cacheRead,
				r.output,
				r.messages
			]), "按模型分账.csv");
			const exportProviders = () => exportRows([
				"供应商",
				"费用(元)",
				"未命中输入",
				"缓存读",
				"输出",
				"调用次数"
			], providerRows.map((r) => [
				r.key,
				r.cost.toFixed(6),
				r.input,
				r.cacheRead,
				r.output,
				r.messages
			]), "按供应商分账.csv");
			const exportDays = () => exportRows([
				"日期",
				"费用(元)",
				"未命中输入",
				"缓存读",
				"输出",
				"调用次数"
			], dayRows.map((r) => [
				r.key,
				r.cost.toFixed(6),
				r.input,
				r.cacheRead,
				r.output,
				r.messages
			]), "每日账单.csv");
			const section = (title, children) => (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [(0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 12,
						opacity: .8
					},
					children: title
				}), children]
			});
			const sourceLine = bills.status === "ready" ? `数据源：会话日志聚合 · ${rows.length} 个会话 · 更新于 ${ledger?.generatedAt ? new Date(ledger.generatedAt).toLocaleTimeString("zh-CN") : "—"}` : bills.status === "loading" ? "数据源：正在读取会话日志…" : `数据源读取失败：${bills.error}（下方为当前会话的实时投影兜底）`;
			return (0, react_jsx_runtime.jsx)("section", {
				"data-money-widgets-panel": true,
				style: {
					padding: "18px 20px 32px",
					overflowY: "auto",
					height: "100%",
					boxSizing: "border-box"
				},
				children: (0, react_jsx_runtime.jsxs)("div", {
					style: {
						maxWidth: 760,
						margin: "0 auto",
						display: "flex",
						flexDirection: "column",
						gap: 14,
						fontSize: 13,
						lineHeight: "20px"
					},
					children: [
						(0, react_jsx_runtime.jsxs)("header", {
							style: {
								display: "flex",
								justifyContent: "space-between",
								alignItems: "baseline",
								gap: 12
							},
							children: [(0, react_jsx_runtime.jsx)("h2", {
								style: {
									margin: 0,
									fontSize: 16
								},
								children: "费用账单"
							}), (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: MUTED
								},
								children: status.peak ? "当前峰时 · 全价" : "当前谷时 · 半价"
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: MUTED
							},
							children: `共 ${rows.length} 个会话 · ${fmt(totals.messages)} 次调用 · 合计 ${formatMoney(totals.cost)}（未命中输入 ${fmt(totals.input)} · 缓存读 ${fmt(totals.cacheRead)} · 输出 ${fmt(totals.output)}）`
						}),
						(0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								color: bills.status === "error" ? "#e0a080" : MUTED
							},
							children: sourceLine
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 6,
								flexWrap: "wrap"
							},
							children: [
								(0, react_jsx_runtime.jsx)("button", {
									style: panelButtonStyle,
									onClick: () => void reload(true),
									children: "刷新"
								}),
								(0, react_jsx_runtime.jsx)("button", {
									style: panelButtonStyle,
									onClick: exportAll,
									children: "导出全部会话 CSV"
								}),
								(0, react_jsx_runtime.jsx)("button", {
									style: panelButtonStyle,
									onClick: exportModels,
									children: "导出按模型 CSV"
								}),
								(0, react_jsx_runtime.jsx)("button", {
									style: panelButtonStyle,
									onClick: exportProviders,
									children: "导出按供应商 CSV"
								}),
								(0, react_jsx_runtime.jsx)("button", {
									style: panelButtonStyle,
									onClick: exportDays,
									children: "导出每日账单 CSV"
								})
							]
						}),
						section("按模型分账", (0, react_jsx_runtime.jsx)(BillTable, {
							rows: modelRows,
							empty: "暂无模型调用"
						})),
						section("按供应商分账", (0, react_jsx_runtime.jsx)(BillTable, {
							rows: providerRows,
							empty: "暂无供应商调用"
						})),
						section("每日账单", (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 4
							},
							children: [(0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: MUTED
								},
								children: `今日 ${todayRow === void 0 ? formatMoney(0) : formatMoney(todayRow.cost)} · 近 7 天 ${formatMoney(weekCost)} · ${fmt(weekMessages)} 次调用`
							}), (0, react_jsx_runtime.jsx)(DayBills, {
								days: Array.isArray(ledger?.days) ? ledger.days.slice(0, 30).map((day) => ({
									...day,
									date: day.date === todayKey ? `${day.date}（今天）` : day.date
								})) : [],
								empty: "暂无每日账单"
							})]
						})),
						section("会话账单", (0, react_jsx_runtime.jsx)(BillTable, {
							rows: rows.slice(0, 60).map((r) => ({
								...r,
								key: r.title === "" ? r.id : r.title
							})),
							empty: "暂无会话账单"
						})),
						section("预算与提醒", budgetForm === null || budgetForm === undefined ? (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								color: MUTED
							},
							children: "预算设置不可用（configForms 未就绪）"
						}) : (0, react_jsx_runtime.jsx)(PanelBudget, {
							budgetForm,
							saveSettings
						}))
					]
				})
			});
		}

		//#endregion

		/** 本插件宿主条目的 id（cordis.patch.yml 里 `- id: money-widgets`）。 */
		const MONEY_ENTRY_ID = "money-widgets";
		/** 本包名，作为 bundle 配置页的 key。 */
		const PACKAGE_NAME = "dsh-plugin-money-widgets";

		function apply(ctx) {
			const slots = ctx.slots;
			let budgetFormRef = null;
			/** 直连 settings 服务保存预算（表单被拒时兜底，并把宿主错误原文带回来）。 */
			const saveSettingsRef = async (ops, revision) => {
				try {
					const settings = ctx.remote?.settings;
					if (settings === undefined || typeof settings.mutate !== "function") {
						return { ok: false, message: "client 运行时不提供 remote.settings" };
					}
					const response = await settings.mutate(MONEY_ENTRY_ID, ops, revision);
					if (response?.ok) return { ok: true };
					const code = response?.error?.code ?? "unknown";
					const message = response?.error?.message ?? String(response?.error ?? "no detail");
					return { ok: false, message: `${code}: ${message}` };
				} catch (error) {
					return { ok: false, message: String(error?.message ?? error) };
				}
			};

			// —— 费用三处 ——
			slots.inject("conversation.input.dock", () => slots.register({
				name: "conversation.input.dock",
				id: "cost-live-budget",
				order: 5
			}, LiveBudgetLine));
			slots.inject("conversation.chat.assistant-actions", () => slots.register({
				name: "conversation.chat.assistant-actions",
				id: "cost-turn-summary",
				order: 10
			}, TurnCostSummary));
			slots.inject("conversation.composer.dock", () => slots.register({
				name: "conversation.composer.dock",
				id: "cost-total",
				order: 30
			}, CostTotalBar));

			// —— 限额设置卡（可选，失败不影响展示） ——
			try {
				ctx.inject?.(["configForms"], (sctx) => {
					const configForms = sctx.configForms;
					const form = configForms.get(MONEY_ENTRY_ID);
					budgetFormRef = form;
					return sctx.effect?.(() => configForms.whileServed([MONEY_ENTRY_ID], () => slots.inject("plugins.bundle.config", () => slots.register({
						name: "plugins.bundle.config",
						key: PACKAGE_NAME,
						inject: () => ({ budgetForm: form })
					}, BudgetSettingsPage))));
				});
			} catch (error) {
				console.warn("[dsh-plugin-money-widgets] 设置卡注册异常（不影响展示）", error);
			}

			// —— 余额格子 ——
			const store = createStore();
			const read = async () => {
				try {
					const [state, balance] = await Promise.all([
						ctx.remote.account.getState(),
						ctx.remote.account.getBalance(clientMetadata()),
					]);
					if (!state.ok) return;
					const view = state.value;
					const next = { signedIn: view.status === "credential-stored", href: view.links.usageUrl, amount: undefined, breakdown: "" };
					if (balance.ok && balance.value !== null && balance.value.status === "ready") {
						const value = balance.value;
						next.amount = remaining(value);
						const parts = [];
						if (value.value.length > 0) parts.push(`${copy().balance} ${readings(totals(value.value))}`);
						const granted = value.bonusWallets.filter((wallet) => Number(wallet.balance) > 0);
						if (granted.length > 0) parts.push(`${copy().bonus} ${readings(totals(granted))}`);
						next.breakdown = parts.join(" · ");
					}
					store.publish(next);
				} catch {
					// A failed read leaves the last published reading in place; the next
					// period tries again.
				}
			};

			ctx.remoteAccess.whenAccess("account/watch", () => {
				void read();
				const timer = setInterval(() => { if (!document.hidden) void read(); }, BAL_REFRESH_MS);
				const registration = ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
					name: "conversation.composer.dock",
					id: BAL_CELL,
					order: 2,
					inject: () => ({ hooks: { balance: store } }),
				}, Pill));
				return () => {
					clearInterval(timer);
					registration();
				};
			});
			// —— 侧边栏「费用账单」面板（main keyed slot + 图标入口） ——
			slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({
					budgetForm: budgetFormRef,
					saveSettings: saveSettingsRef
				})
			}, MoneyWidgetsPage));
			slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 40,
				label: () => "费用账单"
			}, MoneyWidgetsIcon));
		}

		exports.apply = apply;
		exports.inject = ["slots", "remote", "remote.account", "remoteAccess"];
		exports.name = "money-widgets";
		exports.Pill = Pill;
		exports.TurnCostSummary = TurnCostSummary;
		exports.CostTotalBar = CostTotalBar;
		exports.LiveBudgetLine = LiveBudgetLine;
		exports.BudgetSettingsPage = BudgetSettingsPage;
		return module.exports;
	},
});
