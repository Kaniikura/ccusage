import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createFixture } from 'fs-fixture';
import {
	calculateCostForEntry,
	calculateWindowStatistics,
	formatDate,
	formatDateCompact,
	getDefaultClaudePath,
	groupWindowsByMonth,
	loadDailyUsageData,
	loadMonthlyUsageData,
	loadSessionData,
	type UsageData,
	type WindowUsage,
} from './data-loader.ts';
import { PricingFetcher } from './pricing-fetcher.ts';

describe('formatDate', () => {
	test('formats UTC timestamp to local date', () => {
		// Test with UTC timestamps - results depend on local timezone
		expect(formatDate('2024-01-01T00:00:00Z')).toBe('2024-01-01');
		expect(formatDate('2024-12-31T23:59:59Z')).toBe('2024-12-31');
	});

	test('handles various date formats', () => {
		expect(formatDate('2024-01-01')).toBe('2024-01-01');
		expect(formatDate('2024-01-01T12:00:00')).toBe('2024-01-01');
		expect(formatDate('2024-01-01T12:00:00.000Z')).toBe('2024-01-01');
	});

	test('pads single digit months and days', () => {
		expect(formatDate('2024-01-05T00:00:00Z')).toBe('2024-01-05');
		expect(formatDate('2024-10-01T00:00:00Z')).toBe('2024-10-01');
	});
});

describe('formatDateCompact', () => {
	test('formats UTC timestamp to local date with line break', () => {
		expect(formatDateCompact('2024-01-01T00:00:00Z')).toBe('2024\n01-01');
	});

	test('handles various date formats', () => {
		expect(formatDateCompact('2024-12-31T23:59:59Z')).toBe('2024\n12-31');
		expect(formatDateCompact('2024-01-01')).toBe('2024\n01-01');
		expect(formatDateCompact('2024-01-01T12:00:00')).toBe('2024\n01-01');
		expect(formatDateCompact('2024-01-01T12:00:00.000Z')).toBe('2024\n01-01');
	});

	test('pads single digit months and days', () => {
		expect(formatDateCompact('2024-01-05T00:00:00Z')).toBe('2024\n01-05');
		expect(formatDateCompact('2024-10-01T00:00:00Z')).toBe('2024\n10-01');
	});
});

describe('getDefaultClaudePath', () => {
	const originalEnv = process.env.CLAUDE_CONFIG_DIR;

	beforeEach(() => {
		// Clean up env var before each test
		delete process.env.CLAUDE_CONFIG_DIR;
	});

	afterEach(() => {
		// Restore original environment
		if (originalEnv != null) {
			process.env.CLAUDE_CONFIG_DIR = originalEnv;
		}
		else {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});

	test('returns CLAUDE_CONFIG_DIR when environment variable is set', async () => {
		await using fixture = await createFixture({
			claude: {},
		});
		process.env.CLAUDE_CONFIG_DIR = fixture.path;

		expect(getDefaultClaudePath()).toBe(fixture.path);
	});

	test('returns default path when CLAUDE_CONFIG_DIR is not set', () => {
		// Ensure CLAUDE_CONFIG_DIR is not set
		delete process.env.CLAUDE_CONFIG_DIR;

		// Test that it returns the default path (which ends with .claude)
		const actualPath = getDefaultClaudePath();
		expect(actualPath).toMatch(/\.claude$/);
		expect(actualPath).toContain(homedir());
	});

	test('returns default path with trimmed CLAUDE_CONFIG_DIR', async () => {
		await using fixture = await createFixture({
			claude: {},
		});
		// Test with extra spaces
		process.env.CLAUDE_CONFIG_DIR = `  ${fixture.path}  `;

		expect(getDefaultClaudePath()).toBe(fixture.path);
	});

	test('throws an error when CLAUDE_CONFIG_DIR is not a directory', async () => {
		await using fixture = await createFixture();
		process.env.CLAUDE_CONFIG_DIR = join(fixture.path, 'not-a-directory');

		expect(() => getDefaultClaudePath()).toThrow(/Claude data directory does not exist/);
	});

	test('throws an error when CLAUDE_CONFIG_DIR does not exist', async () => {
		process.env.CLAUDE_CONFIG_DIR = '/nonexistent/path/that/does/not/exist';

		expect(() => getDefaultClaudePath()).toThrow(/Claude data directory does not exist/);
	});

	test('throws an error when default path does not exist', () => {
		// Set to a non-existent path
		process.env.CLAUDE_CONFIG_DIR = '/nonexistent/path/.claude';

		expect(() => getDefaultClaudePath()).toThrow(/Claude data directory does not exist/);
	});
});

describe('loadDailyUsageData', () => {
	test('returns empty array when no files found', async () => {
		await using fixture = await createFixture({
			projects: {},
		});

		const result = await loadDailyUsageData({ claudePath: fixture.path });
		expect(result).toEqual([]);
	});

	test('aggregates daily usage data correctly', async () => {
		const mockData1: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-01T12:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
		];

		const mockData2: UsageData = {
			timestamp: '2024-01-01T18:00:00Z',
			message: { usage: { input_tokens: 300, output_tokens: 150 } },
			costUSD: 0.03,
		};

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file1.jsonl': mockData1.map(d => JSON.stringify(d)).join('\n'),
					},
					session2: {
						'file2.jsonl': JSON.stringify(mockData2),
					},
				},
			},
		});

		const result = await loadDailyUsageData({ claudePath: fixture.path });

		expect(result).toHaveLength(1);
		expect(result[0]?.date).toBe('2024-01-01');
		expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
		expect(result[0]?.outputTokens).toBe(300); // 50 + 100 + 150
		expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
	});

	test('handles cache tokens', async () => {
		const mockData: UsageData = {
			timestamp: '2024-01-01T00:00:00Z',
			message: {
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 25,
					cache_read_input_tokens: 10,
				},
			},
			costUSD: 0.01,
		};

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': JSON.stringify(mockData),
					},
				},
			},
		});

		const result = await loadDailyUsageData({ claudePath: fixture.path });

		expect(result[0]?.cacheCreationTokens).toBe(25);
		expect(result[0]?.cacheReadTokens).toBe(10);
	});

	test('filters by date range', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-15T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: '2024-01-31T00:00:00Z',
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadDailyUsageData({
			claudePath: fixture.path,
			since: '20240110',
			until: '20240125',
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.date).toBe('2024-01-15');
		expect(result[0]?.inputTokens).toBe(200);
	});

	test('sorts by date descending by default', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-15T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-31T00:00:00Z',
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadDailyUsageData({ claudePath: fixture.path });

		expect(result[0]?.date).toBe('2024-01-31');
		expect(result[1]?.date).toBe('2024-01-15');
		expect(result[2]?.date).toBe('2024-01-01');
	});

	test('sorts by date ascending when order is \'asc\'', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-15T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-31T00:00:00Z',
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'usage.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadDailyUsageData({
			claudePath: fixture.path,
			order: 'asc',
		});

		expect(result).toHaveLength(3);
		expect(result[0]?.date).toBe('2024-01-01');
		expect(result[1]?.date).toBe('2024-01-15');
		expect(result[2]?.date).toBe('2024-01-31');
	});

	test('sorts by date descending when order is \'desc\'', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-15T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-31T00:00:00Z',
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'usage.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadDailyUsageData({
			claudePath: fixture.path,
			order: 'desc',
		});

		expect(result).toHaveLength(3);
		expect(result[0]?.date).toBe('2024-01-31');
		expect(result[1]?.date).toBe('2024-01-15');
		expect(result[2]?.date).toBe('2024-01-01');
	});

	test('handles invalid JSON lines gracefully', async () => {
		const mockData = `
{"timestamp":"2024-01-01T00:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
invalid json line
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":200,"output_tokens":100}},"costUSD":0.02}
{ broken json
{"timestamp":"2024-01-01T18:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData,
					},
				},
			},
		});

		const result = await loadDailyUsageData({ claudePath: fixture.path });

		// Should only process valid lines
		expect(result).toHaveLength(1);
		expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
		expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
	});

	test('skips data without required fields', async () => {
		const mockData = `
{"timestamp":"2024-01-01T00:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{}}}
{"timestamp":"2024-01-01T18:00:00Z","message":{}}
{"timestamp":"2024-01-01T20:00:00Z"}
{"message":{"usage":{"input_tokens":200,"output_tokens":100}}}
{"timestamp":"2024-01-01T22:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData,
					},
				},
			},
		});

		const result = await loadDailyUsageData({ claudePath: fixture.path });

		// Should only include valid entries
		expect(result).toHaveLength(1);
		expect(result[0]?.inputTokens).toBe(400); // 100 + 300
		expect(result[0]?.totalCost).toBe(0.04); // 0.01 + 0.03
	});
});

describe('loadMonthlyUsageData', () => {
	test('aggregates daily data by month correctly', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-15T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: '2024-02-01T00:00:00Z',
				message: { usage: { input_tokens: 150, output_tokens: 75 } },
				costUSD: 0.015,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadMonthlyUsageData({ claudePath: fixture.path });

		// Should be sorted by month descending (2024-02 first)
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			month: '2024-02',
			inputTokens: 150,
			outputTokens: 75,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.015,
			modelsUsed: [],
			modelBreakdowns: [{
				modelName: 'unknown',
				inputTokens: 150,
				outputTokens: 75,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0.015,
			}],
		});
		expect(result[1]).toEqual({
			month: '2024-01',
			inputTokens: 300,
			outputTokens: 150,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.03,
			modelsUsed: [],
			modelBreakdowns: [{
				modelName: 'unknown',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0.03,
			}],
		});
	});

	test('handles empty data', async () => {
		await using fixture = await createFixture({
			projects: {},
		});

		const result = await loadMonthlyUsageData({ claudePath: fixture.path });
		expect(result).toEqual([]);
	});

	test('handles single month data', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-31T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadMonthlyUsageData({ claudePath: fixture.path });

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			month: '2024-01',
			inputTokens: 300,
			outputTokens: 150,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0.03,
			modelsUsed: [],
			modelBreakdowns: [{
				modelName: 'unknown',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				cost: 0.03,
			}],
		});
	});

	test('sorts months in descending order', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-03-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-02-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2023-12-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadMonthlyUsageData({ claudePath: fixture.path });
		const months = result.map(r => r.month);

		expect(months).toEqual(['2024-03', '2024-02', '2024-01', '2023-12']);
	});

	test('sorts months in ascending order when order is \'asc\'', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-03-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-02-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2023-12-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadMonthlyUsageData({
			claudePath: fixture.path,
			order: 'asc',
		});
		const months = result.map(r => r.month);

		expect(months).toEqual(['2023-12', '2024-01', '2024-02', '2024-03']);
	});

	test('handles year boundaries correctly in sorting', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2023-12-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-02-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2023-11-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		// Descending order (default)
		const descResult = await loadMonthlyUsageData({
			claudePath: fixture.path,
			order: 'desc',
		});
		const descMonths = descResult.map(r => r.month);
		expect(descMonths).toEqual(['2024-02', '2024-01', '2023-12', '2023-11']);

		// Ascending order
		const ascResult = await loadMonthlyUsageData({
			claudePath: fixture.path,
			order: 'asc',
		});
		const ascMonths = ascResult.map(r => r.month);
		expect(ascMonths).toEqual(['2023-11', '2023-12', '2024-01', '2024-02']);
	});

	test('respects date filters', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			},
			{
				timestamp: '2024-02-15T00:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				costUSD: 0.02,
			},
			{
				timestamp: '2024-03-01T00:00:00Z',
				message: { usage: { input_tokens: 150, output_tokens: 75 } },
				costUSD: 0.015,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadMonthlyUsageData({
			claudePath: fixture.path,
			since: '20240110',
			until: '20240225',
		});

		// Should only include February data
		expect(result).toHaveLength(1);
		expect(result[0]?.month).toBe('2024-02');
		expect(result[0]?.inputTokens).toBe(200);
	});

	test('handles cache tokens correctly', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 25,
						cache_read_input_tokens: 10,
					},
				},
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-15T00:00:00Z',
				message: {
					usage: {
						input_tokens: 200,
						output_tokens: 100,
						cache_creation_input_tokens: 50,
						cache_read_input_tokens: 20,
					},
				},
				costUSD: 0.02,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'file.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadMonthlyUsageData({ claudePath: fixture.path });

		expect(result).toHaveLength(1);
		expect(result[0]?.cacheCreationTokens).toBe(75); // 25 + 50
		expect(result[0]?.cacheReadTokens).toBe(30); // 10 + 20
	});
});

describe('loadSessionData', () => {
	test('returns empty array when no files found', async () => {
		await using fixture = await createFixture({
			projects: {},
		});

		const result = await loadSessionData({ claudePath: fixture.path });
		expect(result).toEqual([]);
	});

	test('extracts session info from file paths', async () => {
		const mockData: UsageData = {
			timestamp: '2024-01-01T00:00:00Z',
			message: { usage: { input_tokens: 100, output_tokens: 50 } },
			costUSD: 0.01,
		};

		await using fixture = await createFixture({
			projects: {
				'project1/subfolder': {
					session123: {
						'chat.jsonl': JSON.stringify(mockData),
					},
				},
				'project2': {
					session456: {
						'chat.jsonl': JSON.stringify(mockData),
					},
				},
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		expect(result).toHaveLength(2);
		expect(result.find(s => s.sessionId === 'session123')).toBeTruthy();
		expect(
			result.find(s => s.projectPath === 'project1/subfolder'),
		).toBeTruthy();
		expect(result.find(s => s.sessionId === 'session456')).toBeTruthy();
		expect(result.find(s => s.projectPath === 'project2')).toBeTruthy();
	});

	test('aggregates session usage data', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 10,
						cache_read_input_tokens: 5,
					},
				},
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-01T12:00:00Z',
				message: {
					usage: {
						input_tokens: 200,
						output_tokens: 100,
						cache_creation_input_tokens: 20,
						cache_read_input_tokens: 10,
					},
				},
				costUSD: 0.02,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'chat.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		expect(result).toHaveLength(1);
		const session = result[0];
		expect(session?.sessionId).toBe('session1');
		expect(session?.projectPath).toBe('project1');
		expect(session?.inputTokens).toBe(300); // 100 + 200
		expect(session?.outputTokens).toBe(150); // 50 + 100
		expect(session?.cacheCreationTokens).toBe(30); // 10 + 20
		expect(session?.cacheReadTokens).toBe(15); // 5 + 10
		expect(session?.totalCost).toBe(0.03); // 0.01 + 0.02
		expect(session?.lastActivity).toBe('2024-01-01');
	});

	test('tracks versions', async () => {
		const mockData: UsageData[] = [
			{
				timestamp: '2024-01-01T00:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				version: '1.0.0',
				costUSD: 0.01,
			},
			{
				timestamp: '2024-01-01T12:00:00Z',
				message: { usage: { input_tokens: 200, output_tokens: 100 } },
				version: '1.1.0',
				costUSD: 0.02,
			},
			{
				timestamp: '2024-01-01T18:00:00Z',
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				version: '1.0.0', // Duplicate version
				costUSD: 0.03,
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: {
					session1: {
						'chat.jsonl': mockData.map(d => JSON.stringify(d)).join('\n'),
					},
				},
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		const session = result[0];
		expect(session?.versions).toEqual(['1.0.0', '1.1.0']); // Sorted and unique
	});

	test('sorts by last activity descending', async () => {
		const sessions = [
			{
				sessionId: 'session1',
				data: {
					timestamp: '2024-01-15T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session2',
				data: {
					timestamp: '2024-01-01T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session3',
				data: {
					timestamp: '2024-01-31T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: Object.fromEntries(
					sessions.map(s => [
						s.sessionId,
						{ 'chat.jsonl': JSON.stringify(s.data) },
					]),
				),
			},
		});

		const result = await loadSessionData({ claudePath: fixture.path });

		expect(result[0]?.sessionId).toBe('session3');
		expect(result[1]?.sessionId).toBe('session1');
		expect(result[2]?.sessionId).toBe('session2');
	});

	test('sorts by last activity ascending when order is \'asc\'', async () => {
		const sessions = [
			{
				sessionId: 'session1',
				data: {
					timestamp: '2024-01-15T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session2',
				data: {
					timestamp: '2024-01-01T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session3',
				data: {
					timestamp: '2024-01-31T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: Object.fromEntries(
					sessions.map(s => [
						s.sessionId,
						{ 'chat.jsonl': JSON.stringify(s.data) },
					]),
				),
			},
		});

		const result = await loadSessionData({
			claudePath: fixture.path,
			order: 'asc',
		});

		expect(result[0]?.sessionId).toBe('session2'); // oldest first
		expect(result[1]?.sessionId).toBe('session1');
		expect(result[2]?.sessionId).toBe('session3'); // newest last
	});

	test('sorts by last activity descending when order is \'desc\'', async () => {
		const sessions = [
			{
				sessionId: 'session1',
				data: {
					timestamp: '2024-01-15T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session2',
				data: {
					timestamp: '2024-01-01T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session3',
				data: {
					timestamp: '2024-01-31T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: Object.fromEntries(
					sessions.map(s => [
						s.sessionId,
						{ 'chat.jsonl': JSON.stringify(s.data) },
					]),
				),
			},
		});

		const result = await loadSessionData({
			claudePath: fixture.path,
			order: 'desc',
		});

		expect(result[0]?.sessionId).toBe('session3'); // newest first (same as default)
		expect(result[1]?.sessionId).toBe('session1');
		expect(result[2]?.sessionId).toBe('session2'); // oldest last
	});

	test('filters by date range based on last activity', async () => {
		const sessions = [
			{
				sessionId: 'session1',
				data: {
					timestamp: '2024-01-01T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session2',
				data: {
					timestamp: '2024-01-15T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
			{
				sessionId: 'session3',
				data: {
					timestamp: '2024-01-31T00:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			},
		];

		await using fixture = await createFixture({
			projects: {
				project1: Object.fromEntries(
					sessions.map(s => [
						s.sessionId,
						{ 'chat.jsonl': JSON.stringify(s.data) },
					]),
				),
			},
		});

		const result = await loadSessionData({
			claudePath: fixture.path,
			since: '20240110',
			until: '20240125',
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.lastActivity).toBe('2024-01-15');
	});
});

describe('data-loader cost calculation with real pricing', () => {
	describe('loadDailyUsageData with mixed schemas', () => {
		test('should handle old schema with costUSD', async () => {
			const oldData = {
				timestamp: '2024-01-15T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
					},
				},
				costUSD: 0.05, // Pre-calculated cost
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-old': {
						'session-old': {
							'usage.jsonl': `${JSON.stringify(oldData)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe('2024-01-15');
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.totalCost).toBe(0.05);
		});

		test('should calculate cost for new schema with claude-sonnet-4-20250514', async () => {
			// Use a well-known Claude model
			const modelName = 'claude-sonnet-4-20250514';

			const newData = {
				timestamp: '2024-01-16T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 200,
						cache_read_input_tokens: 300,
					},
					model: modelName,
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-new': {
						'session-new': {
							'usage.jsonl': `${JSON.stringify(newData)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe('2024-01-16');
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(200);
			expect(results[0]?.cacheReadTokens).toBe(300);

			// Should have calculated some cost
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});

		test('should calculate cost for new schema with claude-opus-4-20250514', async () => {
			// Use Claude 4 Opus model
			const modelName = 'claude-opus-4-20250514';

			const newData = {
				timestamp: '2024-01-16T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 200,
						cache_read_input_tokens: 300,
					},
					model: modelName,
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-opus': {
						'session-opus': {
							'usage.jsonl': `${JSON.stringify(newData)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe('2024-01-16');
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(200);
			expect(results[0]?.cacheReadTokens).toBe(300);

			// Should have calculated some cost
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});

		test('should handle mixed data in same file', async () => {
			const data1 = {
				timestamp: '2024-01-17T10:00:00Z',
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			};

			const data2 = {
				timestamp: '2024-01-17T11:00:00Z',
				message: {
					usage: { input_tokens: 200, output_tokens: 100 },
					model: 'claude-4-sonnet-20250514',
				},
			};

			const data3 = {
				timestamp: '2024-01-17T12:00:00Z',
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				// No costUSD and no model - should be 0 cost
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-mixed': {
						'session-mixed': {
							'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n${JSON.stringify(data3)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe('2024-01-17');
			expect(results[0]?.inputTokens).toBe(600); // 100 + 200 + 300
			expect(results[0]?.outputTokens).toBe(300); // 50 + 100 + 150

			// Total cost should be at least the pre-calculated cost from data1
			expect(results[0]?.totalCost).toBeGreaterThanOrEqual(0.01);
		});

		test('should handle data without model or costUSD', async () => {
			const data = {
				timestamp: '2024-01-18T10:00:00Z',
				message: { usage: { input_tokens: 500, output_tokens: 250 } },
				// No costUSD and no model
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-no-cost': {
						'session-no-cost': {
							'usage.jsonl': `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.inputTokens).toBe(500);
			expect(results[0]?.outputTokens).toBe(250);
			expect(results[0]?.totalCost).toBe(0); // 0 cost when no pricing info available
		});
	});

	describe('loadSessionData with mixed schemas', () => {
		test('should handle mixed cost sources in different sessions', async () => {
			const session1Data = {
				timestamp: '2024-01-15T10:00:00Z',
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
				costUSD: 0.05,
			};

			const session2Data = {
				timestamp: '2024-01-16T10:00:00Z',
				message: {
					usage: { input_tokens: 2000, output_tokens: 1000 },
					model: 'claude-4-sonnet-20250514',
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session1: {
							'usage.jsonl': JSON.stringify(session1Data),
						},
						session2: {
							'usage.jsonl': JSON.stringify(session2Data),
						},
					},
				},
			});

			const results = await loadSessionData({ claudePath: fixture.path });

			expect(results).toHaveLength(2);

			// Check session 1
			const session1 = results.find(s => s.sessionId === 'session1');
			expect(session1).toBeTruthy();
			expect(session1?.totalCost).toBe(0.05);

			// Check session 2
			const session2 = results.find(s => s.sessionId === 'session2');
			expect(session2).toBeTruthy();
			expect(session2?.totalCost).toBeGreaterThan(0);
		});

		test('should handle unknown models gracefully', async () => {
			const data = {
				timestamp: '2024-01-19T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'unknown-model-xyz',
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-unknown': {
						'session-unknown': {
							'usage.jsonl': `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadSessionData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.totalCost).toBe(0); // 0 cost for unknown model
		});
	});

	describe('cached tokens cost calculation', () => {
		test('should correctly calculate costs for all token types with claude-sonnet-4-20250514', async () => {
			const data = {
				timestamp: '2024-01-20T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 2000,
						cache_read_input_tokens: 1500,
					},
					model: 'claude-4-sonnet-20250514',
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-cache': {
						'session-cache': {
							'usage.jsonl': `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe('2024-01-20');
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(2000);
			expect(results[0]?.cacheReadTokens).toBe(1500);

			// Should have calculated cost including cache tokens
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});

		test('should correctly calculate costs for all token types with claude-opus-4-20250514', async () => {
			const data = {
				timestamp: '2024-01-20T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						cache_creation_input_tokens: 2000,
						cache_read_input_tokens: 1500,
					},
					model: 'claude-opus-4-20250514',
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project-opus-cache': {
						'session-opus-cache': {
							'usage.jsonl': `${JSON.stringify(data)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({ claudePath: fixture.path });

			expect(results).toHaveLength(1);
			expect(results[0]?.date).toBe('2024-01-20');
			expect(results[0]?.inputTokens).toBe(1000);
			expect(results[0]?.outputTokens).toBe(500);
			expect(results[0]?.cacheCreationTokens).toBe(2000);
			expect(results[0]?.cacheReadTokens).toBe(1500);

			// Should have calculated cost including cache tokens
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});
	});

	describe('cost mode functionality', () => {
		test('auto mode: uses costUSD when available, calculates otherwise', async () => {
			const data1 = {
				timestamp: '2024-01-01T10:00:00Z',
				message: { usage: { input_tokens: 1000, output_tokens: 500 } },
				costUSD: 0.05,
			};

			const data2 = {
				timestamp: '2024-01-01T11:00:00Z',
				message: {
					usage: { input_tokens: 2000, output_tokens: 1000 },
					model: 'claude-4-sonnet-20250514',
				},
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'auto',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBeGreaterThan(0.05); // Should include both costs
		});

		test('calculate mode: always calculates from tokens, ignores costUSD', async () => {
			const data = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				costUSD: 99.99, // This should be ignored
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': JSON.stringify(data),
						},
					},
				},
			});

			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'calculate',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBeGreaterThan(0);
			expect(results[0]?.totalCost).toBeLessThan(1); // Much less than 99.99
		});

		test('display mode: always uses costUSD, even if undefined', async () => {
			const data1 = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				costUSD: 0.05,
			};

			const data2 = {
				timestamp: '2024-01-01T11:00:00Z',
				message: {
					usage: { input_tokens: 2000, output_tokens: 1000 },
					model: 'claude-4-sonnet-20250514',
				},
				// No costUSD - should result in 0 cost
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n`,
						},
					},
				},
			});

			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBe(0.05); // Only the costUSD from data1
		});

		test('mode works with session data', async () => {
			const sessionData = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				costUSD: 99.99,
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session1: {
							'usage.jsonl': JSON.stringify(sessionData),
						},
					},
				},
			});

			// Test calculate mode
			const calculateResults = await loadSessionData({
				claudePath: fixture.path,
				mode: 'calculate',
			});
			expect(calculateResults[0]?.totalCost).toBeLessThan(1);

			// Test display mode
			const displayResults = await loadSessionData({
				claudePath: fixture.path,
				mode: 'display',
			});
			expect(displayResults[0]?.totalCost).toBe(99.99);
		});
	});

	describe('pricing data fetching optimization', () => {
		test('should not require model pricing when mode is display', async () => {
			const data = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				costUSD: 0.05,
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': JSON.stringify(data),
						},
					},
				},
			});

			// In display mode, only pre-calculated costUSD should be used
			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBe(0.05);
		});

		test('should fetch pricing data when mode is calculate', async () => {
			const data = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				costUSD: 0.05,
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': JSON.stringify(data),
						},
					},
				},
			});

			// This should fetch pricing data (will call real fetch)
			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'calculate',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBeGreaterThan(0);
			expect(results[0]?.totalCost).not.toBe(0.05); // Should calculate, not use costUSD
		});

		test('should fetch pricing data when mode is auto', async () => {
			const data = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				// No costUSD, so auto mode will need to calculate
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': JSON.stringify(data),
						},
					},
				},
			});

			// This should fetch pricing data (will call real fetch)
			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'auto',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBeGreaterThan(0);
		});

		test('session data should not require model pricing when mode is display', async () => {
			const data = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'claude-4-sonnet-20250514',
				},
				costUSD: 0.05,
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': JSON.stringify(data),
						},
					},
				},
			});

			// In display mode, only pre-calculated costUSD should be used
			const results = await loadSessionData({
				claudePath: fixture.path,
				mode: 'display',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBe(0.05);
		});

		test('display mode should work without network access', async () => {
			const data = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 1000, output_tokens: 500 },
					model: 'some-unknown-model',
				},
				costUSD: 0.05,
			};

			await using fixture = await createFixture({
				projects: {
					'test-project': {
						session: {
							'usage.jsonl': JSON.stringify(data),
						},
					},
				},
			});

			// This test verifies that display mode doesn't try to fetch pricing
			// by using an unknown model that would cause pricing lookup to fail
			// if it were attempted. Since we're in display mode, it should just
			// use the costUSD value.
			const results = await loadDailyUsageData({
				claudePath: fixture.path,
				mode: 'display',
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.totalCost).toBe(0.05);
		});
	});
});

describe('calculateCostForEntry', () => {
	const mockUsageData: UsageData = {
		timestamp: '2024-01-01T10:00:00Z',
		message: {
			usage: {
				input_tokens: 1000,
				output_tokens: 500,
				cache_creation_input_tokens: 200,
				cache_read_input_tokens: 100,
			},
			model: 'claude-sonnet-4-20250514',
		},
		costUSD: 0.05,
	};

	describe('display mode', () => {
		test('should return costUSD when available', async () => {
			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(mockUsageData, 'display', fetcher);
			expect(result).toBe(0.05);
		});

		test('should return 0 when costUSD is undefined', async () => {
			const dataWithoutCost = { ...mockUsageData };
			dataWithoutCost.costUSD = undefined;

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithoutCost, 'display', fetcher);
			expect(result).toBe(0);
		});

		test('should not use model pricing in display mode', async () => {
			// Even with model pricing available, should use costUSD
			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(mockUsageData, 'display', fetcher);
			expect(result).toBe(0.05);
		});
	});

	describe('calculate mode', () => {
		test('should calculate cost from tokens when model pricing available', async () => {
			// Use the exact same structure as working integration tests
			const testData: UsageData = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
					},
					model: 'claude-4-sonnet-20250514',
				},
			};

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(testData, 'calculate', fetcher);

			expect(result).toBeGreaterThan(0);
		});

		test('should ignore costUSD in calculate mode', async () => {
			using fetcher = new PricingFetcher();
			const dataWithHighCost = { ...mockUsageData, costUSD: 99.99 };
			const result = await calculateCostForEntry(
				dataWithHighCost,
				'calculate',
				fetcher,
			);

			expect(result).toBeGreaterThan(0);
			expect(result).toBeLessThan(1); // Much less than 99.99
		});

		test('should return 0 when model not available', async () => {
			const dataWithoutModel = { ...mockUsageData };
			dataWithoutModel.message.model = undefined;

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithoutModel, 'calculate', fetcher);
			expect(result).toBe(0);
		});

		test('should return 0 when model pricing not found', async () => {
			const dataWithUnknownModel = {
				...mockUsageData,
				message: { ...mockUsageData.message, model: 'unknown-model' },
			};

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(
				dataWithUnknownModel,
				'calculate',
				fetcher,
			);
			expect(result).toBe(0);
		});

		test('should handle missing cache tokens', async () => {
			const dataWithoutCacheTokens: UsageData = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
					},
					model: 'claude-4-sonnet-20250514',
				},
			};

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(
				dataWithoutCacheTokens,
				'calculate',
				fetcher,
			);

			expect(result).toBeGreaterThan(0);
		});
	});

	describe('auto mode', () => {
		test('should use costUSD when available', async () => {
			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(mockUsageData, 'auto', fetcher);
			expect(result).toBe(0.05);
		});

		test('should calculate from tokens when costUSD undefined', async () => {
			const dataWithoutCost: UsageData = {
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
					},
					model: 'claude-4-sonnet-20250514',
				},
			};

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(
				dataWithoutCost,
				'auto',
				fetcher,
			);
			expect(result).toBeGreaterThan(0);
		});

		test('should return 0 when no costUSD and no model', async () => {
			const dataWithoutCostOrModel = { ...mockUsageData };
			dataWithoutCostOrModel.costUSD = undefined;
			dataWithoutCostOrModel.message.model = undefined;

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithoutCostOrModel, 'auto', fetcher);
			expect(result).toBe(0);
		});

		test('should return 0 when no costUSD and model pricing not found', async () => {
			const dataWithoutCost = { ...mockUsageData };
			dataWithoutCost.costUSD = undefined;

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithoutCost, 'auto', fetcher);
			expect(result).toBe(0);
		});

		test('should prefer costUSD over calculation even when both available', async () => {
			// Both costUSD and model pricing available, should use costUSD
			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(mockUsageData, 'auto', fetcher);
			expect(result).toBe(0.05);
		});
	});

	describe('edge cases', () => {
		test('should handle zero token counts', async () => {
			const dataWithZeroTokens = {
				...mockUsageData,
				message: {
					...mockUsageData.message,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
			};
			dataWithZeroTokens.costUSD = undefined;

			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithZeroTokens, 'calculate', fetcher);
			expect(result).toBe(0);
		});

		test('should handle costUSD of 0', async () => {
			const dataWithZeroCost = { ...mockUsageData, costUSD: 0 };
			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithZeroCost, 'display', fetcher);
			expect(result).toBe(0);
		});

		test('should handle negative costUSD', async () => {
			const dataWithNegativeCost = { ...mockUsageData, costUSD: -0.01 };
			using fetcher = new PricingFetcher();
			const result = await calculateCostForEntry(dataWithNegativeCost, 'display', fetcher);
			expect(result).toBe(-0.01);
		});
	});

	describe('offline mode', () => {
		test('should pass offline flag through loadDailyUsageData', async () => {
			await using fixture = await createFixture({ projects: {} });
			// This test verifies that the offline flag is properly passed through
			// We can't easily mock the internal behavior, but we can verify it doesn't throw
			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				offline: true,
				mode: 'calculate',
			});

			// Should return empty array or valid data without throwing
			expect(Array.isArray(result)).toBe(true);
		});
	});
});

describe('window aggregation functions', () => {
	describe('calculateWindowStatistics', () => {
		test('should group messages into 5-hour windows', () => {
			const entries = [
				{
					data: {
						timestamp: '2025-06-16T00:30:00Z',
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
					} as UsageData,
					timestamp: '2025-06-16T00:30:00Z',
					cost: 0.01,
					sessionKey: 'project1/session1',
					model: 'claude-sonnet-4-20250514' as const,
				},
				{
					data: {
						timestamp: '2025-06-16T04:30:00Z',
						message: { usage: { input_tokens: 200, output_tokens: 100 } },
					} as UsageData,
					timestamp: '2025-06-16T04:30:00Z',
					cost: 0.02,
					sessionKey: 'project1/session1',
					model: 'claude-sonnet-4-20250514' as const,
				},
				{
					data: {
						timestamp: '2025-06-16T05:30:00Z',
						message: { usage: { input_tokens: 300, output_tokens: 150 } },
					} as UsageData,
					timestamp: '2025-06-16T05:30:00Z',
					cost: 0.03,
					sessionKey: 'project1/session2',
					model: 'claude-sonnet-4-20250514' as const,
				},
			];

			const windowMap = calculateWindowStatistics(entries);

			// Should have 2 windows
			expect(windowMap.size).toBe(2);

			// Check window 00:00-05:00
			const window1 = windowMap.get('2025-06-16-00');
			expect(window1).toBeDefined();
			expect(window1?.windowId).toBe('2025-06-16-00');
			expect(window1?.messageCount).toBe(2);
			expect(window1?.sessionCount).toBe(1); // Only session1
			expect(window1?.inputTokens).toBe(300); // 100 + 200
			expect(window1?.outputTokens).toBe(150); // 50 + 100
			expect(window1?.totalCost).toBe(0.03); // 0.01 + 0.02

			// Check window 05:00-10:00
			const window2 = windowMap.get('2025-06-16-05');
			expect(window2).toBeDefined();
			expect(window2?.windowId).toBe('2025-06-16-05');
			expect(window2?.messageCount).toBe(1);
			expect(window2?.sessionCount).toBe(1); // Only session2
			expect(window2?.inputTokens).toBe(300);
			expect(window2?.outputTokens).toBe(150);
			expect(window2?.totalCost).toBe(0.03);
		});

		test('should calculate correct window durations', () => {
			const entries = [
				{
					data: {
						timestamp: '2025-06-16T10:00:00Z',
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
					} as UsageData,
					timestamp: '2025-06-16T10:00:00Z',
					cost: 0.01,
					sessionKey: 'project1/session1',
					model: undefined,
				},
				{
					data: {
						timestamp: '2025-06-16T14:59:59Z',
						message: { usage: { input_tokens: 200, output_tokens: 100 } },
					} as UsageData,
					timestamp: '2025-06-16T14:59:59Z',
					cost: 0.02,
					sessionKey: 'project1/session1',
					model: undefined,
				},
			];

			const windowMap = calculateWindowStatistics(entries);
			const window = windowMap.get('2025-06-16-10');

			expect(window).toBeDefined();
			expect(window?.startTimestamp).toBe('2025-06-16T10:00:00Z');
			expect(window?.endTimestamp).toBe('2025-06-16T14:59:59Z');
			expect(window?.duration).toBe(17999000); // 4h 59m 59s in milliseconds
		});

		test('should count unique sessions per window', () => {
			const entries = [
				{
					data: {
						timestamp: '2025-06-16T15:00:00Z',
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
					} as UsageData,
					timestamp: '2025-06-16T15:00:00Z',
					cost: 0.01,
					sessionKey: 'project1/session1',
					model: 'claude-sonnet-4-20250514' as const,
				},
				{
					data: {
						timestamp: '2025-06-16T16:00:00Z',
						message: { usage: { input_tokens: 200, output_tokens: 100 } },
					} as UsageData,
					timestamp: '2025-06-16T16:00:00Z',
					cost: 0.02,
					sessionKey: 'project2/session2',
					model: 'claude-sonnet-4-20250514' as const,
				},
				{
					data: {
						timestamp: '2025-06-16T17:00:00Z',
						message: { usage: { input_tokens: 300, output_tokens: 150 } },
					} as UsageData,
					timestamp: '2025-06-16T17:00:00Z',
					cost: 0.03,
					sessionKey: 'project1/session1',
					model: 'claude-sonnet-4-20250514' as const,
				},
			];

			const windowMap = calculateWindowStatistics(entries);
			const window = windowMap.get('2025-06-16-15');

			expect(window).toBeDefined();
			expect(window?.sessionCount).toBe(2); // session1 and session2
			expect(window?.messageCount).toBe(3);
		});

		test('should handle cache tokens correctly', () => {
			const entries = [
				{
					data: {
						timestamp: '2025-06-16T20:00:00Z',
						message: {
							usage: {
								input_tokens: 100,
								output_tokens: 50,
								cache_creation_input_tokens: 25,
								cache_read_input_tokens: 10,
							},
						},
					} as UsageData,
					timestamp: '2025-06-16T20:00:00Z',
					cost: 0.01,
					sessionKey: 'project1/session1',
					model: 'claude-opus-4-20250514' as const,
				},
			];

			const windowMap = calculateWindowStatistics(entries);
			const window = windowMap.get('2025-06-16-20');

			expect(window).toBeDefined();
			expect(window?.cacheCreationTokens).toBe(25);
			expect(window?.cacheReadTokens).toBe(10);
		});
	});

	describe('groupWindowsByMonth', () => {
		test('should group windows by month correctly', () => {
			const windows = new Map([
				['2025-06-16-00', {
					windowId: '2025-06-16-00',
					month: '2025-06',
					startTimestamp: '2025-06-16T00:00:00Z',
					endTimestamp: '2025-06-16T04:59:59Z',
					messageCount: 10,
					sessionCount: 2,
					inputTokens: 1000,
					outputTokens: 500,
					cacheCreationTokens: 100,
					cacheReadTokens: 50,
					totalCost: 0.1,
					duration: 17999000,
					modelsUsed: ['claude-sonnet-4-20250514'],
				}],
				['2025-06-17-00', {
					windowId: '2025-06-17-00',
					month: '2025-06',
					startTimestamp: '2025-06-17T00:00:00Z',
					endTimestamp: '2025-06-17T02:00:00Z',
					messageCount: 5,
					sessionCount: 1,
					inputTokens: 500,
					outputTokens: 250,
					cacheCreationTokens: 50,
					cacheReadTokens: 25,
					totalCost: 0.05,
					duration: 7200000,
					modelsUsed: ['claude-sonnet-4-20250514'],
				}],
				['2025-07-01-00', {
					windowId: '2025-07-01-00',
					month: '2025-07',
					startTimestamp: '2025-07-01T00:00:00Z',
					endTimestamp: '2025-07-01T01:00:00Z',
					messageCount: 3,
					sessionCount: 1,
					inputTokens: 300,
					outputTokens: 150,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.03,
					duration: 3600000,
					modelsUsed: ['claude-opus-4-20250514'],
				}],
			]);

			const summaries = groupWindowsByMonth(windows);

			expect(summaries).toHaveLength(2);

			// Check July (should be first due to descending sort)
			expect(summaries[0]?.month).toBe('2025-07');
			expect(summaries[0]?.windowCount).toBe(1);
			expect(summaries[0]?.totalCost).toBe(0.03);
			expect(summaries[0]?.totalTokens).toBe(450); // 300 + 150

			// Check June
			expect(summaries[1]?.month).toBe('2025-06');
			expect(summaries[1]?.windowCount).toBe(2);
			expect(summaries[1]?.totalCost).toBeCloseTo(0.15, 10); // 0.1 + 0.05
			expect(summaries[1]?.totalTokens).toBe(2475); // (1000+500+100+50) + (500+250+50+25)
		});

		test('should apply session limits correctly', () => {
			const windows = new Map<string, WindowUsage>();
			// Add 55 windows for June
			for (let i = 0; i < 55; i++) {
				const day = Math.floor(i / 5) + 1;
				const hour = (i % 5) * 5;
				const windowId = `2025-06-${day.toString().padStart(2, '0')}-${hour.toString().padStart(2, '0')}`;
				windows.set(windowId, {
					windowId,
					month: '2025-06',
					startTimestamp: `2025-06-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:00:00Z`,
					endTimestamp: `2025-06-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:30:00Z`,
					messageCount: 1,
					sessionCount: 1,
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					duration: 1800000,
					modelsUsed: ['claude-sonnet-4-20250514'],
				});
			}

			const summaries = groupWindowsByMonth(windows, { sessionLimit: 50 });

			expect(summaries).toHaveLength(1);
			const summary = summaries[0];
			expect(summary?.windowCount).toBe(55);
			expect(summary?.sessionLimit).toBe(50);
			expect(summary?.remainingSessions).toBe(0); // Max 0, not negative
			expect(summary?.utilizationPercent).toBeCloseTo(110, 10); // 55/50 * 100
		});

		test('should sort windows within month by windowId descending', () => {
			const windows = new Map([
				['2025-06-01-00', {
					windowId: '2025-06-01-00',
					month: '2025-06',
					startTimestamp: '2025-06-01T00:00:00Z',
					endTimestamp: '2025-06-01T01:00:00Z',
					messageCount: 1,
					sessionCount: 1,
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					duration: 3600000,
					modelsUsed: [],
				}],
				['2025-06-02-10', {
					windowId: '2025-06-02-10',
					month: '2025-06',
					startTimestamp: '2025-06-02T10:00:00Z',
					endTimestamp: '2025-06-02T11:00:00Z',
					messageCount: 1,
					sessionCount: 1,
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					duration: 3600000,
					modelsUsed: [],
				}],
				['2025-06-01-20', {
					windowId: '2025-06-01-20',
					month: '2025-06',
					startTimestamp: '2025-06-01T20:00:00Z',
					endTimestamp: '2025-06-01T21:00:00Z',
					messageCount: 1,
					sessionCount: 1,
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					duration: 3600000,
					modelsUsed: [],
				}],
			]);

			const summaries = groupWindowsByMonth(windows);
			const juneSummary = summaries[0];

			expect(juneSummary?.windows).toHaveLength(3);
			// Should be sorted by windowId descending (most recent first)
			expect(juneSummary?.windows[0]?.windowId).toBe('2025-06-02-10');
			expect(juneSummary?.windows[1]?.windowId).toBe('2025-06-01-20');
			expect(juneSummary?.windows[2]?.windowId).toBe('2025-06-01-00');
		});
	});
});
