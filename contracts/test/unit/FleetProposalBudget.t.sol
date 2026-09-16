// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetProposalBudget} from "../../src/FleetProposalBudget.sol";
import {FleetProposalToken} from "../../src/FleetProposalToken.sol";
import {ICreditToken} from "../../src/FleetProposalCredits.sol";

contract ProposalVotesStub is ICreditToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public getVotes;
    function add(address who) external { balanceOf[who] = 1e18; getVotes[who] = 1e18; }
    function delegatePower(address who, uint256 power) external { getVotes[who] = power; }
}

contract FleetProposalBudgetTest is Test {
    FleetProposalBudget bank;
    FleetProposalToken budget;
    ProposalVotesStub votes;
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address inactive = address(0xcafe);
    bytes32 runHash = keccak256("run-1");
    address[] agents;

    function setUp() public {
        vm.warp(1000);
        votes = new ProposalVotesStub();
        votes.add(alice); votes.add(bob); votes.add(inactive);
        agents.push(alice); agents.push(bob);
        bank = new FleetProposalBudget(address(votes), votes, address(this));
        bank.registerRunPolicy(1, runHash, 3, 2000, 1, 1e18, agents);
        budget = bank.proposalToken(1);
    }

    function testFixedSupplyMintedOnlyToActiveAgents() public view {
        assertEq(budget.name(), "Fleet Proposal"); assertEq(budget.symbol(), "FPROP");
        assertEq(budget.decimals(), 0);
        assertEq(budget.initialSupply(), 6); assertEq(budget.totalSupply(), 6);
        assertEq(budget.balanceOf(alice), 3); assertEq(budget.balanceOf(bob), 3);
        assertEq(budget.balanceOf(inactive), 0);
        assertEq(budget.controller(), address(bank)); assertEq(budget.taskId(), 1);
        assertEq(budget.runHash(), runHash);
    }

    function testEveryAgentCanProposeAndBurnsDoNotRemoveVotingPower() public {
        vm.prank(alice); bank.spend(1, 101);
        vm.prank(bob); bank.spend(1, 102);
        assertEq(budget.totalSupply(), 4);
        assertEq(bank.remaining(1, alice), 2); assertEq(bank.remaining(1, bob), 2);
        assertEq(votes.balanceOf(alice), 1e18); assertEq(votes.getVotes(alice), 1e18);
        (uint256 taskId, address proposer, uint64 at, uint8 cost, uint256 power) = bank.receipts(101);
        assertEq(taskId, 1); assertEq(proposer, alice); assertEq(at, 1000);
        assertEq(cost, 1); assertEq(power, 1e18);
    }

    function testExhaustedBudgetRejectsSpamAndDoesNotAffectPeers() public {
        vm.startPrank(alice);
        bank.spend(1, 101); bank.spend(1, 102); bank.spend(1, 103);
        vm.expectRevert(FleetProposalBudget.NoCredits.selector); bank.spend(1, 104);
        vm.stopPrank();
        assertEq(budget.totalSupply(), 3); assertEq(budget.balanceOf(bob), 3);
        assertEq(bank.proposalCount(1), 3); assertEq(bank.proposalAt(1, 2), 103);
    }

    function testNeitherAgentsNorOperatorCanMintOrRefillOrReplaceToken() public {
        vm.prank(alice);
        (bool agentMint,) = address(budget).call(abi.encodeWithSignature("mint(address,uint256)", alice, 99));
        (bool operatorMint,) = address(budget).call(abi.encodeWithSignature("mint(address,uint256)", alice, 99));
        assertFalse(agentMint); assertFalse(operatorMint);
        vm.expectRevert(FleetProposalBudget.RunAlreadyRegistered.selector);
        bank.registerRunPolicy(1, keccak256("refill"), 8, 2000, 1, 1e18, agents);
        vm.expectRevert(FleetProposalBudget.RunAlreadyRegistered.selector);
        bank.registerRunPolicy(2, runHash, 8, 2000, 1, 1e18, agents);
        vm.prank(alice);
        vm.expectRevert(FleetProposalBudget.NotOperator.selector);
        bank.registerRunPolicy(2, keccak256("forged"), 8, 2000, 1, 1e18, agents);
        assertEq(address(bank.proposalToken(1)), address(budget));
        assertEq(budget.totalSupply(), 6);
    }

    function testLookalikeTokensCannotRefillCanonicalBudget() public {
        vm.startPrank(alice);
        bank.spend(1, 101); bank.spend(1, 102); bank.spend(1, 103);
        FleetProposalToken fake = new FleetProposalToken(1, runHash, agents, 255);
        assertEq(fake.balanceOf(alice), 255);
        vm.expectRevert(FleetProposalBudget.NoCredits.selector); bank.spend(1, 104);
        vm.stopPrank();
        assertEq(address(bank.proposalToken(1)), address(budget));
        assertEq(bank.remaining(1, alice), 0);
    }

    function testCannotStealTransferApproveOrBurnPeerTokens() public {
        vm.startPrank(alice);
        vm.expectRevert(FleetProposalToken.TransfersDisabled.selector); budget.transfer(bob, 1);
        vm.expectRevert(FleetProposalToken.ApprovalsDisabled.selector); budget.approve(bob, 1);
        vm.expectRevert(FleetProposalToken.NotController.selector); budget.burnForProposal(bob, 1);
        vm.expectRevert(); budget.transferFrom(bob, alice, 1);
        vm.stopPrank();
        vm.expectRevert(FleetProposalToken.NotController.selector); budget.burnForProposal(alice, 1);
        assertEq(budget.balanceOf(alice), 3); assertEq(budget.balanceOf(bob), 3);
    }

    function testDuplicatePaymentRevertsWithoutAdditionalBurn() public {
        vm.prank(alice); bank.spend(1, 101);
        vm.prank(bob);
        vm.expectRevert(FleetProposalBudget.AlreadyPaid.selector); bank.spend(1, 101);
        assertEq(budget.balanceOf(bob), 3); assertEq(budget.totalSupply(), 5);
    }

    function testCostThresholdAndExpiryAreEnforcedOnchain() public {
        bank.registerRunPolicy(2, keccak256("run-2"), 3, 2000, 2, 2e18, agents);
        vm.prank(alice);
        vm.expectRevert(FleetProposalBudget.InsufficientVotingPower.selector); bank.spend(2, 201);
        votes.delegatePower(alice, 2e18);
        vm.prank(alice); bank.spend(2, 201);
        assertEq(bank.remaining(2, alice), 1);
        vm.prank(alice);
        vm.expectRevert(FleetProposalBudget.NoCredits.selector); bank.spend(2, 202);
        assertEq(bank.remaining(1, alice), 3);
        vm.warp(2000);
        vm.prank(alice);
        vm.expectRevert(FleetProposalBudget.RunClosed.selector); bank.spend(1, 101);
    }

    function testInactiveOrNewWalletCannotClaimTokens() public {
        vm.prank(inactive);
        vm.expectRevert(FleetProposalBudget.NoCredits.selector); bank.spend(1, 101);
        address sybil = address(0x1234); votes.add(sybil);
        vm.prank(sybil);
        vm.expectRevert(FleetProposalBudget.NoCredits.selector); bank.spend(1, 101);
        assertEq(bank.remaining(1, sybil), 0);
    }

    function testDuplicateRosterAndInvalidRulesRevertBeforeMint() public {
        agents[1] = alice;
        vm.expectRevert(FleetProposalBudget.InvalidRun.selector);
        bank.registerRunPolicy(2, keccak256("run-2"), 3, 2000, 1, 1e18, agents);
        agents[1] = bob;
        vm.expectRevert(FleetProposalBudget.InvalidRun.selector);
        bank.registerRunPolicy(2, keccak256("run-2"), 3, 2000, 4, 1e18, agents);
        assertEq(address(bank.proposalToken(2)), address(0));
    }

    function testFuzzSupplyEqualsInitialMintMinusPaidProposals(uint8 attempts) public {
        uint256 count = bound(attempts, 0, 8);
        vm.startPrank(alice);
        for (uint256 i; i < count; ++i) {
            if (i >= 3) vm.expectRevert(FleetProposalBudget.NoCredits.selector);
            bank.spend(1, 100 + i);
        }
        vm.stopPrank();
        uint256 burned = count > 3 ? 3 : count;
        assertEq(budget.totalSupply() + burned, budget.initialSupply());
        assertEq(budget.balanceOf(alice) + budget.balanceOf(bob), budget.totalSupply());
    }
}
