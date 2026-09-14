// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";

contract AmendmentTest is FleetFixture {
    string constant CHARTER_V2 =
        '{"schema":"fleet.charter.v1","goal":"pass tests","externalAllowlist":["registry.npmjs.org","examples.internal"]}';

    function _passAndExecute(uint256 agent, bytes memory data, string memory description)
        internal
        returns (uint256 pid)
    {
        address[] memory t;
        uint256[] memory v;
        bytes[] memory c;
        (pid, t, v, c) = proposeDecision(agent, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, FOR, "for");
        warpPastDeadline(pid);
        queueAs(keeper, t, v, c, description);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
    }

    function test_AmendmentBumpsVersionAndGatewayReadsNewCharter() public {
        uint256 taskId = openTask();
        bytes32 h = keccak256(bytes(CHARTER_V2));
        bytes memory data =
            actionCalldata(taskId, uint8(TaskLedger.DecisionKind.AMEND_CHARTER), 1, h, CHARTER_V2, "add host");
        _passAndExecute(0, data, string.concat("amend", DESC_SUFFIX));
        TaskLedger.Task memory t = ledger.getTask(taskId);
        assertEq(t.charterVersion, 2);
        assertEq(t.charterHash, h);
        assertEq(ledger.charterText(taskId), CHARTER_V2);
    }

    // Split out of the test body to keep its stack shallow enough for the legacy (non via-IR)
    // codegen; the fixture's foundry.toml does not enable via-ir. Behavior is identical to
    // inlining these two calls.
    function _queue(bytes memory data, string memory description) internal {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        queueAs(keeper, t, v, c, description);
    }

    function _execute(bytes memory data, string memory description) internal {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        executeAs(keeper, t, v, c, description);
    }

    function test_PendingProposalOnOldVersionCannotExecuteAfterAmendment() public {
        uint256 taskId = openTask();
        // proposal A (exception on v1) by agent 1, proposal B (amend) by agent 0, both active
        bytes memory dataA = actionCalldata(taskId, 1, 1, keccak256("x"), "", "exception on v1");
        string memory descA = string.concat("A", DESC_SUFFIX);
        (uint256 pidA,,,) = proposeDecision(1, dataA, descA);
        bytes32 h = keccak256(bytes(CHARTER_V2));
        bytes memory dataB = actionCalldata(taskId, 2, 1, h, CHARTER_V2, "amend");
        string memory descB = string.concat("B", DESC_SUFFIX);
        (uint256 pidB,,,) = proposeDecision(0, dataB, descB);
        warpToActive(pidB);
        for (uint256 i = 0; i < 3; i++) {
            vote(i, pidA, FOR, "for");
            vote(i, pidB, FOR, "for");
        }
        warpPastDeadline(pidB);
        // execute B first
        _queue(dataB, descB);
        _queue(dataA, descA);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        _execute(dataB, descB);
        assertEq(ledger.getTask(taskId).charterVersion, 2);
        // A now names a stale version; the ledger rejects it and the governor call reverts. The revert
        // originates in TaskLedger.recordDecision (called by the timelock's executeBatch), not the hook,
        // and bubbles up through the timelock's low-level call; keep this bare (confirmed with -vvvv that
        // the cause is TaskLedger.CharterVersionMismatch(1, 2)).
        (address[] memory tA, uint256[] memory vA, bytes[] memory cA) = singleAction(dataA);
        vm.prank(keeper);
        vm.expectRevert();
        governor.execute(tA, vA, cA, descHash(descA));
        // the timelock operation for A is still pending (it was never executed), so the governor still
        // reports Queued even though it can never succeed now.
        assertEq(uint8(stateOf(pidA)), uint8(IGovernor.ProposalState.Queued));
        assertEq(ledger.exceptionVersion(taskId, keccak256("x")), 0);
    }

    function test_StopTaskClosesFutureProposals() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, uint8(TaskLedger.DecisionKind.STOP_TASK), 1, bytes32(0), "", "stop");
        _passAndExecute(0, data, string.concat("stop", DESC_SUFFIX));
        assertEq(uint8(ledger.getTask(taskId).state), uint8(TaskLedger.TaskState.Stopped));
        (address[] memory t, uint256[] memory v, bytes[] memory c) =
            singleAction(actionCalldata(taskId, 0, 1, keccak256("p"), "", "s"));
        vm.prank(members[1]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, string.concat("after stop", DESC_SUFFIX));
    }
}
