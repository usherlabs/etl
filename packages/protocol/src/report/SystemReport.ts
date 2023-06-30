import { Signer } from '@ethersproject/abstract-signer';
import { BigNumber } from '@ethersproject/bignumber';
import { arrayify } from '@ethersproject/bytes';
import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';

import { ReportSerializer } from '../abstracts/ReportSerializer';
import { ValidationError } from '../errors';
import {
	ReportContractParams,
	ReportSerializerVersions,
} from '../interfaces/report.common';
import { IReportV1, IReportV1Serialized } from '../interfaces/report.v1';
import { ProofOfReport } from '../system/ProofOfReport';

const serializerByVersion: Record<string, ReportSerializer> = {};

const LATEST_VERSION = ReportSerializerVersions.V1;

type IReport = IReportV1 | IReportV1Serialized;
export class SystemReport {
	constructor(protected report: IReport, protected version = LATEST_VERSION) {
		if (!('s' in report && 'v' in report)) {
			throw new ValidationError('Invalid Report Payload');
		}
		if (!ReportSerializerVersions[report.v]) {
			throw new ValidationError('Invalid Version');
		}
	}

	public get id() {
		return this.report.id;
	}

	public get height() {
		return this.report.height;
	}

	public isSerialized() {
		return this.report.s;
	}

	public getVersion() {
		return this.version;
	}

	serialize() {
		if (this.report.s === true) {
			return this.report;
		}
		const serializer = SystemReport.getSerializer(this.version);
		return serializer.serialize(this.report as IReportV1);
	}

	deserialize() {
		if (this.report.s === false) {
			return this.report;
		}
		const serializer = SystemReport.getSerializer(this.version);
		return serializer.deserialize(this.report as IReportV1Serialized);
	}

	toJSON() {
		const serializer = SystemReport.getSerializer(this.version);
		return serializer.toJSON(this.report);
	}

	toContract() {
		const serializer = SystemReport.getSerializer(this.version);
		return serializer.toContract(this.report);
	}

	// ? Produce a hash based on the time of the ProofOfReport
	async toProof(
		signer: Signer,
		// ? Create a Timestamp for Proof Of Report - Compatible with On-Chain Verification
		// Tried using Streamr Message Timestamp, but hash/signature mechanism is difficult to replicate on-chain
		timestamp = Date.now()
	): Promise<ProofOfReport> {
		const toth = this.toHash(timestamp);
		// ? sign the hash + timestamp
		// Signatures verified on-chain require proofTimestamp relative to the signature to be concatenated to Contract Params Hash
		const signature = await signer.signMessage(arrayify(toth));

		return new ProofOfReport({
			hash: this.toHash(),
			address: await signer.getAddress(),
			toth,
			signature,
			timestamp,
		});
	}

	toHash(timestamp?: number) {
		return SystemReport.toContractHash(this.toContract(), timestamp);
	}

	// ? Produce a deterministic hash based on the parameters provided to the on-chain env
	static toContractHash(
		params: ReportContractParams,
		timestamp?: number
	): string {
		const [
			,
			,
			,
			writeCaptureAmounts,
			,
			,
			readCaptureAmounts,
			,
			,
			nodeChanges,
			,
			,
			delegateNodeChanges,
			treasurySupplyChange,
		] = params;
		const hexTreasurySupplyChange =
			BigNumber.from(treasurySupplyChange).toHexString();
		const hexWriteCaptureAmounts = writeCaptureAmounts.map((v) =>
			BigNumber.from(v).toHexString()
		);
		const hexReadCaptureAmounts = readCaptureAmounts.map((v) =>
			BigNumber.from(v).toHexString()
		);
		const hexNodeChanges = nodeChanges.map((v) =>
			BigNumber.from(v).toHexString()
		);
		const hexDelegateNodeChanges = delegateNodeChanges.map((delArr) =>
			delArr.map((v) => BigNumber.from(v).toHexString())
		);

		const clonedParams = [...params];
		clonedParams[3] = hexWriteCaptureAmounts;
		clonedParams[6] = hexReadCaptureAmounts;
		clonedParams[9] = hexNodeChanges;
		clonedParams[12] = hexDelegateNodeChanges;
		clonedParams[13] = hexTreasurySupplyChange;

		if (!timestamp) {
			return solidityKeccak256(
				['string'],
				[JSON.stringify(clonedParams).toLowerCase()]
			);
		}

		return solidityKeccak256(
			['string', 'string'],
			[JSON.stringify(clonedParams).toLowerCase(), `${timestamp}`]
		);
	}

	static registerSerializer(
		version: ReportSerializerVersions,
		serializer: ReportSerializer
	): void {
		if (serializerByVersion[version] !== undefined) {
			throw new Error(
				`ReportSerializer for version ${version} is already registered: ${JSON.stringify(
					serializerByVersion[version]
				)}`
			);
		}
		serializerByVersion[version] = serializer;
	}

	public static getSerializer(version: ReportSerializerVersions) {
		if (typeof serializerByVersion[version] === 'undefined') {
			throw new ValidationError('Invalid ReportSerializerVersion');
		}
		const serializer = serializerByVersion[version];
		return serializer;
	}

	static unregisterSerializer(version: ReportSerializerVersions): void {
		delete serializerByVersion[version];
	}

	static getVersionByNumber(versionNumber: number): ReportSerializerVersions {
		const res =
			ReportSerializerVersions[ReportSerializerVersions[versionNumber]];

		return res;
	}

	static getSupportedVersions(): number[] {
		const res = Object.values(ReportSerializerVersions)
			.filter((v) => typeof v === 'number')
			.map((v) => v as number);

		return res;
	}
}
