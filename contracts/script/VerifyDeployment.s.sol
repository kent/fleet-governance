// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {FleetRegistry} from "../src/FleetRegistry.sol";
import {FleetVotes} from "../src/FleetVotes.sol";
import {TaskLedger} from "../src/TaskLedger.sol";
import {FleetHook} from "../src/FleetHook.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {FleetExecutor} from "../src/FleetExecutor.sol";
import {GovernedArtifactStore} from "../src/GovernedArtifactStore.sol";

/// @notice Re-reads a manifest written by DeployFleet.s.sol and asserts every post-condition the
///         deployment sequence promises, with a clear require message on the first one that
///         fails. Prints VERIFIED at the end when every check passes.
/// @dev Every check either passes or reverts. None is skipped, and VERIFIED is never printed with a
///      check unperformed: the one check with a timing precondition (per-member voting power, which
///      needs the token clock to have moved past the deployment) reverts and asks the operator to
///      retry rather than quietly passing over it.
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
        address operator;
        address guardian;
        uint256 deploymentBlock;
        uint256 deploymentTimestamp;
    }

    function run() external view {
        string memory manifestPath = vm.envString("FLEET_MANIFEST");
        string memory json = vm.readFile(manifestPath);

        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "chain id mismatch");

        ManifestAddrs memory a = _parseAddrs(json);
        _checkWiring(a);
        _checkLedger(json, a);
        _checkMembership(json, a);
        _checkSupplyAndVotes(a);
        _checkTimelockRoles(json, a);
        _checkGovernorParams(json, a);
        _checkCodeHashes(json, a);
        _checkExecutionResources(json, a);

        console2.log("VERIFIED");
    }

    function _checkExecutionResources(string memory json, ManifestAddrs memory a) internal view {
        // Historical transparency-only deployments have neither optional resource address.
        bool hasExecutor = vm.keyExistsJson(json, ".addresses.executor");
        bool hasStore = vm.keyExistsJson(json, ".addresses.artifactStore");
        require(hasExecutor == hasStore, "incomplete execution resources");
        require(hasExecutor == vm.keyExistsJson(json, ".codeHashes.executor"), "incomplete executor code hash");
        require(hasStore == vm.keyExistsJson(json, ".codeHashes.artifactStore"), "incomplete artifact store code hash");
        if (!hasExecutor) return;
        address executorAddress = vm.parseJsonAddress(json, ".addresses.executor");
        address storeAddress = vm.parseJsonAddress(json, ".addresses.artifactStore");
        FleetExecutor executor = FleetExecutor(executorAddress);
        require(address(executor.hook()) == a.hook, "executor hook mismatch");
        require(address(executor.ledger()) == a.ledger, "executor ledger mismatch");
        require(address(executor.registry()) == a.registry, "executor registry mismatch");
        require(GovernedArtifactStore(storeAddress).executor() == executorAddress, "artifact store executor mismatch");
        require(executor.activeTaskId() == 0, "executor has an active call at deployment");
        require(executorAddress.codehash == vm.parseJsonBytes32(json, ".codeHashes.executor"), "executor code hash mismatch");
        require(storeAddress.codehash == vm.parseJsonBytes32(json, ".codeHashes.artifactStore"), "artifact store code hash mismatch");
    }

    function _parseAddrs(string memory json) internal pure returns (ManifestAddrs memory a) {
        a.registry = vm.parseJsonAddress(json, ".addresses.registry");
        a.token = vm.parseJsonAddress(json, ".addresses.token");
        a.timelock = vm.parseJsonAddress(json, ".addresses.timelock");
        a.ledger = vm.parseJsonAddress(json, ".addresses.ledger");
        a.hook = vm.parseJsonAddress(json, ".addresses.hook");
        a.governor = vm.parseJsonAddress(json, ".addresses.governor");
        a.deployer = vm.parseJsonAddress(json, ".deployer");
        a.operator = vm.parseJsonAddress(json, ".operator");
        a.guardian = vm.parseJsonAddress(json, ".guardian");
        a.deploymentBlock = vm.parseJsonUint(json, ".deploymentBlock");
        a.deploymentTimestamp = vm.parseJsonUint(json, ".deploymentTimestamp");
    }

    function _checkWiring(ManifestAddrs memory a) internal view {
        AgoraGovernor governor = AgoraGovernor(payable(a.governor));
        FleetHook hook = FleetHook(a.hook);
        FleetVotes token = FleetVotes(a.token);

        require(address(governor.hooks()) == a.hook, "governor.hooks() != manifest hook");
        require(address(hook.governor()) == a.governor, "hook.governor() != manifest governor");
        require(address(hook.registry()) == a.registry, "hook.registry() != manifest registry");
        require(address(hook.ledger()) == a.ledger, "hook.ledger() != manifest ledger");
        require(uint160(a.hook) & 0xFFFF == 0x22C0, "hook address missing permission bits");
        require(hook.PERMISSION_MASK() == 0x22C0, "hook.PERMISSION_MASK() != 0x22C0");
        require(governor.admin() == address(0), "governor.admin() is not zero");
        require(governor.manager() == address(0), "governor.manager() is not zero");
        require(governor.timelock() == a.timelock, "governor.timelock() != manifest timelock");
        require(address(governor.token()) == a.token, "governor.token() != manifest token");
        require(address(token.registry()) == a.registry, "token.registry() != manifest registry");
    }

    function _checkLedger(string memory json, ManifestAddrs memory a) internal view {
        TaskLedger ledger = TaskLedger(a.ledger);
        uint256 maxTaskLifetime = vm.parseJsonUint(json, ".params.maxTaskLifetime");

        require(ledger.timelock() == a.timelock, "ledger.timelock() != manifest timelock");
        require(ledger.operator() == a.operator, "ledger.operator() != manifest operator");
        require(ledger.guardian() == a.guardian, "ledger.guardian() != manifest guardian");
        require(ledger.maxTaskLifetime() == maxTaskLifetime, "ledger.maxTaskLifetime() != manifest params");
        require(!ledger.paused(), "ledger is paused at deployment");
    }

    function _checkMembership(string memory json, ManifestAddrs memory a) internal view {
        FleetRegistry registry = FleetRegistry(a.registry);
        address[] memory manifestMembers = vm.parseJsonAddressArray(json, ".members");

        require(registry.memberCount() == manifestMembers.length, "registry.memberCount() != manifest members length");
        // Historical v1 manifests predate batched initialization. New deployments always carry
        // the roster commitment and must pass the full activation checks.
        if (vm.keyExistsJson(json, ".membershipHash")) {
            require(registry.initialized(), "registry is not initialized");
            require(registry.expectedMemberCount() == manifestMembers.length, "registry expected member count mismatch");
            require(registry.membershipHash() == vm.parseJsonBytes32(json, ".membershipHash"), "membership hash mismatch");
            require(registry.registeredHash() == registry.membershipHash(), "registered roster commitment mismatch");
            require(FleetVotes(a.token).initialized(), "token is not initialized");
            require(FleetVotes(a.token).mintedMembers() == manifestMembers.length, "token mint is incomplete");
        }
        for (uint256 i = 0; i < manifestMembers.length; i++) {
            require(registry.accountOf(i) == manifestMembers[i], "registry.accountOf(i) != manifest members[i]");
        }
    }

    function _checkSupplyAndVotes(ManifestAddrs memory a) internal view {
        FleetRegistry registry = FleetRegistry(a.registry);
        FleetVotes token = FleetVotes(a.token);

        address[] memory members = registry.members();
        require(token.totalSupply() == members.length * 1e18, "token.totalSupply() != memberCount * 1e18");

        // The manifest time precedes all mint batches. Check the last member too: the first
        // member may have votes while later batches are still too recent for getPastVotes.
        require(token.numCheckpoints(members[0]) > 0, "token has no voting checkpoint for member 0");
        Checkpoints.Checkpoint208 memory first = token.checkpoints(members[0], 0);
        require(first._key >= a.deploymentTimestamp, "token mint predates manifest deploymentTimestamp");

        // getPastVotes(clock()-1) reaches the mint checkpoint only once the clock has moved past the
        // block the deployment landed in; asking earlier looks up a timepoint that predates it. This
        // is a timing condition, not an optional check, so it reverts and asks for a retry rather
        // than passing over the votes check and still printing VERIFIED.
        uint256 clockNow = token.clock();
        Checkpoints.Checkpoint208 memory last = token.checkpoints(members[members.length - 1], 0);
        require(clockNow > last._key, "VerifyDeployment: clock has not advanced past deployment; retry in a moment");

        for (uint256 i = 0; i < members.length; i++) {
            require(token.getPastVotes(members[i], clockNow - 1) == 1e18, "member getPastVotes(clock()-1) != 1e18");
        }
    }

    function _checkTimelockRoles(string memory json, ManifestAddrs memory a) internal view {
        TimelockController timelock = TimelockController(payable(a.timelock));
        uint256 timelockDelay = vm.parseJsonUint(json, ".params.timelockDelay");

        require(timelock.getMinDelay() == timelockDelay, "timelock.getMinDelay() != manifest params");

        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        bytes32 executorRole = timelock.EXECUTOR_ROLE();
        bytes32 cancellerRole = timelock.CANCELLER_ROLE();
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();

        require(timelock.hasRole(proposerRole, a.governor), "governor missing PROPOSER_ROLE");
        require(timelock.hasRole(executorRole, a.governor), "governor missing EXECUTOR_ROLE");
        require(timelock.hasRole(cancellerRole, a.governor), "governor missing CANCELLER_ROLE");
        require(timelock.hasRole(cancellerRole, a.guardian), "guardian missing CANCELLER_ROLE");
        require(timelock.hasRole(adminRole, a.timelock), "timelock missing its own DEFAULT_ADMIN_ROLE");
        require(!timelock.hasRole(adminRole, a.deployer), "deployer still holds DEFAULT_ADMIN_ROLE");
        require(!timelock.hasRole(proposerRole, a.deployer), "deployer holds PROPOSER_ROLE");
        require(!timelock.hasRole(executorRole, address(0)), "zero address holds EXECUTOR_ROLE");
    }

    function _checkGovernorParams(string memory json, ManifestAddrs memory a) internal view {
        AgoraGovernor governor = AgoraGovernor(payable(a.governor));

        uint256 quorumNumerator = vm.parseJsonUint(json, ".params.quorumNumerator");
        uint256 votingDelay = vm.parseJsonUint(json, ".params.votingDelay");
        uint256 votingPeriod = vm.parseJsonUint(json, ".params.votingPeriod");
        // A decimal string in the manifest, not a JSON number; see DeployFleet.s.sol.
        uint256 proposalThreshold = vm.parseUint(vm.parseJsonString(json, ".params.proposalThreshold"));

        require(governor.quorumNumerator() == quorumNumerator, "quorumNumerator != manifest params");
        require(governor.votingDelay() == votingDelay, "votingDelay != manifest params");
        require(governor.votingPeriod() == votingPeriod, "votingPeriod != manifest params");
        require(governor.proposalThreshold() == proposalThreshold, "proposalThreshold != manifest params");
    }

    function _checkCodeHashes(string memory json, ManifestAddrs memory a) internal view {
        require(
            a.registry.codehash == vm.parseJsonBytes32(json, ".codeHashes.registry"),
            "registry.codehash != manifest codeHashes.registry"
        );
        require(
            a.token.codehash == vm.parseJsonBytes32(json, ".codeHashes.token"),
            "token.codehash != manifest codeHashes.token"
        );
        require(
            a.timelock.codehash == vm.parseJsonBytes32(json, ".codeHashes.timelock"),
            "timelock.codehash != manifest codeHashes.timelock"
        );
        require(
            a.ledger.codehash == vm.parseJsonBytes32(json, ".codeHashes.ledger"),
            "ledger.codehash != manifest codeHashes.ledger"
        );
        require(
            a.hook.codehash == vm.parseJsonBytes32(json, ".codeHashes.hook"),
            "hook.codehash != manifest codeHashes.hook"
        );
        require(
            a.governor.codehash == vm.parseJsonBytes32(json, ".codeHashes.governor"),
            "governor.codehash != manifest codeHashes.governor"
        );
    }
}
