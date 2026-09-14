// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Finds a CREATE2 salt whose resulting address carries exactly the requested low-16-bit flags.
/// @dev Expected work is 2^16 hashes. Deterministic: the first matching salt from zero is returned.
///      `find` hashes from one fixed 85-byte scratch buffer allocated once for the whole search,
///      updating only the salt word each iteration, instead of a fresh `abi.encodePacked` per
///      iteration. The old per-iteration encoding never freed the memory it touched, so a loop of
///      up to MAX_ITERATIONS iterations grew memory by roughly one word per pass and paid its
///      quadratic expansion cost; that exhausted gas when three fleets were mined inside one EVM
///      call frame (see docs/compatibility-notes.md, Task 9). The buffer layout mirrors
///      OpenZeppelin's Create2.computeAddress (lib/agora-governor/lib/openzeppelin-contracts/
///      contracts/utils/Create2.sol): [0xff][deployer(20)][salt(32)][initCodeHash(32)] = 85 bytes,
///      packed starting 11 bytes into a word holding the right-aligned deployer address.
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

        // Reserve the 85-byte hashing window once, bumping the free memory pointer a single time
        // for the whole search. `start` is 11 bytes into the word holding the right-aligned
        // deployer address, so the 0xff prefix byte and the deployer's 20 address bytes are
        // immediately contiguous; the salt and initCodeHash words follow.
        bytes32 start;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(ptr, 0x40), initCodeHash)
            mstore(ptr, deployer)
            start := add(ptr, 0x0b)
            mstore8(start, 0xff)
            mstore(0x40, add(ptr, 0x60))
        }

        for (uint256 i = 0; i < MAX_ITERATIONS; ++i) {
            salt = bytes32(i);
            assembly ("memory-safe") {
                mstore(add(start, 0x15), salt)
                hookAddress := and(keccak256(start, 85), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            if ((uint160(hookAddress) & FLAG_MASK) == flags && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert SaltNotFound();
    }

    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address hookAddress)
    {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(add(ptr, 0x40), initCodeHash)
            mstore(add(ptr, 0x20), salt)
            mstore(ptr, deployer)
            let start := add(ptr, 0x0b)
            mstore8(start, 0xff)
            hookAddress := and(keccak256(start, 85), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
