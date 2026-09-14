// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {HookMiner} from "../../src/deploy/HookMiner.sol";

contract Probe {
    uint256 public x;

    constructor(uint256 x_) {
        x = x_;
    }
}

contract HookMinerTest is Test {
    function test_FindsSaltMatchingFlagsAndDeploysThere() public {
        uint160 flags = 0x22C0;
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(Probe).creationCode, abi.encode(uint256(42)));
        assertEq(uint160(predicted) & 0xFFFF, flags);
        Probe p = new Probe{salt: salt}(42);
        assertEq(address(p), predicted);
        assertEq(p.x(), 42);
    }

    /// @notice Equivalence check for the allocation-free rewrite: for fixed inputs, `find` must
    ///         return the exact same (address, salt) as the old, allocating formula
    ///         (`abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)` recomputed fresh
    ///         every iteration), kept here only as a reference, not in production code.
    function test_MatchesReferenceImplementationForFixedInputs() public view {
        address deployer = address(0xBEEF);
        uint160 flags = 0x22C0;
        bytes memory creationCode = type(Probe).creationCode;
        bytes memory constructorArgs = abi.encode(uint256(7));

        (address expectedAddr, bytes32 expectedSalt) = _referenceFind(deployer, flags, creationCode, constructorArgs);
        (address actualAddr, bytes32 actualSalt) = HookMiner.find(deployer, flags, creationCode, constructorArgs);

        assertEq(actualAddr, expectedAddr);
        assertEq(actualSalt, expectedSalt);
    }

    /// @notice A second fixed-input case with a different deployer and flag value, so the
    ///         equivalence check above is not accidentally true only for one salt shape.
    function test_MatchesReferenceImplementationForSecondFixedInput() public view {
        address deployer = address(0xC0FFEE);
        uint160 flags = 0x0091;
        bytes memory creationCode = type(Probe).creationCode;
        bytes memory constructorArgs = abi.encode(uint256(1337));

        (address expectedAddr, bytes32 expectedSalt) = _referenceFind(deployer, flags, creationCode, constructorArgs);
        (address actualAddr, bytes32 actualSalt) = HookMiner.find(deployer, flags, creationCode, constructorArgs);

        assertEq(actualAddr, expectedAddr);
        assertEq(actualSalt, expectedSalt);
    }

    /// @notice Task 9 (docs/compatibility-notes.md) hit MemoryOOG mining three fleets in one EVM
    ///         frame with the old, allocating `computeAddress`. Mining three times here, directly
    ///         in one test function body (no `this.`-call frame boundary between rounds), proves
    ///         the fixed-scratch-buffer rewrite no longer accumulates memory across rounds.
    function test_MiningThreeTimesInOneFrameDoesNotRunOutOfMemory() public view {
        uint160 flags = 0x22C0;
        (address a1,) = HookMiner.find(address(this), flags, type(Probe).creationCode, abi.encode(uint256(1)));
        (address a2,) = HookMiner.find(address(this), flags, type(Probe).creationCode, abi.encode(uint256(2)));
        (address a3,) = HookMiner.find(address(this), flags, type(Probe).creationCode, abi.encode(uint256(3)));

        assertEq(uint160(a1) & 0xFFFF, flags);
        assertEq(uint160(a2) & 0xFFFF, flags);
        assertEq(uint160(a3) & 0xFFFF, flags);
        assertTrue(a1 != a2);
        assertTrue(a2 != a3);
        assertTrue(a1 != a3);
    }

    /// @dev The pre-rewrite formula, kept only as a reference for the equivalence tests above.
    function _referenceComputeAddress(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }

    /// @dev The pre-rewrite `find`, kept only as a reference for the equivalence tests above.
    function _referenceFind(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < HookMiner.MAX_ITERATIONS; ++i) {
            salt = bytes32(i);
            hookAddress = _referenceComputeAddress(deployer, salt, initCodeHash);
            if ((uint160(hookAddress) & HookMiner.FLAG_MASK) == flags && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert HookMiner.SaltNotFound();
    }
}
