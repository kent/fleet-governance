// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {HookMiner} from "../../src/deploy/HookMiner.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract FleetHookTest is Test {
    address[] members;
    string[] manifests;
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address outsider = makeAddr("outsider");
    FleetRegistry registry;
    FleetVotes token;
    TaskLedger ledger;
    TimelockController timelock;
    FleetHook hook;
    AgoraGovernor governor;

    function setUp() public {
        vm.warp(1_800_000_000);
        for (uint256 i = 0; i < 5; i++) {
            members.push(makeAddr(string.concat("agent", vm.toString(i))));
            manifests.push("{}");
        }
        registry = new FleetRegistry(members, manifests, "{}");
        token = new FleetVotes("Fleet Vote", "FLEET", registry);
        address[] memory none = new address[](0);
        timelock = new TimelockController(30, none, none, address(this));
        ledger = new TaskLedger(address(timelock), operator, guardian, 7200);
        // 0x22C0 mirrors FleetHook.PERMISSION_MASK. A contract's public constant is not reachable via
        // ContractName.CONSTANT (only type(X).creationCode/runtimeCode/name and library constants are);
        // reading it would need a deployed instance, which does not exist yet while mining the salt.
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this), 0x22C0, type(FleetHook).creationCode, abi.encode(registry, ledger, address(this))
        );
        hook = new FleetHook{salt: salt}(registry, ledger, address(this));
        assertEq(address(hook), predicted);
        // `new AgoraGovernor(..., IHooks(address(hook)))` does not typecheck here: AgoraGovernor.sol resolves
        // IHooks through the submodule's own context-scoped remapping ("src/interfaces/IHooks.sol"), which
        // solc treats as a distinct nominal type from any IHooks our own files import from outside
        // lib/agora-governor (confirmed with a minimal repro unrelated to FleetHook: the same "Invalid
        // implicit conversion from contract IHooks to contract IHooks" fires for a bare address argument).
        // ABI-encoding sidesteps it: constructor arguments of contract/interface type are encoded identically
        // to `address`, so deploying via the raw creation code plus ABI-encoded args is behaviorally identical
        // to `new AgoraGovernor(...)` and needs no IHooks value at all. See docs/compatibility-notes.md.
        governor = AgoraGovernor(
            payable(
                deployCode(
                    "AgoraGovernor.sol:AgoraGovernor",
                    abi.encode(
                        uint48(15),
                        uint32(120),
                        uint256(1e18),
                        uint256(6000),
                        address(token),
                        address(timelock),
                        address(0),
                        address(0),
                        address(hook)
                    )
                )
            )
        );
        hook.initialize(address(governor));
        vm.warp(block.timestamp + 1);
    }

    function test_PermissionMaskAndAddressBits() public view {
        assertEq(uint160(address(hook)) & 0xFFFF, 0x22C0);
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeVoteSucceeded && p.beforeVote && p.beforePropose && p.afterPropose);
        assertFalse(p.beforeQueue || p.afterQueue || p.beforeExecute || p.afterExecute || p.beforeCancel || p.afterCancel);
        assertFalse(p.beforeInitialize || p.afterInitialize || p.afterVote || p.afterVoteSucceeded || p.beforeQuorumCalculation || p.afterQuorumCalculation);
    }

    function test_PlainCreateDeploymentRevertsOnMask() public {
        vm.expectRevert();
        new FleetHook(registry, ledger, address(this));
    }

    function test_InitializeOnceByInitializerOnly() public {
        assertEq(address(hook.governor()), address(governor));
        vm.expectRevert(FleetHook.AlreadyInitialized.selector);
        hook.initialize(address(governor));
        (, bytes32 salt2) = HookMiner.find(
            address(this), 0x22C0, type(FleetHook).creationCode, abi.encode(registry, ledger, outsider)
        );
        FleetHook other = new FleetHook{salt: salt2}(registry, ledger, outsider);
        vm.expectRevert(abi.encodeWithSelector(FleetHook.NotInitializer.selector, address(this)));
        other.initialize(address(governor));
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(FleetHook.GovernorHookMismatch.selector, address(governor)));
        other.initialize(address(governor)); // governor.hooks() is `hook`, not `other`
    }

    function test_StateChangingHooksRejectNonGovernor() public {
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        vm.expectRevert(abi.encodeWithSelector(FleetHook.NotGovernor.selector, address(this)));
        hook.beforePropose(members[0], t, v, c, "x");
        vm.expectRevert(abi.encodeWithSelector(FleetHook.NotGovernor.selector, address(this)));
        hook.afterPropose(members[0], 1, t, v, c, "x");
        vm.expectRevert(abi.encodeWithSelector(FleetHook.NotGovernor.selector, address(this)));
        hook.beforeVote(members[0], 1, members[0], 1, "r", "");
    }

    function test_UnusedHooksRevertNotImplemented() public {
        vm.expectRevert(FleetHook.HookNotImplemented.selector);
        hook.beforeInitialize(address(this));
        address[] memory t = new address[](0);
        uint256[] memory v = new uint256[](0);
        bytes[] memory c = new bytes[](0);
        vm.expectRevert(FleetHook.HookNotImplemented.selector);
        hook.beforeQueue(address(this), t, v, c, bytes32(0));
    }

    function test_DecodeActionRoundTripAndRejectsTrailingBytes() public view {
        bytes memory data = abi.encodeCall(TaskLedger.recordDecision, (7, 1, 1, keccak256("p"), "", "summary"));
        FleetHook.DecodedAction memory a = hook.decodeAction(data);
        assertEq(a.taskId, 7);
        assertEq(a.kind, 1);
        assertEq(a.expectedVersion, 1);
        assertEq(a.payloadHash, keccak256("p"));
        assertEq(a.summary, "summary");
    }

    function test_DecodeActionRejectsBadSelectorAndTrailing() public {
        bytes memory wrong = abi.encodeCall(TaskLedger.completeTask, (7));
        vm.expectRevert(abi.encodeWithSelector(FleetHook.InvalidSelector.selector, TaskLedger.completeTask.selector));
        hook.decodeAction(wrong);
        bytes memory data = abi.encodeCall(TaskLedger.recordDecision, (7, 1, 1, keccak256("p"), "", "summary"));
        bytes memory trailing = bytes.concat(data, hex"00");
        vm.expectRevert(FleetHook.MalformedCalldata.selector);
        hook.decodeAction(trailing);
        vm.expectRevert(FleetHook.MalformedCalldata.selector);
        hook.decodeAction(hex"aabb");
        // Right selector, tail shorter than the six-word static head: must revert MalformedCalldata(),
        // not bubble abi.decode's own empty-return-data revert.
        vm.expectRevert(FleetHook.MalformedCalldata.selector);
        hook.decodeAction(abi.encodePacked(TaskLedger.recordDecision.selector));
        vm.expectRevert(FleetHook.MalformedCalldata.selector);
        hook.decodeAction(abi.encodePacked(TaskLedger.recordDecision.selector, bytes32(0), bytes32(0), bytes32(0)));
    }

    function test_BeforeVoteSucceededUsesForOnlyRule() public {
        // Drive through the governor so proposalVotes exist: open task, propose, vote, check state.
        vm.prank(operator);
        uint256 taskId = ledger.openTask('{"goal":"x"}', 7200);
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        t[0] = address(ledger);
        c[0] = abi.encodeCall(TaskLedger.recordDecision, (taskId, 0, 1, keccak256("p"), "", "s"));
        vm.prank(members[0]);
        uint256 pid = governor.propose(t, v, c, "choose\n#proposalTypeId=0");
        vm.warp(governor.proposalSnapshot(pid) + 1);
        vm.prank(members[0]); governor.castVoteWithReason(pid, 1, "for");
        vm.prank(members[1]); governor.castVoteWithReason(pid, 1, "for");
        vm.prank(members[2]); governor.castVoteWithReason(pid, 2, "abstain");
        vm.warp(governor.proposalDeadline(pid) + 1);
        // 2 For + 1 Abstain: participation quorum met, For-only quorum not met
        assertEq(uint8(governor.state(pid)), uint8(IGovernorState.Defeated));
    }
}

// Local mirror of IGovernor.ProposalState ordering for readability in assertions.
library IGovernorState {
    uint8 constant Pending = 0;
    uint8 constant Active = 1;
    uint8 constant Canceled = 2;
    uint8 constant Defeated = 3;
    uint8 constant Succeeded = 4;
    uint8 constant Queued = 5;
    uint8 constant Expired = 6;
    uint8 constant Executed = 7;
}
