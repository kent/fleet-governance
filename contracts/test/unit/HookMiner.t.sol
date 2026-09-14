// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {HookMiner} from "../../src/deploy/HookMiner.sol";

contract Probe {
    uint256 public x;
    constructor(uint256 x_) { x = x_; }
}

contract HookMinerTest is Test {
    function test_FindsSaltMatchingFlagsAndDeploysThere() public {
        uint160 flags = 0x22C0;
        (address predicted, bytes32 salt) = HookMiner.find(address(this), flags, type(Probe).creationCode, abi.encode(uint256(42)));
        assertEq(uint160(predicted) & 0xFFFF, flags);
        Probe p = new Probe{salt: salt}(42);
        assertEq(address(p), predicted);
        assertEq(p.x(), 42);
    }
}
