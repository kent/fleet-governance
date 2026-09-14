// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract AdmissionTest is FleetFixture {
    uint256 taskId;
    bytes data;
    string description;

    function setUp() public override {
        super.setUp();
        taskId = openTask();
        data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        description = string.concat("ok", DESC_SUFFIX);
    }

    // Agora's Hooks.callHook collapses every hook revert into a bare HookCallFailed() (it does not bubble
    // the inner error data despite the ERC-7751 doc comment on the error; see docs/compatibility-notes.md).
    // Rejections that originate inside FleetHook (beforePropose/beforeVote) assert on that selector so the
    // test proves the hook is the cause; rejections that originate in the governor or OpenZeppelin itself
    // stay bare or use the specific OZ selector.

    function test_ImpostorCannotPropose() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        vm.prank(outsider);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);
    }

    function test_ImpostorCannotVote() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vm.prank(outsider);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVoteWithReason(pid, FOR, "i am not a member");
        vm.prank(outsider);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVote(pid, FOR);
    }

    function test_EmptyReasonRejected() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vm.prank(members[1]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVote(pid, FOR);
        vm.prank(members[1]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVoteWithReason(pid, FOR, "");
        vm.prank(members[1]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVoteWithReason(pid, FOR, new string(1025));
        vm.prank(members[1]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.castVoteWithReasonAndParams(pid, FOR, "reason", hex"01");
    }

    function test_DoubleVoteRejected() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(1, pid, FOR, "for");
        vm.prank(members[1]);
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorAlreadyCastVote.selector, members[1]));
        governor.castVoteWithReason(pid, AGAINST, "changed my mind");
    }

    function test_ForbiddenTargetsRejected() public {
        address[] memory forbidden = new address[](5);
        forbidden[0] = address(governor);
        forbidden[1] = address(timelock);
        forbidden[2] = address(token);
        forbidden[3] = address(registry);
        forbidden[4] = address(hook);
        for (uint256 i = 0; i < forbidden.length; i++) {
            (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
            t[0] = forbidden[i];
            vm.prank(members[0]);
            vm.expectRevert(Hooks.HookCallFailed.selector);
            governor.propose(t, v, c, description);
        }
        // governance settings and relay are unreachable even with ledger as target because the selector is wrong
        (address[] memory t2, uint256[] memory v2, bytes[] memory c2) = singleAction(abi.encodeCall(GovernorSettings.setVotingDelay, (1)));
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t2, v2, c2, description);
    }

    function test_MultipleActionsValueAndCalldataRejected() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        address[] memory t2 = new address[](2);
        uint256[] memory v2 = new uint256[](2);
        bytes[] memory c2 = new bytes[](2);
        t2[0] = t[0]; t2[1] = t[0]; c2[0] = data; c2[1] = data;
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t2, v2, c2, description);

        v[0] = 1;
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);
        v[0] = 0;

        c[0] = bytes.concat(data, hex"00");
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);

        c[0] = abi.encodeCall(TaskLedger.completeTask, (taskId));
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);
    }

    function test_DescriptionBounds() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, "");
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, new string(4097));
    }

    function test_StaleVersionPausedAndExpiredRejected() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(actionCalldata(taskId, 0, 2, keccak256("p"), "", "s"));
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);

        vm.prank(guardian);
        ledger.pause();
        (t, v, c) = singleAction(data);
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);
        vm.prank(guardian);
        ledger.unpause();

        // not enough time left: warp to within required window of expiry
        uint256 required = VOTING_DELAY + VOTING_PERIOD + TIMELOCK_DELAY + 60;
        uint64 expiresAt = ledger.getTask(taskId).expiresAt;
        if (expiresAt <= block.timestamp || expiresAt - block.timestamp <= required) {
            // a previous step advanced time far enough that this task's window already closed;
            // open a fresh task so the "not enough time left" check itself is what we exercise.
            taskId = openTask();
            (t, v, c) = singleAction(actionCalldata(taskId, 0, 1, keccak256("p"), "", "s"));
            expiresAt = ledger.getTask(taskId).expiresAt;
        }
        vm.warp(expiresAt - required + 1);
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, description);
    }

    // ---------------------------------------------------------------------
    // The one-proposal-per-member-per-task slot, and the noSelfCall trap underneath it
    // ---------------------------------------------------------------------

    /// @notice A proposal the fleet rule defeats must release its proposer's slot.
    /// @dev Regression for the noSelfCall defect. `afterPropose` asks the governor for the previous
    ///      proposal's state while the hook is the governor's msg.sender, and Agora's
    ///      `Hooks.noSelfCall` skips `beforeVoteSucceeded` for exactly that caller, so the governor
    ///      answers with stock OpenZeppelin counting. Under stock counting 2 For plus 1 Abstain
    ///      reaches the participation quorum and beats 0 Against, so it reads Succeeded, while every
    ///      other caller sees Defeated. The hook used to treat that as an unsettled proposal and lock
    ///      the member out of the task for the rest of its life. See docs/compatibility-notes.md.
    function test_FleetDefeatedProposalReleasesTheProposerSlot() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, ABSTAIN, "abstain");
        warpPastDeadline(pid);

        // Everyone outside the hook sees the fleet rule: For (2e18) never reaches quorum (3e18).
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
        // The hook, asking the same question as msg.sender, is answered with stock counting instead.
        vm.prank(address(hook));
        assertEq(uint8(governor.state(pid)), uint8(IGovernor.ProposalState.Succeeded));

        // The slot is free: the same member proposes again on the same task.
        (uint256 pid2,,,) = proposeDecision(0, data, string.concat("second try", DESC_SUFFIX));
        assertTrue(pid2 != pid);
        assertEq(hook.lastProposalOf(taskId, members[0]), pid2);
    }

    /// @notice The contrast: a genuinely succeeded proposal still holds the slot until it settles.
    function test_SucceededUnqueuedProposalStillBlocksTheProposerSlot() public {
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) =
            proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, FOR, "for");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));

        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, string.concat("second try", DESC_SUFFIX));
        assertEq(hook.lastProposalOf(taskId, members[0]), pid);

        // Queued holds the slot too, and executing releases it.
        queueAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));
        vm.prank(members[0]);
        vm.expectRevert(Hooks.HookCallFailed.selector);
        governor.propose(t, v, c, string.concat("third try", DESC_SUFFIX));

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Executed));
        (uint256 pid2,,,) = proposeDecision(0, data, string.concat("after execution", DESC_SUFFIX));
        assertEq(hook.lastProposalOf(taskId, members[0]), pid2);
    }

    function test_DirectLedgerWriteReverts() public {
        vm.prank(members[0]);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotTimelock.selector, members[0]));
        ledger.recordDecision(taskId, 0, 1, keccak256("p"), "", "s");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotTimelock.selector, guardian));
        ledger.recordDecision(taskId, 0, 1, keccak256("p"), "", "s");
    }

    function test_GuardianCannotScheduleOnTimelock() public {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        t[0] = address(ledger);
        c[0] = data;
        vm.prank(guardian);
        vm.expectRevert();
        timelock.scheduleBatch(t, v, c, bytes32(0), bytes32(0), TIMELOCK_DELAY);
        // read the role constant before pranking: vm.prank/vm.expectRevert bind to the very next call,
        // and timelock.PROPOSER_ROLE() is itself an external staticcall, so evaluating it inline as an
        // argument would consume the prank and the expectRevert on that harmless view call instead of
        // on grantRole (observed live with -vvvv: PROPOSER_ROLE() ran as the pranked call and grantRole
        // then executed unpranked, as this test contract, and did not revert).
        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        vm.prank(guardian);
        vm.expectRevert();
        timelock.grantRole(proposerRole, guardian);
    }
}
