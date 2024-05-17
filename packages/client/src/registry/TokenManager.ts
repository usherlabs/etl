import { BigNumberish } from '@ethersproject/bignumber';
import type { Overrides } from '@ethersproject/contracts';
import { Provider } from '@ethersproject/providers';
import { LSAN as LogStoreTokenManagerContract } from '@logsn/contracts';
import { abi as LogStoreTokenManagerAbi } from '@logsn/contracts/artifacts/src/alpha/Token.sol/LSAN.json';
import { getMaticPrice } from '@logsn/shared';
import { Logger, toEthereumAddress } from '@streamr/utils';
import Decimal from 'decimal.js';
import { ContractTransaction } from 'ethers';
import { inject, Lifecycle, scoped } from 'tsyringe';

import {
	LogStoreClientConfigInjectionToken,
	StrictLogStoreClientConfig,
} from '../Config';
import {
	getStreamRegistryChainProviders,
	getEthersOverrides,
} from '../Ethereum';
import {
	Authentication,
	AuthenticationInjectionToken,
} from '../streamr/Authentication';
import {
	StreamrClientConfigInjectionToken,
	StrictStreamrClientConfig,
} from '../streamr/Config';
import {
	ContractFactory,
	ContractFactoryInjectionToken,
} from '../streamr/ContractFactory';
import {
	LoggerFactory,
	LoggerFactoryInjectionToken,
} from '../streamr/LoggerFactory';
import {
	ObservableContract,
	queryAllReadonlyContracts,
} from '../streamr/utils/contract';
import { AmountTypes } from '../types';

@scoped(Lifecycle.ContainerScoped)
export class TokenManager {
	private contractFactory: ContractFactory;
	private authentication: Authentication;
	private logStoreClientConfig: Pick<StrictLogStoreClientConfig, 'contracts'>;
	private streamrClientConfig: Pick<StrictStreamrClientConfig, 'contracts'>;
	private logStoreTokenManagerContract?: ObservableContract<LogStoreTokenManagerContract>;
	private readonly logstoreTokenManagerContractsReadonly: LogStoreTokenManagerContract[];
	private readonly logger: Logger;

	constructor(
		@inject(ContractFactoryInjectionToken)
		contractFactory: ContractFactory,
		@inject(LoggerFactoryInjectionToken)
		loggerFactory: LoggerFactory,
		@inject(AuthenticationInjectionToken)
		authentication: Authentication,
		@inject(LogStoreClientConfigInjectionToken)
		logStoreClientConfig: Pick<StrictLogStoreClientConfig, 'contracts'>,
		@inject(StreamrClientConfigInjectionToken)
		streamrClientConfig: Pick<StrictStreamrClientConfig, 'contracts'>
	) {
		this.contractFactory = contractFactory;
		this.logStoreClientConfig = logStoreClientConfig;
		this.streamrClientConfig = streamrClientConfig;
		this.logger = loggerFactory.createLogger(module);
		this.authentication = authentication;
		this.logstoreTokenManagerContractsReadonly =
			getStreamRegistryChainProviders(this.streamrClientConfig).map(
				(provider: Provider) => {
					const tokenManagerAddress = toEthereumAddress(
						this.logStoreClientConfig.contracts.logStoreTokenManagerChainAddress
					);
					this.logger.debug('tokenManagerAddress: ' + tokenManagerAddress);
					return this.contractFactory.createReadContract(
						tokenManagerAddress,
						LogStoreTokenManagerAbi,
						provider,
						'logStoreTokenManager'
					) as LogStoreTokenManagerContract;
				}
			);
	}

	private async connectToContract(): Promise<void> {
		if (!this.logStoreTokenManagerContract) {
			const chainSigner =
				await this.authentication.getStreamRegistryChainSigner();
			this.logStoreTokenManagerContract =
				this.contractFactory.createWriteContract<LogStoreTokenManagerContract>(
					toEthereumAddress(
						this.logStoreClientConfig.contracts.logStoreTokenManagerChainAddress
					),
					LogStoreTokenManagerAbi,
					chainSigner,
					'LSAN'
				);
		}
	}

	public async getBalance(): Promise<bigint> {
		return queryAllReadonlyContracts(async (contract) => {
			const accountAddress = await this.authentication.getAddress();
			this.logger.debug(`getBalance of current account: ${accountAddress}`);
			const balance = await contract
				.balanceOf(accountAddress)
				.then((b) => b.toBigInt());
			this.logger.debug(`got balance of ${accountAddress}: ${balance}`);
			return balance;
		}, this.logstoreTokenManagerContractsReadonly);
	}

	public async getPrice(): Promise<bigint> {
		return queryAllReadonlyContracts(async (contract) => {
			this.logger.debug('getPrice');
			const priceBN = await contract.price();
			return priceBN.toBigInt();
		}, this.logstoreTokenManagerContractsReadonly);
	}

	public async mint(
		amount: BigNumberish,
		overrides?: Overrides
	): Promise<ContractTransaction> {
		this.logger.debug('mint amount: ' + amount);
		await this.connectToContract();
		// gas price here should be omitted, its inclusion generates "eip-1559 transaction do not support gasPrice" error
		// on the main net
		const { gasPrice: _unusedGasPrice, ...mergedOverrides } = {
			...getEthersOverrides(this.streamrClientConfig),
			...overrides,
		};
		return this.logStoreTokenManagerContract!.mint({
			value: amount,
			...mergedOverrides,
		});
	}

	/**
	 * Helper to get correct amount of tokens in desired currency
	 */
	public async convert({
		to,
		amount,
		from,
	}: {
		amount: string;
		from: AmountTypes;
		to: AmountTypes;
	}): Promise<string> {
		this.logger.debug(`convert amount ${amount} from ${from} to ${to}`);

		const getWeiPerUsd = async () => {
			const usdPerMatic = await getMaticPrice(new Date().getTime());
			const usdPerWei = new Decimal(usdPerMatic).mul('1e-18');
			return usdPerWei.pow(-1);
		};

		const getWeiPerByte = async () => {
			const weiPerByte = await queryAllReadonlyContracts((contract) => {
				return contract.price();
			}, this.logstoreTokenManagerContractsReadonly);
			return new Decimal(weiPerByte.toString());
		};

		const getRatesToWei = {
			wei: () => new Decimal(1),
			usd: getWeiPerUsd,
			bytes: getWeiPerByte,
		};

		const outputDecimals = {
			wei: 0,
			usd: 18,
			bytes: 0,
		};

		const result = new Decimal(amount.toString())
			.mul(await getRatesToWei[from]())
			.div(await getRatesToWei[to]())
			.toDP(outputDecimals[to], Decimal.ROUND_DOWN);

		return result.toString();
	}
}
