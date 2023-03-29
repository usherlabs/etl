import chokidar from 'chokidar';
import { ClassicLevel } from 'classic-level';
import path from 'path';
import StreamrClient, { MessageMetadata } from 'streamr-client';

import type Validator from './validator';

type StreamrMessage = { content: any; metadata: MessageMetadata };

const SystemStreamId = '' as const;
// const QuerySystemStreamId = '' as const;

export default class Listener {
	private client: StreamrClient;
	private _db!: ClassicLevel<string, StreamrMessage>;
	// private _storeMap: Record<string, string[]>;

	constructor(private core: Validator) {
		this.client = new StreamrClient();
	}

	public async start(cacheHome: string): Promise<void> {
		// const systemSubscription =
		this.core.logger.info('Starting listeners ...');
		await this.client.subscribe(SystemStreamId, async (content, metadata) => {
			// Add to store
			const key = `${Date.now().toString()}:${metadata.publisherId}`;

			this.core.logger.debug('New message received over stream', {
				key,
				value: { content, metadata },
			});

			const db = await this.db();
			await db.put(key, { content, metadata });
		});

		// Kyve cache dir would have already setup this directory
		// On each new bundle, this cache will be deleted
		const cachePath = path.join(cacheHome, 'cache/system');
		this._db = new ClassicLevel<string, StreamrMessage>(cachePath, {
			valueEncoding: 'json',
		});

		// First key in the cache is a timestamp that is comparable to the bundle start key -- ie. Node must have a timestamp < bundle_start_key
		const db = await this.db();
		await db.clear();
		await db.put(Date.now().toString(), null);

		// Chokidar listening to reinitiate the cache after each flush/drop/wipe.
		chokidar.watch(cachePath).on('unlink', async (eventPath) => {
			if (eventPath == cachePath) {
				const db = await this.db();
				await db.put(Date.now().toString(), null);

				this.core.logger.info('System cache removed and reinitialised.');
			}
		});
	}

	public async db(): Promise<ClassicLevel<string, StreamrMessage>> {
		if (!this._db) {
			throw new Error('Database is not initialised');
		}
		if (this._db.status === 'closed') {
			await this._db.open();
		}
		return this._db;
	}

	// public getStoreMap(){
	// 	return this._storeMap;
	// }
}
