import type { LoadOptions } from './data-loader.ts';
import type { CostMode } from './types.internal.ts';
import { FastMCP } from 'fastmcp';
import * as v from 'valibot';

import { name, version } from '../package.json';
import {
	getDefaultClaudePath,
	loadDailyUsageData,
	loadSessionData,
} from './data-loader.ts';
import { CostModes, dateSchema } from './types.internal.ts';

const sinceSchema = v.pipe(
	dateSchema,
	v.description('Filter from date (YYYYMMDD format)'),
);

const untilSchema = v.pipe(
	dateSchema,
	v.description('Filter until date (YYYYMMDD format)'),
);
const modeSchema = v.optional(
	v.pipe(
		v.union(CostModes.map(m => v.literal(m))),
		v.description(
			`
Cost calculation mode: auto (use costUSD if exists, otherwise calculate), calculate (always calculate), display (always use costUSD)
default: auto
`,
		),
	),
);

const parametersSchema = v.object({
	since: v.optional(sinceSchema),
	until: v.optional(untilSchema),
	mode: v.optional(modeSchema, () => 'auto' as const satisfies CostMode),
});

/** Default options for the MCP server */
const defaultOptions = {
	claudePath: getDefaultClaudePath(),
} as const satisfies LoadOptions;

/**
 * Creates a FastMCP server with tools for showing usage reports.
 */
export function createMcpServer({
	claudePath,
}: LoadOptions = defaultOptions): FastMCP {
	const server = new FastMCP({
		name,
		version: version as `1.2.3`, // type mismatch workaround
	});

	server.addTool({
		name: 'daily',
		description: 'Show usage report grouped by date',
		parameters: parametersSchema,
		execute: async (args) => {
			const dailyData = await loadDailyUsageData({ ...args, claudePath });
			return JSON.stringify(dailyData);
		},
	});

	server.addTool({
		name: 'session',
		description: 'Show usage report grouped by conversation session',
		parameters: parametersSchema,
		execute: async (args) => {
			const sessionData = await loadSessionData({ ...args, claudePath });
			return JSON.stringify(sessionData);
		},
	});

	return server;
}
