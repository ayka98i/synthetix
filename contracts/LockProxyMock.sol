// SPDX-License-Identifier: MIT
pragma solidity ^0.6.0;

contract LockProxy {
    mapping(address => mapping(uint64 => bytes)) public assetHashMap;

    event LockEvent(address fromAssetHash, address fromAddress, uint64 toChainId, bytes toAssetHash, bytes toAddress, uint256 amount);

    function lock(address fromAssetHash, uint64 toChainId, bytes memory toAddress, uint256 amount) public payable returns (bool) {
        emit LockEvent(fromAssetHash, msg.sender, toChainId, toAddress, toAddress, amount);
        return true;
    }

    function bindAssetHash(address fromAssetHash, uint64 toChainId, bytes memory toAssetHash) public returns (bool) {
        assetHashMap[fromAssetHash][toChainId] = toAssetHash;
        return true;
    }
}