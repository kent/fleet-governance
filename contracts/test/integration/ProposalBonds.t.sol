// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetBondHook} from "../../src/FleetBondHook.sol";
import {FleetBondVotes} from "../../src/FleetBondVotes.sol";
import {FleetProposalBonds} from "../../src/FleetProposalBonds.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";

contract ProposalBondsTest is FleetFixture {
    FleetProposalBonds bank;
    FleetBondVotes bondedToken;
    uint256 task;
    uint256 constant BOND = 0.1e18;

    function useProposalBonds() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        bank = FleetBondHook(address(hook)).proposalBonds();
        bondedToken = FleetBondVotes(address(token));
        task = openTask();
        register(task, 6000);
    }

    function register(uint256 taskId, uint16 participation) internal {
        vm.prank(operator);
        bank.registerRunPolicy(
            taskId,
            keccak256(abi.encode(taskId)),
            uint64(block.timestamp + MAX_LIFETIME),
            BOND,
            1e18,
            60,
            participation,
            members
        );
    }

    function propose(uint256 agent, string memory label) internal returns (uint256 pid) {
        (pid,,,) = proposeDecision(
            agent, actionCalldata(task, 1, 1, keccak256(bytes(label)), "", label), string.concat(label, DESC_SUFFIX)
        );
    }

    function cancel(uint256 agent, uint256 pid, string memory label) internal {
        (address[] memory t, uint256[] memory v, bytes[] memory c) =
            singleAction(actionCalldata(task, 1, 1, keccak256(bytes(label)), "", label));
        vm.prank(members[agent]);
        governor.cancel(t, v, c, keccak256(bytes(string.concat(label, DESC_SUFFIX))));
        assertEq(uint8(governor.state(pid)), uint8(IGovernor.ProposalState.Canceled));
    }

    function testBondUsesSameTokenAndPreservesSnapshotVotingPower() public {
        uint256 pid = propose(0, "read diagnostics");
        assertEq(address(bank.token()), address(governor.token()));
        assertEq(token.totalSupply(), 5e18);
        assertEq(token.balanceOf(members[0]), 1e18);
        assertEq(bondedToken.available(members[0]), 0.9e18);
        assertEq(bondedToken.bonded(members[0]), BOND);
        assertEq(token.getVotes(members[0]), 1e18);
        warpToActive(pid);
        vote(0, pid, AGAINST, "My own request conflicts with the charter.");
        (uint256 againstVotes,,) = governor.proposalVotes(pid);
        assertEq(againstVotes, 1e18);
    }

    /// Any agent with voting power can move to stop the fleet. The motion is an ordinary bonded
    /// proposal whose kind the hook records onchain, which is what the Guardian reads.
    function testAnyAgentCanMoveToStopTheFleetAndAPassedMotionStopsTheTask() public {
        string memory label = "stop the fleet";
        bytes memory data = actionCalldata(task, uint8(TaskLedger.DecisionKind.STOP_TASK), 1, keccak256(bytes(label)), "", label);
        string memory description = string.concat(label, DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(3, data, description);
        assertEq(bondedToken.bonded(members[3]), BOND);
        // One unsettled proposal per agent applies to stop motions too.
        vm.warp(block.timestamp + 61);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        propose(3, "second motion");

        warpToActive(pid);
        vote(0, pid, FOR, "We are drifting outside the charter.");
        vote(1, pid, FOR, "Agree, stop.");
        vote(3, pid, FOR, "My motion.");
        vote(2, pid, AGAINST, "The work is still in scope.");
        vote(4, pid, AGAINST, "Keep going.");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));
        queueAs(keeper, t, v, c, description);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
        assertEq(uint8(ledger.getTask(task).state), uint8(TaskLedger.TaskState.Stopped));
        assertEq(uint8(ledger.getDecision(task, 0).kind), uint8(TaskLedger.DecisionKind.STOP_TASK));
        assertEq(bank.settle(pid), 1);
        assertEq(bondedToken.available(members[3]), 1e18);
    }

    function testAllAgainstRefundsAfterWellAttendedDefeat() public {
        uint256 pid = propose(0, "request disputed scope");
        warpToActive(pid);
        for (uint256 i; i < N; ++i) {
            vote(i, pid, AGAINST, "Outside the charter.");
        }
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
        vm.prank(outsider);
        assertEq(bank.settle(pid), 1);
        assertEq(bondedToken.available(members[0]), 1e18);
        assertEq(token.getVotes(members[0]), 1e18);
        assertEq(bank.settle(pid), 1); // No double refund.
    }

    function testForAgainstAndAbstainAllCountAsParticipation() public {
        uint256 pid = propose(0, "mixed review");
        warpToActive(pid);
        vote(0, pid, FOR, "Limited request.");
        vote(1, pid, AGAINST, "Concern.");
        vote(2, pid, ABSTAIN, "Uncertain.");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
        assertEq(bank.settle(pid), 1);
        assertEq(bondedToken.totalBonded(), 0);
    }

    function testApprovalRefundsWithoutRequiringExecution() public {
        uint256 pid = propose(0, "approved read");
        warpToActive(pid);
        for (uint256 i; i < 3; ++i) {
            vote(i, pid, FOR, "Within scope.");
        }
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));
        assertEq(bank.settle(pid), 1);
    }

    function testInsufficientParticipationForfeitsActualTokensAndFutureVotes() public {
        uint256 pid = propose(0, "unattended request");
        warpToActive(pid);
        vote(0, pid, AGAINST, "Withdraw my support.");
        warpPastDeadline(pid);
        assertEq(bank.settle(pid), 2);
        assertEq(token.balanceOf(members[0]), 0.9e18);
        assertEq(token.balanceOf(address(bank)), BOND);
        assertEq(token.getVotes(members[0]), 0.9e18);
        assertEq(token.getVotes(address(bank)), 0);
        assertEq(token.getPastVotes(members[0], governor.proposalSnapshot(pid)), 1e18);
        assertEq(token.totalSupply(), 5e18);
        assertEq(bank.settle(pid), 2);
        assertEq(token.balanceOf(address(bank)), BOND);
    }

    function testCancellationForfeitsAndCooldownCannotBeBypassed() public {
        uint256 pid = propose(0, "cancelled request");
        cancel(0, pid, "cancelled request");
        assertEq(bank.settle(pid), 2);
        // Delegate support back to the penalised agent; it still cannot bypass cooldown.
        vm.prank(members[1]);
        token.delegate(members[0]);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        propose(0, "repeated spam");
        vm.warp(block.timestamp + 60);
        propose(0, "later request");
        assertEq(bondedToken.bonded(members[0]), BOND);
    }

    function testActiveBondCannotBeReturnedByAgentOrOperator() public {
        uint256 pid = propose(0, "still pending");
        vm.expectRevert(FleetProposalBonds.VotingNotFinished.selector);
        bank.settle(pid);
        vm.prank(operator);
        vm.expectRevert(FleetBondVotes.NotBondController.selector);
        bondedToken.resolveBond(members[0], BOND, false);
        vm.prank(members[0]);
        vm.expectRevert(FleetBondVotes.NotBondController.selector);
        bondedToken.resetExperimentBalance(members[0]);
        vm.prank(operator);
        vm.expectRevert(FleetProposalBonds.BondsOutstanding.selector);
        bank.closeRun(task);
    }

    function testOneUnsettledProposalAndAtomicRevert() public {
        propose(0, "one active");
        vm.expectRevert(Hooks.HookCallFailed.selector);
        propose(0, "second active");
        assertEq(bank.proposalCount(task), 1);
        assertEq(bondedToken.totalBonded(), BOND);
        assertEq(bondedToken.available(members[0]), 0.9e18);
    }

    function testNewRunRedistributesExistingSupplyOnlyAfterExplicitClosure() public {
        uint256 pid = propose(0, "cancel and reset");
        cancel(0, pid, "cancel and reset");
        bank.settle(pid);
        uint256 next = openTask();
        vm.expectRevert(FleetProposalBonds.PreviousRunOpen.selector);
        register(next, 6000);
        vm.prank(members[0]);
        vm.expectRevert(FleetProposalBonds.NotOperator.selector);
        bank.closeRun(task);
        vm.prank(operator);
        bank.closeRun(task);
        register(next, 6000);
        assertEq(token.totalSupply(), 5e18);
        assertEq(token.balanceOf(members[0]), 1e18);
        assertEq(token.balanceOf(address(bank)), 0);
        assertEq(bondedToken.forfeited(members[0]), 0);
        vm.warp(block.timestamp + 60);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        propose(1, "old run cannot reopen");
        vm.expectRevert(FleetProposalBonds.RunAlreadyRegistered.selector);
        register(task, 6000);
    }

    function testNoMintTransferOrArbitraryBondAuthority() public {
        vm.prank(members[0]);
        (bool minted,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", members[0], 10e18));
        assertFalse(minted);
        vm.prank(members[0]);
        vm.expectRevert(FleetVotes.TransfersDisabled.selector);
        token.transfer(members[1], 1);
        vm.prank(operator);
        vm.expectRevert(FleetProposalBonds.NotHook.selector);
        bank.bond(task, 123, members[0]);
        vm.prank(members[0]);
        vm.expectRevert(FleetBondVotes.NotBondController.selector);
        bondedToken.lockBond(members[1], BOND);
        vm.expectRevert(FleetBondVotes.InvalidBondController.selector);
        bondedToken.bindBondController(address(bank));
    }

    function testOnlyRecordedParticipantsCanPayBond() public {
        vm.prank(operator);
        bank.closeRun(task);
        uint256 next = openTask();
        address[] memory active = new address[](3);
        for (uint256 i; i < 3; ++i) {
            active[i] = members[i];
        }
        vm.prank(operator);
        bank.registerRunPolicy(
            next, keccak256("three"), uint64(block.timestamp + MAX_LIFETIME), BOND, 1e18, 60, 6000, active
        );
        task = next;
        vm.expectRevert(Hooks.HookCallFailed.selector);
        propose(4, "inactive member");
        assertEq(bank.proposalCount(next), 0);
    }

    function testFuzzParticipationRefundIsIndependentOfForAgainstSplit(uint8 yes, uint8 no, uint8 abstain) public {
        uint256 y = bound(yes, 0, N);
        uint256 n = bound(no, 0, N - y);
        uint256 a = bound(abstain, 0, N - y - n);
        uint256 pid = propose(0, "participation fuzz");
        warpToActive(pid);
        for (uint256 i; i < y + n + a; ++i) {
            vote(i, pid, i < y ? FOR : i < y + n ? AGAINST : ABSTAIN, "Independent review.");
        }
        warpPastDeadline(pid);
        assertEq(bank.settle(pid), y + n + a >= 3 ? 1 : 2);
        assertEq(token.totalSupply(), 5e18);
        assertEq(bondedToken.totalBonded(), 0);
    }
}
