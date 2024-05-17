import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { config as CHAIN_CONFIG } from '@streamr/config';
import StreamrClient, { Stream, StreamMetadata } from '@streamr/sdk';
import { Logger } from '@streamr/utils';
import crypto from 'crypto';

import { LoggerFactory } from '../../src/streamr/LoggerFactory';
import { counterId } from '../../src/utils/utils';

export const TEST_CHAIN_CONFIG = CHAIN_CONFIG.dev2;

export function mockLoggerFactory(): LoggerFactory {
	return {
		createLogger(module: NodeJS.Module): Logger {
			return new Logger(module, { id: 'TestCtx' }, 'info')
		}

	} as unknown as LoggerFactory
}

export const uid = (prefix?: string): string =>
	counterId(`p${process.pid}${prefix ? '-' + prefix : ''}`);

const getTestName = (module: NodeModule): string => {
	const fileNamePattern = new RegExp('.*/(.*).test\\...');
	const groups = module.filename.match(fileNamePattern);
	return groups !== null ? groups[1] : module.filename;
};

const randomTestRunId =
	process.pid != null ? process.pid : crypto.randomBytes(4).toString('hex');

export const createRelativeTestStreamId = (
	module: NodeModule,
	suffix?: string
): string => {
	const randomBit = crypto.randomBytes(4).toString('hex');
	return counterId(
		`/test/${randomTestRunId}${randomBit}/${getTestName(module)}${suffix !== undefined ? '-' + suffix : ''
		}`,
		'-'
	);
};

export const createTestStream = async (
	streamrClient: StreamrClient,
	module: NodeModule,
	props?: Partial<StreamMetadata>
): Promise<Stream> => {
	const stream = await streamrClient.createStream({
		id: createRelativeTestStreamId(module),
		...props,
	});
	return stream;
};

export function getProvider(): Provider {
	return new JsonRpcProvider(TEST_CHAIN_CONFIG.rpcEndpoints[0].url);
}
