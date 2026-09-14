// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";

contract LedgerHandler is Test {
    TaskLedger public ledger;
    address public timelock;
    address public operator;
    address public guardian;
    address[] public randos;
    uint256 public directWriteAttempts;
    bool public directWriteSucceeded;

    constructor(TaskLedger ledger_, address timelock_, address operator_, address guardian_) {
        ledger = ledger_; timelock = timelock_; operator = operator_; guardian = guardian_;
        randos.push(makeAddr("r1")); randos.push(makeAddr("r2")); randos.push(operator_); randos.push(guardian_);
    }

    function open(uint64 lifetime) external {
        vm.prank(operator);
        try ledger.openTask("{}", 300 + (lifetime % 6900)) {} catch {}
    }

    function recordAsTimelock(uint256 taskSeed, uint8 kind, uint32 version, bytes32 payload) external {
        uint256 count = ledger.taskCount();
        if (count == 0) return;
        uint256 taskId = (taskSeed % count) + 1;
        string memory text = kind % 5 == 2 ? "{\"v\":\"amended\"}" : "";
        bytes32 ph = kind % 5 == 2 ? keccak256(bytes(text)) : payload;
        vm.prank(timelock);
        try ledger.recordDecision(taskId, kind % 5, version % 3 + 1, ph, text, "s") {} catch {}
    }

    function recordAsRando(uint256 who, uint256 taskSeed) external {
        uint256 count = ledger.taskCount();
        if (count == 0) return;
        directWriteAttempts++;
        vm.prank(randos[who % randos.length]);
        try ledger.recordDecision((taskSeed % count) + 1, 0, 1, bytes32(0), "", "s") {
            directWriteSucceeded = true;
        } catch {}
    }

    function togglePause() external {
        vm.prank(guardian);
        if (ledger.paused()) { try ledger.unpause() {} catch {} } else { try ledger.pause() {} catch {} }
    }

    function warp(uint256 secs) external { vm.warp(block.timestamp + (secs % 3000) + 1); }
}

contract TaskLedgerInvariant is FleetFixture {
    LedgerHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new LedgerHandler(ledger, address(timelock), operator, guardian);
        targetContract(address(handler));
    }

    function invariant_EveryDecisionHasConsistentVersions() public view {
        uint256 count = ledger.taskCount();
        for (uint256 id = 1; id <= count; id++) {
            TaskLedger.Task memory t = ledger.getTask(id);
            uint32 expectedVersion = 1;
            for (uint32 i = 0; i < t.decisionCount; i++) {
                TaskLedger.Decision memory d = ledger.getDecision(id, i);
                assertEq(d.charterVersionBefore, expectedVersion);
                if (d.kind == TaskLedger.DecisionKind.AMEND_CHARTER) {
                    assertEq(d.charterVersionAfter, expectedVersion + 1);
                    expectedVersion++;
                } else {
                    assertEq(d.charterVersionAfter, expectedVersion);
                }
            }
            assertEq(t.charterVersion, expectedVersion);
        }
    }

    function invariant_StoppedTasksHaveNoLaterDecisions() public view {
        uint256 count = ledger.taskCount();
        for (uint256 id = 1; id <= count; id++) {
            TaskLedger.Task memory t = ledger.getTask(id);
            if (t.state == TaskLedger.TaskState.Stopped && t.decisionCount > 0) {
                TaskLedger.Decision memory last = ledger.getDecision(id, t.decisionCount - 1);
                assertEq(uint8(last.kind), uint8(TaskLedger.DecisionKind.STOP_TASK));
            }
        }
    }

    function invariant_NoDirectWriteEverSucceeded() public view {
        assertFalse(handler.directWriteSucceeded());
    }
}
