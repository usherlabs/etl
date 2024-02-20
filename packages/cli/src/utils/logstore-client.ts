import { getRootOptions } from '@/commands/options';
import { USE_TEST_CONFIG } from '@/env-config';
import { logger } from '@/utils/utils';
import {
	CONFIG_TEST as LOGSTORE_CONFIG_TEST,
	LogStoreClient,
} from '@logsn/client';
import { ethers } from 'ethers';
import {
	CONFIG_TEST as STREAMR_CONFIG_TEST,
	StreamrClient,
	StreamrClientConfig,
} from 'streamr-client';

function getCredentialsFrom(host: string, wallet: string) {
	const provider = new ethers.providers.JsonRpcProvider(host);
	const signer = new ethers.Wallet(wallet, provider);
	return { provider, signer };
}

export function getCredentialsFromOptions() {
	const { wallet, host } = getRootOptions() as { wallet: string; host: string };
	return getCredentialsFrom(host, wallet);
}

export function getClientsForCredentials({
	host,
	wallet,
}: {
	host: string;
	wallet: string;
}) {
	const { logLevel: _unused, ...streamrConfig } = USE_TEST_CONFIG
		? STREAMR_CONFIG_TEST
		: ({} as never);
	const logStoreConfig = USE_TEST_CONFIG ? LOGSTORE_CONFIG_TEST : {};

	const logLevel = logger.settings.minLevel === 3 ? 'warn' : 'debug';
	if (!('LOG_LEVEL' in process.env)) {
		// eslint-disable-next-line immutable/no-mutation
		process.env.LOG_LEVEL = logLevel;
	}
	let config = {
		...streamrConfig,
		logLevel: logLevel,
		auth: { privateKey: wallet },
	} as StreamrClientConfig;
	if (USE_TEST_CONFIG || host) {
		config = {
			...config,
			contracts: {
				...streamrConfig?.contracts,
				streamRegistryChainRPCs: {
					rpcs: [
						{
							url: host,
						},
					],
					chainId: USE_TEST_CONFIG ? 8997 : 137,
					name: USE_TEST_CONFIG ? 'streamr' : 'polygon',
				},
			},
		};
	}
	const streamrClient = new StreamrClient(config);

	let logStoreClient: LogStoreClient | undefined;

	return {
		// We define this as a getter, so if anyone instantiate this helper and do not use it, it won't execute logStoreClient
		// startup process.
		// It's not meant to be like this, but a workaround for backward compatibility of this code.
		get logStoreClient() {
			if (logStoreClient) {
				return logStoreClient;
			}

			logStoreClient = new LogStoreClient(streamrClient, {
				logLevel,
				...logStoreConfig,
			});

			return logStoreClient;
		},
		streamrClient,
	};
}

export const getClientsFromOptions = () => {
	const { wallet, host } = getRootOptions() as { wallet: string; host: string };
	return getClientsForCredentials({ host, wallet });
};
