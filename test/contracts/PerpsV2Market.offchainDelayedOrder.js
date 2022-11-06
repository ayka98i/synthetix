const { artifacts, contract, web3, ethers } = require('hardhat');
const { toBytes32 } = require('../..');
const { toUnit, multiplyDecimal, currentTime, fastForward } = require('../utils')();
const { toBN } = web3.utils;

const PerpsV2Market = artifacts.require('TestablePerpsV2Market');

const { setupAllContracts, setupContract } = require('./setup');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { getDecodedLogs, decodedEventEqual, updateAggregatorRates } = require('./helpers');

contract('PerpsV2Market PerpsV2MarketOffchainOrders', accounts => {
	let perpsV2MarketSettings,
		perpsV2Market,
		perpsV2DelayedOrder,
		perpsV2MarketState,
		perpsV2ExchangeRate,
		mockPyth,
		exchangeRates,
		circuitBreaker,
		sUSD,
		systemSettings,
		systemStatus,
		feePool;

	const owner = accounts[1];
	const trader = accounts[2];
	const trader2 = accounts[3];
	const trader3 = accounts[4];
	const traderInitialBalance = toUnit(1000000);
	const defaultDesiredTimeDelta = 60;

	const marketKeySuffix = '-perp';

	const marketKey = toBytes32('sBTC' + marketKeySuffix);
	const baseAsset = toBytes32('sBTC');
	const takerFeeOffchainDelayedOrder = toUnit('0.00005');
	const makerFeeOffchainDelayedOrder = toUnit('0.00001');
	const initialPrice = toUnit('100');

	const offchainDelayedOrderMinAge = 15;
	const offchainDelayedOrderMaxAge = 60;

	const feeds = [
		{ assetId: baseAsset, feedId: toBytes32('feed-sBTC') },
		{ assetId: toBytes32('sETH'), feedId: toBytes32('feed-sETH') },
	];

	const defaultFeedId = feeds[0].feedId;
	const defaultFeedExpo = -6;
	const defaultFeedPrice = 1000;
	const defaultFeedConfidence = 1;
	const defaultFeedEMAPrice = 2100;
	const defaultFeedEMAConfidence = 1;

	async function setOnchainPrice(asset, price, resetCircuitBreaker = true) {
		await updateAggregatorRates(
			exchangeRates,
			resetCircuitBreaker ? circuitBreaker : null,
			[asset],
			[price]
		);
	}

	async function setOffchainPrice(user, priceData = {}) {
		const updateFeedData = await getFeedUpdateData(priceData);
		await perpsV2ExchangeRate.updatePythPrice(user, [updateFeedData], { from: user });
	}

	async function getFeedUpdateData({
		id = defaultFeedId,
		expo = defaultFeedExpo,
		price = feedBaseFromUNIT(defaultFeedPrice),
		conf = feedBaseFromUNIT(defaultFeedConfidence),
		emaPrice = feedBaseFromUNIT(defaultFeedEMAPrice),
		emaConf = feedBaseFromUNIT(defaultFeedEMAConfidence),
		publishTime,
	}) {
		const feedUpdateData = await mockPyth.createPriceFeedUpdateData(
			id,
			price,
			conf,
			expo,
			emaPrice,
			emaConf,
			publishTime || (await currentTime())
		);

		return feedUpdateData;
	}

	// function decimalToFeedBaseUNIT(price, feedExpo = defaultFeedExpo) {
	// 	// feedExpo should be negative
	// 	return toBN(price * 10 ** -feedExpo).mul(toBN(10 ** (18 + feedExpo)));
	// }

	function feedBaseFromUNIT(price, feedExpo = defaultFeedExpo) {
		return toBN(price).div(toBN(10 ** (18 + feedExpo)));
	}

	// function decimalFromFeedBaseWei(price, feedExpo = defaultFeedExpo) {
	// 	// feedExpo should be negative
	// 	return toBN(price).div(toBN(10 ** (18 + feedExpo))) / 10 ** -feedExpo;
	// }

	before(async () => {
		({
			PerpsV2MarketSettings: perpsV2MarketSettings,
			ProxyPerpsV2MarketBTC: perpsV2Market,
			PerpsV2DelayedOrderBTC: perpsV2DelayedOrder,
			PerpsV2MarketStateBTC: perpsV2MarketState,
			PerpsV2ExchangeRate: perpsV2ExchangeRate,
			ExchangeRates: exchangeRates,
			CircuitBreaker: circuitBreaker,
			SynthsUSD: sUSD,
			FeePool: feePool,
			SystemSettings: systemSettings,
			SystemStatus: systemStatus,
		} = await setupAllContracts({
			accounts,
			synths: ['sUSD', 'sBTC', 'sETH'],
			contracts: [
				'PerpsV2MarketManager',
				'PerpsV2MarketSettings',
				{ contract: 'PerpsV2MarketStateBTC', properties: { perpSuffix: marketKeySuffix } },
				'PerpsV2MarketBTC',
				'PerpsV2ExchangeRate',
				'AddressResolver',
				'FeePool',
				'ExchangeRates',
				'CircuitBreaker',
				'SystemStatus',
				'SystemSettings',
				'Synthetix',
				'CollateralManager',
				'DebtCache',
			],
		}));

		// Update the rate so that it is not invalid
		await setOnchainPrice(baseAsset, initialPrice);

		// disable dynamic fee for most tests
		// it will be enabled for specific tests
		await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

		// Issue the trader some sUSD
		for (const t of [trader, trader2, trader3]) {
			await sUSD.issue(t, traderInitialBalance);
		}

		// use implementation ABI on the proxy address to simplify calling
		perpsV2Market = await PerpsV2Market.at(perpsV2Market.address);

		// Setup mock pyth and perpsV2ExchangeRage
		mockPyth = await setupContract({
			accounts,
			contract: 'MockPyth',
			args: [60, 0],
		});

		await perpsV2ExchangeRate.setOffchainOracle(mockPyth.address, { from: owner });

		for (const feed of feeds) {
			await perpsV2ExchangeRate.setOffchainPriceFeedId(feed.assetId, feed.feedId, {
				from: owner,
			});

			// set initial prices to have some valid data in Pyth
			await setOffchainPrice(owner, { id: feed.feedId });
		}
	});

	addSnapshotBeforeRestoreAfterEach();

	let margin, size, price, offChainPrice, confidence, latestPublishTime;

	beforeEach(async () => {
		// prepare basic order parameters
		margin = toUnit('2000');
		await perpsV2Market.transferMargin(margin, { from: trader });
		size = toUnit('50');
		price = toUnit('200');
		offChainPrice = toUnit('190');
		confidence = toUnit('1');
		latestPublishTime = await currentTime();

		await setOnchainPrice(baseAsset, price);

		await setOffchainPrice(trader, {
			id: defaultFeedId,
			price: feedBaseFromUNIT(offChainPrice),
			conf: feedBaseFromUNIT(confidence),
			publishTime: latestPublishTime,
		});
	});

	describe('submitOffchainDelayedOrder()', () => {
		it('submitting an order results in correct views and events', async () => {
			// setup
			const roundId = await exchangeRates.getCurrentRoundId(baseAsset);
			const spotFee = (await perpsV2Market.orderFee(size))[0];
			const keeperFee = await perpsV2MarketSettings.minKeeperFee();
			const tx = await perpsV2Market.submitOffchainDelayedOrder(size, {
				from: trader,
			});
			const txBlock = await ethers.provider.getBlock(tx.receipt.blockNumber);
			const expectedExecutableAt = txBlock.timestamp + defaultDesiredTimeDelta;

			const order = await perpsV2MarketState.delayedOrders(trader);
			assert.bnEqual(order.sizeDelta, size);
			assert.bnEqual(order.targetRoundId, roundId.add(toBN(1)));
			assert.bnEqual(order.commitDeposit, spotFee);
			assert.bnEqual(order.keeperDeposit, keeperFee);
			assert.bnEqual(order.executableAtTime, expectedExecutableAt);

			// check margin
			const position = await perpsV2Market.positions(trader);
			const expectedMargin = margin.sub(spotFee.add(keeperFee));
			assert.bnEqual(position.margin, expectedMargin);

			// The relevant events are properly emitted
			const decodedLogs = await getDecodedLogs({
				hash: tx.tx,
				contracts: [perpsV2Market, perpsV2DelayedOrder],
			});
			assert.equal(decodedLogs.length, 3);
			// PositionModified
			decodedEventEqual({
				event: 'PositionModified',
				emittedFrom: perpsV2Market.address,
				args: [toBN('1'), trader, expectedMargin, 0, 0, price, toBN(2), 0],
				log: decodedLogs[1],
			});
			// DelayedOrderSubmitted
			decodedEventEqual({
				event: 'DelayedOrderSubmitted',
				emittedFrom: perpsV2Market.address,
				args: [trader, true, size, roundId.add(toBN(1)), expectedExecutableAt, spotFee, keeperFee],
				log: decodedLogs[2],
			});
		});

		describe('cannot submit an order when', () => {
			it('zero size', async () => {
				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(0, { from: trader }),
					'Cannot submit empty order'
				);
			});

			it('not enough margin', async () => {
				await perpsV2Market.withdrawAllMargin({ from: trader });
				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(size, { from: trader }),
					'Insufficient margin'
				);
			});

			it('too much leverage', async () => {
				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(size.mul(toBN(10)), {
						from: trader,
					}),
					'Max leverage exceeded'
				);
			});

			it('previous delayed order exists', async () => {
				await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });
				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(size, { from: trader }),
					'previous order exists'
				);
			});

			it('if futures markets are suspended', async () => {
				await systemStatus.suspendFutures(toUnit(0), { from: owner });
				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(size, { from: trader }),
					'Futures markets are suspended'
				);
			});

			it('if market is suspended', async () => {
				await systemStatus.suspendFuturesMarket(marketKey, toUnit(0), { from: owner });
				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(size, { from: trader }),
					'Market suspended'
				);
			});
		});
	});

	describe('submitOffchainDelayedOrderWithTracking()', () => {
		const trackingCode = toBytes32('code');

		it('submitting an order results in correct views and events', async () => {
			// setup
			const roundId = await exchangeRates.getCurrentRoundId(baseAsset);
			const spotFee = (await perpsV2Market.orderFee(size))[0];
			const keeperFee = await perpsV2MarketSettings.minKeeperFee();

			const tx = await perpsV2Market.submitOffchainDelayedOrderWithTracking(
				size,

				trackingCode,
				{
					from: trader,
				}
			);
			const txBlock = await ethers.provider.getBlock(tx.receipt.blockNumber);

			// check order
			const order = await perpsV2MarketState.delayedOrders(trader);
			assert.bnEqual(order.sizeDelta, size);
			assert.bnEqual(order.targetRoundId, roundId.add(toBN(1)));
			assert.bnEqual(order.commitDeposit, spotFee);
			assert.bnEqual(order.keeperDeposit, keeperFee);
			assert.bnEqual(order.executableAtTime, txBlock.timestamp + defaultDesiredTimeDelta);
			assert.bnEqual(order.trackingCode, trackingCode);

			const decodedLogs = await getDecodedLogs({
				hash: tx.tx,
				contracts: [sUSD, perpsV2Market, perpsV2DelayedOrder],
			});

			// OffchainDelayedOrderSubmitted
			decodedEventEqual({
				event: 'DelayedOrderSubmitted',
				emittedFrom: perpsV2Market.address,
				args: [
					trader,
					true,
					size,
					roundId.add(toBN(1)),
					txBlock.timestamp + 60,
					spotFee,
					keeperFee,
					trackingCode,
				],
				log: decodedLogs[2],
			});
		});

		it('executing an order emits the tracking event', async () => {
			await perpsV2MarketSettings.setOffchainDelayedOrderMinAge(marketKey, 0, { from: owner });

			// setup
			await perpsV2Market.submitOffchainDelayedOrderWithTracking(
				size,

				trackingCode,
				{
					from: trader,
				}
			);

			// go to next round
			await setOnchainPrice(baseAsset, price);

			latestPublishTime = await currentTime();

			const updateFeedData = await getFeedUpdateData({
				id: defaultFeedId,
				price: feedBaseFromUNIT(offChainPrice),
				conf: feedBaseFromUNIT(confidence),
				publishTime: latestPublishTime,
			});

			const expectedFee = multiplyDecimal(
				size,
				multiplyDecimal(offChainPrice, takerFeeOffchainDelayedOrder)
			);

			// execute the order
			const tx = await perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
				from: trader,
			});

			const decodedLogs = await getDecodedLogs({
				hash: tx.tx,
				contracts: [sUSD, perpsV2Market, perpsV2DelayedOrder],
			});

			decodedEventEqual({
				event: 'FuturesTracking',
				emittedFrom: perpsV2Market.address,
				args: [trackingCode, baseAsset, marketKey, size, expectedFee],
				log: decodedLogs[6],
			});
		});
	});

	describe('cancelOffchainDelayedOrder()', () => {
		it('cannot cancel when there is no order', async () => {
			// account owner
			await assert.revert(
				perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader }),
				'no previous order'
			);
			// keeper
			await assert.revert(
				perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader2 }),
				'no previous order'
			);
		});

		describe('when an order exists', () => {
			let roundId, spotFee, keeperFee;

			// helper function to check cancellation tx effects
			async function checkCancellation(from) {
				const currentMargin = toBN((await perpsV2Market.positions(trader)).margin);
				// cancel the order
				const tx = await perpsV2Market.cancelOffchainDelayedOrder(trader, { from: from });

				// check order is removed
				const order = await perpsV2MarketState.delayedOrders(trader);
				assert.bnEqual(order.sizeDelta, 0);
				assert.bnEqual(order.targetRoundId, 0);
				assert.bnEqual(order.commitDeposit, 0);
				assert.bnEqual(order.keeperDeposit, 0);

				// The relevant events are properly emitted
				const decodedLogs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [sUSD, perpsV2Market, perpsV2DelayedOrder],
				});

				if (from === trader) {
					// trader gets refunded
					assert.equal(decodedLogs.length, 4);
					// keeper fee was refunded
					// PositionModified
					decodedEventEqual({
						event: 'PositionModified',
						emittedFrom: perpsV2Market.address,
						args: [toBN('1'), trader, currentMargin.add(keeperFee), 0, 0, price, toBN(2), 0],
						log: decodedLogs[1],
					});
				} else {
					// keeper gets paid
					assert.equal(decodedLogs.length, 3);
					decodedEventEqual({
						event: 'Issued',
						emittedFrom: sUSD.address,
						args: [from, keeperFee],
						log: decodedLogs[0],
					});
				}

				// commitFee (equal to spotFee) paid to fee pool
				decodedEventEqual({
					event: 'Issued',
					emittedFrom: sUSD.address,
					args: [await feePool.FEE_ADDRESS(), spotFee],
					log: decodedLogs.slice(-2, -1)[0], // [-2]
				});
				// DelayedOrderRemoved
				decodedEventEqual({
					event: 'DelayedOrderRemoved',
					emittedFrom: perpsV2Market.address,
					args: [trader, roundId, size, roundId.add(toBN(1)), spotFee, keeperFee],
					log: decodedLogs.slice(-1)[0],
				});

				// transfer more margin
				await perpsV2Market.transferMargin(margin, { from: trader });
				// and can submit new order
				await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });
				const newOrder = await perpsV2MarketState.delayedOrders(trader);
				assert.bnEqual(newOrder.sizeDelta, size);
			}

			beforeEach(async () => {
				roundId = await exchangeRates.getCurrentRoundId(baseAsset);
				spotFee = (await perpsV2Market.orderFee(size))[0];
				keeperFee = await perpsV2MarketSettings.minKeeperFee();
				await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });
			});

			it('cannot cancel before time', async () => {
				await assert.revert(
					perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader }),
					'cannot cancel yet'
				);
			});

			it('cannot cancel if futures markets are suspended', async () => {
				await fastForward(offchainDelayedOrderMaxAge * 2);
				await systemStatus.suspendFutures(toUnit(0), { from: owner });
				await assert.revert(
					perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader }),
					'Futures markets are suspended'
				);
			});

			it('cannot cancel if market is suspended', async () => {
				await fastForward(offchainDelayedOrderMaxAge * 2);
				await systemStatus.suspendFuturesMarket(marketKey, toUnit(0), { from: owner });
				await assert.revert(
					perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader }),
					'Market suspended'
				);
			});

			describe('account owner moving in time', () => {
				it('cannot cancel before time based 2 maxAge', async () => {
					// set a known and deterministic confirmation window.
					let ffDelta = 0;
					const maxAge = 60;
					const executionExpiredDelay = maxAge + 1;
					const cancellableDelay = 2 * maxAge + 1;
					await perpsV2MarketSettings.setOffchainDelayedOrderMaxAge(marketKey, maxAge, {
						from: owner,
					});

					// no time has changed.
					await assert.revert(
						perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader }),
						'cannot cancel yet'
					);

					// time has moved forward, order cannot be executed (due to maxAge) but is not cancellable yet
					ffDelta = executionExpiredDelay - ffDelta;
					await fastForward(ffDelta);
					const updateFeedData = await getFeedUpdateData({
						id: defaultFeedId,
						price: feedBaseFromUNIT(offChainPrice),
						conf: feedBaseFromUNIT(confidence),
					});

					await assert.revert(
						perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
						'too late'
					);

					await assert.revert(
						perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader }),
						'cannot cancel yet'
					);

					// time has moved forward and now is cancellable
					ffDelta = cancellableDelay - ffDelta;
					await fastForward(ffDelta);
					await checkCancellation(trader);
				});
			});

			describe('non-account owner moving in time', () => {
				it('cannot cancel before time based 2 maxAge', async () => {
					// set a known and deterministic confirmation window.
					let ffDelta = 0;
					const maxAge = 60;
					const executionExpiredDelay = maxAge + 1;
					const cancellableDelay = 2 * maxAge + 1;
					await perpsV2MarketSettings.setOffchainDelayedOrderMaxAge(marketKey, maxAge, {
						from: owner,
					});

					// no time has changed.
					await assert.revert(
						perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader2 }),
						'cannot cancel yet'
					);

					// time has moved forward, order cannot be executed (due to maxAge) but is not cancellable yet
					ffDelta = executionExpiredDelay - ffDelta;
					await fastForward(ffDelta);
					const updateFeedData = await getFeedUpdateData({
						id: defaultFeedId,
						price: feedBaseFromUNIT(offChainPrice),
						conf: feedBaseFromUNIT(confidence),
					});

					await assert.revert(
						perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader2 }),
						'too late'
					);

					await assert.revert(
						perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader2 }),
						'cannot cancel yet'
					);

					// time has moved forward and now is cancellable
					ffDelta = cancellableDelay - ffDelta;
					await fastForward(ffDelta);
					await checkCancellation(trader2);
				});
			});

			describe('an order that would revert on execution can be cancelled', () => {
				beforeEach(async () => {
					// remove minumun delay
					await perpsV2MarketSettings.setOffchainDelayedOrderMinAge(marketKey, 0, { from: owner });
					// go to next round
					await setOnchainPrice(baseAsset, price);
					// withdraw margin (will cause order to fail)
					await perpsV2Market.withdrawAllMargin({ from: trader });
					const updateFeedData = await getFeedUpdateData({
						id: defaultFeedId,
						price: feedBaseFromUNIT(offChainPrice),
						conf: feedBaseFromUNIT(confidence),
					});
					// check execution would fail
					await assert.revert(
						perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
						'Position can be liquidated'
					);
				});

				it('by account owner', async () => {
					await fastForward(offchainDelayedOrderMaxAge * 2);
					await checkCancellation(trader);
				});

				it('by non-account owner', async () => {
					await fastForward(offchainDelayedOrderMaxAge * 2);
					// now cancel
					await checkCancellation(trader2);
				});
			});
		});
	});

	describe('executeOffchainDelayedOrder()', () => {
		it('cannot execute when there is no order', async () => {
			const updateFeedData = await getFeedUpdateData({
				id: defaultFeedId,
				price: feedBaseFromUNIT(offChainPrice),
				conf: feedBaseFromUNIT(confidence),
			});
			// account owner
			await assert.revert(
				perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
				'no previous order'
			);
			// keeper
			await assert.revert(
				perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader2 }),
				'no previous order'
			);
		});

		describe('when an order exists', () => {
			let commitFee, keeperFee, updateFeedData;

			async function submitOffchainOrderAndDelay(delay, feedTimeOffset = 0) {
				await setOffchainPrice(trader, {
					id: defaultFeedId,
					price: feedBaseFromUNIT(offChainPrice),
					conf: feedBaseFromUNIT(confidence),
					publishTime: (await currentTime()) + feedTimeOffset,
				});

				await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });

				await fastForward(delay);

				updateFeedData = await getFeedUpdateData({
					id: defaultFeedId,
					price: feedBaseFromUNIT(offChainPrice),
					conf: feedBaseFromUNIT(confidence),
					publishTime: await currentTime(),
				});
			}

			describe('execution reverts', () => {
				describe('if min age was not reached', () => {
					beforeEach('submitOrder and prepare updateFeedData', async () => {
						// commitFee is the fee that would be charged for a spot trade when order is submitted
						commitFee = (await perpsV2Market.orderFee(size))[0];
						// keeperFee is the minimum keeperFee for the system
						keeperFee = await perpsV2MarketSettings.minKeeperFee();

						await submitOffchainOrderAndDelay(offchainDelayedOrderMinAge - 1);
					});

					it('reverts for owner', async () => {
						// account owner
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'too early'
						);
					});
					it('reverts for keeper', async () => {
						// keeper
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
								from: trader2,
							}),
							'too early'
						);
					});
				});

				describe('if max age was exceeded for order', () => {
					beforeEach('submitOrder and prepare updateFeedData', async () => {
						// commitFee is the fee that would be charged for a spot trade when order is submitted
						commitFee = (await perpsV2Market.orderFee(size))[0];
						// keeperFee is the minimum keeperFee for the system
						keeperFee = await perpsV2MarketSettings.minKeeperFee();

						await submitOffchainOrderAndDelay(offchainDelayedOrderMaxAge + 2);
					});

					it('reverts for owner', async () => {
						// account owner
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'too late'
						);
					});
					it('reverts for keeper', async () => {
						// keeper
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
								from: trader2,
							}),
							'too late'
						);
					});
				});

				describe('if max age was exceeded for price', () => {
					beforeEach('submitOrder and prepare updateFeedData', async () => {
						// commitFee is the fee that would be charged for a spot trade when order is submitted
						commitFee = (await perpsV2Market.orderFee(size))[0];
						// keeperFee is the minimum keeperFee for the system
						keeperFee = await perpsV2MarketSettings.minKeeperFee();

						await submitOffchainOrderAndDelay(offchainDelayedOrderMaxAge - 1);

						updateFeedData = await getFeedUpdateData({
							id: defaultFeedId,
							price: feedBaseFromUNIT(offChainPrice),
							conf: feedBaseFromUNIT(confidence),
							publishTime: (await currentTime()) - offchainDelayedOrderMaxAge,
						});
					});

					it('reverts for owner', async () => {
						// account owner
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'no price available which is recent enough'
						);
					});
					it('reverts for keeper', async () => {
						// keeper
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
								from: trader2,
							}),
							'no price available which is recent enough'
						);
					});
				});

				describe('orders on time', () => {
					beforeEach('submitOrder and prepare updateFeedData', async () => {
						// commitFee is the fee that would be charged for a spot trade when order is submitted
						commitFee = (await perpsV2Market.orderFee(size))[0];
						// keeperFee is the minimum keeperFee for the system
						keeperFee = await perpsV2MarketSettings.minKeeperFee();

						await submitOffchainOrderAndDelay(offchainDelayedOrderMinAge + 1);
					});

					it('if margin removed', async () => {
						// withdraw margin (will cause order to fail)
						await perpsV2Market.withdrawAllMargin({ from: trader });

						// account owner
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'Position can be liquidated'
						);
						// the difference in reverts is due to difference between refund into margin
						// in case of account owner and transfer in case of keeper
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
								from: trader2,
							}),
							'Insufficient margin'
						);
					});

					it('if price too high', async () => {
						// set price too high
						updateFeedData = await getFeedUpdateData({
							id: defaultFeedId,
							price: feedBaseFromUNIT(offChainPrice.mul(toBN(5))),
							conf: feedBaseFromUNIT(confidence),
						});

						// account owner
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'Max leverage exceeded'
						);
						// keeper
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
								from: trader2,
							}),
							'Max leverage exceeded'
						);
					});
				});
			});

			// helper function to check execution and its results
			// from: which account is requesting the execution
			// currentOffchainPrice: current price of the asset (informed by offchain oracle)
			// targetPrice: the price that the order should be executed at
			// feeRate: expected exchange fee rate
			// spotTradeDetails: trade details of the same trade if it would happen as spot
			async function checkExecution(
				from,
				currentOffchainPrice,
				targetPrice,
				feeRate,
				spotTradeDetails,
				updateFeedData
			) {
				const roundId = await exchangeRates.getCurrentRoundId(baseAsset);

				const currentMargin = toBN((await perpsV2Market.positions(trader)).margin);
				// execute the order
				const tx = await perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], {
					from: from,
				});

				// check order is removed now
				const order = await perpsV2MarketState.delayedOrders(trader);
				assert.bnEqual(order.sizeDelta, 0);
				assert.bnEqual(order.targetRoundId, 0);
				assert.bnEqual(order.commitDeposit, 0);
				assert.bnEqual(order.keeperDeposit, 0);
				assert.bnEqual(order.executableAtTime, 0);

				// The relevant events are properly emitted
				const decodedLogs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [sUSD, perpsV2Market, perpsV2DelayedOrder],
				});

				let expectedRefund = commitFee; // at least the commitFee is refunded
				if (from === trader) {
					// trader gets refunded keeperFee
					expectedRefund = expectedRefund.add(keeperFee);
					// no event for keeper payment
					assert.equal(decodedLogs.length, 8);
					// funding, position(refund), issued (exchange fee), position(trade), order removed
				} else {
					// keeper gets paid
					assert.equal(decodedLogs.length, 9);
					// keeper fee, funding, position(refund), issued (exchange fee), position(trade), order removed
					decodedEventEqual({
						event: 'Issued',
						emittedFrom: sUSD.address,
						args: [from, keeperFee],
						log: decodedLogs[3],
					});
				}

				// trader was refunded correctly
				// PositionModified
				let expectedMargin = currentMargin.add(expectedRefund);

				decodedEventEqual({
					event: 'PositionModified',
					emittedFrom: perpsV2Market.address,
					args: [toBN('1'), trader, expectedMargin, 0, 0, currentOffchainPrice, toBN(2), 0],
					log: decodedLogs.slice(-4, -3)[0],
				});

				// trade was executed correctly
				// PositionModified
				const expectedFee = multiplyDecimal(size, multiplyDecimal(targetPrice, feeRate));

				// calculate the expected margin after trade
				expectedMargin = spotTradeDetails.margin
					.add(spotTradeDetails.fee)
					.sub(expectedFee)
					.add(expectedRefund);

				decodedEventEqual({
					event: 'PositionModified',
					emittedFrom: perpsV2Market.address,
					args: [toBN('1'), trader, expectedMargin, size, size, targetPrice, toBN(2), expectedFee],
					log: decodedLogs.slice(-2, -1)[0],
				});

				// DelayedOrderRemoved
				decodedEventEqual({
					event: 'DelayedOrderRemoved',
					emittedFrom: perpsV2Market.address,
					args: [trader, roundId, size, roundId.add(toBN(1)), commitFee, keeperFee],
					log: decodedLogs.slice(-1)[0],
				});

				// transfer more margin
				await perpsV2Market.transferMargin(margin, { from: trader });
				// and can submit new order
				await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });
				const newOrder = await perpsV2MarketState.delayedOrders(trader);
				assert.bnEqual(newOrder.sizeDelta, size);
			}

			describe('execution results in correct views and events', () => {
				let targetPrice, targetOffchainPrice, spotTradeDetails, updateFeedData;

				beforeEach(async () => {
					await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });

					await fastForward(offchainDelayedOrderMinAge + 1);

					targetPrice = multiplyDecimal(price, toUnit(0.9));
					targetOffchainPrice = multiplyDecimal(offChainPrice, toUnit(0.9));

					updateFeedData = await getFeedUpdateData({
						id: defaultFeedId,
						price: feedBaseFromUNIT(targetOffchainPrice),
						conf: feedBaseFromUNIT(confidence),
					});
				});

				describe('during target round', () => {
					describe('taker trade', () => {
						beforeEach(async () => {
							// go to next round
							// Get spotTradeDetails with offchain price and back to original price
							await setOnchainPrice(baseAsset, targetOffchainPrice);
							spotTradeDetails = await perpsV2Market.postTradeDetails(size, trader);
							await setOnchainPrice(baseAsset, targetPrice);
						});

						it('from account owner', async () => {
							await checkExecution(
								trader,
								targetOffchainPrice,
								targetOffchainPrice,
								takerFeeOffchainDelayedOrder,
								spotTradeDetails,
								updateFeedData
							);
						});

						it('from keeper', async () => {
							await checkExecution(
								trader2,
								targetOffchainPrice,
								targetOffchainPrice,
								takerFeeOffchainDelayedOrder,
								spotTradeDetails,
								updateFeedData
							);
						});
					});

					describe('maker trade', () => {
						beforeEach(async () => {
							// skew the other way
							await perpsV2Market.transferMargin(margin.mul(toBN(2)), { from: trader3 });
							await perpsV2Market.modifyPosition(size.mul(toBN(-2)), { from: trader3 });
							// go to next round
							// Get spotTradeDetails with offchain price and back to original price
							await setOnchainPrice(baseAsset, targetOffchainPrice);
							spotTradeDetails = await perpsV2Market.postTradeDetails(size, trader);
							await setOnchainPrice(baseAsset, targetPrice);
						});

						it('from account owner', async () => {
							await checkExecution(
								trader,
								targetOffchainPrice,
								targetOffchainPrice,
								makerFeeOffchainDelayedOrder,
								spotTradeDetails,
								updateFeedData
							);
						});

						it('from keeper', async () => {
							await checkExecution(
								trader2,
								targetOffchainPrice,
								targetOffchainPrice,
								makerFeeOffchainDelayedOrder,
								spotTradeDetails,
								updateFeedData
							);
						});
					});

					it('reverts if futures markets are suspended', async () => {
						await setOnchainPrice(baseAsset, targetPrice);
						await systemStatus.suspendFutures(toUnit(0), { from: owner });
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'Futures markets are suspended'
						);
					});

					it('reverts if market is suspended', async () => {
						await setOnchainPrice(baseAsset, targetPrice);
						await systemStatus.suspendFuturesMarket(marketKey, toUnit(0), { from: owner });
						await assert.revert(
							perpsV2Market.executeOffchainDelayedOrder(trader, [updateFeedData], { from: trader }),
							'Market suspended'
						);
					});
				});
			});
		});
	});

	describe('when dynamic fee is enabled', () => {
		beforeEach(async () => {
			const dynamicFeeRounds = 4;
			// set multiple past rounds
			for (let i = 0; i < dynamicFeeRounds; i++) {
				await setOnchainPrice(baseAsset, initialPrice);
			}
			// enable dynamic fees
			await systemSettings.setExchangeDynamicFeeRounds(dynamicFeeRounds, { from: owner });
		});

		describe('when dynamic fee is too high (price too volatile)', () => {
			const spikedPrice = multiplyDecimal(initialPrice, toUnit(1.1));
			beforeEach(async () => {
				// set up a healthy position
				await perpsV2Market.transferMargin(toUnit('1000'), { from: trader });

				// submit an order
				await perpsV2Market.submitOffchainDelayedOrder(size, { from: trader });

				// spike the price
				await setOnchainPrice(baseAsset, spikedPrice);
			});

			it('canceling an order works', async () => {
				await fastForward(offchainDelayedOrderMaxAge * 2);
				await perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader });
			});

			it('submitting an order reverts', async () => {
				// cancel existing
				await fastForward(offchainDelayedOrderMaxAge * 2);
				await perpsV2Market.cancelOffchainDelayedOrder(trader, { from: trader });

				await assert.revert(
					perpsV2Market.submitOffchainDelayedOrder(size, { from: trader }),
					'Price too volatile'
				);
			});
		});
	});
});