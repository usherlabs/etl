import { Logger, toEthereumAddress } from '@streamr/utils';
import { randomFillSync } from 'crypto';
import toArray from 'stream-to-array';

import {
	LogStore,
	startCassandraLogStore,
} from '../../../../src/plugins/logStore/LogStore';
import { getTestName, STREAMR_DOCKER_DEV_HOST } from '../../../utils';
import { buildMsg } from './LogStore.test';

const contactPoints = [STREAMR_DOCKER_DEV_HOST];
const localDataCenter = 'datacenter1';
const keyspace = 'logstore_dev';
const MAX_BUCKET_MESSAGE_COUNT = 20;

const NUM_MESSAGES = 1000;
const MESSAGE_SIZE = 1e3; // 1k

const logger = new Logger(module);

function retryFlakyTest(
	fn: () => Promise<unknown>,
	isFlakyError: (e: Error) => boolean,
	maxRuns: number
): () => Promise<void> {
	return async () => {
		for (let i = 1; i <= maxRuns; ++i) {
			try {
				await fn();
				return;
			} catch (e) {
				if (isFlakyError(e)) {
					logger.warn('Flaky test run detected %d/%d run', i, maxRuns);
					if (i === maxRuns) {
						throw e;
					}
				} else {
					throw e;
				}
			}
		}
	};
}

describe('LogStore: lots of data', () => {
	let logStore: LogStore;
	let streamId: string;

	beforeAll(async () => {
		logStore = await startCassandraLogStore({
			contactPoints,
			localDataCenter,
			keyspace,
			opts: {
				maxBucketRecords: MAX_BUCKET_MESSAGE_COUNT,
				checkFullBucketsTimeout: 100,
				storeBucketsTimeout: 100,
				bucketKeepAliveSeconds: 1,
			},
		});
		streamId = getTestName(module) + Date.now();
	});

	afterAll(async () => {
		await logStore.close();
	});

	beforeAll(async () => {
		const storePromises = [];
		const randomBuffer = Buffer.alloc(MESSAGE_SIZE);
		for (let i = 0; i < NUM_MESSAGES; i++) {
			randomFillSync(randomBuffer);
			const msg = buildMsg({
				streamId: streamId,
				streamPartition: 0,
				timestamp: 1000000 + (i + 1),
				sequenceNumber: 0,
				publisherId: toEthereumAddress(
					'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				),
				content: randomBuffer.toString('hex'),
			});
			storePromises.push(() => logStore.store(msg));
		}
		const half = Math.floor(storePromises.length / 2);
		await Promise.all(storePromises.slice(0, half).map((fn) => fn()));
		await Promise.all(storePromises.slice(half).map((fn) => fn()));
	}, 60000);

	it(`can store ${NUM_MESSAGES} ${MESSAGE_SIZE} byte messages and requestLast 1`, async () => {
		const streamingResults = logStore.requestLast(streamId, 0, 1);
		const results = await toArray(streamingResults);
		expect(results.length).toEqual(1);
	});

	it('can requestLast all', async () => {
		const streamingResults = logStore.requestLast(streamId, 0, NUM_MESSAGES);
		const results = await toArray(streamingResults);
		expect(results.length).toEqual(NUM_MESSAGES);
	});

	it('can requestLast all again', async () => {
		const streamingResults = logStore.requestLast(streamId, 0, NUM_MESSAGES);
		const results = await toArray(streamingResults);
		expect(results.length).toEqual(NUM_MESSAGES);
	});

	// TODO: Determine actual reason for flaky behavior in NET-918, something to do with cassandra-driver?
	it(
		'can requestFrom',
		retryFlakyTest(
			async () => {
				const streamingResults = logStore.requestFrom(
					streamId,
					0,
					1000,
					0,
					undefined
				);
				const results = await toArray(streamingResults);
				expect(results.length).toEqual(NUM_MESSAGES);
			},
			(e) => e.message?.includes('The value of "offset" is out of range'),
			5
		)
	);

	// TODO: Determine actual reason for flaky behavior in NET-918, something to do with cassandra-driver?
	it(
		'can requestFrom again',
		retryFlakyTest(
			async () => {
				const streamingResults = logStore.requestFrom(
					streamId,
					0,
					1000,
					0,
					undefined
				);
				const results = await toArray(streamingResults);
				expect(results.length).toEqual(NUM_MESSAGES);
			},
			(e) => e.message?.includes('The value of "offset" is out of range'),
			5
		)
	);
});
