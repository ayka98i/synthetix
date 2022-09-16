pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./FuturesV2MarketMutations.sol";
import "./MixinFuturesV2NextPriceOrders.sol";
import "./interfaces/IFuturesV2Market.sol";

/*
 * Synthetic Futures
 * =================
 *
 * Futures markets allow users leveraged exposure to an asset, long or short.
 * A user must post some margin in order to open a futures account, and profits/losses are
 * continually tallied against this margin. If a user's margin runs out, then their position is closed
 * by a liquidation keeper, which is rewarded with a flat fee extracted from the margin.
 *
 * The Synthetix debt pool is effectively the counterparty to each trade, so if a particular position
 * is in profit, then the debt pool pays by issuing sUSD into their margin account,
 * while if the position makes a loss then the debt pool burns sUSD from the margin, reducing the
 * debt load in the system.
 *
 * As the debt pool underwrites all positions, the debt-inflation risk to the system is proportional to the
 * long-short skew in the market. It is therefore in the interest of the system to reduce the skew.
 * To encourage the minimisation of the skew, each position is charged a funding rate, which increases with
 * the size of the skew. The funding rate is charged continuously, and positions on the heavier side of the
 * market are charged the current funding rate times the notional value of their position, while positions
 * on the lighter side are paid at the same rate to keep their positions open.
 * As the funding rate is the same (but negated) on both sides of the market, there is an excess quantity of
 * funding being charged, which is collected by the debt pool, and serves to reduce the system debt.
 *
 * The contract architecture is as follows:
 *
 *     - FuturesV2Market.sol:         one of these exists per asset. Margin is maintained isolated per market.
 *                                  this contract is composed of several mixins: `base` contains all the core logic,
 *                                  `nextPrice` contains the next-price order flows, and `views` contains logic
 *                                  that is only used by external / manager contracts.
 *
 *     - FuturesV2MarketManager.sol:  the manager keeps track of which markets exist, and is the main window between
 *                                  futures markets and the rest of the system. It accumulates the total debt
 *                                  over all markets, and issues and burns sUSD on each market's behalf.
 *
 *     - FuturesV2MarketSettings.sol: Holds the settings for each market in the global FlexibleStorage instance used
 *                                  by SystemSettings, and provides an interface to modify these values. Other than
 *                                  the base asset, these settings determine the behaviour of each market.
 *                                  See that contract for descriptions of the meanings of each setting.
 *
 * Technical note: internal functions within the FuturesV2Market contract assume the following:
 *
 *     - prices passed into them are valid;
 *
 *     - funding has already been recomputed up to the current time (hence unrecorded funding is nil);
 *
 *     - the account being managed was not liquidated in the same transaction;
 */

// https://docs.synthetix.io/contracts/source/contracts/FuturesV2Market
contract FuturesV2Market is IFuturesV2Market, FuturesV2MarketMutations, MixinFuturesV2NextPriceOrders {
    constructor(
        address payable _proxy,
        address _marketState,
        address _owner,
        address _resolver
    ) public FuturesV2MarketMutations(_proxy, _marketState, _owner, _resolver) {}
}