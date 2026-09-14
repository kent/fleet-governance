// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../../src/deploy/FleetDeployer.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract FleetDeployerTest is Test {
    function _params() internal returns (FleetDeployParams memory p) {
        p.tokenName = "Fleet Vote";
        p.tokenSymbol = "FLEET";
        p.members = new address[](5);
        p.agentManifests = new string[](5);
        for (uint256 i = 0; i < 5; i++) {
            p.members[i] = makeAddr(string.concat("agent", vm.toString(i)));
            p.agentManifests[i] = "{}";
        }
        p.fleetManifest = "{}";
        p.operator = makeAddr("operator");
        p.guardian = makeAddr("guardian");
        p.votingDelay = 15;
        p.votingPeriod = 120;
        p.proposalThreshold = 1e18;
        p.quorumNumerator = 6000;
        p.timelockDelay = 30;
        p.maxTaskLifetime = 7200;
        p.create2Deployer = address(this);
        p.deployer = address(this);
    }

    function test_DeploysAndWiresEverything() public {
        vm.warp(1_800_000_000);
        FleetAddresses memory a = FleetDeployer.deploy(_params());
        TimelockController tl = TimelockController(payable(a.timelock));
        AgoraGovernor gov = AgoraGovernor(payable(a.governor));
        FleetHook hook = FleetHook(a.hook);

        assertEq(FleetRegistry(a.registry).memberCount(), 5);
        assertEq(FleetVotes(a.token).totalSupply(), 5e18);
        assertEq(TaskLedger(a.ledger).timelock(), a.timelock);
        assertEq(address(gov.hooks()), a.hook);
        assertEq(address(hook.governor()), a.governor);
        assertEq(uint160(a.hook) & 0xFFFF, 0x22C0);
        assertEq(FleetHook(a.hook).PERMISSION_MASK(), 0x22C0);
        assertEq(gov.admin(), address(0));
        assertEq(gov.manager(), address(0));
        assertEq(gov.timelock(), a.timelock);
        assertEq(gov.quorumNumerator(), 6000);
        assertEq(gov.votingDelay(), 15);
        assertEq(gov.votingPeriod(), 120);
        assertEq(gov.proposalThreshold(), 1e18);

        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), a.governor));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), a.governor));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), a.governor));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), makeAddr("guardian")));
        assertTrue(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), a.timelock));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), address(this)));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)));
        assertEq(tl.getMinDelay(), 30);
    }
}
