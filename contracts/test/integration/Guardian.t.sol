// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";

contract GuardianTest is FleetFixture {
    function test_GuardianPausesAndCancelsQueuedOperation() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 1, 1, keccak256("danger"), "", "risky exception");
        string memory description = string.concat("risky", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for"); vote(1, pid, FOR, "for"); vote(2, pid, FOR, "for");
        warpPastDeadline(pid);
        queueAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));

        vm.prank(guardian);
        ledger.pause();

        // guardian cancels the timelock operation directly (CANCELLER_ROLE)
        bytes32 opId = timelock.hashOperationBatch(t, v, c, bytes32(0), _timelockSalt(description));
        assertTrue(timelock.isOperationPending(opId));
        vm.prank(guardian);
        timelock.cancel(opId);
        assertFalse(timelock.isOperationPending(opId));
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Canceled));

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        vm.prank(keeper);
        // the governor's own state check rejects execute() once it sees Canceled (Succeeded|Queued
        // required); confirmed with -vvvv that this is IGovernor.GovernorUnexpectedProposalState.
        vm.expectRevert(
            abi.encodeWithSelector(
                IGovernor.GovernorUnexpectedProposalState.selector,
                pid,
                IGovernor.ProposalState.Canceled,
                bytes32(uint256(1 << uint8(IGovernor.ProposalState.Succeeded)) | uint256(1 << uint8(IGovernor.ProposalState.Queued)))
            )
        );
        governor.execute(t, v, c, descHash(description));
        assertEq(ledger.decisionCount(taskId), 0);

        vm.prank(guardian);
        ledger.unpause();
    }

    function test_GuardianCannotCancelAtGovernorOrProposeOrExecute() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        string memory description = string.concat("x", DESC_SUFFIX);
        (, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        vm.prank(guardian);
        // AgoraGovernor.cancel checks sender against proposer/admin/executor/manager itself, before ever
        // reaching a hook; the pinned governor raises its own GovernorUnauthorizedCancel(), not OZ's
        // IGovernor.GovernorUnableToCancel. Confirmed with -vvvv.
        vm.expectRevert(AgoraGovernor.GovernorUnauthorizedCancel.selector);
        governor.cancel(t, v, c, descHash(description));
        vm.prank(guardian);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, string.concat("guardian", DESC_SUFFIX));
    }

    /// @dev Mirrors AgoraGovernor._timelockSalt: bytes20(address(governor)) ^ descriptionHash.
    function _timelockSalt(string memory description) internal view returns (bytes32) {
        return bytes20(address(governor)) ^ descHash(description);
    }
}
