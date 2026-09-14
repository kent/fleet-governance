// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {FleetRegistry} from "../src/FleetRegistry.sol";
import {FleetVotes} from "../src/FleetVotes.sol";
import {TaskLedger} from "../src/TaskLedger.sol";
import {FleetHook} from "../src/FleetHook.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Re-reads a manifest written by DeployFleet.s.sol and asserts every post-condition the
///         deployment sequence promises, with a clear require message on the first one that
///         fails. Prints VERIFIED at the end when every check passes.
/// @dev Checks are split into several internal functions, each with its own local variables, to
///      stay under the EVM stack depth without turning on the optimizer's IR pipeline.
contract VerifyDeployment is Script {
    struct ManifestAddrs {
        address registry;
        address token;
        address timelock;
        address ledger;
        address hook;
        address governor;
        address deployer;
        uint256 deploymentBlock;
    }

    function run() external view {
        string memory manifestPath = vm.envString("FLEET_MANIFEST");
        string memory json = vm.readFile(manifestPath);

        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "chain id mismatch");

        ManifestAddrs memory a = _parseAddrs(json);
        _checkWiring(a);
        _checkSupplyAndVotes(a);
        _checkTimelockRoles(a);
        _checkGovernorParams(json, a.governor);
        _checkGovernorCodeHash(json, a.governor);

        console2.log("VERIFIED");
    }

    function _parseAddrs(string memory json) internal pure returns (ManifestAddrs memory a) {
        a.registry = vm.parseJsonAddress(json, ".addresses.registry");
        a.token = vm.parseJsonAddress(json, ".addresses.token");
        a.timelock = vm.parseJsonAddress(json, ".addresses.timelock");
        a.ledger = vm.parseJsonAddress(json, ".addresses.ledger");
        a.hook = vm.parseJsonAddress(json, ".addresses.hook");
        a.governor = vm.parseJsonAddress(json, ".addresses.governor");
        a.deployer = vm.parseJsonAddress(json, ".deployer");
        a.deploymentBlock = vm.parseJsonUint(json, ".deploymentBlock");
    }

    function _checkWiring(ManifestAddrs memory a) internal view {
        AgoraGovernor governor = AgoraGovernor(payable(a.governor));
        FleetHook hook = FleetHook(a.hook);
        FleetVotes token = FleetVotes(a.token);
        TaskLedger ledger = TaskLedger(a.ledger);

        require(address(governor.hooks()) == a.hook, "governor.hooks() != manifest hook");
        require(address(hook.governor()) == a.governor, "hook.governor() != manifest governor");
        require(uint160(a.hook) & 0xFFFF == 0x22C0, "hook address missing permission bits");
        require(governor.admin() == address(0), "governor.admin() is not zero");
        require(governor.manager() == address(0), "governor.manager() is not zero");
        require(governor.timelock() == a.timelock, "governor.timelock() != manifest timelock");
        require(address(token.registry()) == a.registry, "token.registry() != manifest registry");
        require(ledger.timelock() == a.timelock, "ledger.timelock() != manifest timelock");
    }

    function _checkSupplyAndVotes(ManifestAddrs memory a) internal view {
        FleetRegistry registry = FleetRegistry(a.registry);
        FleetVotes token = FleetVotes(a.token);

        uint256 memberCount = registry.memberCount();
        require(token.totalSupply() == memberCount * 1e18, "token.totalSupply() != memberCount * 1e18");

        // clock()-1 is only a valid, checkpoint-covering lookup once at least one block has been
        // mined after the deployment block; verifying in the same block the deployment landed in
        // would look up a timestamp that predates the mint/delegate checkpoints.
        uint48 clockNow = token.clock();
        if (block.number > a.deploymentBlock && clockNow > 0) {
            address[] memory members = registry.members();
            for (uint256 i = 0; i < members.length; i++) {
                uint256 votes = token.getPastVotes(members[i], clockNow - 1);
                require(votes == 1e18, "member getPastVotes(clock()-1) != 1e18");
            }
        }
    }

    function _checkTimelockRoles(ManifestAddrs memory a) internal view {
        TimelockController timelock = TimelockController(payable(a.timelock));
        address guardian = TaskLedger(a.ledger).guardian();

        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        bytes32 executorRole = timelock.EXECUTOR_ROLE();
        bytes32 cancellerRole = timelock.CANCELLER_ROLE();
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();

        require(timelock.hasRole(proposerRole, a.governor), "governor missing PROPOSER_ROLE");
        require(timelock.hasRole(executorRole, a.governor), "governor missing EXECUTOR_ROLE");
        require(timelock.hasRole(cancellerRole, a.governor), "governor missing CANCELLER_ROLE");
        require(timelock.hasRole(cancellerRole, guardian), "guardian missing CANCELLER_ROLE");
        require(timelock.hasRole(adminRole, a.timelock), "timelock missing its own DEFAULT_ADMIN_ROLE");
        require(!timelock.hasRole(adminRole, a.deployer), "deployer still holds DEFAULT_ADMIN_ROLE");
        require(!timelock.hasRole(proposerRole, a.deployer), "deployer holds PROPOSER_ROLE");
        require(!timelock.hasRole(executorRole, address(0)), "zero address holds EXECUTOR_ROLE");
    }

    function _checkGovernorParams(string memory json, address governorAddr) internal view {
        AgoraGovernor governor = AgoraGovernor(payable(governorAddr));

        uint256 quorumNumerator = vm.parseJsonUint(json, ".params.quorumNumerator");
        uint256 votingDelay = vm.parseJsonUint(json, ".params.votingDelay");
        uint256 votingPeriod = vm.parseJsonUint(json, ".params.votingPeriod");
        uint256 proposalThreshold = vm.parseJsonUint(json, ".params.proposalThreshold");

        require(governor.quorumNumerator() == quorumNumerator, "quorumNumerator != manifest params");
        require(governor.votingDelay() == votingDelay, "votingDelay != manifest params");
        require(governor.votingPeriod() == votingPeriod, "votingPeriod != manifest params");
        require(governor.proposalThreshold() == proposalThreshold, "proposalThreshold != manifest params");
    }

    function _checkGovernorCodeHash(string memory json, address governorAddr) internal view {
        bytes32 manifestGovernorHash = vm.parseJsonBytes32(json, ".codeHashes.governor");
        require(governorAddr.codehash == manifestGovernorHash, "governor.codehash != manifest codeHashes.governor");
    }
}
