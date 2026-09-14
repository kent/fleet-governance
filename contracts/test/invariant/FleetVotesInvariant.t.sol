// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";

contract VotesHandler is Test {
    FleetVotes public token;
    address[] public actors;

    constructor(FleetVotes token_, address[] memory members, address[] memory outsiders) {
        token = token_;
        for (uint256 i = 0; i < members.length; i++) {
            actors.push(members[i]);
        }
        for (uint256 i = 0; i < outsiders.length; i++) {
            actors.push(outsiders[i]);
        }
    }

    function delegateTo(uint256 a, uint256 b) external {
        address from = actors[a % actors.length];
        address to = actors[b % actors.length];
        vm.prank(from);
        try token.delegate(to) {} catch {}
    }

    function transfer(uint256 a, uint256 b, uint256 amount) external {
        vm.prank(actors[a % actors.length]);
        try token.transfer(actors[b % actors.length], amount) {} catch {}
    }

    function approveAndTransferFrom(uint256 a, uint256 b, uint256 amount) external {
        address from = actors[a % actors.length];
        address to = actors[b % actors.length];
        vm.prank(from);
        try token.approve(to, amount) {} catch {}
        vm.prank(to);
        try token.transferFrom(from, to, amount) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + (secs % 1000) + 1);
    }
}

contract FleetVotesInvariant is FleetFixture {
    VotesHandler handler;
    address[] outsiders;

    function setUp() public override {
        super.setUp();
        outsiders.push(outsider);
        outsiders.push(makeAddr("outsider2"));
        handler = new VotesHandler(token, members, outsiders);
        targetContract(address(handler));
    }

    function invariant_SupplyConstant() public view {
        assertEq(token.totalSupply(), N * 1e18);
    }

    function invariant_BalancesFixed() public view {
        for (uint256 i = 0; i < N; i++) {
            assertEq(token.balanceOf(members[i]), 1e18);
        }
    }

    function invariant_VotingPowerSumsToSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < N; i++) {
            sum += token.getVotes(members[i]);
        }
        assertEq(sum, N * 1e18);
    }

    function invariant_NoMemberAboveSupplyAndNoOutsiderPower() public view {
        for (uint256 i = 0; i < N; i++) {
            assertLe(token.getVotes(members[i]), N * 1e18);
        }
        for (uint256 i = 0; i < outsiders.length; i++) {
            assertEq(token.balanceOf(outsiders[i]), 0);
            assertEq(token.getVotes(outsiders[i]), 0);
        }
    }
}
