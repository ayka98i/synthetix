pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./interfaces/IFuturesV2MarketBaseTypes.sol";
import "./Owned.sol";
import "./State.sol";

// https://docs.synthetix.io/contracts/source/contracts/FuturesV2MarketState
contract FuturesV2MarketState is Owned, State, IFuturesV2MarketBaseTypes {
    /*
     * Each user's position. Multiple positions can always be merged, so each user has
     * only have one position at a time.
     */
    mapping(address => Position) public positions;

    /*
     * The funding sequence allows constant-time calculation of the funding owed to a given position.
     * Each entry in the sequence holds the net funding accumulated per base unit since the market was created.
     * Then to obtain the net funding over a particular interval, subtract the start point's sequence entry
     * from the end point's sequence entry.
     * Positions contain the funding sequence entry at the time they were confirmed; so to compute
     * the net funding on a given position, obtain from this sequence the net funding per base unit
     * since the position was confirmed and multiply it by the position size.
     */
    uint32 public fundingLastRecomputed;
    int128[] public fundingSequence;

    constructor(address _owner, address _associatedContract) public Owned(_owner) State(_associatedContract) {
        // Initialise the funding sequence with 0 initially accrued, so that the first usable funding index is 1.
        fundingSequence.push(0);
    }

    function setFundingLastRecomputed(uint32 lastRecomputed) external onlyAssociatedContract {
        fundingLastRecomputed = lastRecomputed;
    }

    function fundingSequenceLength() external view returns (uint) {
        return fundingSequence.length;
    }

    function pushFundingSequence(int128 _fundingSequence) external onlyAssociatedContract {
        fundingSequence.push(_fundingSequence);
    }

    function getPosition(address account) external view returns (Position memory) {
        return positions[account];
    }

    /**
     * @notice Set the position of a given account
     * @dev Only the associated contract may call this.
     * @param account The account whose value to set.
     * @param id position id.
     * @param lastFundingIndex position lastFundingIndex.
     * @param margin position margin.
     * @param lastPrice position lastPrice.
     * @param size position size.
     */
    function updatePosition(
        address account,
        uint64 id,
        uint64 lastFundingIndex,
        uint128 margin,
        uint128 lastPrice,
        int128 size
    ) external onlyAssociatedContract {
        positions[account] = Position(id, lastFundingIndex, margin, lastPrice, size);
    }

    /**
     * @notice Delete the position of a given account
     * @dev Only the associated contract may call this.
     * @param account The account whose position should be deleted.
     */
    function deletePosition(address account) external onlyAssociatedContract {
        delete positions[account];
    }
}
