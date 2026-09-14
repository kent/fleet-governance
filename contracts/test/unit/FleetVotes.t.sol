// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";

contract FleetVotesTest is Test {
    address[] members;
    uint256[] keys;
    string[] manifests;
    FleetRegistry registry;
    FleetVotes token;
    address outsider = makeAddr("outsider");

    function setUp() public {
        vm.warp(1_800_000_000);
        for (uint256 i = 0; i < 5; i++) {
            (address a, uint256 k) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            members.push(a);
            keys.push(k);
            manifests.push("{}");
        }
        registry = new FleetRegistry(members, manifests, "{}");
        token = new FleetVotes("Fleet Vote", "FLEET", registry);
        vm.warp(block.timestamp + 1);
    }

    function test_SupplyAndBalances() public view {
        assertEq(token.totalSupply(), 5e18);
        assertEq(token.decimals(), 18);
        assertEq(token.name(), "Fleet Vote");
        assertEq(token.symbol(), "FLEET");
        for (uint256 i = 0; i < 5; i++) {
            assertEq(token.balanceOf(members[i]), 1e18);
            assertEq(token.getVotes(members[i]), 1e18);
            assertEq(token.delegates(members[i]), members[i]);
        }
        assertEq(token.balanceOf(outsider), 0);
        assertEq(token.getVotes(outsider), 0);
    }

    function test_TimestampClock() public view {
        assertEq(token.clock(), uint48(block.timestamp));
        assertEq(token.CLOCK_MODE(), "mode=timestamp");
        assertEq(token.getPastTotalSupply(block.timestamp - 1), 5e18);
        assertEq(token.getPastVotes(members[0], block.timestamp - 1), 1e18);
    }

    function test_TransfersRevert() public {
        vm.startPrank(members[0]);
        vm.expectRevert(FleetVotes.TransfersDisabled.selector);
        token.transfer(members[1], 1e18);
        vm.expectRevert(FleetVotes.TransfersDisabled.selector);
        token.transfer(members[1], 0);
        vm.stopPrank();
    }

    function test_ApprovalsRevert() public {
        vm.prank(members[0]);
        vm.expectRevert(FleetVotes.ApprovalsDisabled.selector);
        token.approve(members[1], 1);
        vm.prank(members[1]);
        vm.expectRevert(); // transferFrom fails before reaching _update: allowance path is disabled
        token.transferFrom(members[0], members[1], 1);
        assertEq(token.balanceOf(members[0]), 1e18);
    }

    function test_DelegateToMemberMovesPower() public {
        vm.prank(members[0]);
        token.delegate(members[1]);
        assertEq(token.getVotes(members[0]), 0);
        assertEq(token.getVotes(members[1]), 2e18);
        assertEq(token.balanceOf(members[0]), 1e18);
        vm.warp(block.timestamp + 1);
        assertEq(token.getPastVotes(members[1], block.timestamp - 1), 2e18);
        // return power to self
        vm.prank(members[0]);
        token.delegate(members[0]);
        assertEq(token.getVotes(members[0]), 1e18);
        assertEq(token.getVotes(members[1]), 1e18);
    }

    function test_SelfDelegationIdempotent() public {
        vm.prank(members[0]);
        token.delegate(members[0]);
        assertEq(token.getVotes(members[0]), 1e18);
    }

    function test_DelegateToNonMemberOrZeroReverts() public {
        vm.startPrank(members[0]);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, outsider));
        token.delegate(outsider);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, address(0)));
        token.delegate(address(0));
        vm.stopPrank();
    }

    function test_NonMemberCannotDelegate() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.NotMember.selector, outsider));
        token.delegate(members[0]);
    }

    function test_DelegateBySigCannotBypassRestriction() public {
        uint256 nonce = token.nonces(members[0]);
        uint256 expiry = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)"), outsider, nonce, expiry)
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], digest);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, outsider));
        token.delegateBySig(outsider, nonce, expiry, v, r, s);
    }

    function test_DelegateBySigToMemberWorks() public {
        uint256 nonce = token.nonces(members[0]);
        uint256 expiry = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)"), members[2], nonce, expiry
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], _hashTypedData(structHash));
        token.delegateBySig(members[2], nonce, expiry, v, r, s);
        assertEq(token.getVotes(members[2]), 2e18);
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = token.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
