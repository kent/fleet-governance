// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Identity of one ledger action, independent of the proposal that carries it.
/// @dev The hook stores it per proposal and the ledger emits it per decision so the two events join.
library ActionId {
    function compute(address ledger, uint256 taskId, uint8 kind, uint32 expectedVersion, bytes32 payloadHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, ledger, taskId, kind, expectedVersion, payloadHash));
    }
}
