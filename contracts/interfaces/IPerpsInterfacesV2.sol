pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// a contract / interface matching the filename is expected for compilation
interface IPerpsInterfacesV2 {
    function noEmptyBlocks() external; // no empty blocks (post commit checks)
}

interface IPerpsTypesV2 {
    enum Status {
        Ok,
        InvalidPrice,
        PriceOutOfBounds,
        CanLiquidate,
        CannotLiquidate,
        MaxMarketSizeExceeded,
        MaxLeverageExceeded,
        InsufficientMargin,
        NotPermitted,
        NilOrder,
        NoPositionOpen
    }

    // If margin/size are positive, the position is long; if negative then it is short.
    struct Position {
        bytes32 marketKey;
        uint id;
        FundingEntry lastFundingEntry;
        uint margin;
        // locked margin is used to withhold margin for
        // possible future operations (e.g. orders) or possible payments (fees)
        // it is tracked in order to correctly account for market debt instead of just burning
        // and minting sUSD without tracking the amounts, and in order to only allow locking/unlocking
        // correct amounts of already transferred amounts
        uint lockedMargin;
        uint lastPrice;
        int size;
    }

    // next-price order storage
    struct NextPriceOrder {
        int128 sizeDelta; // difference in position to pass to modifyPosition
        uint128 targetRoundId; // price oracle roundId using which price this order needs to exucted
        uint128 commitDeposit; // the commitDeposit paid upon submitting that needs to be refunded if order succeeds
        uint128 keeperDeposit; // the keeperDeposit paid upon submitting that needs to be paid / refunded on tx confirmation
        bytes32 trackingCode; // tracking code to emit on execution for volume source fee sharing
    }

    struct MarketScalars {
        bytes32 baseAsset;
        uint marketSize;
        int marketSkew;
        int entryDebtCorrection;
        uint lastPositionId;
    }

    struct FundingEntry {
        int funding;
        uint timestamp;
    }

    struct PositionStatus {
        int profitLoss;
        int accruedFunding;
        uint remainingMargin;
        uint accessibleMargin;
        bool canLiquidate;
        uint approxLiquidationPrice;
        uint approxLiquidationFee;
        bool priceInvalid;
    }
}

interface IPerpsEngineV2External {
    // views
    function assetPrice(bytes32 marketKey) external view returns (uint price, bool invalid);

    function storageContract() external view returns (IPerpsStorageV2External);

    function marketSizes(bytes32 marketKey) external view returns (uint long, uint short);

    function marketDebt(bytes32 marketKey) external view returns (uint debt, bool invalid);

    function currentFundingRate(bytes32 marketKey) external view returns (int);

    function unrecordedFunding(bytes32 marketKey) external view returns (int funding, bool invalid);

    function positionDetails(bytes32 marketKey, address account)
        external
        view
        returns (IPerpsTypesV2.Position memory position, IPerpsTypesV2.PositionStatus memory positionStatus);

    function orderFee(
        bytes32 marketKey,
        int sizeDelta,
        uint feeRate
    ) external view returns (uint fee, bool invalid);

    function postTradeDetails(
        bytes32 marketKey,
        address account,
        int sizeDelta,
        uint feeRate
    )
        external
        view
        returns (
            uint margin,
            int size,
            uint fee,
            IPerpsTypesV2.Status status
        );

    // mutative
    function liquidatePosition(
        bytes32 marketKey,
        address account,
        address liquidator
    ) external;
}

interface IPerpsEngineV2Internal {
    // internal mutative

    // only manager
    function initMarket(bytes32 marketKey, bytes32 baseAsset) external;

    // only settings
    function recomputeFunding(bytes32 marketKey) external;

    // only routers
    function transferMargin(
        bytes32 marketKey,
        address account,
        int amount
    ) external;

    // only routers
    function modifyLockedMargin(
        bytes32 marketKey,
        address account,
        int lockAmount,
        uint burnAmount
    ) external;

    // only routers
    function trade(
        bytes32 marketKey,
        address account,
        int sizeDelta,
        uint feeRate,
        bytes32 trackingCode
    ) external;
}

interface IPerpsStorageV2External {
    // views

    function marketScalars(bytes32 marketKey) external view returns (IPerpsTypesV2.MarketScalars memory);

    function fundingSequences(bytes32 marketKey, uint index) external view returns (IPerpsTypesV2.FundingEntry memory);

    function fundingSequenceLength(bytes32 marketKey) external view returns (uint);

    function lastFundingEntry(bytes32 marketKey) external view returns (IPerpsTypesV2.FundingEntry memory);

    function positions(bytes32 marketKey, address account) external view returns (IPerpsTypesV2.Position memory);

    function positionIdToAccount(bytes32 marketKey, uint positionId) external view returns (address account);
}

interface IPerpsStorageV2Internal {
    // mutative restricted to engine contract

    function initMarket(bytes32 marketKey, bytes32 baseAsset) external;

    function positionWithInit(bytes32 marketKey, address account) external returns (IPerpsTypesV2.Position memory);

    function pushFundingEntry(bytes32 marketKey, int funding) external;

    function storePosition(
        bytes32 marketKey,
        address account,
        uint newMargin,
        uint newLocked,
        int newSize,
        uint price
    ) external;

    function storeMarketAggregates(
        bytes32 marketKey,
        uint marketSize,
        int marketSkew,
        int entryDebtCorrection
    ) external;
}

interface IFuturesMarketManagerInternal {
    function issueSUSD(address account, uint amount) external;

    function burnSUSD(address account, uint amount) external returns (uint postReclamationAmount);

    function payFee(uint amount, bytes32 trackingCode) external;

    function approvedRouter(
        address router,
        bytes32 marketKey,
        address account
    ) external returns (bool approved);
}

interface IPerpsOrdersV2 {
    // VIEWS
    function engineContract() external view returns (IPerpsEngineV2External);

    function storageContract() external view returns (IPerpsStorageV2External);

    function nextPriceOrders(bytes32 marketKey, address account) external view returns (IPerpsTypesV2.NextPriceOrder memory);

    function baseFee(bytes32 marketKey) external view returns (uint);

    function feeRate(bytes32 marketKey) external view returns (uint);

    function dynamicFeeRate(bytes32 marketKey) external view returns (uint rate, bool tooVolatile);

    function baseFeeNextPrice(bytes32 marketKey) external view returns (uint);

    function feeRateNextPrice(bytes32 marketKey) external view returns (uint);

    function currentRoundId(bytes32 marketKey) external view returns (uint);

    // MUTATIVE

    function transferMargin(int marginDelta) external;

    function withdrawAllMargin() external;

    function modifyPosition(int sizeDelta) external;

    function modifyPositionWithTracking(int sizeDelta, bytes32 trackingCode) external;

    function submitNextPriceOrder(int sizeDelta) external;

    function submitNextPriceOrderWithTracking(int sizeDelta, bytes32 trackingCode) external;

    function cancelNextPriceOrder(address account) external;

    function executeNextPriceOrder(address account) external;

    function closePosition() external;

    function closePositionWithTracking(bytes32 trackingCode) external;

    function liquidatePosition(address account) external;
}

interface IPerpsSettingsV2 {
    struct Parameters {
        uint baseFee;
        uint baseFeeNextPrice;
        uint nextPriceConfirmWindow;
        uint maxLeverage;
        uint maxSingleSideValueUSD;
        uint maxFundingRate;
        uint skewScaleUSD;
    }

    function baseFee(bytes32 _marketKey) external view returns (uint);

    function baseFeeNextPrice(bytes32 _marketKey) external view returns (uint);

    function nextPriceConfirmWindow(bytes32 _marketKey) external view returns (uint);

    function maxLeverage(bytes32 _marketKey) external view returns (uint);

    function maxSingleSideValueUSD(bytes32 _marketKey) external view returns (uint);

    function maxFundingRate(bytes32 _marketKey) external view returns (uint);

    function skewScaleUSD(bytes32 _marketKey) external view returns (uint);

    function parameters(bytes32 _marketKey) external view returns (Parameters memory);

    function minKeeperFee() external view returns (uint);

    function liquidationFeeRatio() external view returns (uint);

    function liquidationBufferRatio() external view returns (uint);

    function minInitialMargin() external view returns (uint);
}