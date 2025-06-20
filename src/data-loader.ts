import type { CostMode, SortOrder } from './types.internal.ts';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { unreachable } from '@core/errorutil';
import { groupBy } from 'es-toolkit'; // TODO: after node20 is deprecated, switch to native Object.groupBy
import { sort } from 'fast-sort';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { logger } from './logger.ts';
import {
	PricingFetcher,
} from './pricing-fetcher.ts';
import { get5HourWindowId } from './utils.internal.ts';

const DEFAULT_CLAUDE_CODE_PATH = path.join(homedir(), '.claude');

/**
 * Default path for Claude data directory
 * Uses environment variable CLAUDE_CONFIG_DIR if set, otherwise defaults to ~/.claude
 */
export function getDefaultClaudePath(): string {
	const envClaudeCodePath = process.env.CLAUDE_CONFIG_DIR?.trim() ?? DEFAULT_CLAUDE_CODE_PATH;
	if (!isDirectorySync(envClaudeCodePath)) {
		throw new Error(
			` Claude data directory does not exist: ${envClaudeCodePath}. 
Please set CLAUDE_CONFIG_DIR to a valid path, or ensure ${DEFAULT_CLAUDE_CODE_PATH} exists.
			`.trim(),
		);
	}
	return envClaudeCodePath;
}

export const UsageDataSchema = v.object({
	timestamp: v.string(),
	version: v.optional(v.string()), // Claude Code version
	message: v.object({
		usage: v.object({
			input_tokens: v.number(),
			output_tokens: v.number(),
			cache_creation_input_tokens: v.optional(v.number()),
			cache_read_input_tokens: v.optional(v.number()),
		}),
		model: v.optional(v.string()), // Model is inside message object
		id: v.optional(v.string()), // Message ID for deduplication
	}),
	costUSD: v.optional(v.number()), // Made optional for new schema
	requestId: v.optional(v.string()), // Request ID for deduplication
});

export type UsageData = v.InferOutput<typeof UsageDataSchema>;

export const ModelBreakdownSchema = v.object({
	modelName: v.string(),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	cost: v.number(),
});

export type ModelBreakdown = v.InferOutput<typeof ModelBreakdownSchema>;

export const DailyUsageSchema = v.object({
	date: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD format
	),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	modelsUsed: v.array(v.string()),
	modelBreakdowns: v.array(ModelBreakdownSchema),
});

export type DailyUsage = v.InferOutput<typeof DailyUsageSchema>;

export const SessionUsageSchema = v.object({
	sessionId: v.string(),
	projectPath: v.string(),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	lastActivity: v.string(),
	versions: v.array(v.string()), // List of unique versions used in this session
	modelsUsed: v.array(v.string()),
	modelBreakdowns: v.array(ModelBreakdownSchema),
});

export type SessionUsage = v.InferOutput<typeof SessionUsageSchema>;

export const MonthlyUsageSchema = v.object({
	month: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}$/), // YYYY-MM format
	),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	modelsUsed: v.array(v.string()),
	modelBreakdowns: v.array(ModelBreakdownSchema),
});

export type MonthlyUsage = v.InferOutput<typeof MonthlyUsageSchema>;

export const WindowUsageSchema = v.object({
	windowId: v.string(), // YYYY-MM-DD-HH format
	month: v.string(), // YYYY-MM format
	startTimestamp: v.string(), // First message in window
	endTimestamp: v.string(), // Last message in window
	messageCount: v.number(),
	sessionCount: v.number(), // Unique conversation sessions
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	duration: v.number(), // Duration in milliseconds
	modelsUsed: v.array(v.string()),
});

export type WindowUsage = v.InferOutput<typeof WindowUsageSchema>;

export const MonthlyWindowSummarySchema = v.object({
	month: v.string(),
	windowCount: v.number(),
	sessionLimit: v.optional(v.number()),
	remainingSessions: v.optional(v.number()),
	utilizationPercent: v.optional(v.number()),
	totalCost: v.number(),
	totalTokens: v.number(),
	windows: v.array(WindowUsageSchema),
});

export type MonthlyWindowSummary = v.InferOutput<typeof MonthlyWindowSummarySchema>;

type TokenStats = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

/**
 * Aggregates token counts and costs by model name
 */
function aggregateByModel<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): Map<string, TokenStats> {
	const modelAggregates = new Map<string, TokenStats>();
	const defaultStats: TokenStats = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		cost: 0,
	};

	for (const entry of entries) {
		const modelName = getModel(entry) ?? 'unknown';
		// Skip synthetic model
		if (modelName === '<synthetic>') {
			continue;
		}

		const usage = getUsage(entry);
		const cost = getCost(entry);

		const existing = modelAggregates.get(modelName) ?? defaultStats;

		modelAggregates.set(modelName, {
			inputTokens: existing.inputTokens + (usage.input_tokens ?? 0),
			outputTokens: existing.outputTokens + (usage.output_tokens ?? 0),
			cacheCreationTokens: existing.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
			cacheReadTokens: existing.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
			cost: existing.cost + cost,
		});
	}

	return modelAggregates;
}

/**
 * Aggregates model breakdowns from multiple sources
 */
function aggregateModelBreakdowns(
	breakdowns: ModelBreakdown[],
): Map<string, TokenStats> {
	const modelAggregates = new Map<string, TokenStats>();
	const defaultStats: TokenStats = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		cost: 0,
	};

	for (const breakdown of breakdowns) {
		// Skip synthetic model
		if (breakdown.modelName === '<synthetic>') {
			continue;
		}

		const existing = modelAggregates.get(breakdown.modelName) ?? defaultStats;

		modelAggregates.set(breakdown.modelName, {
			inputTokens: existing.inputTokens + breakdown.inputTokens,
			outputTokens: existing.outputTokens + breakdown.outputTokens,
			cacheCreationTokens: existing.cacheCreationTokens + breakdown.cacheCreationTokens,
			cacheReadTokens: existing.cacheReadTokens + breakdown.cacheReadTokens,
			cost: existing.cost + breakdown.cost,
		});
	}

	return modelAggregates;
}

/**
 * Converts model aggregates to sorted model breakdowns
 */
function createModelBreakdowns(
	modelAggregates: Map<string, TokenStats>,
): ModelBreakdown[] {
	return Array.from(modelAggregates.entries())
		.map(([modelName, stats]) => ({
			modelName,
			...stats,
		}))
		.sort((a, b) => b.cost - a.cost); // Sort by cost descending
}

/**
 * Calculates total token counts and costs from entries
 */
function calculateTotals<T>(
	entries: T[],
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): TokenStats & { totalCost: number } {
	return entries.reduce(
		(acc, entry) => {
			const usage = getUsage(entry);
			const cost = getCost(entry);

			return {
				inputTokens: acc.inputTokens + (usage.input_tokens ?? 0),
				outputTokens: acc.outputTokens + (usage.output_tokens ?? 0),
				cacheCreationTokens: acc.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
				cacheReadTokens: acc.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
				cost: acc.cost + cost,
				totalCost: acc.totalCost + cost,
			};
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			cost: 0,
			totalCost: 0,
		},
	);
}

/**
 * Filters items by date range
 */
function filterByDateRange<T>(
	items: T[],
	getDate: (item: T) => string,
	since?: string,
	until?: string,
): T[] {
	if (since == null && until == null) {
		return items;
	}

	return items.filter((item) => {
		const dateStr = getDate(item).substring(0, 10).replace(/-/g, ''); // Convert to YYYYMMDD
		if (since != null && dateStr < since) {
			return false;
		}
		if (until != null && dateStr > until) {
			return false;
		}
		return true;
	});
}

/**
 * Checks if an entry is a duplicate based on hash
 */
function isDuplicateEntry(
	uniqueHash: string | null,
	processedHashes: Set<string>,
): boolean {
	if (uniqueHash == null) {
		return false;
	}
	return processedHashes.has(uniqueHash);
}

/**
 * Marks an entry as processed
 */
function markAsProcessed(
	uniqueHash: string | null,
	processedHashes: Set<string>,
): void {
	if (uniqueHash != null) {
		processedHashes.add(uniqueHash);
	}
}

/**
 * Extracts unique models from entries, excluding synthetic model
 */
function extractUniqueModels<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
): string[] {
	return [...new Set(entries.map(getModel).filter((m): m is string => m != null && m !== '<synthetic>'))];
}

export function formatDate(dateStr: string): string {
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function formatDateCompact(dateStr: string): string {
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}\n${month}-${day}`;
}

/**
 * Generic function to sort items by date based on sort order
 * @param items - Array of items to sort
 * @param getDate - Function to extract date/timestamp from item
 * @param order - Sort order (asc or desc)
 * @returns Sorted array
 */
function sortByDate<T>(
	items: T[],
	getDate: (item: T) => string | Date,
	order: SortOrder = 'desc',
): T[] {
	const sorted = sort(items);
	switch (order) {
		case 'desc':
			return sorted.desc(item => new Date(getDate(item)).getTime());
		case 'asc':
			return sorted.asc(item => new Date(getDate(item)).getTime());
		default:
			unreachable(order);
	}
}

/**
 * Create a unique identifier for deduplication using message ID and request ID
 */
export function createUniqueHash(data: UsageData): string | null {
	const messageId = data.message.id;
	const requestId = data.requestId;

	if (messageId == null || requestId == null) {
		return null;
	}

	// Create a hash using simple concatenation
	return `${messageId}:${requestId}`;
}

/**
 * Extract the earliest timestamp from a JSONL file
 * Scans through the file until it finds a valid timestamp
 */
export async function getEarliestTimestamp(filePath: string): Promise<Date | null> {
	try {
		const content = await readFile(filePath, 'utf-8');
		const lines = content.trim().split('\n');

		let earliestDate: Date | null = null;

		for (const line of lines) {
			if (line.trim() === '') {
				continue;
			}

			try {
				const json = JSON.parse(line) as Record<string, unknown>;
				if (json.timestamp != null && typeof json.timestamp === 'string') {
					const date = new Date(json.timestamp);
					if (!Number.isNaN(date.getTime())) {
						if (earliestDate == null || date < earliestDate) {
							earliestDate = date;
						}
					}
				}
			}
			catch {
				// Skip invalid JSON lines
				continue;
			}
		}

		return earliestDate;
	}
	catch (error) {
		// Log file access errors for diagnostics, but continue processing
		// This ensures files without timestamps or with access issues are sorted to the end
		logger.debug(`Failed to get earliest timestamp for ${filePath}:`, error);
		return null;
	}
}

/**
 * Sort files by their earliest timestamp
 * Files without valid timestamps are placed at the end
 */
export async function sortFilesByTimestamp(files: string[]): Promise<string[]> {
	const filesWithTimestamps = await Promise.all(
		files.map(async file => ({
			file,
			timestamp: await getEarliestTimestamp(file),
		})),
	);

	return filesWithTimestamps
		.sort((a, b) => {
			// Files without timestamps go to the end
			if (a.timestamp == null && b.timestamp == null) {
				return 0;
			}
			if (a.timestamp == null) {
				return 1;
			}
			if (b.timestamp == null) {
				return -1;
			}
			// Sort by timestamp (oldest first)
			return a.timestamp.getTime() - b.timestamp.getTime();
		})
		.map(item => item.file);
}

export async function calculateCostForEntry(
	data: UsageData,
	mode: CostMode,
	fetcher: PricingFetcher,
): Promise<number> {
	if (mode === 'display') {
		// Always use costUSD, even if undefined
		return data.costUSD ?? 0;
	}

	if (mode === 'calculate') {
		// Always calculate from tokens
		if (data.message.model != null) {
			return fetcher.calculateCostFromTokens(data.message.usage, data.message.model);
		}
		return 0;
	}

	if (mode === 'auto') {
		// Auto mode: use costUSD if available, otherwise calculate
		if (data.costUSD != null) {
			return data.costUSD;
		}

		if (data.message.model != null) {
			return fetcher.calculateCostFromTokens(data.message.usage, data.message.model);
		}

		return 0;
	}

	unreachable(mode);
}

export type DateFilter = {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
};

export type LoadOptions = {
	claudePath?: string; // Custom path to Claude data directory
	mode?: CostMode; // Cost calculation mode
	order?: SortOrder; // Sort order for dates
	offline?: boolean; // Use offline mode for pricing
} & DateFilter;

export async function loadDailyUsageData(
	options?: LoadOptions,
): Promise<DailyUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, 'projects');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	// Sort files by timestamp to ensure chronological processing
	const sortedFiles = await sortFilesByTimestamp(files);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

	// Track processed message+request combinations for deduplication
	const processedHashes = new Set<string>();

	// Collect all valid data entries first
	const allEntries: { data: UsageData; date: string; cost: number; model: string | undefined }[] = [];

	for (const file of sortedFiles) {
		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				// Check for duplicate message + request ID combination
				const uniqueHash = createUniqueHash(data);
				if (isDuplicateEntry(uniqueHash, processedHashes)) {
					// Skip duplicate message
					continue;
				}

				// Mark this combination as processed
				markAsProcessed(uniqueHash, processedHashes);

				const date = formatDate(data.timestamp);
				// If fetcher is available, calculate cost based on mode and tokens
				// If fetcher is null, use pre-calculated costUSD or default to 0
				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({ data, date, cost, model: data.message.model });
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Group by date using Object.groupBy
	const groupedByDate = groupBy(allEntries, entry => entry.date);

	// Aggregate each group
	const results = Object.entries(groupedByDate)
		.map(([date, entries]) => {
			if (entries == null) {
				return undefined;
			}

			// Aggregate by model first
			const modelAggregates = aggregateByModel(
				entries,
				entry => entry.model,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			// Create model breakdowns
			const modelBreakdowns = createModelBreakdowns(modelAggregates);

			// Calculate totals
			const totals = calculateTotals(
				entries,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			const modelsUsed = extractUniqueModels(entries, e => e.model);

			return {
				date,
				...totals,
				modelsUsed,
				modelBreakdowns,
			};
		})
		.filter(item => item != null);

	// Filter by date range if specified
	const filtered = filterByDateRange(results, item => item.date, options?.since, options?.until);

	// Sort by date based on order option (default to descending)
	return sortByDate(filtered, item => item.date, options?.order);
}

export async function loadSessionData(
	options?: LoadOptions,
): Promise<SessionUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, 'projects');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	// Sort files by timestamp to ensure chronological processing
	const sortedFiles = await sortFilesByTimestamp(files);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);

	// Track processed message+request combinations for deduplication
	const processedHashes = new Set<string>();

	// Collect all valid data entries with session info first
	const allEntries: Array<{
		data: UsageData;
		sessionKey: string;
		sessionId: string;
		projectPath: string;
		cost: number;
		timestamp: string;
		model: string | undefined;
	}> = [];

	for (const file of sortedFiles) {
		// Extract session info from file path
		const relativePath = path.relative(claudeDir, file);
		const parts = relativePath.split(path.sep);

		// Session ID is the directory name containing the JSONL file
		const sessionId = parts[parts.length - 2] ?? 'unknown';
		// Project path is everything before the session ID
		const joinedPath = parts.slice(0, -2).join(path.sep);
		const projectPath = joinedPath.length > 0 ? joinedPath : 'Unknown Project';

		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				// Check for duplicate message + request ID combination
				const uniqueHash = createUniqueHash(data);
				if (isDuplicateEntry(uniqueHash, processedHashes)) {
					// Skip duplicate message
					continue;
				}

				// Mark this combination as processed
				markAsProcessed(uniqueHash, processedHashes);

				const sessionKey = `${projectPath}/${sessionId}`;
				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({
					data,
					sessionKey,
					sessionId,
					projectPath,
					cost,
					timestamp: data.timestamp,
					model: data.message.model,
				});
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Group by session using Object.groupBy
	const groupedBySessions = groupBy(
		allEntries,
		entry => entry.sessionKey,
	);

	// Aggregate each session group
	const results = Object.entries(groupedBySessions)
		.map(([_, entries]) => {
			if (entries == null) {
				return undefined;
			}

			// Find the latest timestamp for lastActivity
			const latestEntry = entries.reduce((latest, current) =>
				current.timestamp > latest.timestamp ? current : latest,
			);

			// Collect all unique versions
			const versionSet = new Set<string>();
			for (const entry of entries) {
				if (entry.data.version != null) {
					versionSet.add(entry.data.version);
				}
			}

			// Aggregate by model
			const modelAggregates = aggregateByModel(
				entries,
				entry => entry.model,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			// Create model breakdowns
			const modelBreakdowns = createModelBreakdowns(modelAggregates);

			// Calculate totals
			const totals = calculateTotals(
				entries,
				entry => entry.data.message.usage,
				entry => entry.cost,
			);

			const modelsUsed = extractUniqueModels(entries, e => e.model);

			return {
				sessionId: latestEntry.sessionId,
				projectPath: latestEntry.projectPath,
				...totals,
				lastActivity: formatDate(latestEntry.timestamp),
				versions: Array.from(versionSet).sort(),
				modelsUsed,
				modelBreakdowns,
			};
		})
		.filter(item => item != null);

	// Filter by date range if specified
	const filtered = filterByDateRange(results, item => item.lastActivity, options?.since, options?.until);

	return sortByDate(filtered, item => item.lastActivity, options?.order);
}

export async function loadMonthlyUsageData(
	options?: LoadOptions,
): Promise<MonthlyUsage[]> {
	const dailyData = await loadDailyUsageData(options);

	// Group daily data by month using Object.groupBy
	const groupedByMonth = groupBy(dailyData, data =>
		data.date.substring(0, 7));

	// Aggregate each month group
	const monthlyArray: MonthlyUsage[] = [];
	for (const [month, dailyEntries] of Object.entries(groupedByMonth)) {
		if (dailyEntries == null) {
			continue;
		}

		// Aggregate model breakdowns across all days
		const allBreakdowns = dailyEntries.flatMap(daily => daily.modelBreakdowns);
		const modelAggregates = aggregateModelBreakdowns(allBreakdowns);

		// Create model breakdowns
		const modelBreakdowns = createModelBreakdowns(modelAggregates);

		// Collect unique models
		const modelsSet = new Set<string>();
		for (const data of dailyEntries) {
			for (const model of data.modelsUsed) {
				// Skip synthetic model
				if (model !== '<synthetic>') {
					modelsSet.add(model);
				}
			}
		}

		// Calculate totals from daily entries
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheCreationTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCost = 0;

		for (const daily of dailyEntries) {
			totalInputTokens += daily.inputTokens;
			totalOutputTokens += daily.outputTokens;
			totalCacheCreationTokens += daily.cacheCreationTokens;
			totalCacheReadTokens += daily.cacheReadTokens;
			totalCost += daily.totalCost;
		}
		const monthlyUsage: MonthlyUsage = {
			month,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			cacheReadTokens: totalCacheReadTokens,
			totalCost,
			modelsUsed: Array.from(modelsSet),
			modelBreakdowns,
		};

		monthlyArray.push(monthlyUsage);
	}

	// Sort by month based on sortOrder
	return sortByDate(monthlyArray, item => `${item.month}-01`, options?.order);
}

/**
 * Calculate 5-hour window statistics from all entries
 */
export function calculateWindowStatistics(
	allEntries: Array<{
		data: UsageData;
		timestamp: string;
		cost: number;
		sessionKey: string;
		model: string | undefined;
	}>,
): Map<string, WindowUsage> {
	const windowMap = new Map<string, WindowUsage>();

	for (const entry of allEntries) {
		const windowId = get5HourWindowId(entry.timestamp);
		const month = entry.timestamp.substring(0, 7);

		let window = windowMap.get(windowId);
		if (window == null) {
			window = {
				windowId,
				month,
				startTimestamp: entry.timestamp,
				endTimestamp: entry.timestamp,
				messageCount: 0,
				sessionCount: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				duration: 0,
				modelsUsed: [],
			};
			windowMap.set(windowId, window);
		}

		// Update window statistics
		window.messageCount++;
		window.inputTokens += entry.data.message.usage.input_tokens ?? 0;
		window.outputTokens += entry.data.message.usage.output_tokens ?? 0;
		window.cacheCreationTokens += entry.data.message.usage.cache_creation_input_tokens ?? 0;
		window.cacheReadTokens += entry.data.message.usage.cache_read_input_tokens ?? 0;
		window.totalCost += entry.cost;

		// Update timestamps
		if (entry.timestamp < window.startTimestamp) {
			window.startTimestamp = entry.timestamp;
		}
		if (entry.timestamp > window.endTimestamp) {
			window.endTimestamp = entry.timestamp;
		}

		// Track models
		if (entry.model != null && !window.modelsUsed.includes(entry.model)) {
			window.modelsUsed.push(entry.model);
		}
	}

	// Calculate durations and session counts
	for (const [windowId, window] of windowMap) {
		const start = new Date(window.startTimestamp);
		const end = new Date(window.endTimestamp);
		window.duration = end.getTime() - start.getTime();

		// Count unique sessions in this window
		const sessionsInWindow = new Set(
			allEntries
				.filter(e => get5HourWindowId(e.timestamp) === windowId)
				.map(e => e.sessionKey),
		);
		window.sessionCount = sessionsInWindow.size;
	}

	return windowMap;
}

/**
 * Group windows by month and calculate summaries
 */
export function groupWindowsByMonth(
	windows: Map<string, WindowUsage>,
	options?: { sessionLimit?: number },
): MonthlyWindowSummary[] {
	const monthlyMap = new Map<string, MonthlyWindowSummary>();

	for (const window of windows.values()) {
		let monthly = monthlyMap.get(window.month);
		if (monthly == null) {
			monthly = {
				month: window.month,
				windowCount: 0,
				totalCost: 0,
				totalTokens: 0,
				windows: [],
			};
			monthlyMap.set(window.month, monthly);
		}

		monthly.windowCount++;
		monthly.totalCost += window.totalCost;
		monthly.totalTokens += window.inputTokens + window.outputTokens
			+ window.cacheCreationTokens + window.cacheReadTokens;
		monthly.windows.push(window);
	}

	// Apply session limits if provided
	if (options?.sessionLimit != null) {
		for (const monthly of monthlyMap.values()) {
			monthly.sessionLimit = options.sessionLimit;
			monthly.remainingSessions = Math.max(0, options.sessionLimit - monthly.windowCount);
			monthly.utilizationPercent = (monthly.windowCount / options.sessionLimit) * 100;
		}
	}

	// Sort windows within each month by windowId (chronological)
	for (const monthly of monthlyMap.values()) {
		monthly.windows.sort((a, b) => b.windowId.localeCompare(a.windowId));
	}

	return Array.from(monthlyMap.values())
		.sort((a, b) => b.month.localeCompare(a.month));
}
