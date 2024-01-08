import type { Schema } from 'ajv';
import { Option } from 'effect';
import {
	type StreamID,
	type StreamMetadata,
	StreamrClient,
} from 'streamr-client';
import { delay, inject, Lifecycle, scoped } from 'tsyringe';

import { defaultAjv, getSchemaFromMetadata } from './getStreamSchema';
import type { SchemaParams } from './types';


@scoped(Lifecycle.ContainerScoped)
export class ValidationManager {
	constructor(
		@inject(delay(() => StreamrClient))
		private streamrClient: StreamrClient
	) {}

	public async setValidationSchema({
		schemaOrHash,
		protocol,
		streamId,
	}: {
		streamId: string;
	} & SchemaParams): Promise<void> {
		const stream = await this.streamrClient.getStream(streamId);
		const actualMetadata = stream.getMetadata();

		if (typeof schemaOrHash === 'object') {
			await defaultAjv.validateSchema(schemaOrHash, true);
		}

		await this.streamrClient.updateStream({
			...actualMetadata,
			// @ts-expect-error Metadata on streamr doesn't specify additional properties
			logstore: {
				// @ts-expect-error Metadata on streamr doesn't specify additional properties
				...actualMetadata.logstore,
				schema: {
					schemaOrHash,
					protocol,
				},
			},
			id: streamId,
		});
	}

	public async removeValidationSchema({
		streamId,
	}: {
		streamId: StreamID;
	}): Promise<void> {
		const actualMetadata = await this.streamrClient
			.getStream(streamId)
			.then((s) => s.getMetadata());

		// @ts-expect-error Metadata on streamr doesn't specify additional properties
		if (actualMetadata.logstore?.schema) {
			// @ts-expect-error Metadata on streamr doesn't specify additional properties
			delete actualMetadata.logstore.schema;
			await this.streamrClient.updateStream({
				...actualMetadata,
				id: streamId,
			});
		}
	}

	public async getValidationSchemaFromStreamMetadata(metadata: StreamMetadata) {
		const maybeSchemaPromise = getSchemaFromMetadata(metadata).pipe(
			Option.getOrNull
		);

		if (!maybeSchemaPromise) {
			return null;
		}

		return maybeSchemaPromise;
	}

	public async getValidationSchema({
		streamId,
	}: {
		streamId: StreamID;
	}): Promise<Schema | null> {
		const actualMetadata = await this.streamrClient
			.getStream(streamId)
			.then((s) => s.getMetadata());

		return this.getValidationSchemaFromStreamMetadata(actualMetadata);
	}
}
