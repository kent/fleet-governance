// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetProposalCredits, ICreditToken} from "../../src/FleetProposalCredits.sol";

contract CreditTokenStub is ICreditToken {
    mapping(address => uint256) public balanceOf;
    function mint(address who) external { balanceOf[who] = 1e18; }
}

contract FleetProposalCreditsTest is Test {
    FleetProposalCredits bank;
    CreditTokenStub token;
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    bytes32 runHash = keccak256("run-1");

    function setUp() public {
        vm.warp(1000);
        token = new CreditTokenStub();
        token.mint(alice);
        token.mint(bob);
        bank = new FleetProposalCredits(address(token), token, address(this));
        bank.registerRun(1, runHash, 3, 2000);
    }

    function testThreeProposalsConsumeAllCreditsWithoutChangingVotes() public {
        vm.startPrank(alice);
        bank.spend(1, 101);
        bank.spend(1, 102);
        bank.spend(1, 103);
        vm.expectRevert(FleetProposalCredits.NoCredits.selector);
        bank.spend(1, 104);
        vm.stopPrank();
        assertEq(bank.remaining(1, alice), 0);
        assertEq(bank.remaining(1, bob), 3);
        assertEq(token.balanceOf(alice), 1e18);
        assertEq(bank.proposalCount(1), 3);
        assertEq(bank.proposalAt(1, 2), 103);
        (uint256 taskId, address proposer, uint64 spentAt) = bank.receipts(101);
        assertEq(taskId, 1);
        assertEq(proposer, alice);
        assertEq(spentAt, 1000);
    }

    function testAnyHolderCanSpendItsOwnAllowance() public {
        vm.prank(alice); bank.spend(1, 101);
        vm.prank(bob); bank.spend(1, 102);
        assertEq(bank.remaining(1, alice), 2);
        assertEq(bank.remaining(1, bob), 2);
        vm.expectRevert(FleetProposalCredits.NotTokenHolder.selector);
        bank.spend(1, 103);
    }

    function testCannotPayTwiceOrChangeWhoPaid() public {
        vm.prank(alice); bank.spend(1, 101);
        vm.prank(bob);
        vm.expectRevert(FleetProposalCredits.AlreadyPaid.selector);
        bank.spend(1, 101);
        assertEq(bank.remaining(1, bob), 3);
    }

    function testRunCannotBeResetExtendedOrReused() public {
        vm.expectRevert(FleetProposalCredits.RunAlreadyRegistered.selector);
        bank.registerRun(1, keccak256("replacement"), 8, 2500);
        vm.expectRevert(FleetProposalCredits.RunAlreadyRegistered.selector);
        bank.registerRun(2, runHash, 3, 2500);
        vm.prank(alice);
        vm.expectRevert(FleetProposalCredits.NotOperator.selector);
        bank.registerRun(2, keccak256("replacement"), 3, 2500);
        vm.warp(2000);
        vm.prank(alice);
        vm.expectRevert(FleetProposalCredits.RunClosed.selector);
        bank.spend(1, 101);
    }

    function testUnknownRunAndUnboundedAllowancesFail() public {
        vm.prank(alice);
        vm.expectRevert(FleetProposalCredits.RunClosed.selector);
        bank.spend(99, 101);
        vm.expectRevert(FleetProposalCredits.InvalidRun.selector);
        bank.registerRun(2, keccak256("other"), 9, 2000);
        vm.expectRevert(FleetProposalCredits.InvalidRun.selector);
        bank.registerRun(2, keccak256("other"), 3, 20000);
    }
}
