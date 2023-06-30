import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { ethers } from 'hardhat';

import {
	CUSTOM_EXCEPTIONS,
	NODE_MANAGER,
	REPORT_MANAGER_EVENTS,
	REPORT_TIME_BUFFER,
	SAMPLE_STREAM_ID,
	SAMPLE_WSS_URL,
} from './utils/constants';
import {
	ApproveFundsForContract,
	fetchEventArgsFromTx,
	generateContractReportPayload,
	generateReportData,
	getDecimalBN,
	getERC20Token,
	getLatestBlockNumber,
	loadQueryManager,
	loadReportManager,
	loadStoreManager,
	setupNodeManager,
	sleep,
} from './utils/functions';

describe('ReportManager', async function () {
	let adminSigner: SignerWithAddress;
	let otherSigners: SignerWithAddress[];
	let activeNodes: SignerWithAddress[];
	let reportManagerContract: Contract;
	let nodeManagerContract: Contract;
	let token: Contract;
	let blockHeight: number;

	beforeEach(async () => {
		[adminSigner, ...otherSigners] = await ethers.getSigners();
		activeNodes = otherSigners.slice(0, 2);
		nodeManagerContract = await setupNodeManager(adminSigner, activeNodes);
		reportManagerContract = await loadReportManager(
			adminSigner,
			nodeManagerContract
		);
		token = await getERC20Token(adminSigner);
		const blockNumber = await getLatestBlockNumber();
		blockHeight = +blockNumber - 500;
	});

	it('ReportManager ---- Nodes are ordered by reputation', async function () {
		// get all reports
		const [reporters] = await reportManagerContract.functions.getReporters();

		// get all nodes
		const [nodes] = await nodeManagerContract.functions.nodeAddresses();

		// make sure they are uniquely of the same length
		const uniqueReports = [...new Set(reporters)];
		const uniqueNodes = [...new Set(nodes)];

		expect(uniqueReports.length).to.be.equal(uniqueNodes.length);
	});

	it('ReportManager ---- Staked Node can submit report', async function () {
		const sampleNode = activeNodes[0];
		const reportData = await generateReportData({
			bundleId: '75',
			blockheight: blockHeight,
			signer: sampleNode,
		});

		const payload = await generateContractReportPayload(
			activeNodes,
			reportData.systemReport
		);

		const activeAddresses = [
			// Dedupe the array of addresses
			...new Set([
				...NODE_MANAGER.INITIAL_NODES,
				...activeNodes.map((n) => n.address),
			]),
		];

		// console.log(
		// 	'payload',
		// 	payload[payload.length - 1],
		// 	payload[payload.length - 2],
		// 	payload[payload.length - 3]
		// );
		// console.log(
		// 	`Calling Address ${sampleNode.address}`,
		// 	'Payload Addresses:',
		// 	payload[payload.length - 3],
		// 	'Payload Timestamps:',
		// 	payload[payload.length - 2],
		// 	`Now: ${Date.now()}`
		// );
		// console.log(
		// 	'activeNodes',
		// 	activeNodes.map((n) => n.address)
		// );

		const [reporters] = await reportManagerContract.functions.getReporters();

		const totalNodes = await nodeManagerContract.functions.totalNodes();
		expect(
			Number(totalNodes),
			'Total nodes should equal activeNodes'
		).to.be.equal(activeAddresses.length);
		expect(
			payload[payload.length - 1].length,
			'expect signature length to be length of activeNodes'
		).to.be.equal(activeNodes.length);

		// ? Sleep for the report buffer time
		// Find node in reporters list
		const reporterIndex = reporters.findIndex(
			(addr: string) => addr === sampleNode.address
		);
		console.log('Reporters Overview:', {
			reporters,
			reporter: sampleNode.address,
			reporterIndex,
			sleepTime: reporterIndex * REPORT_TIME_BUFFER,
			buffer: REPORT_TIME_BUFFER,
		});
		await sleep(reporterIndex * REPORT_TIME_BUFFER + 5);

		const responseTx = await reportManagerContract
			.connect(sampleNode)
			.functions.report(...payload);

		const event = await fetchEventArgsFromTx(responseTx, 'ReportAccepted');
		expect(event?.id).to.be.equal(reportData.report.id);
	});

	it('ReportManager ---- Staked Node is an invalid reporter', async function () {
		const sampleNode = activeNodes[1];
		const reportData = await generateReportData({
			bundleId: '75',
			blockheight: blockHeight,
			signer: sampleNode,
		});

		const payload = await generateContractReportPayload(
			activeNodes,
			reportData.systemReport
		);

		const responseTx = await reportManagerContract
			.connect(sampleNode)
			.functions.report(...payload);

		await expect(responseTx).to.be.revertedWith(
			CUSTOM_EXCEPTIONS.INVALID_REPORTER
		);
	});

	it('ReportManager ---- un-staked Node cannot submit report', async function () {
		// use the 15th because node 0-10 have been staked and we need an unstaked node
		const sampleNode = otherSigners[15];

		const reportData = await generateReportData({
			bundleId: '75',
			blockheight: blockHeight,
			signer: sampleNode,
		});

		const payload = await generateContractReportPayload(
			activeNodes,
			reportData.systemReport
		);

		const responseTx = reportManagerContract
			.connect(sampleNode)
			.functions.report(...payload);

		await expect(responseTx).to.be.revertedWith(
			CUSTOM_EXCEPTIONS.STAKE_REQUIRED
		);
	});

	it('ReportManager ---- Staked Node can only submit report when quorum is met', async function () {
		const sampleNode = activeNodes[0];
		const reportData = await generateReportData({
			bundleId: '75',
			blockheight: blockHeight,
			signer: sampleNode,
		});

		// Produce a payload with a single signer
		const payload = await generateContractReportPayload(
			[sampleNode],
			reportData.systemReport
		);

		// add more nodes to the network, such that requiredNodes > 1 and joinedNodes > 3
		await Promise.all(
			otherSigners.map(async (signer) => {
				await nodeManagerContract.functions.whitelistApproveNode(
					signer.address
				);
				await ApproveFundsForContract(
					nodeManagerContract.address,
					getDecimalBN(10),
					signer
				);
				await nodeManagerContract
					.connect(signer)
					.functions.join(getDecimalBN(1), SAMPLE_WSS_URL);
			})
		);

		// send a report
		const responseTx = reportManagerContract
			.connect(sampleNode)
			.functions.report(...payload);

		await expect(responseTx).to.be.revertedWith(
			CUSTOM_EXCEPTIONS.QUORUM_NOT_MET
		);
	});

	it('NodeManager ---- Node manager can process submitted report', async function () {
		const currentNode = activeNodes[0];
		const consumerSigner = otherSigners[otherSigners.length - 2];
		const stakeAmount = getDecimalBN(70);
		// ------ submit a report
		const reportData = await generateReportData({
			bundleId: '75',
			blockheight: blockHeight,
			signer: currentNode,
		});
		// Produce a payload with a single signer
		const payload = await generateContractReportPayload(
			activeNodes,
			reportData.systemReport
		);

		// ---------------------------------------------- submit a report
		// ---- stake for the user in both query manager and store manager
		const queryManagerContract = await loadQueryManager(
			adminSigner,
			nodeManagerContract.address
		);
		await queryManagerContract
			.connect(consumerSigner)
			.functions.stake(stakeAmount);
		const storeManagerContract = await loadStoreManager(
			adminSigner,
			nodeManagerContract.address
		);
		await storeManagerContract
			.connect(consumerSigner)
			.functions.stake(SAMPLE_STREAM_ID, stakeAmount);
		// ---- stake for the user in both query manager and store manager
		// ---- set the right contracts for the nodemanager contract
		nodeManagerContract.registerStoreManager(storeManagerContract.address);
		nodeManagerContract.registerQueryManager(queryManagerContract.address);
		nodeManagerContract.registerReportManager(reportManagerContract.address);

		await reportManagerContract
			.connect(currentNode)
			.functions.report(...payload);
		//  ---- set the right contracts for the nodemanager contract
		const [preReportProcessBalance] = await token.functions.balanceOf(
			nodeManagerContract.address
		);
		// ---- process the actual report
		const processReportTx = await nodeManagerContract
			.connect(currentNode)
			.functions.processReport(reportData.report.id);
		// ---------------------------------------------- submit a report
		// ---------------------------------------------- verify the report
		const event = await fetchEventArgsFromTx(
			processReportTx,
			REPORT_MANAGER_EVENTS.REPORT_PROCESSED
		);
		expect(event?.id).to.equal(reportData.report.id);

		// validate store manager capture funds
		const consumerCapture = reportData.report.streams[0].capture;
		const consumerBalance = await storeManagerContract.functions.balanceOf(
			consumerSigner.address
		);
		const [consumerStreamBalance] =
			await storeManagerContract.functions.storeBalanceOf(
				consumerSigner.address,
				reportData.report.streams[0]
			);
		const [streamStoreBalance] = await storeManagerContract.functions.stores(
			reportData.report.streams[0]
		);

		const [storeManagertotalSupply] =
			await storeManagerContract.functions.totalSupply();
		expect(+consumerBalance)
			.to.equal(+stakeAmount.sub(consumerCapture))
			.to.equal(+consumerStreamBalance)
			.to.equal(+streamStoreBalance)
			.to.equal(+storeManagertotalSupply);
		// validate store manager capture funds

		// validate query manager capture function
		const totalReadCapture = reportData.report.consumers[0].capture;
		const [queryUserBalance] = await queryManagerContract.functions.balanceOf(
			consumerSigner.address
		);
		const [queryTotalSupply] =
			await queryManagerContract.functions.totalSupply();
		expect(+stakeAmount.sub(totalReadCapture))
			.to.equal(+queryUserBalance)
			.to.equal(+queryTotalSupply);
		// validate query manager capture function

		// validate nodes
		const nodeAddress = Object.keys(reportData.report.nodes); // Nodes first element
		const nodeAddressKey = nodeAddress[0].toLowerCase();
		const allNodes: Record<string, number> = reportData.report.nodes;
		const allDelegates: Record<string, Record<string, number>> = reportData
			.report.delegates;
		const nodeIncrement = allNodes[nodeAddressKey];
		const foundNode = await nodeManagerContract.functions.nodes(
			nodeAddress[0].toLowerCase()
		);
		const initialNodeStake = getDecimalBN(10);
		expect(+foundNode.stake).to.equal(+initialNodeStake.add(nodeIncrement));
		// validate nodes

		// validate delegates
		const [nodeDelegateBalance] =
			await nodeManagerContract.functions.delegatesOf(
				nodeAddressKey,
				nodeAddressKey
			);
		expect(+nodeDelegateBalance).to.equal(
			+initialNodeStake.add(allDelegates[nodeAddressKey][nodeAddressKey])
		);
		// validate delegates

		// validate total supply
		const treasurySupply = await nodeManagerContract.functions.treasurySupply();
		expect(+treasurySupply).to.equal(+reportData.report.treasury);
		// validate total supply

		// validate token balance has gone up by totalRead + totalWrite
		const totalIncrement = totalReadCapture + consumerCapture;
		const [postReportProcessBalance] = await token.functions.balanceOf(
			nodeManagerContract.address
		);

		expect(+postReportProcessBalance).to.equal(
			+preReportProcessBalance.add(totalIncrement)
		);
	});
});
