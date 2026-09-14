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
    uint256 public totalCalls;
    uint256 public directWriteAttempts;
    bool public directWriteSucceeded;

    /// @notice Every distinct payload hash the campaign has handed to recordDecision, so the
    ///         escalation invariant can enumerate the otherwise sparse escalationVersion mapping.
    bytes32[] public payloads;
    mapping(bytes32 payloadHash => bool) public payloadSeen;

    /// @notice Decisions that actually landed, per DecisionKind. `fail_on_revert` is false here, so a
    ///         sequence in which every call reverted would satisfy every invariant while proving
    ///         nothing; afterInvariant reads these to confirm the run did real work.
    uint256[5] public kindSuccesses;

    constructor(TaskLedger ledger_, address timelock_, address operator_, address guardian_) {
        ledger = ledger_;
        timelock = timelock_;
        operator = operator_;
        guardian = guardian_;
        randos.push(makeAddr("r1"));
        randos.push(makeAddr("r2"));
        randos.push(operator_);
        randos.push(guardian_);
    }

    modifier counted() {
        totalCalls++;
        _;
    }

    function payloadCount() external view returns (uint256) {
        return payloads.length;
    }

    function successesOf(TaskLedger.DecisionKind kind) external view returns (uint256) {
        return kindSuccesses[uint8(kind)];
    }

    function amendSuccesses() external view returns (uint256) {
        return kindSuccesses[uint8(TaskLedger.DecisionKind.AMEND_CHARTER)];
    }

    function escalateSuccesses() external view returns (uint256) {
        return kindSuccesses[uint8(TaskLedger.DecisionKind.ESCALATE_TO_HUMAN)];
    }

    function open(uint64 lifetime) external counted {
        vm.prank(operator);
        try ledger.openTask("{}", 300 + (lifetime % 6900)) {} catch {}
        // The operator owns the task lifecycle and holds no decision authority, so every open is
        // followed by the operator trying to write a decision directly. It must always revert.
        _attemptDirectWrite(operator);
    }

    function recordAsTimelock(uint256 taskSeed, uint8 kind, uint32 version, bytes32 payload) external counted {
        uint256 count = ledger.taskCount();
        if (count == 0) return;
        uint8 k = _biasedKind(kind);
        if (k == uint8(TaskLedger.DecisionKind.AMEND_CHARTER)) {
            _amendSomewhere(taskSeed);
            return;
        }
        _record(taskSeed % count + 1, k, version % 3 + 1, payload, "");
    }

    /// @notice A deterministic driver for AMEND_CHARTER, reached from here and from the fuzzed path.
    function amendCharter(uint256 taskSeed) external counted {
        _amendSomewhere(taskSeed);
    }

    function recordAsRando(uint256 who) external counted {
        _attemptDirectWrite(randos[who % randos.length]);
    }

    function togglePause() external counted {
        vm.prank(guardian);
        if (ledger.paused()) {
            try ledger.unpause() {} catch {}
        } else {
            try ledger.pause() {} catch {}
        }
    }

    function warp(uint256 secs) external counted {
        vm.warp(block.timestamp + (secs % 3000) + 1);
    }

    /// @dev Eight slots, three of them AMEND_CHARTER, so the fuzzed path reaches amendments more
    ///      often than a flat one-in-five draw would.
    function _biasedKind(uint8 raw) private pure returns (uint8) {
        uint8[8] memory table = [0, 1, 2, 2, 2, 3, 4, 0];
        return table[raw % 8];
    }

    /// @dev Left to chance, an amendment lands only when the pause state, the task state, and
    ///      `expectedVersion` all line up, which left whole campaigns with zero amendments and so no
    ///      coverage of the only kind that moves `charterVersion`. This arranges those conditions:
    ///      unpause, take an Open unexpired task or open one, then amend it at its real version.
    function _amendSomewhere(uint256 taskSeed) private {
        if (ledger.paused()) {
            vm.prank(guardian);
            try ledger.unpause() {} catch {}
        }
        uint256 taskId = _usableTask(taskSeed);
        if (taskId == 0) {
            vm.prank(operator);
            try ledger.openTask("{}", 7200) returns (uint256 opened) {
                taskId = opened;
            } catch {
                return;
            }
        }
        TaskLedger.Task memory task = ledger.getTask(taskId);
        string memory text = string.concat('{"v":', vm.toString(uint256(task.charterVersion) + 1), "}");
        _record(taskId, uint8(TaskLedger.DecisionKind.AMEND_CHARTER), task.charterVersion, keccak256(bytes(text)), text);
    }

    /// @dev An Open, unexpired task at or after `taskSeed`'s slot, wrapping; 0 when the ledger has none.
    function _usableTask(uint256 taskSeed) private view returns (uint256) {
        uint256 count = ledger.taskCount();
        if (count == 0) return 0;
        uint256 first = taskSeed % count;
        for (uint256 i = 0; i < count; i++) {
            uint256 candidate = (first + i) % count + 1;
            TaskLedger.Task memory task = ledger.getTask(candidate);
            if (task.state == TaskLedger.TaskState.Open && block.timestamp < task.expiresAt) return candidate;
        }
        return 0;
    }

    function _record(uint256 taskId, uint8 kind, uint32 version, bytes32 payloadHash, string memory text) private {
        if (!payloadSeen[payloadHash]) {
            payloadSeen[payloadHash] = true;
            payloads.push(payloadHash);
        }
        vm.prank(timelock);
        try ledger.recordDecision(taskId, kind, version, payloadHash, text, "s") {
            kindSuccesses[kind]++;
        } catch {}
    }

    function _attemptDirectWrite(address who) private {
        uint256 count = ledger.taskCount();
        directWriteAttempts++;
        vm.prank(who);
        try ledger.recordDecision(count == 0 ? 1 : count, 0, 1, bytes32(0), "", "s") {
            directWriteSucceeded = true;
        } catch {}
    }
}

contract TaskLedgerInvariant is FleetFixture {
    LedgerHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new LedgerHandler(ledger, address(timelock), operator, guardian);
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.depth = 64
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

    /// forge-config: default.invariant.depth = 64
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

    /// @notice openEscalations is exactly the number of payloads currently marked on the task. The
    ///         counter is maintained by increments and decrements inside recordDecision, so it stays
    ///         honest only if every path that sets or clears escalationVersion moves it too.
    /// forge-config: default.invariant.depth = 64
    function invariant_OpenEscalationsMatchesTheMarkedPayloads() public view {
        uint256 taskCount = ledger.taskCount();
        uint256 payloadCount = handler.payloadCount();
        for (uint256 id = 1; id <= taskCount; id++) {
            uint256 marked;
            for (uint256 i = 0; i < payloadCount; i++) {
                if (ledger.escalationVersion(id, handler.payloads(i)) != 0) marked++;
            }
            assertEq(ledger.getTask(id).openEscalations, marked);
        }
    }

    /// forge-config: default.invariant.depth = 64
    function invariant_NoDirectWriteEverSucceeded() public view {
        assertFalse(handler.directWriteSucceeded());
    }

    /// @notice Coverage floor. A campaign in which every call reverted would satisfy every invariant
    ///         above while proving nothing, so assert the run actually landed an amendment and
    ///         actually attempted a direct write.
    /// @dev Foundry 1.7.1 calls afterInvariant after each run, and once more before the first run with
    ///      the handler untouched (confirmed by logging every invocation to a file: 66 records for a
    ///      64-run campaign, the first of them all zeroes). The totalCalls guard skips that empty
    ///      invocation; without it these assertions fail on every campaign. The invariants above run
    ///      at depth 64 rather than the project-wide 32 for the same reason: this is a per-run
    ///      assertion, and 64 calls put "a run that draws no amendment at all" below one in a million.
    ///      See docs/compatibility-notes.md.
    function afterInvariant() public view {
        if (handler.totalCalls() == 0) return;
        assertGt(handler.amendSuccesses(), 0, "run landed no AMEND_CHARTER decision");
        assertGt(handler.directWriteAttempts(), 0, "run attempted no direct ledger write");
    }
}
