import { sha256, sleep } from '@kyvejs/protocol';
import type { ChildProcess } from 'child_process';
import fse from 'fs-extra';
import type { RootDatabase } from 'lmdb';
import path from 'path';
import shell from 'shelljs';
import type { Logger } from 'tslog';

import { copyFromTimeIndex } from '../env-config';
import { Managers } from '../managers';
import { IConfig } from '../types';
import { Database } from '../utils/database';

type BlockNumber = number;
type Timestamp = number;
type DB = RootDatabase<
	{
		b: BlockNumber;
		s: string[]; // Sources that agree
	},
	Timestamp
>;

const CONFIRMATIONS = 128 as const; // The number of confirmations/blocks required to determine finality.
const SCAN_BUFFER = 10000 as const; // The time a find/scan will use to evaluate the indexed block
const DEFAULT_DB_VALUE = { b: 0, s: [] };
const POLL_INTERVAL = 10 as const; // The time in seconds to delay between the latest index and the next
const BATCH_SIZE = 10 as const; // How many blocks to batch in single request

/**
 * Class to manage an index of blocks and their timestamps
 *
 * ? This index only needs to start from the last report's block height, as all bundles moving forward are based on future data.
 * ? If no report exists, then the startBlockNumber is used.
 *
 * This index makes the Validator way more reliable and efficient at managing correlation between blocks and time
 */
export class TimeIndexer {
	protected _cachePath: string;
	private _db!: DB;
	private _ready: boolean = false;
	private _latestTimestamp: number;
	private _childProcesses: ChildProcess[] = [];

	constructor(
		homeDir: string,
		protected config: IConfig,
		protected logger: Logger
	) {
		this._cachePath = path.join(homeDir, '.logstore-time');

		if (!shell.which('ethereumetl')) {
			throw new Error(
				'ethereumetl is not installed. Please re-install the Log Store Validator, or run `pip install ethereum-etl`'
			);
		}
	}

	public get latestTimestamp() {
		return this._latestTimestamp;
	}

	public async start(): Promise<void> {
		try {
			await fse.remove(this._cachePath);

			let startBlock = 0;
			const dbPath = path.join(this._cachePath, 'cache');

			// ? For testing purposes
			if (copyFromTimeIndex) {
				this.logger.info(`Copy from an existing Time Index`);
				const exists = await fse.pathExists(copyFromTimeIndex);
				if (!exists) {
					throw new Error('Time Index to copy from does not exist');
				}
				const existingTimeIndex = path.join(copyFromTimeIndex, 'cache');
				await fse.copySync(existingTimeIndex, dbPath);
			}

			this._db = Database.create('time-index', dbPath) as DB;

			// ? If the index already exists, check it's latest data.
			for (const { key, value } of this._db.getRange({
				reverse: true,
				limit: 1,
			})) {
				this.logger.debug(
					`Fetch last Time Index item - ${key}: ${value.b} (${value.s.join(
						','
					)})`
				);
				this._latestTimestamp = key;
				startBlock = value.b;
			}

			this.logger.info('Starting time indexer ...');

			if (startBlock === 0) {
				startBlock = await Managers.withSources<number>(
					this.config.sources,
					async (managers) => {
						const lastReport = await managers.report.getLastReport();
						if ((lastReport || {})?.id) {
							return lastReport.height;
						}
						const startBlockNumber = await managers.node.getStartBlockNumber();
						return startBlockNumber;
					}
				);
			}

			this.logger.info('Start Block Number: ', startBlock);

			await this.etl(startBlock);
		} catch (e) {
			this.logger.error(`Unexpected error indexing blocks by time...`);
			this.logger.error(e);
			throw e; // Fail if there's an issue with listening to data critical to performance of validator.
		}
	}

	public stop() {
		this._childProcesses.forEach((child) => {
			child.kill();
		});
	}

	// Wait until the TimeIndex is ready
	public async ready() {
		while (true) {
			if (this._ready) {
				return true;
			}
			await sleep(1000);
		}
	}

	public find(timestamp: number): number {
		const db = this.db();

		if (timestamp === 0) {
			return 0;
		}

		// If exact match, use it.
		const res = db.get(timestamp) || DEFAULT_DB_VALUE;
		if (res.b > 0 && res.s.length > 0) {
			return res.b;
		}
		// Create an array of diffs - indicating how far the parameter timestamp is from the current value
		const diffs = [];
		for (const { key, value } of db.getRange({
			start: timestamp - SCAN_BUFFER,
			end: timestamp + SCAN_BUFFER,
		})) {
			if (key === timestamp) {
				return value.b;
			}
			diffs.push({ diff: Math.abs(timestamp - key), ts: key, block: value.b });
		}

		this.logger.debug('Scan blocks with timestamp', {
			timestamp,
			diffs,
		});

		if (diffs.length === 0) {
			throw new Error('Could not find time indexed blocks for timestamp');
		}
		// Sort by diff and value
		diffs.sort((a, b) => {
			if (a.diff < b.diff) {
				return -1;
			}
			if (a.diff > b.diff) {
				return 1;
			}
			if (a.diff === b.diff) {
				if (a.block < b.block) {
					return -1;
				}
				if (a.block < b.block) {
					return 1;
				}
			}
			return 0;
		});

		return diffs[0].block;
	}

	protected db() {
		if (!this._db) {
			throw new Error('Database is not initialised');
		}
		return this._db;
	}

	private async etl(startBlock?: number) {
		const { sources } = this.config;
		const db = this.db();
		this.logger.debug(`Start ETL from block ${startBlock || `'latest'`} ...`);

		for (const source of sources) {
			const saveFilename = `last_synced_block_${sha256(
				Buffer.from(source)
			)}.txt`;
			const savefile = path.join(this._cachePath, saveFilename);
			const managers = new Managers(source);
			await managers.init();
			const latestBlock =
				(await managers.provider.getBlockNumber()) - CONFIRMATIONS;
			const fromBlock = startBlock || latestBlock;

			const child = shell.exec(
				`ethereumetl stream -s ${fromBlock} -e block -p ${source} -l ${savefile} --period-seconds ${POLL_INTERVAL} -b ${BATCH_SIZE} --lag ${CONFIRMATIONS}`,
				{ async: true, silent: true, fatal: true }
			);
			this._childProcesses.push(child);

			this.logger.debug(`TimeIndexer (${source}) PID:`, child.pid);

			// let isReady = false

			child.stderr.on('data', (data) => {
				if (data.includes(`[INFO]`)) {
					// Skip logs that aren't root of command
					if (
						data.includes(`Writing last synced block`) ||
						data.includes(`Current block`)
					) {
						this.logger.debug(`TimeIndexer (${source}):`, data);
					} else if (data.includes(`Nothing to sync`)) {
						this.logger.info(`TimeIndexer (${source}):`, data);

						// Once there is nothing to sync, the TimeIndex is considered Ready
						this._ready = true;
					}
				} else {
					this.logger.error(`TimeIndexer (${source}):`, data);
					throw new Error('TimeIndexer Error');
				}
			});

			child.stdout.on('data', async (data) => {
				let block: number;
				let timestamp: number;
				try {
					if (data.includes(`"type": "block"`)) {
						const json = JSON.parse(data);
						block = json.number;
						timestamp = json.timestamp;
					}
				} catch (e) {
					// ...
				}
				if (block && timestamp) {
					await db.transaction(() => {
						const value = db.get(timestamp) || DEFAULT_DB_VALUE;
						if (value.b === 0 && value.s.length === 0) {
							return db.put(timestamp, { b: block, s: [source] });
						} else if (value.b !== block) {
							this.logger.error(
								`TimeIndexer (${source}): Sources returned different results`,
								{
									databaseValue: value,
									newValue: {
										source,
										block,
										timestamp,
									},
								}
							);
							throw new Error(`Sources returned different results`);
						} else {
							return db.put(timestamp, {
								b: block,
								s: [...value.s, source],
							});
						}
					});

					this.logger.debug(
						`TimeIndexer (${source}): Indexed ${
							db.get(timestamp).b
						} at time ${timestamp}`
					);
					const blocksIndexedSinceStart = block - fromBlock;
					if (
						blocksIndexedSinceStart % 100 === 0 &&
						blocksIndexedSinceStart > 0
					) {
						this.logger.info(
							`TimeIndexer (${source}): Indexed ${blocksIndexedSinceStart} blocks`
						);
					}

					this._latestTimestamp = timestamp;
				}
			});
		}
	}
}
