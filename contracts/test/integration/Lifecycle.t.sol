// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {ActionId} from "../../src/libraries/ActionId.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";

contract LifecycleTest is FleetFixture {
    function test_GrantExceptionProposalThroughToLedger() public {
        uint256 taskId = openTask();
        bytes32 payload = keccak256("network_fetch|examples.internal|0xargs");
        bytes memory data = actionCalldata(taskId, uint8(TaskLedger.DecisionKind.GRANT_EXCEPTION), 1, payload, "", "one-time fetch");
        string memory description = string.concat("# Grant exception\n\nfetch examples.internal", DESC_SUFFIX);

        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(1, data, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Pending));
        assertEq(hook.taskOf(pid), taskId);
        assertEq(hook.actionOf(pid), ActionId.compute(address(ledger), taskId, 1, 1, payload));
        assertEq(hook.lastProposalOf(taskId, members[1]), pid);

        warpToActive(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Active));
        vote(0, pid, FOR, "FOR. Needed to finish; host is benign.");
        vote(1, pid, FOR, "FOR. I proposed it.");
        vote(2, pid, AGAINST, "AGAINST. Charter forbids it and the task is solvable without.");
        vote(3, pid, FOR, "FOR. Cheap.");
        vote(4, pid, AGAINST, "AGAINST. Provenance unknown.");
        (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes) = governor.proposalVotes(pid);
        assertEq(forVotes, 3e18);
        assertEq(againstVotes, 2e18);
        assertEq(abstainVotes, 0);

        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));

        queueAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));
        vm.prank(keeper);
        vm.expectRevert(); // timelock not ready
        governor.execute(t, v, c, descHash(description));

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Executed));

        assertEq(ledger.exceptionVersion(taskId, payload), 1);
        TaskLedger.Decision memory d = ledger.getDecision(taskId, 0);
        assertEq(d.actionId, hook.actionOf(pid));
        assertEq(uint8(d.kind), uint8(TaskLedger.DecisionKind.GRANT_EXCEPTION));
    }

    function test_DefeatedProposalCannotQueueOrExecute() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 1, 1, keccak256("p"), "", "s");
        string memory description = string.concat("defeat me", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, AGAINST, "against");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
        vm.prank(keeper);
        vm.expectRevert();
        governor.queue(t, v, c, descHash(description));
        vm.prank(keeper);
        vm.expectRevert();
        governor.execute(t, v, c, descHash(description));
        assertEq(ledger.decisionCount(taskId), 0);
    }

    function test_DelegatedWeightCountsAndIsVisible() public {
        // agent 3 and 4 delegate to agent 0 before the snapshot
        vm.prank(members[3]); token.delegate(members[0]);
        vm.prank(members[4]); token.delegate(members[0]);
        vm.warp(block.timestamp + 1);
        assertEq(token.getVotes(members[0]), 3e18);

        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("path"), "", "choose");
        string memory description = string.concat("choose", DESC_SUFFIX);
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for, carrying two delegations");
        vote(1, pid, AGAINST, "against");
        vote(2, pid, AGAINST, "against");
        // agents 3 and 4 have no power at the snapshot
        vm.prank(members[3]);
        // Agora's Hooks.callHook collapses every hook revert into a bare HookCallFailed();
        // the underlying rejection is FleetHook.NoVotingPower(members[3]).
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVoteWithReason(pid, FOR, "no power");
        warpPastDeadline(pid);
        (uint256 againstVotes, uint256 forVotes,) = governor.proposalVotes(pid);
        assertEq(forVotes, 3e18);
        assertEq(againstVotes, 2e18);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));
    }

    function test_ProposerCancelReleasesSlot() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("a"), "", "a");
        string memory d1 = string.concat("first", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, d1);
        // second proposal by same member on same task is rejected while first is unsettled
        vm.prank(members[0]);
        // Agora's Hooks.callHook collapses every hook revert into a bare HookCallFailed();
        // the underlying rejection is FleetHook.MemberHasUnsettledProposal(members[0], taskId, pid).
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, string.concat("second", DESC_SUFFIX));
        // a different member may propose on the same task
        proposeDecision(1, data, string.concat("by agent 1", DESC_SUFFIX));
        // proposer cancels, slot released
        vm.prank(members[0]);
        governor.cancel(t, v, c, descHash(d1));
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Canceled));
        proposeDecision(0, data, string.concat("second", DESC_SUFFIX));
    }
}
