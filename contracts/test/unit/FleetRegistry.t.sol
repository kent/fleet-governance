// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetMembership} from "../../src/libraries/FleetMembership.sol";

contract FleetRegistryTest is Test {
    address[] members;
    string[] manifests;

    function setUp() public {
        for (uint256 i; i < 5; ++i) {
            members.push(makeAddr(string.concat("agent", vm.toString(i))));
            manifests.push(string.concat('{"role":"r', vm.toString(i), '"}'));
        }
    }

    function _new() internal returns (FleetRegistry) {
        return new FleetRegistry(members.length, FleetMembership.commitment(members, manifests), '{"fleet":"test"}');
    }

    function _deploy() internal returns (FleetRegistry r) {
        r = _new();
        r.registerMembers(0, members, manifests);
    }

    function _batch(FleetRegistry r, uint256 start, uint256 count) internal {
        address[] memory a = new address[](count);
        string[] memory m = new string[](count);
        for (uint256 i; i < count; ++i) { a[i] = members[start + i]; m[i] = manifests[start + i]; }
        r.registerMembers(start, a, m);
    }

    function test_RegistersFiveMembersWithIds() public {
        FleetRegistry r = _deploy();
        assertTrue(r.initialized());
        assertEq(r.memberCount(), 5);
        assertEq(r.registeredHash(), r.membershipHash());
        for (uint256 i; i < 5; ++i) {
            assertTrue(r.isMember(members[i]));
            assertEq(r.idOf(members[i]), i);
            assertEq(r.accountOf(i), members[i]);
            assertEq(r.agentManifest(i), manifests[i]);
        }
        assertEq(r.fleetManifest(), '{"fleet":"test"}');
        assertEq(r.fleetManifestHash(), keccak256(bytes('{"fleet":"test"}')));
        assertEq(r.members().length, 5);
    }

    function test_EmitsRegistrationEvents() public {
        FleetRegistry r = _new();
        vm.expectEmit(true, true, false, true);
        emit FleetRegistry.MemberRegistered(0, members[0], keccak256(bytes(manifests[0])), manifests[0]);
        r.registerMembers(0, members, manifests);
    }

    function test_PartialRosterHasNoMembershipAuthorityAndFinalRosterIsImmutable() public {
        FleetRegistry r = _new();
        _batch(r, 0, 2);
        assertEq(r.memberCount(), 2);
        assertEq(r.expectedMemberCount(), 5);
        assertFalse(r.initialized());
        assertFalse(r.isMember(members[0]));
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.WrongStartIndex.selector, 2, 0));
        r.registerMembers(0, members, manifests);
        _batch(r, 2, 3);
        assertTrue(r.initialized());
        assertTrue(r.isMember(members[0]));
        vm.expectRevert(FleetRegistry.AlreadyInitialized.selector);
        r.registerMembers(5, members, manifests);
    }

    function test_OnlyInitializerCanPopulateRoster() public {
        FleetRegistry r = _new();
        vm.prank(members[0]);
        vm.expectRevert(FleetRegistry.NotInitializer.selector);
        r.registerMembers(0, members, manifests);
        assertEq(r.memberCount(), 0);
    }

    function test_FinalBatchMustMatchCommittedIdentitiesOrderAndManifests() public {
        FleetRegistry r = _new();
        _batch(r, 0, 2);
        string memory original = manifests[4];
        manifests[4] = '{"role":"impostor"}';
        vm.expectRevert(FleetRegistry.MembershipHashMismatch.selector);
        _batch(r, 2, 3);
        assertEq(r.memberCount(), 2);
        assertFalse(r.initialized());
        manifests[4] = original;
        _batch(r, 2, 3);
        assertTrue(r.initialized());
    }

    function test_NonMemberLookupsRevert() public {
        FleetRegistry r = _deploy();
        assertFalse(r.isMember(address(0xBEEF)));
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.NotMember.selector, address(0xBEEF)));
        r.idOf(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.UnknownAgent.selector, 5));
        r.accountOf(5);
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.UnknownAgent.selector, 5));
        r.agentManifest(5);
    }

    function test_RejectsInvalidTotalCount() public {
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.InvalidMemberCount.selector, 1));
        new FleetRegistry(1, bytes32(0), "{}");
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.InvalidMemberCount.selector, 4097));
        new FleetRegistry(4097, bytes32(0), "{}");
    }

    function test_RejectsLengthMismatch() public {
        FleetRegistry r = _new();
        string[] memory m = new string[](4);
        vm.expectRevert(FleetRegistry.LengthMismatch.selector);
        r.registerMembers(0, members, m);
    }

    function test_RejectsZeroAddress() public {
        FleetRegistry r = _new();
        members[2] = address(0);
        vm.expectRevert(FleetRegistry.ZeroAddress.selector);
        r.registerMembers(0, members, manifests);
    }

    function test_RejectsDuplicateAcrossBatches() public {
        FleetRegistry r = _new();
        _batch(r, 0, 2);
        members[3] = members[1];
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.DuplicateMember.selector, members[1]));
        _batch(r, 2, 3);
        assertEq(r.memberCount(), 2);
    }

    function test_RejectsOversizedManifests() public {
        FleetRegistry r = _new();
        manifests[0] = new string(2049);
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.ManifestTooLong.selector, 2049, 2048));
        r.registerMembers(0, members, manifests);
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.ManifestTooLong.selector, 4097, 4096));
        new FleetRegistry(5, bytes32(0), new string(4097));
    }

    function test_RejectsBatchesExceedingCountOrByteLimits() public {
        FleetRegistry r = new FleetRegistry(40, bytes32(0), "{}");
        address[] memory a = new address[](33);
        string[] memory m = new string[](33);
        vm.expectRevert(FleetRegistry.InvalidBatch.selector);
        r.registerMembers(0, a, m);
        for (uint256 i; i < 5; ++i) manifests[i] = new string(2048);
        vm.expectRevert(FleetRegistry.InvalidBatch.selector);
        r.registerMembers(0, members, manifests);
        assertEq(r.memberCount(), 0);
    }
}
