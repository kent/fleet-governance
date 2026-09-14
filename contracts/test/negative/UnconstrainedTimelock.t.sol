// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice NOT FOR DEPLOYMENT. Negative demonstration: what restricting timelock roles to the
///         governor alone prevents.
/// @dev FleetDeployer.deploy grants PROPOSER_ROLE, EXECUTOR_ROLE, and CANCELLER_ROLE on the
///      timelock only to the governor (CANCELLER_ROLE also goes to the guardian), then renounces
///      DEFAULT_ADMIN_ROLE. This builds a separate TimelockController the ordinary way, with a plain
///      EOA as both proposer and executor, and a fresh TaskLedger whose timelock is that controller.
///      The EOA schedules a TaskLedger.recordDecision call directly, waits out the delay, then
///      executes it itself: a decision lands on the ledger with no proposal, no vote, and no
///      collective process behind it at all, just one account and a timer. Only the governor
///      holding those roles is what makes a recorded decision mean "the fleet decided."
contract UnconstrainedTimelockTest is FleetFixture {
    address internal eoaProposer = makeAddr("eoaProposer");
    address internal eoaExecutor = makeAddr("eoaExecutor");
    address internal looseOperator = makeAddr("looseOperator");
    address internal looseGuardian = makeAddr("looseGuardian");

    function test_EoaSchedulesAndExecutesDecisionWithNoVote() public {
        address[] memory proposers = new address[](1);
        proposers[0] = eoaProposer;
        address[] memory executors = new address[](1);
        executors[0] = eoaExecutor;
        TimelockController looseTimelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(this));

        TaskLedger looseLedger = new TaskLedger(address(looseTimelock), looseOperator, looseGuardian, MAX_LIFETIME);

        vm.prank(looseOperator);
        uint256 taskId = looseLedger.openTask(CHARTER, MAX_LIFETIME);

        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("unconstrained"), "", "no vote behind this");
        address[] memory t = new address[](1);
        t[0] = address(looseLedger);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        c[0] = data;
        bytes32 salt = keccak256("uct-salt");

        vm.prank(eoaProposer);
        looseTimelock.scheduleBatch(t, v, c, bytes32(0), salt, TIMELOCK_DELAY);

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);

        vm.prank(eoaExecutor);
        looseTimelock.executeBatch(t, v, c, bytes32(0), salt);

        // The bad outcome: a decision is recorded with no proposal and no vote ever cast.
        assertEq(looseLedger.decisionCount(taskId), 1);
    }

    /// @notice Real-contract contrast: the same EOA against the pinned timelock, which only ever
    ///         granted PROPOSER_ROLE to the real governor. scheduleBatch reverts before the ledger
    ///         is ever touched.
    function test_RealTimelockRejectsEoaProposer() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        bytes32 salt = keccak256("real-salt");

        // Read the role hash before pranking: a single vm.prank only covers the very next call, and
        // that call must be scheduleBatch itself, not this lookup.
        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        vm.prank(eoaProposer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, eoaProposer, proposerRole)
        );
        timelock.scheduleBatch(t, v, c, bytes32(0), salt, TIMELOCK_DELAY);
    }
}
