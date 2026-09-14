// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {ActionId} from "../../src/libraries/ActionId.sol";

contract ActionIdTest is Test {
    function test_ComputeMatchesReferenceEncoding() public view {
        address ledger = address(0x1234);
        bytes32 expected = keccak256(abi.encode(block.chainid, ledger, uint256(7), uint8(1), uint32(1), keccak256("x")));
        assertEq(ActionId.compute(ledger, 7, 1, 1, keccak256("x")), expected);
    }

    function test_DifferentChainDifferentId() public {
        bytes32 a = ActionId.compute(address(1), 1, 0, 1, bytes32(0));
        vm.chainId(84532);
        bytes32 b = ActionId.compute(address(1), 1, 0, 1, bytes32(0));
        assertTrue(a != b);
    }
}
