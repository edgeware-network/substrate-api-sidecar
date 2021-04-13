import { u32 } from '@polkadot/types';
import { Option, Vec } from '@polkadot/types/codec';
import {
	AccountId,
	BalanceOf,
	BlockHash,
	BlockNumber,
	FundInfo,
	ParaGenesisArgs,
	ParaId,
	ParaLifecycle,
	WinningData,
} from '@polkadot/types/interfaces';
import { ITuple } from '@polkadot/types/types';
import BN from 'bn.js';
import { InternalServerError } from 'http-errors';

import {
	AuctionPhase,
	IAuctionsCurrent,
	ICrowdloans,
	ICrowdloansInfo,
	IFund,
	ILeaseInfo,
	ILeasesCurrent,
	IParas,
	LeaseFormatted,
	ParaType,
} from '../../types/responses';
import { IOption, isSome } from '../../types/util';
import { AbstractService } from '../AbstractService';

// This was the orgiginal value in the rococo test net. Once the exposed metadata
// consts makes its way into `rococo-v1` this can be taken out.
const LEASE_PERIODS_PER_SLOT_FALLBACK = 4;

export class ParasService extends AbstractService {
	/**
	 * Get crowdloan information for a `paraId`.
	 *
	 * @param hash `BlockHash` to make call at
	 * @param paraId ID of para to get crowdloan info for
	 */
	async crowdloansInfo(
		hash: BlockHash,
		paraId: number
	): Promise<ICrowdloansInfo> {
		const [fund, { number }] = await Promise.all([
			this.api.query.crowdloan.funds.at<Option<FundInfo>>(hash, paraId),
			this.api.rpc.chain.getHeader(hash),
		]);

		if (!fund) {
			throw new InternalServerError(
				`Could not find funds info at para id: ${paraId}`
			);
		}

		let fundInfo, leasePeriods;
		if (fund.isSome) {
			fundInfo = fund.unwrap();
			const firstSlot = fundInfo.firstSlot.toNumber();
			// number of lease periods this crowdloan covers
			const leasePeriodCount = fundInfo.lastSlot.toNumber() - firstSlot + 1;
			leasePeriods = Array(leasePeriodCount)
				.fill(0)
				.map((_, i) => i + firstSlot);
		} else {
			fundInfo = null;
		}

		const at = {
			hash,
			height: number.unwrap().toString(10),
		};

		return {
			at,
			fundInfo,
			leasePeriods,
		};
	}

	/**
	 * List all available crowdloans.
	 *
	 * @param hash `BlockHash` to make call at
	 * @param includeFundInfo wether or not to include `FundInfo` for every crowdloan
	 */
	async crowdloans(
		hash: BlockHash,
		includeFundInfo: boolean
	): Promise<ICrowdloans> {
		const [{ number }, funds] = await Promise.all([
			this.api.rpc.chain.getHeader(hash),
			this.api.query.crowdloan.funds.entriesAt<Option<FundInfo>, [ParaId]>(
				hash
			),
		]);

		let entries: IFund[];
		if (includeFundInfo) {
			entries = funds.map(([keys, fundInfo]) => {
				return {
					paraId: keys.args[0],
					fundInfo,
				};
			});
		} else {
			entries = (await this.api.query.crowdloan.funds.keys<[ParaId]>()).map(
				({ args: [paraId] }) => {
					return {
						paraId,
					};
				}
			);
		}

		const at = {
			hash,
			height: number.unwrap().toString(10),
		};

		return {
			at,
			funds: entries,
		};
	}

	/**
	 * Get current and future lease info + lifecycle stage for a given `paraId`.
	 *
	 * @param hash `BlockHash` to make call at
	 * @param paraId ID of para to get lease info of
	 */
	async leaseInfo(hash: BlockHash, paraId: number): Promise<ILeaseInfo> {
		const [leases, { number }, paraLifeCycleOpt] = await Promise.all([
			this.api.query.slots.leases.at<
				Vec<Option<ITuple<[AccountId, BalanceOf]>>>
			>(hash, paraId),
			this.api.rpc.chain.getHeader(hash),
			this.api.query.paras.paraLifecycles.at<Option<ParaLifecycle>>(
				hash,
				paraId
			),
		]);
		const blockNumber = number.unwrap();

		const at = {
			hash,
			height: blockNumber.toString(10),
		};

		let leasesFormatted;
		if (leases.length) {
			const currentLeasePeriodIndex = this.currentLeasePeriodIndex(
				blockNumber
			).toNumber();

			leasesFormatted = leases.reduce((acc, curLeaseOpt, idx) => {
				if (curLeaseOpt.isSome) {
					const leasePeriodIndex = currentLeasePeriodIndex + idx;
					const lease = curLeaseOpt.unwrap();
					acc.push({
						leasePeriodIndex,
						account: lease[0],
						deposit: lease[1],
					});
				}

				return acc;
			}, [] as LeaseFormatted[]);
		} else {
			leasesFormatted = null;
		}

		let onboardingAs: ParaType | undefined;
		if (paraLifeCycleOpt.isSome && paraLifeCycleOpt.unwrap().isOnboarding) {
			const paraGenesisArgs = await this.api.query.paras.upcomingParasGenesis.at<
				Option<ParaGenesisArgs>
			>(hash, paraId);

			if (paraGenesisArgs.isSome) {
				onboardingAs = paraGenesisArgs.unwrap().parachain.isTrue
					? 'parachain'
					: 'parathread';
			}
		}

		return {
			at,
			paraLifeCycle: paraLifeCycleOpt,
			onboardingAs,
			leases: leasesFormatted,
		};
	}

	/**
	 * Get the status of the current auction.
	 *
	 * Note: most fields will be null if there is no ongoing auction.
	 *
	 * @param hash `BlockHash` to make call at
	 */
	async auctionsCurrent(hash: BlockHash): Promise<IAuctionsCurrent> {
		const [auctionInfoOpt, { number }, auctionCounter] = await Promise.all([
			this.api.query.auctions.auctionInfo.at<Option<Vec<BlockNumber>>>(hash),
			this.api.rpc.chain.getHeader(hash),
			this.api.query.auctions.auctionCounter.at<BlockNumber>(hash),
		]);
		const blockNumber = number.unwrap();

		const endingPeriod = this.api.consts.auctions.endingPeriod as BlockNumber;

		let leasePeriodIndex: IOption<BlockNumber>,
			beginEnd: IOption<BlockNumber>,
			finishEnd: IOption<BN>,
			phase: IOption<AuctionPhase>,
			winning;
		if (auctionInfoOpt.isSome) {
			[leasePeriodIndex, beginEnd] = auctionInfoOpt.unwrap();
			const endingOffset = this.endingOffset(blockNumber, beginEnd);
			const winningOpt = endingOffset
				? await this.api.query.auctions.winning.at<Option<WinningData>>(
						hash,
						endingOffset
				  )
				: await this.api.query.auctions.winning.at<Option<WinningData>>(
						hash,
						// when we are not in the ending phase of the auction winning bids are stored at 0
						0
				  );

			if (winningOpt.isSome) {
				const ranges = this.enumerateLeaseSets(leasePeriodIndex);

				// zip the winning bids together with their slot range
				winning = winningOpt.unwrap().map((bid, idx) => {
					const leaseSet = ranges[idx];

					let result;
					if (bid.isSome) {
						const [accountId, paraId, amount] = bid.unwrap();
						result = { bid: { accountId, paraId, amount }, leaseSet };
					} else {
						result = { bid: null, leaseSet };
					}

					return result;
				});
			} else {
				winning = null;
			}

			finishEnd = beginEnd.add(endingPeriod);
			phase = beginEnd.gt(blockNumber) ? 'starting' : 'ending';
		} else {
			leasePeriodIndex = null;
			beginEnd = null;
			finishEnd = null;
			phase = null;
			winning = null;
		}

		const leasePeriodsPerSlot =
			(this.api.consts.auctions.leasePeriodsPerSlot as u32)?.toNumber() ||
			LEASE_PERIODS_PER_SLOT_FALLBACK;
		const leasePeriods = isSome(leasePeriodIndex)
			? Array(leasePeriodsPerSlot)
					.fill(0)
					.map((_, i) => i + (leasePeriodIndex as BN).toNumber())
			: null;

		return {
			at: {
				hash,
				height: blockNumber.toString(10),
			},
			beginEnd,
			finishEnd,
			phase,
			// If there is no current auction, this will be the index of the previous auction
			auctionIndex: auctionCounter,
			leasePeriods,
			winning,
		};
	}

	/**
	 * Get general information about the current lease period.
	 *
	 * @param hash `BlockHash` to make call at
	 * @param includeCurrentLeaseHolders wether or not to include the paraIds of
	 * all the curent lease holders. Not including is likely faster and reduces
	 * response size.
	 */
	async leasesCurrent(
		hash: BlockHash,
		includeCurrentLeaseHolders: boolean
	): Promise<ILeasesCurrent> {
		let blockNumber, currentLeaseHolders;
		if (!includeCurrentLeaseHolders) {
			const { number } = await this.api.rpc.chain.getHeader(hash);
			blockNumber = number.unwrap();
		} else {
			const [{ number }, leaseEntries] = await Promise.all([
				this.api.rpc.chain.getHeader(hash),
				this.api.query.slots.leases.entriesAt<
					Vec<Option<ITuple<[AccountId, BalanceOf]>>>,
					[ParaId]
				>(hash),
			]);

			blockNumber = number.unwrap();

			currentLeaseHolders = leaseEntries
				.filter(([_k, leases]) => leases[0].isSome)
				.map(([key, _l]) => key.args[0]);
		}

		const leasePeriod = this.api.consts.slots.leasePeriod as BlockNumber;
		const leasePeriodIndex = this.currentLeasePeriodIndex(blockNumber);
		const endOfLeasePeriod = leasePeriodIndex.mul(leasePeriod).add(leasePeriod);

		return {
			at: {
				hash,
				height: blockNumber.toString(10),
			},
			leasePeriodIndex,
			endOfLeasePeriod,
			currentLeaseHolders,
		};
	}

	/**
	 * List all registered paras (parathreads & parachains).
	 *
	 * @param hash `BlockHash` to make call at
	 * @returns all the current registered paraIds and their lifecycle status
	 */
	async paras(hash: BlockHash): Promise<IParas> {
		const [{ number }, paraLifecycles] = await Promise.all([
			this.api.rpc.chain.getHeader(hash),
			this.api.query.paras.paraLifecycles.entriesAt<ParaLifecycle, [ParaId]>(
				hash
			),
		]);

		const parasPromises = paraLifecycles.map(async ([k, paraLifeCycle]) => {
			const paraId = k.args[0];
			let onboardingAs: ParaType | undefined;
			if (paraLifeCycle.isOnboarding) {
				const paraGenesisArgs = await this.api.query.paras.paraGenesisArgs.at<ParaGenesisArgs>(
					hash,
					paraId
				);
				onboardingAs = paraGenesisArgs.parachain.isTrue
					? 'parachain'
					: 'parathread';
			}

			return {
				paraId,
				paraLifeCycle,
				onboardingAs,
			};
		});

		return {
			at: {
				hash,
				height: number.unwrap().toString(10),
			},
			paras: await Promise.all(parasPromises),
		};
	}

	/**
	 * Calculate the current lease period index.
	 *
	 * @param blockHeight current blockheight
	 * @param leasePeriod duration of lease period
	 */
	private currentLeasePeriodIndex(now: BN): BN {
		const leasePeriod = this.api.consts.slots.leasePeriod as BlockNumber;
		return now.div(leasePeriod);
	}

	/**
	 * The offset into the ending samples of the auction. When we are not in the
	 * ending phase of the auction we can use 0 as the offset, but we do not return
	 * that here in order to closely mimic `Auctioneer::is_ending` impl in
	 * polkadot's `runtime::common::auctions`.
	 *
	 * @param now current block number
	 * @param startEnd block number of the start of the auctions ending period
	 */
	private endingOffset(now: BN, begginEnd: IOption<BN>): IOption<BN> {
		if (!isSome(begginEnd)) {
			return null;
		}

		const afterEarlyEnd = now.sub(begginEnd);
		if (afterEarlyEnd.lten(0)) {
			return null;
		}

		// Once https://github.com/paritytech/polkadot/pull/2848 is merged no longer
		// need a fallback of 1
		const sampleLength =
			(this.api.consts.auctions.sampleLength as BlockNumber) || new BN(1);
		return afterEarlyEnd.div(sampleLength);
	}

	/**
	 * Enumerate in order all the lease sets (SlotRange expressed as a set of
	 * lease periods) that an `auctions::winning` array covers.
	 *
	 * @param leasePeriodIndex
	 */
	private enumerateLeaseSets(leasePeriodIndex: BN): number[][] {
		const leasePeriodIndexNumber = leasePeriodIndex.toNumber();
		const lPPS =
			(this.api.consts.auctions.leasePeriodsPerSlot as u32)?.toNumber() ||
			LEASE_PERIODS_PER_SLOT_FALLBACK;

		const ranges: number[][] = [];
		for (let start = 0; start < lPPS; start += 1) {
			for (let end = start; end < lPPS; end += 1) {
				const slotRange = [];
				for (let i = start; i <= end; i += 1) {
					slotRange.push(i + leasePeriodIndexNumber);
				}
				ranges.push(slotRange);
			}
		}

		return ranges;
	}
}