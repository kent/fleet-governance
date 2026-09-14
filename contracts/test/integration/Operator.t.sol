// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

/// @notice The operator's lifecycle powers, and their edges.
/// @dev Spec section 4: the operator opens and completes tasks. Completing a task retires every
///      proposal on it, including queued ones. That is deliberate, and it is a lifecycle power, not a
///      decision power: the operator can end the conversation but never write a decision into it, and
///      every completion is an onchain event anyone can see.
contract OperatorTest is FleetFixture {
    function test_CompletingATaskRetiresAQueuedProposal() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("path-a"), "", "take path a");
        string memory description = string.concat("choose path a", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);

        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, FOR, "for");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));
        queueAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));

        // The fleet has voted and the operation is scheduled. The operator ends the task anyway.
        vm.prank(operator);
        ledger.completeTask(taskId);
        assertEq(uint8(ledger.getTask(taskId).state), uint8(TaskLedger.TaskState.Completed));

        // Execution now reverts inside TaskLedger.recordDecision, which requires an Open task.
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        vm.prank(keeper);
        vm.expectRevert();
        governor.execute(t, v, c, descHash(description));
        assertEq(ledger.decisionCount(taskId), 0);

        // Nothing cancelled the timelock operation, so the proposal still reads Queued and the
        // proposer's one-proposal-per-task slot is still occupied. See docs/compatibility-notes.md,
        // "A Queued but unexecutable proposal holds its proposer's slot until someone cancels it".
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));
        assertTrue(
            timelock.isOperationPending(timelock.hashOperationBatch(t, v, c, bytes32(0), timelockSalt(description)))
        );

        // The keeper cannot clear it: AgoraGovernor.cancel admits only the proposer, admin,
        // executor, and manager, and admin and manager are the zero address in this deployment.
        vm.prank(keeper);
        vm.expectRevert(AgoraGovernor.GovernorUnauthorizedCancel.selector);
        governor.cancel(t, v, c, descHash(description));

        // The proposer can, and that is what releases the slot.
        vm.prank(members[0]);
        governor.cancel(t, v, c, descHash(description));
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Canceled));
    }

    /// @notice The other half of the boundary: the lifecycle power is not a decision power.
    function test_OperatorCannotDecideAnything() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotTimelock.selector, operator));
        ledger.recordDecision(taskId, 0, 1, keccak256("p"), "", "s");

        vm.prank(operator);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, string.concat("operator proposal", DESC_SUFFIX));

        (uint256 pid,,,) = proposeDecision(0, data, string.concat("member proposal", DESC_SUFFIX));
        warpToActive(pid);
        vm.prank(operator);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVoteWithReason(pid, FOR, "the operator has no seat");
    }
}
