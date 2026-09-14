// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Finds a CREATE2 salt whose resulting address carries exactly the requested low-16-bit flags.
/// @dev Expected work is 2^16 hashes. Deterministic: the first matching salt from zero is returned.
library HookMiner {
    uint160 internal constant FLAG_MASK = 0xFFFF;
    uint256 internal constant MAX_ITERATIONS = 500_000;

    error SaltNotFound();

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < MAX_ITERATIONS; ++i) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, initCodeHash);
            if ((uint160(hookAddress) & FLAG_MASK) == flags && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert SaltNotFound();
    }

    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
