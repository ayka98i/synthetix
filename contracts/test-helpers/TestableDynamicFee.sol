pragma solidity ^0.5.16;

// Libraries
import "../DynamicFee.sol";

contract TestableDynamicFee {
    uint public threshold = 4 * 10**uint(SafeDecimalMath.decimals() - 3);
    uint public weightDecay = 9 * 10**uint(SafeDecimalMath.decimals() - 1);

    function testGetPriceDifferential(uint price, uint previousPrice) external view returns (uint) {
        return DynamicFee.getPriceDifferential(price, previousPrice, threshold);
    }

    function testGetPriceWeight(uint round) external view returns (uint) {
        return DynamicFee.getRoundDecay(round, weightDecay);
    }

    function testGetDynamicFee(uint[] calldata prices) external view returns (uint) {
        return DynamicFee.getDynamicFee(prices, threshold, weightDecay);
    }
}