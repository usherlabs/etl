import {
	LogStoreClient,
	NetworkNodeStub,
	PrivateKeyAuthConfig,
	validateConfig as validateClientConfig,
} from '@logsn/client';
import { getNodeManagerContract } from '@logsn/shared';
import { toStreamID } from '@streamr/protocol';
import { Logger, toEthereumAddress } from '@streamr/utils';
import { ethers } from 'ethers';
import { Server as HttpServer } from 'http';
import { Server as HttpsServer } from 'https';

import { version as CURRENT_VERSION } from '../package.json';
import { Config } from './config/config';
import BROKER_CONFIG_SCHEMA from './config/config.schema.json';
import { validateConfig } from './config/validateConfig';
import { generateMnemonicFromAddress } from './helpers/generateMnemonicFromAddress';
import { startServer as startHttpServer, stopServer } from './httpServer';
import { HttpServerEndpoint, Plugin, PluginOptions } from './Plugin';
import { createPlugin } from './pluginRegistry';
import { ctx } from './telemetry/context';

const logger = new Logger(module);

export interface Broker {
	getNode: () => Promise<NetworkNodeStub>;
	start: () => Promise<unknown>;
	stop: () => Promise<unknown>;
}

export const createBroker = async (
	configWithoutDefaults: Config
): Promise<Broker> => {
	const config = validateConfig(configWithoutDefaults, BROKER_CONFIG_SCHEMA);
	validateClientConfig(config.client);

	// Tweaks suggested by the Streamr Team
	config.client.network!.webrtcSendBufferMaxMessageCount = 5000;
	config.client.gapFill = true;
	config.client.gapFillTimeout = 30 * 1000;

	const logStoreClient = new LogStoreClient(config.client);

	const nodeManagerAddress = toEthereumAddress(
		config.client.contracts!.logStoreNodeManagerChainAddress!
	);

	const isDevNetwork =
		nodeManagerAddress ===
		toEthereumAddress('0x85ac4C8E780eae81Dd538053D596E382495f7Db9');

	const recoveryStreamId = isDevNetwork
		? toStreamID('/recovery', nodeManagerAddress)
		: '0xa156eda7dcd689ac725ce9595d4505bf28256454/alpha-recovery';

	const rollcallStreamId = isDevNetwork
		? toStreamID('/rollcall', nodeManagerAddress)
		: '0xa156eda7dcd689ac725ce9595d4505bf28256454/alpha-rollcall';

	const systemStreamId = isDevNetwork
		? toStreamID('/system', nodeManagerAddress)
		: '0xa156eda7dcd689ac725ce9595d4505bf28256454/alpha-system';

	const recoveryStream = await logStoreClient.getStream(recoveryStreamId);
	const rollCallStream = await logStoreClient.getStream(rollcallStreamId);
	const systemStream = await logStoreClient.getStream(systemStreamId);

	const privateKey = (config.client!.auth as PrivateKeyAuthConfig).privateKey;

	const provider = new ethers.providers.JsonRpcProvider(
		config.client!.contracts?.streamRegistryChainRPCs!.rpcs[0]
	);
	const signer = new ethers.Wallet(privateKey, provider);

	const nodeManger = await getNodeManagerContract(signer);

	const plugins: Plugin<any>[] = Object.keys(config.plugins).map((name) => {
		const pluginOptions: PluginOptions = {
			name,
			logStoreClient,
			recoveryStream,
			rollCallStream,
			systemStream,
			brokerConfig: config,
			signer,
			nodeManger,
		};
		return createPlugin(name, pluginOptions);
	});

	let started = false;
	let httpServer: HttpServer | HttpsServer | undefined;

	const getNode = async (): Promise<NetworkNodeStub> => {
		if (!started) {
			throw new Error('cannot invoke on non-started broker');
		}
		return logStoreClient.getNode();
	};

	return {
		getNode,
		start: async () => {
			const nodeId = (await logStoreClient.getNode()).getNodeId();
			ctx.nodeInfo.enterWith({ id: nodeId });

			logger.info(`Starting LogStore broker version ${CURRENT_VERSION}`);
			await Promise.all(plugins.map((plugin) => plugin.start()));
			const httpServerEndpoints = plugins.flatMap((plugin: Plugin<any>) => {
				return plugin
					.getHttpServerEndpoints()
					.map((endpoint: HttpServerEndpoint) => {
						return {
							...endpoint,
						};
					});
			});
			if (httpServerEndpoints.length > 0) {
				httpServer = await startHttpServer(
					httpServerEndpoints,
					config.httpServer
				);
			}

			const brokerAddress = await logStoreClient.getAddress();
			const mnemonic = generateMnemonicFromAddress(
				toEthereumAddress(brokerAddress)
			);

			logger.info(
				`Welcome to the LogStore Network. Your node's generated name is ${mnemonic}.`
			);
			// TODO: Network Explorer link
			logger.info(
				`View your node in the Network Explorer: https://streamr.network/network-explorer/nodes/${encodeURIComponent(
					nodeId
				)}`
			);
			logger.info(`Network node ${nodeId} running`);
			logger.info(`Ethereum address ${brokerAddress}`);
			logger.info(
				`Tracker Configuration: ${
					config.client.network?.trackers
						? JSON.stringify(config.client.network?.trackers)
						: 'default'
				}`
			);

			logger.info(`Plugins: ${JSON.stringify(plugins.map((p) => p.name))}`);

			if (
				config.client.network?.webrtcDisallowPrivateAddresses === undefined ||
				config.client.network.webrtcDisallowPrivateAddresses
			) {
				logger.warn(
					'WebRTC private address probing is disabled. ' +
						'This makes it impossible to create network layer connections directly via local routers ' +
						'More info: https://github.com/streamr-dev/network-monorepo/wiki/WebRTC-private-addresses'
				);
			}
			started = true;
		},
		stop: async () => {
			if (httpServer !== undefined) {
				await stopServer(httpServer);
			}
			await Promise.all(plugins.map((plugin) => plugin.stop()));
			await logStoreClient.destroy();
		},
	};
};

process.on('uncaughtException', (err) => {
	logger.getFinalLogger().error(err, 'uncaughtException');
	process.exit(1);
});

process.on('unhandledRejection', (err) => {
	logger.getFinalLogger().error(err, 'unhandledRejection');
	process.exit(1);
});
