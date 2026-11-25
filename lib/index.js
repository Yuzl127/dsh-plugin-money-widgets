import Schema from "@deepseek-ai/schemastery";
import { z } from "zod";
//#region src/index.ts
const name = "dsh-plugin-money-widgets";
/** 需要宿主侧的 sessionProjections 服务（dsh-base 内置）。 */
import { createLedger, sessionsRootOf } from "./bills.js";
const inject = ["sessionProjections"];
const DEFAULT_PRICES = {
	"deepseek-flash": {
		cacheHit: .04,
		cacheMiss: 2,
		output: 8
	},
	"deepseek-v4-pro": {
		cacheHit: .3,
		cacheMiss: 9,
		output: 27
	},
	"deepseek-v4-flash": {
		cacheHit: .04,
		cacheMiss: 2,
		output: 8
	},
	"deepseek-v4-flash-vision-exp": {
		cacheHit: .04,
		cacheMiss: 2,
		output: 8
	}
};
const budgetSchema = Schema.object({
	enabled: Schema.boolean().default(false),
	perTurn: Schema.number().min(0).default(1),
	mode: Schema.union(["warn", "ask"]).default("warn"),
	/** 整段会话预算（元）；0 表示不启用。 */
	session: Schema.number().min(0).default(0)
}).default({
	enabled: false,
	perTurn: 1,
	mode: "warn",
	session: 0
});
const remindSchema = Schema.object({
	/** 峰谷切换前提醒（客户端按北京时间判断）。 */
	peak: Schema.boolean().default(true),
	/** 距切换多少分钟开始提醒。 */
	leadMinutes: Schema.number().min(1).default(30)
}).default({
	peak: true,
	leadMinutes: 30
});
const Config = Schema.object({
	prices: Schema.dict(Schema.object({
		cacheHit: Schema.number().min(0),
		cacheMiss: Schema.number().min(0),
		output: Schema.number().min(0)
	})).default(DEFAULT_PRICES),
	peakMode: Schema.union([
		"auto",
		"peak",
		"off-peak"
	]).default("auto"),
	defaultModel: Schema.string().default("deepseek-flash"),
	budget: budgetSchema,
	remind: remindSchema
});
/**
* 是否处于高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00。
* @param date - 事件发生时刻（毫秒级 epoch 或 Date）。
*/
function isPeakHour(date = /* @__PURE__ */ new Date()) {
	const ms = typeof date === "number" ? date : date.getTime();
	const bj = new Date(ms + 288e5);
	const day = bj.getUTCDay();
	if (day === 0 || day === 6) return false;
	const h = bj.getUTCHours();
	return h >= 9 && h < 12 || h >= 14 && h < 18;
}
/**
* 按单价表计算一次请求的费用。
* @param input - 未命中输入 token。
* @param cacheRead - 命中输入 token。
* @param output - 输出 token。
* @param prices - 该模型的【高峰】单价（元/百万）。
* @param peak - 是否高峰；false 时按半价。
*/
function computeCost(input, cacheRead, output, prices, peak) {
	const rate = peak ? 1 : .5;
	return {
		input,
		cacheRead,
		output,
		cost: (input / 1e6 * prices.cacheMiss + cacheRead / 1e6 * prices.cacheHit + output / 1e6 * prices.output) * rate,
		peak
	};
}
/** 从 usage 桶取数（llm-deepseek 的 disjoint 语义：inputTokens 不含缓存读）。 */
function usageBuckets(usage) {
	return {
		input: usage.inputTokens,
		cacheRead: usage.cacheReadTokens ?? 0,
		output: usage.outputTokens
	};
}
/** 流式估算的字符→输出 token 近似系数（离线校准，中英混排约 3.2 字/token）。 */
const OUTPUT_CHARS_PER_TOKEN = 3.2;
const emptyTotals = () => ({
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	messages: 0
});
const costMessageSchema = z.object({
	input: z.number().int().nonnegative(),
	cacheRead: z.number().int().nonnegative(),
	output: z.number().int().nonnegative(),
	cost: z.number().nonnegative(),
	peak: z.boolean(),
	model: z.string(),
	provider: z.string(),
	turn: z.number().int().nonnegative(),
	step: z.number().int().nonnegative(),
	time: z.number().int().nonnegative(),
	text: z.boolean(),
	tools: z.array(z.string())
}).strict();
const costTotalsSchema = z.object({
	input: z.number().int().nonnegative(),
	cacheRead: z.number().int().nonnegative(),
	output: z.number().int().nonnegative(),
	cost: z.number().nonnegative(),
	messages: z.number().int().nonnegative()
}).strict();
const costStateSchema = z.object({
	totals: costTotalsSchema,
	messages: z.record(z.string(), costMessageSchema),
	openTurn: z.number().int().nonnegative().nullable()
}).strict();
/** wire 视图 = 宿主状态 + 当前生效的限额 + 流式估算口径。 */
const costViewSchema = z.object({
	totals: costTotalsSchema,
	messages: z.record(z.string(), costMessageSchema),
	openTurn: z.number().int().nonnegative().nullable(),
	budget: z.object({
		enabled: z.boolean(),
		perTurn: z.number().nonnegative(),
		mode: z.enum(["warn", "ask"]),
		session: z.number().nonnegative()
	}).strict(),
	remind: z.object({
		peak: z.boolean(),
		leadMinutes: z.number().positive()
	}).strict(),
	estimation: z.object({
		charsPerToken: z.number().positive(),
		outputPrices: z.record(z.string(), z.number().nonnegative()),
		defaultModel: z.string().min(1),
		peakMode: z.enum([
			"auto",
			"peak",
			"off-peak"
		])
	}).strict()
}).strict();
/** 会话摘要用的小投影：只留聚合值，进 Session 列表行。 */
const costSummaryBucketSchema = z.object({
	input: z.number().int().nonnegative(),
	cacheRead: z.number().int().nonnegative(),
	output: z.number().int().nonnegative(),
	cost: z.number().nonnegative(),
	messages: z.number().int().nonnegative()
}).strict();
const costSummaryStateSchema = z.object({
	totals: costSummaryBucketSchema,
	models: z.record(z.string(), costSummaryBucketSchema),
	providers: z.record(z.string(), costSummaryBucketSchema)
}).strict();
/**
* 组装投影单元：apply 为纯 fold，闭包只引用启动期确定的 config。
* `readBudget` 在每次产出 wire 视图时读取【当前生效】的限额
* （Web 插件页保存后无需重启即反映到浏览器）。导出以便测试。
*/
function makeProjection(config, readBudget = () => ({
	enabled: false,
	perTurn: 1,
	mode: "warn",
	session: 0
})) {
	const fallbackModel = config.defaultModel;
	const prices = {
		...DEFAULT_PRICES,
		...config.prices
	};
	const isPeak = (time) => {
		if (config.peakMode === "peak") return true;
		if (config.peakMode === "off-peak") return false;
		return isPeakHour(time);
	};
	const estimation = {
		charsPerToken: OUTPUT_CHARS_PER_TOKEN,
		outputPrices: Object.fromEntries(Object.entries(prices).map(([model, price]) => [model, price.output])),
		defaultModel: fallbackModel,
		peakMode: config.peakMode
	};
	const warnOnce = /* @__PURE__ */ new Set();
	return {
		key: "cost",
		stateVersion: 7,
		stateSchema: costStateSchema,
		init: () => ({
			totals: emptyTotals(),
			messages: {},
			openTurn: null
		}),
		apply: (state, event) => {
			if (event.type === "turn/start") {
				if (state.openTurn === event.data.turn) return state;
				return {
					...state,
					openTurn: event.data.turn
				};
			}
			if (event.type === "turn/end") {
				if (state.openTurn !== event.data.turn) return state;
				return {
					...state,
					openTurn: null
				};
			}
			if (event.type !== "assistant/message" || event.data.usage === void 0) return state;
			const messageId = String(event.data.message.id ?? event.seq);
			if (state.messages[messageId] !== void 0) return state;
			const { input, cacheRead, output } = usageBuckets(event.data.usage);
			const model = event.data.message.source?.model ?? fallbackModel;
			const provider = event.data.message.source?.provider ?? "unknown";
			const price = prices[model];
			if (price === void 0 && !warnOnce.has(model)) {
				warnOnce.add(model);
				console.warn(`[dsh-plugin-money-widgets] 模型 "${model}" 未配置价格，本次费用按 0 记录；请在 config.prices 中补充该模型。`);
			}
			const totals = { ...state.totals };
			totals.input += input;
			totals.cacheRead += cacheRead;
			totals.output += output;
			totals.messages += 1;
			const peak = isPeak(event.time);
			const cost = price === void 0 ? 0 : computeCost(input, cacheRead, output, price, peak).cost;
			totals.cost += cost;
			const content = event.data.message.content;
			const tools = [];
			let text = false;
			for (const part of content ?? []) if (part?.type === "tool-call" && typeof part.name === "string") tools.push(part.name);
			else if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") text = true;
			return {
				...state,
				totals,
				messages: {
					...state.messages,
					[messageId]: {
						input,
						cacheRead,
						output,
						cost,
						peak,
						model,
						provider,
						turn: event.data.turn,
						step: event.data.step,
						time: event.time,
						text,
						tools
					}
				}
			};
		},
		wire: {
			viewSchema: costViewSchema,
			/** 明细太大，不进 Session 列表行摘要；会话级聚合见 costSummary。 */
			summary: false,
			view: (state) => ({
				...state,
				budget: readBudget(),
				remind: {
					peak: config.remind.peak,
					leadMinutes: config.remind.leadMinutes
				},
				estimation
			})
		}
	};
}
/** 聚合一个桶（原地加，调用方传副本）。 */
function bumpBucket(bucket, m) {
	bucket.input += m.input;
	bucket.cacheRead += m.cacheRead;
	bucket.output += m.output;
	bucket.cost += m.cost;
	bucket.messages += 1;
	return bucket;
}
const zeroBucket = () => ({
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	messages: 0
});
/**
* 会话级聚合投影（进 Session 列表行）：按模型 / 按供应商的账单。
* 只 fold assistant/message，不含明细，行数据很小。
*/
function makeSummaryProjection(config) {
	const fallbackModel = config.defaultModel;
	const prices = {
		...DEFAULT_PRICES,
		...config.prices
	};
	const isPeak = (time) => {
		if (config.peakMode === "peak") return true;
		if (config.peakMode === "off-peak") return false;
		return isPeakHour(time);
	};
	return {
		key: "costSummary",
		stateVersion: 1,
		stateSchema: costSummaryStateSchema,
		init: () => ({
			totals: zeroBucket(),
			models: {},
			providers: {}
		}),
		apply: (state, event) => {
			if (event.type !== "assistant/message" || event.data.usage === void 0) return state;
			const usage = usageBuckets(event.data.usage);
			const model = event.data.message.source?.model ?? fallbackModel;
			const provider = event.data.message.source?.provider ?? "unknown";
			const price = prices[model];
			const cost = price === void 0 ? 0 : computeCost(usage.input, usage.cacheRead, usage.output, price, isPeak(event.time)).cost;
			const row = {
				...usage,
				cost
			};
			const models = { ...state.models };
			const providers = { ...state.providers };
			models[model] = bumpBucket({
				...(models[model] ?? zeroBucket())
			}, row);
			providers[provider] = bumpBucket({
				...(providers[provider] ?? zeroBucket())
			}, row);
			return {
				totals: bumpBucket({
					...state.totals
				}, row),
				models,
				providers
			};
		},
		wire: {
			viewSchema: costSummaryStateSchema,
			view: (state) => state
		}
	};
}
/** 插件主体：注册投影（限额字段是 volatile，由 Loader 原地更新）。 */
function apply(ctx, config) {
	console.log("[dsh-plugin-money-widgets] 插件已加载，余额 + 费用追踪开始");
	const readBudget = () => {
		// budget 是 volatile 字段:config.budget 直接就是对象,没有 .get() 方法
		const budget = config.budget ?? { enabled: false, perTurn: 1, mode: "warn", session: 0 };
		return {
			enabled: budget.enabled,
			perTurn: budget.perTurn,
			mode: budget.mode,
			session: budget.session
		};
	};
	ctx.sessionProjections.register(makeProjection(config, readBudget));
	ctx.sessionProjections.register(makeSummaryProjection(config));
	registerBillRoute(ctx, config);
}

/**
 * Serve the host-side bill ledger on `GET /plugins/money-widgets/bills`.
 *
 * The sidebar panel cannot see history through projection hints (only loaded
 * sessions carry them), so it reads transcript logs through this route instead.
 */
function registerBillRoute(ctx, config) {
	let prices = DEFAULT_PRICES;
	try {
		const configured = config.prices.get();
		if (configured && typeof configured === "object") prices = {
			...DEFAULT_PRICES,
			...configured
		};
	} catch {
		// Fall back to the built-in table when the config section is unavailable.
	}
	const ledger = createLedger({
		prices,
		sessionsRoot: sessionsRootOf()
	});
	ctx.inject(["webServer"], (hostCtx) => {
		const dispose = hostCtx.webServer.register({
			kind: "exact",
			path: "/plugins/money-widgets/bills",
			handler: (request, response) => {
				if (request.method !== "GET") {
					response.writeHead(405, { allow: "GET" });
					response.end();
					return;
				}
				const origin = request.headers.origin;
				const host = request.headers.host;
				if (typeof origin === "string" && origin.length > 0 && typeof host === "string") {
					let originHost = null;
					try {
						originHost = new URL(origin).host;
					} catch {
						originHost = null;
					}
					if (originHost !== null && originHost !== host) {
						response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
						response.end(JSON.stringify({ error: "untrusted origin" }));
						return;
					}
				}
				try {
					const data = ledger(new URL(request.url ?? "/", "http://localhost").searchParams.has("refresh"));
					response.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					response.end(JSON.stringify(data));
				} catch (error) {
					response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					response.end(JSON.stringify({
						error: String(error)
					}));
				}
			}
		});
		hostCtx.effect(() => dispose, "money-widgets: bill ledger route");
	});
}
//#endregion
export { Config, DEFAULT_PRICES, OUTPUT_CHARS_PER_TOKEN, apply, computeCost, inject, isPeakHour, makeProjection, makeSummaryProjection, name };
