// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Commitment to an ordered, fixed roster and its public agent manifests.
library FleetMembership {
    function seed(uint256 count) internal pure returns (bytes32) {
        return keccak256(abi.encode("fleet.membership.v1", count));
    }

    function append(bytes32 previous, uint256 agentId, address member, string memory manifest)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(previous, agentId, member, keccak256(bytes(manifest))));
    }

    function commitment(address[] memory members, string[] memory manifests) internal pure returns (bytes32 hash) {
        require(members.length == manifests.length, "membership length mismatch");
        hash = seed(members.length);
        for (uint256 i; i < members.length; ++i) hash = append(hash, i, members[i], manifests[i]);
    }
}
