// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";

contract FleetRegistryTest is Test {
    address[] members;
    string[] manifests;

    function setUp() public {
        for (uint256 i = 0; i < 5; i++) {
            members.push(makeAddr(string.concat("agent", vm.toString(i))));
            manifests.push(string.concat('{"role":"r', vm.toString(i), '"}'));
        }
    }

    function _deploy() internal returns (FleetRegistry) {
        return new FleetRegistry(members, manifests, '{"fleet":"test"}');
    }

    function test_RegistersFiveMembersWithIds() public {
        FleetRegistry r = _deploy();
        assertEq(r.memberCount(), 5);
        for (uint256 i = 0; i < 5; i++) {
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
        vm.expectEmit(true, true, false, true);
        emit FleetRegistry.MemberRegistered(0, members[0], keccak256(bytes(manifests[0])), manifests[0]);
        _deploy();
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

    function test_RejectsTooFewMembers() public {
        address[] memory one = new address[](1);
        one[0] = members[0];
        string[] memory m = new string[](1);
        m[0] = "{}";
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.InvalidMemberCount.selector, 1));
        new FleetRegistry(one, m, "{}");
    }

    function test_RejectsLengthMismatch() public {
        string[] memory m = new string[](4);
        vm.expectRevert(FleetRegistry.LengthMismatch.selector);
        new FleetRegistry(members, m, "{}");
    }

    function test_RejectsZeroAddress() public {
        members[2] = address(0);
        vm.expectRevert(FleetRegistry.ZeroAddress.selector);
        _deploy();
    }

    function test_RejectsDuplicate() public {
        members[3] = members[1];
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.DuplicateMember.selector, members[1]));
        _deploy();
    }

    function test_RejectsOversizedManifests() public {
        string memory big = new string(2049);
        manifests[0] = big;
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.ManifestTooLong.selector, 2049, 2048));
        _deploy();
        manifests[0] = "{}";
        string memory bigFleet = new string(4097);
        vm.expectRevert(abi.encodeWithSelector(FleetRegistry.ManifestTooLong.selector, 4097, 4096));
        new FleetRegistry(members, manifests, bigFleet);
    }
}
