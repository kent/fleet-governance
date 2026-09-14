// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetExecutor} from "../../src/FleetExecutor.sol";
import {GovernedArtifactStore} from "../../src/GovernedArtifactStore.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract RejectingResource {
    bool public reject = true;
    uint256 public calls;
    function allow() external { reject = false; }
    function work() external { require(!reject, "retry later"); calls++; }
}

contract ReentrantResource {
    FleetExecutor immutable executor;
    bytes public nestedCall;
    bool public nestedSucceeded;
    bytes4 public nestedError;
    constructor(FleetExecutor executor_) { executor = executor_; }
    function setNestedCall(bytes calldata data) external { nestedCall = data; }
    function work() external {
        bytes memory result;
        (nestedSucceeded, result) = address(executor).call(nestedCall);
        if (!nestedSucceeded && result.length >= 4) nestedError = bytes4(result);
    }
}

contract ExecutionTest is FleetFixture {
    FleetExecutor executor;
    GovernedArtifactStore store;
    bytes32 constant DIGEST = keccak256("reviewed artifact");

    function setUp() public override {
        super.setUp();
        executor = FleetExecutor(addrs.executor);
        store = GovernedArtifactStore(addrs.artifactStore);
    }

    function _data() internal pure returns (bytes memory) { return abi.encodeCall(GovernedArtifactStore.publish, (DIGEST)); }

    function _permit(uint256 taskId) internal view returns (FleetExecutor.Permit memory) {
        return FleetExecutor.Permit({ taskId: taskId, charterVersion: 1, actor: members[0], target: address(store),
            targetCodeHash: address(store).codehash, dataHash: keccak256(_data()), nonce: 7, deadline: uint64(block.timestamp + 3000) });
    }

    function _record(uint256 taskId, uint8 kind, uint32 version, bytes32 hash, string memory text, bool approve)
        internal returns (uint256 pid)
    {
        bytes memory data = actionCalldata(taskId, kind, version, hash, text, "exact capability decision");
        string memory description = string.concat(vm.toString(hash), vm.toString(kind), vm.toString(ledger.decisionCount(taskId)), DESC_SUFFIX);
        address[] memory targets;
        uint256[] memory values;
        bytes[] memory calldatas;
        (pid, targets, values, calldatas) = proposeDecision(0, data, description);
        warpToActive(pid);
        for (uint256 i; i < N; i++) {
            bool yes = approve ? i < 3 : i < 2;
            vote(i, pid, yes ? FOR : AGAINST, yes ? "Approve this exact bounded capability." : "The proposed capability is outside the task's authorized work.");
        }
        warpPastDeadline(pid);
        if (approve) {
            queueAs(keeper, targets, values, calldatas, description);
            vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
            executeAs(keeper, targets, values, calldatas, description);
        } else assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
    }

    function _grant(FleetExecutor.Permit memory p) internal { _record(p.taskId, 1, p.charterVersion, executor.hashPermit(p), "", true); }
    function _execute(FleetExecutor.Permit memory p, bytes memory data) internal { vm.prank(p.actor); executor.execute(p, data); }
    function _notApproved(FleetExecutor.Permit memory p) internal {
        bytes32 hash = executor.hashPermit(p);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NotApproved.selector, hash));
        vm.prank(p.actor);
        executor.execute(p, _data());
    }

    function test_DefeatedCapabilityCannotPublishButApprovedExactCallCan() public {
        uint256 taskId = openTask();
        FleetExecutor.Permit memory p = _permit(taskId);
        _record(taskId, 1, 1, executor.hashPermit(p), "", false);
        _notApproved(p);
        (bytes32 digest, uint64 revision) = store.artifacts(taskId);
        assertEq(digest, bytes32(0)); assertEq(revision, 0);

        // A new proposal and a new capability are independently voted through the same fleet.
        p.nonce++;
        _grant(p);
        _execute(p, _data());
        (digest, revision) = store.artifacts(taskId);
        assertEq(digest, DIGEST); assertEq(revision, 1);
        assertTrue(executor.consumed(executor.hashPermit(p)));
        assertEq(executor.activeTaskId(), 0);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.AlreadyConsumed.selector, executor.hashPermit(p)));
        vm.prank(p.actor); executor.execute(p, _data());
    }

    function test_PendingAndQueuedVotesAreNotExecutionAuthority() public {
        FleetExecutor.Permit memory p = _permit(openTask());
        bytes memory data = actionCalldata(p.taskId, 1, 1, executor.hashPermit(p), "", "approve publication");
        string memory description = string.concat("pending capability", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        _notApproved(p);
        warpToActive(pid);
        for (uint256 i; i < 3; i++) vote(i, pid, FOR, "approve after the timelock");
        warpPastDeadline(pid);
        _notApproved(p);
        queueAs(keeper, t, v, c, description);
        _notApproved(p);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
        _execute(p, _data());
    }

    /// @dev All outcomes use actual governor ballots and the production quorum hook. No fixture
    ///      writes an exception directly or treats a missing ballot as implicit approval.
    function _assertNoApproval(uint256 yesCount, uint256 noCount, uint256 abstainCount) internal {
        FleetExecutor.Permit memory p = _permit(openTask());
        bytes memory data = actionCalldata(p.taskId, 1, 1, executor.hashPermit(p), "", "publication requires approval");
        string memory description = string.concat("no implicit approval", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        warpToActive(pid);
        for (uint256 i; i < yesCount + noCount + abstainCount; i++) {
            uint8 support = i < yesCount ? FOR : i < yesCount + noCount ? AGAINST : ABSTAIN;
            vote(i, pid, support, support == FOR ? "Approve this exact publication." : "Do not grant publication authority.");
        }
        _notApproved(p);
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
        vm.expectRevert();
        governor.queue(t, v, c, descHash(description));
        _notApproved(p);
        (bytes32 digest, uint64 revision) = store.artifacts(p.taskId);
        assertEq(digest, bytes32(0));
        assertEq(revision, 0);
        assertFalse(executor.consumed(executor.hashPermit(p)));
    }

    function test_NoBallotsCannotAuthorizeExecution() public { _assertNoApproval(0, 0, 0); }
    function test_YesVoteWithoutQuorumCannotAuthorizeExecution() public { _assertNoApproval(1, 0, 0); }
    function test_AllAbstainCannotAuthorizeExecution() public { _assertNoApproval(0, 0, 5); }
    function test_TiedVoteCannotAuthorizeExecution() public { _assertNoApproval(2, 2, 1); }

    function test_OperatorGuardianMembersAndOutsiderCannotWriteResourceDirectly() public {
        address[4] memory callers = [operator, guardian, members[0], outsider];
        for (uint256 i; i < callers.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(GovernedArtifactStore.NotExecutor.selector, callers[i]));
            vm.prank(callers[i]); store.publish(DIGEST);
        }
        FleetExecutor.Permit memory p = _permit(openTask());
        _grant(p);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NotActor.selector, members[1]));
        vm.prank(members[1]); executor.execute(p, _data());
        bytes32 hash = executor.hashPermit(p);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NotGuardian.selector, operator));
        vm.prank(operator); executor.revoke(hash);
    }

    function test_ChangedCallTargetActorNonceDeadlineAndTaskCannotReuseApproval() public {
        FleetExecutor.Permit memory p = _permit(openTask());
        _grant(p);
        vm.expectRevert(FleetExecutor.CalldataMismatch.selector);
        vm.prank(p.actor); executor.execute(p, abi.encodeCall(GovernedArtifactStore.publish, (keccak256("changed"))));
        p.dataHash = keccak256(abi.encodeCall(GovernedArtifactStore.publish, (keccak256("changed"))));
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NotApproved.selector, executor.hashPermit(p)));
        vm.prank(p.actor); executor.execute(p, abi.encodeCall(GovernedArtifactStore.publish, (keccak256("changed"))));
        p.dataHash = keccak256(_data());
        p.nonce++; _notApproved(p); p.nonce--;
        p.deadline--; _notApproved(p); p.deadline++;
        p.actor = members[1]; _notApproved(p); p.actor = members[0];
        GovernedArtifactStore other = new GovernedArtifactStore(address(executor));
        p.target = address(other); p.targetCodeHash = address(other).codehash; _notApproved(p);
        p.target = address(store); p.targetCodeHash = address(store).codehash;
        uint256 originalTask = p.taskId;
        p.taskId = openTask(); _notApproved(p); p.taskId = originalTask;
        _execute(p, _data());
        (, uint64 untouched) = other.artifacts(p.taskId); assertEq(untouched, 0);
    }

    function test_ApprovalCannotCrossExecutorOrChain() public {
        FleetExecutor.Permit memory p = _permit(openTask());
        _grant(p);
        FleetExecutor other = new FleetExecutor(hook);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NotApproved.selector, other.hashPermit(p)));
        vm.prank(p.actor); other.execute(p, _data());
        uint256 original = block.chainid;
        vm.chainId(original + 1); _notApproved(p); vm.chainId(original);
        _execute(p, _data());
    }

    function test_GuardianPauseAndPermanentRevocationBlockApprovedCapability() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        vm.prank(guardian); ledger.pause();
        vm.expectRevert(FleetExecutor.LedgerPaused.selector); vm.prank(p.actor); executor.execute(p, _data());
        vm.prank(guardian); ledger.unpause();
        bytes32 hash = executor.hashPermit(p);
        vm.prank(guardian); executor.revoke(hash);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.PermitRevoked.selector, hash));
        vm.prank(p.actor); executor.execute(p, _data());
        assertFalse(executor.consumed(hash));
    }

    function test_CharterAmendmentInvalidatesExistingCapability() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        string memory replacement = "charter version two";
        _record(p.taskId, 2, 1, keccak256(bytes(replacement)), replacement, true);
        vm.expectRevert(FleetExecutor.CharterVersionMismatch.selector); vm.prank(p.actor); executor.execute(p, _data());
        p.charterVersion = 2; _notApproved(p);
    }

    function test_EscalationSuspendsAnExistingCapability() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        bytes32 hash = executor.hashPermit(p);
        _record(p.taskId, 4, 1, hash, "", true);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.Escalated.selector, hash));
        vm.prank(p.actor); executor.execute(p, _data());
    }

    function test_ExpiredPermitCannotExecute() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        vm.warp(p.deadline);
        vm.expectRevert(FleetExecutor.Expired.selector); vm.prank(p.actor); executor.execute(p, _data());
    }

    function test_ApprovedNonmemberHasNoExecutionAuthority() public {
        FleetExecutor.Permit memory p = _permit(openTask()); p.actor = outsider; _grant(p);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NotMember.selector, outsider));
        vm.prank(outsider); executor.execute(p, _data());
    }

    function test_CompletedAndExpiredTasksInvalidateApprovedAuthority() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        vm.prank(operator); ledger.completeTask(p.taskId);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.TaskNotOpen.selector, p.taskId));
        vm.prank(p.actor); executor.execute(p, _data());
        p = _permit(openTask()); p.deadline = ledger.getTask(p.taskId).expiresAt; _grant(p);
        vm.warp(p.deadline);
        vm.expectRevert(FleetExecutor.Expired.selector);
        vm.prank(p.actor); executor.execute(p, _data());
    }

    function test_ClosedTaskCannotExecuteAnApprovedPermit() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        _record(p.taskId, 3, 1, bytes32(0), "", true);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.TaskNotOpen.selector, p.taskId));
        vm.prank(p.actor); executor.execute(p, _data());
    }

    function test_ChangedTargetCodeCannotExecute() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p);
        vm.etch(p.target, hex"00");
        vm.expectRevert(FleetExecutor.TargetCodeMismatch.selector); vm.prank(p.actor); executor.execute(p, _data());
    }

    function test_TargetRevertDoesNotConsumePermitOrNonce() public {
        RejectingResource target = new RejectingResource();
        FleetExecutor.Permit memory p = _permit(openTask());
        bytes memory data = abi.encodeCall(RejectingResource.work, ());
        p.target = address(target); p.targetCodeHash = address(target).codehash; p.dataHash = keccak256(data);
        _grant(p);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.TargetCallFailed.selector, abi.encodeWithSignature("Error(string)", "retry later")));
        vm.prank(p.actor); executor.execute(p, data);
        assertFalse(executor.consumed(executor.hashPermit(p))); assertFalse(executor.usedNonces(p.actor, p.nonce));
        assertEq(executor.activeTaskId(), 0);
        target.allow(); _execute(p, data); assertEq(target.calls(), 1);
    }

    function test_ReentrantExecutionCannotUseAnotherCapability() public {
        ReentrantResource target = new ReentrantResource(executor);
        FleetExecutor.Permit memory p = _permit(openTask());
        bytes memory data = abi.encodeCall(ReentrantResource.work, ());
        target.setNestedCall(abi.encodeCall(FleetExecutor.execute, (p, _data())));
        p.target = address(target); p.targetCodeHash = address(target).codehash; p.dataHash = keccak256(data);
        _grant(p); _execute(p, data);
        assertFalse(target.nestedSucceeded()); assertEq(executor.activeTaskId(), 0);
        assertEq(target.nestedError(), FleetExecutor.ReentrantExecution.selector);
    }

    function test_DifferentApprovedPermitsCannotSpendTheSameActorNonceTwice() public {
        FleetExecutor.Permit memory p = _permit(openTask()); _grant(p); _execute(p, _data());
        p.deadline--;
        _grant(p);
        vm.expectRevert(abi.encodeWithSelector(FleetExecutor.NonceAlreadyUsed.selector, p.actor, p.nonce));
        vm.prank(p.actor); executor.execute(p, _data());
    }
}
