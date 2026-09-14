// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {ActionId} from "../../src/libraries/ActionId.sol";

contract TaskLedgerTest is Test {
    address timelock = makeAddr("timelock");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address outsider = makeAddr("outsider");
    TaskLedger ledger;
    string charter = '{"schema":"fleet.charter.v1","goal":"pass tests"}';

    function setUp() public {
        vm.warp(1_800_000_000);
        ledger = new TaskLedger(timelock, operator, guardian, 7200);
    }

    function _open() internal returns (uint256) {
        vm.prank(operator);
        return ledger.openTask(charter, 3600);
    }

    function _record(
        uint256 taskId,
        uint8 kind,
        uint32 version,
        bytes32 payloadHash,
        string memory text,
        string memory summary
    ) internal {
        vm.prank(timelock);
        ledger.recordDecision(taskId, kind, version, payloadHash, text, summary);
    }

    function test_ConstructorRejectsZeroAndShortLifetime() public {
        vm.expectRevert(TaskLedger.ZeroAddress.selector);
        new TaskLedger(address(0), operator, guardian, 7200);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.LifetimeOutOfRange.selector, 299, 300, type(uint64).max));
        new TaskLedger(timelock, operator, guardian, 299);
    }

    function test_OpenTaskStoresCharterVersion1() public {
        vm.expectEmit(true, true, false, true);
        emit TaskLedger.TaskOpened(1, operator, uint64(block.timestamp + 3600), keccak256(bytes(charter)), charter);
        uint256 id = _open();
        assertEq(id, 1);
        TaskLedger.Task memory t = ledger.getTask(1);
        assertEq(uint8(t.state), uint8(TaskLedger.TaskState.Open));
        assertEq(t.charterVersion, 1);
        assertEq(t.charterHash, keccak256(bytes(charter)));
        assertEq(t.expiresAt, block.timestamp + 3600);
        assertEq(t.decisionCount, 0);
        assertEq(ledger.charterText(1), charter);
        assertEq(ledger.taskCount(), 1);
    }

    function test_OpenTaskOnlyOperator() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotOperator.selector, outsider));
        ledger.openTask(charter, 3600);
    }

    function test_OpenTaskBounds() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterTextLengthOutOfRange.selector, 0));
        ledger.openTask("", 3600);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterTextLengthOutOfRange.selector, 8193));
        ledger.openTask(new string(8193), 3600);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.LifetimeOutOfRange.selector, 299, 300, 7200));
        ledger.openTask(charter, 299);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.LifetimeOutOfRange.selector, 7201, 300, 7200));
        ledger.openTask(charter, 7201);
        vm.stopPrank();
    }

    function test_RecordDecisionOnlyTimelock() public {
        uint256 id = _open();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotTimelock.selector, operator));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
    }

    function test_ChoosePathRecordsWithoutVersionChange() public {
        uint256 id = _open();
        bytes32 payload = keccak256("path-a");
        bytes32 actionId = ActionId.compute(address(ledger), id, 0, 1, payload);
        vm.expectEmit(true, true, false, true);
        emit TaskLedger.DecisionRecorded(
            id, 0, TaskLedger.DecisionKind.CHOOSE_PATH, 1, 1, payload, actionId, "take path a"
        );
        _record(id, 0, 1, payload, "", "take path a");
        TaskLedger.Decision memory d = ledger.getDecision(id, 0);
        assertEq(d.actionId, actionId);
        assertEq(d.charterVersionBefore, 1);
        assertEq(d.charterVersionAfter, 1);
        assertEq(ledger.getTask(id).charterVersion, 1);
        assertEq(ledger.decisionCount(id), 1);
    }

    function test_GrantExceptionScopedToVersion() public {
        uint256 id = _open();
        bytes32 payload = keccak256("fetch examples.internal");
        _record(id, 1, 1, payload, "", "one-time exception");
        assertEq(ledger.exceptionVersion(id, payload), 1);
        // amend the charter, exception version no longer equals current version
        string memory newCharter = '{"schema":"fleet.charter.v1","goal":"pass tests","v":2}';
        _record(id, 2, 1, keccak256(bytes(newCharter)), newCharter, "amend");
        assertEq(ledger.getTask(id).charterVersion, 2);
        assertEq(ledger.exceptionVersion(id, payload), 1);
    }

    function test_AmendCharterBumpsVersionAndStoresText() public {
        uint256 id = _open();
        string memory newCharter = '{"goal":"new"}';
        bytes32 h = keccak256(bytes(newCharter));
        vm.expectEmit(true, false, false, true);
        emit TaskLedger.CharterAmended(id, 2, h, newCharter);
        _record(id, 2, 1, h, newCharter, "amend");
        TaskLedger.Task memory t = ledger.getTask(id);
        assertEq(t.charterVersion, 2);
        assertEq(t.charterHash, h);
        assertEq(ledger.charterText(id), newCharter);
        TaskLedger.Decision memory d = ledger.getDecision(id, 0);
        assertEq(d.charterVersionBefore, 1);
        assertEq(d.charterVersionAfter, 2);
    }

    function test_AmendRequiresMatchingHashAndText() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterTextLengthOutOfRange.selector, 0));
        ledger.recordDecision(id, 2, 1, keccak256(""), "", "amend");
        vm.prank(timelock);
        vm.expectRevert(
            abi.encodeWithSelector(TaskLedger.CharterHashMismatch.selector, bytes32(uint256(1)), keccak256("abc"))
        );
        ledger.recordDecision(id, 2, 1, bytes32(uint256(1)), "abc", "amend");
    }

    function test_NonAmendRejectsCharterText() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(TaskLedger.CharterTextNotAllowed.selector);
        ledger.recordDecision(id, 0, 1, bytes32(0), "abc", "x");
    }

    function test_VersionMismatchRejected() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterVersionMismatch.selector, 2, 1));
        ledger.recordDecision(id, 0, 2, bytes32(0), "", "x");
    }

    function test_InvalidKindAndLongSummaryRejected() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.InvalidDecisionKind.selector, 5));
        ledger.recordDecision(id, 5, 1, bytes32(0), "", "x");
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.SummaryTooLong.selector, 1025));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", new string(1025));
    }

    function test_StopTaskClosesFurtherDecisions() public {
        uint256 id = _open();
        vm.expectEmit(true, false, false, true);
        emit TaskLedger.TaskStopped(id, 0);
        _record(id, 3, 1, bytes32(0), "", "stop");
        assertEq(uint8(ledger.getTask(id).state), uint8(TaskLedger.TaskState.Stopped));
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.TaskNotOpen.selector, id, TaskLedger.TaskState.Stopped));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
    }

    function test_EscalationIsPerPayloadAndUnrelatedDecisionsLeaveItOpen() public {
        uint256 id = _open();
        bytes32 disputed = keccak256("network_fetch|examples.internal");
        _record(id, 4, 1, disputed, "", "escalate");
        assertEq(ledger.escalationVersion(id, disputed), 1);
        assertEq(ledger.getTask(id).openEscalations, 1);

        // a decision on a different payload is a different question; the escalation stays open
        _record(id, 0, 1, keccak256("unrelated path"), "", "choose");
        assertEq(ledger.escalationVersion(id, disputed), 1);
        assertEq(ledger.getTask(id).openEscalations, 1);

        // nor does an amendment clear it: an amendment's payloadHash is the charter hash
        string memory newCharter = '{"goal":"new"}';
        _record(id, 2, 1, keccak256(bytes(newCharter)), newCharter, "amend");
        assertEq(ledger.getTask(id).charterVersion, 2);
        assertEq(ledger.escalationVersion(id, disputed), 1);
        assertEq(ledger.getTask(id).openEscalations, 1);

        // escalating the same payload again keeps the version it was first escalated at
        _record(id, 4, 2, disputed, "", "escalate again");
        assertEq(ledger.escalationVersion(id, disputed), 1);
        assertEq(ledger.getTask(id).openEscalations, 1);
    }

    function test_DecisionOnTheSamePayloadClearsThatEscalation() public {
        uint256 id = _open();
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        _record(id, 4, 1, a, "", "escalate a");
        _record(id, 4, 1, b, "", "escalate b");
        assertEq(ledger.getTask(id).openEscalations, 2);

        _record(id, 0, 1, a, "", "choose a, human answered");
        assertEq(ledger.escalationVersion(id, a), 0);
        assertEq(ledger.escalationVersion(id, b), 1);
        assertEq(ledger.getTask(id).openEscalations, 1);

        _record(id, 1, 1, b, "", "grant b instead");
        assertEq(ledger.escalationVersion(id, b), 0);
        assertEq(ledger.exceptionVersion(id, b), 1);
        assertEq(ledger.getTask(id).openEscalations, 0);
    }

    function test_ExpiryBlocksRecordingAndExpireTaskIsPermissionless() public {
        uint256 id = _open();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.TaskNotExpired.selector, id));
        ledger.expireTask(id);
        vm.warp(block.timestamp + 3600);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.TaskExpired.selector, id));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
        vm.prank(outsider);
        ledger.expireTask(id);
        assertEq(uint8(ledger.getTask(id).state), uint8(TaskLedger.TaskState.Expired));
    }

    function test_CompleteTaskOnlyOperator() public {
        uint256 id = _open();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotOperator.selector, outsider));
        ledger.completeTask(id);
        vm.prank(operator);
        ledger.completeTask(id);
        assertEq(uint8(ledger.getTask(id).state), uint8(TaskLedger.TaskState.Completed));
    }

    function test_PauseBlocksOpenAndRecord() public {
        uint256 id = _open();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotGuardian.selector, outsider));
        ledger.pause();
        vm.prank(guardian);
        ledger.pause();
        assertTrue(ledger.paused());
        vm.prank(operator);
        vm.expectRevert(TaskLedger.EnforcedPause.selector);
        ledger.openTask(charter, 3600);
        vm.prank(timelock);
        vm.expectRevert(TaskLedger.EnforcedPause.selector);
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
        vm.prank(guardian);
        vm.expectRevert(TaskLedger.EnforcedPause.selector);
        ledger.pause();
        vm.prank(guardian);
        ledger.unpause();
        assertFalse(ledger.paused());
        vm.prank(guardian);
        vm.expectRevert(TaskLedger.ExpectedPause.selector);
        ledger.unpause();
    }

    function test_UnknownLookupsRevert() public {
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.UnknownTask.selector, 9));
        ledger.getTask(9);
        uint256 id = _open();
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.UnknownDecision.selector, id, 0));
        ledger.getDecision(id, 0);
    }
}
