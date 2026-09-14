// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {NaiveLedger} from "./fixtures/NaiveLedger.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";

/// @notice NOT FOR DEPLOYMENT. Negative demonstration: what onlyTimelock protects against that a
///         frontend cannot.
/// @dev A UI that only shows a "record decision" button to the timelock, or only calls
///      recordDecision after a proposal has passed, protects nothing on its own: anyone can skip
///      the UI and call the contract directly. NaiveLedger has TaskLedger.recordDecision's shape
///      with the onlyTimelock modifier removed, and accepts a call from any address. The real
///      TaskLedger, with that modifier in place, rejects the identical call from the identical
///      caller with NotTimelock. The check has to live in the contract; it cannot live only in
///      whatever client happens to be pointed at it.
contract FrontendOnlyTest is Test {
    address internal timelock = makeAddr("timelock");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal outsider = makeAddr("outsider");
    string internal charter = '{"schema":"fleet.charter.v1","goal":"pass tests"}';

    function test_NaiveLedgerAcceptsRecordDecisionFromAnyone() public {
        NaiveLedger naive = new NaiveLedger();

        vm.prank(outsider);
        uint256 taskId = naive.openTask();

        vm.prank(outsider);
        naive.recordDecision(taskId, 0, 1, keccak256("x"), "", "no gate at all");

        // The bad outcome: an arbitrary caller recorded a decision with no boundary in the way.
        assertEq(naive.decisionCount(taskId), 1);
    }

    /// @notice Real-contract contrast: the identical direct call against TaskLedger, where
    ///         onlyTimelock is still in place.
    function test_RealTaskLedgerRejectsSameCallFromSameCaller() public {
        TaskLedger real = new TaskLedger(timelock, operator, guardian, 7200);
        vm.prank(operator);
        uint256 taskId = real.openTask(charter, 3600);

        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotTimelock.selector, outsider));
        real.recordDecision(taskId, 0, 1, keccak256("x"), "", "no gate at all");
    }
}
