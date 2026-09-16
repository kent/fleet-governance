// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetBudgetHook} from "../../src/FleetBudgetHook.sol";
import {FleetProposalBudget} from "../../src/FleetProposalBudget.sol";
import {FleetProposalToken} from "../../src/FleetProposalToken.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract ProposalEconomicsTest is FleetFixture {
    function useProposalBudget() internal pure override returns (bool) { return true; }

    function testDirectGovernorCallBurnsTokensInSameTransaction() public {
        uint256 task = openTask();
        FleetProposalBudget bank = FleetBudgetHook(address(hook)).proposalBudget();
        FleetProposalToken budget = bank.proposalToken(task);
        (uint256 pid,,,) = proposeDecision(0, actionCalldata(task, 0, 1, keccak256("choice"), "", "choice"), "Request a charter decision");
        assertEq(budget.balanceOf(members[0]), 7); assertEq(budget.totalSupply(), 39);
        (uint256 paidTask, address payer,, uint8 cost,) = bank.receipts(pid);
        assertEq(paidTask, task); assertEq(payer, members[0]); assertEq(cost, 1);
        assertEq(bank.hook(), address(hook)); assertEq(bank.governor(), address(governor));
    }

    function testRejectedAdmissionDoesNotCreateProposalOrBurnTokens() public {
        uint256 task = openTask();
        FleetProposalToken budget = FleetBudgetHook(address(hook)).proposalBudget().proposalToken(task);
        proposeDecision(0, actionCalldata(task, 0, 1, keccak256("first"), "", "first"), "First request");
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(actionCalldata(task, 0, 1, keccak256("second"), "", "second"));
        uint256 rejected = governor.getProposalId(t, v, c, keccak256("Spam request"));
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, "Spam request");
        assertEq(budget.balanceOf(members[0]), 7);
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorNonexistentProposal.selector, rejected)); governor.state(rejected);
    }

    function testExhaustionBlocksProposalSpamButNotVotingOrDelegation() public {
        uint256 task = openTask();
        FleetProposalBudget bank = FleetBudgetHook(address(hook)).proposalBudget();
        for (uint256 i; i < 8; ++i) {
            string memory description = string.concat("Proposal ", vm.toString(i));
            (, address[] memory targets, uint256[] memory values, bytes[] memory calls) = proposeDecision(0,
                actionCalldata(task, 0, 1, bytes32(i + 1), "", "request"), description);
            vm.prank(members[0]); governor.cancel(targets, values, calls, keccak256(bytes(description)));
        }
        assertEq(bank.remaining(task, members[0]), 0);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(actionCalldata(task, 0, 1, bytes32(uint256(99)), "", "spam"));
        uint256 id = governor.getProposalId(t, v, c, keccak256("Ninth proposal"));
        vm.prank(members[0]); vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, "Ninth proposal");
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorNonexistentProposal.selector, id)); governor.state(id);
        (uint256 peer,,,) = proposeDecision(1, actionCalldata(task, 3, 1, keccak256("stop"), "", "stop"), "Stop: this work violates the charter");
        warpToActive(peer);
        vote(0, peer, FOR, "Stop now. This conflicts with our charter.");
        assertTrue(governor.hasVoted(peer, members[0]));
        vm.prank(members[0]); token.delegate(members[1]);
        assertEq(token.getVotes(members[1]), 2e18);
    }

    function testDefeatedProposalLosesFeeAndMinorityVoteHasNoTokenPenalty() public {
        uint256 task = openTask();
        FleetProposalToken budget = FleetBudgetHook(address(hook)).proposalBudget().proposalToken(task);
        (uint256 pid,,,) = proposeDecision(0, actionCalldata(task, 0, 1, bytes32(uint256(1)), "", "request"), "Review this request");
        warpToActive(pid);
        vote(1, pid, AGAINST, "The request violates the charter.");
        warpPastDeadline(pid);
        assertEq(uint256(stateOf(pid)), uint256(IGovernor.ProposalState.Defeated));
        assertEq(budget.balanceOf(members[0]), 7);
        assertEq(budget.balanceOf(members[1]), 8);
        assertEq(token.getVotes(members[1]), 1e18);
    }

    function testUnregisteredTaskCannotBypassProposalFee() public {
        vm.prank(operator); uint256 task = ledger.openTask(CHARTER, MAX_LIFETIME);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(actionCalldata(task, 0, 1, bytes32(uint256(1)), "", "request"));
        vm.prank(members[0]); vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, "Skip token setup");
    }
}
