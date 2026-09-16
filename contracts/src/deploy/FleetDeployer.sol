// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {FleetRegistry} from "../FleetRegistry.sol";
import {FleetVotes} from "../FleetVotes.sol";
import {TaskLedger} from "../TaskLedger.sol";
import {FleetHook} from "../FleetHook.sol";
import {FleetBudgetHook} from "../FleetBudgetHook.sol";
import {FleetBondHook} from "../FleetBondHook.sol";
import {FleetBondVotes} from "../FleetBondVotes.sol";
import {HookMiner} from "./HookMiner.sol";
import {FleetMembership} from "../libraries/FleetMembership.sol";
import {FleetExecutor} from "../FleetExecutor.sol";
import {GovernedArtifactStore} from "../GovernedArtifactStore.sol";

struct FleetDeployParams {
    string tokenName;
    string tokenSymbol;
    address[] members;
    string[] agentManifests;
    string fleetManifest;
    address operator;
    address guardian;
    uint48 votingDelay;
    uint32 votingPeriod;
    uint256 proposalThreshold;
    uint256 quorumNumerator;
    uint256 timelockDelay;
    uint64 maxTaskLifetime;
    address create2Deployer;
    address deployer;
}

struct FleetAddresses {
    address registry;
    address token;
    address timelock;
    address ledger;
    address hook;
    address governor;
    address executor;
    address artifactStore;
    bytes32 hookSalt;
}

/// @notice The deployment sequence of spec section 7.1, shared by the Foundry script and the test fixture.
/// @dev Runs in the caller's context. In tests the caller is the test contract (CREATE2 from it);
///      under `vm.broadcast` Foundry routes CREATE2 through the canonical deployer, so `create2Deployer`
///      must be `0x4e59b44847b379578588920cA78FbF26c0B4956C` there.
library FleetDeployer {
    error HookAddressMismatch(address predicted, address actual);
    error GovernorDeploymentFailed();

    /// @notice Must equal FleetHook.PERMISSION_MASK (0x22C0). Duplicated here because a contract's
    ///         public constant is not addressable as ContractName.CONSTANT from another file.
    uint160 internal constant HOOK_PERMISSION_MASK = 0x22C0;

    function deploy(FleetDeployParams memory p) internal returns (FleetAddresses memory a) {
        return _deploy(p, 0);
    }

    function deployWithProposalBudget(FleetDeployParams memory p) internal returns (FleetAddresses memory a) {
        return _deploy(p, 1);
    }

    function deployWithProposalBonds(FleetDeployParams memory p) internal returns (FleetAddresses memory a) {
        return _deploy(p, 2);
    }

    function _deploy(FleetDeployParams memory p, uint8 economics) private returns (FleetAddresses memory a) {
        FleetRegistry registry = deployRegistry(p.members, p.agentManifests, p.fleetManifest);
        FleetVotes token = economics == 2 ? FleetVotes(address(new FleetBondVotes(p.tokenName, p.tokenSymbol, registry)))
            : new FleetVotes(p.tokenName, p.tokenSymbol, registry);
        _initializeToken(token, p.members.length);

        address[] memory none = new address[](0);
        TimelockController timelock = new TimelockController(p.timelockDelay, none, none, p.deployer);
        TaskLedger ledger = new TaskLedger(address(timelock), p.operator, p.guardian, p.maxTaskLifetime);

        (address predictedHook, bytes32 salt) = HookMiner.find(
            p.create2Deployer,
            HOOK_PERMISSION_MASK,
            economics == 2 ? type(FleetBondHook).creationCode : economics == 1 ? type(FleetBudgetHook).creationCode : type(FleetHook).creationCode,
            abi.encode(registry, ledger, p.deployer)
        );
        FleetHook hook = economics == 2 ? FleetHook(address(new FleetBondHook{salt: salt}(registry, ledger, p.deployer)))
            : economics == 1 ? FleetHook(address(new FleetBudgetHook{salt: salt}(registry, ledger, p.deployer)))
            : new FleetHook{salt: salt}(registry, ledger, p.deployer);
        if (address(hook) != predictedHook) revert HookAddressMismatch(predictedHook, address(hook));

        address governor = _deployGovernor(
            p.votingDelay,
            p.votingPeriod,
            p.proposalThreshold,
            p.quorumNumerator,
            address(token),
            address(timelock),
            address(hook)
        );
        hook.initialize(governor);
        if (economics == 2) FleetBondVotes(address(token)).bindBondController(address(FleetBondHook(address(hook)).proposalBonds()));

        timelock.grantRole(timelock.PROPOSER_ROLE(), governor);
        timelock.grantRole(timelock.EXECUTOR_ROLE(), governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), p.guardian);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), p.deployer);

        a = FleetAddresses({
            registry: address(registry),
            token: address(token),
            timelock: address(timelock),
            ledger: address(ledger),
            hook: address(hook),
            governor: governor,
            executor: address(0),
            artifactStore: address(0),
            hookSalt: salt
        });
        a.executor = address(new FleetExecutor(hook));
        a.artifactStore = address(new GovernedArtifactStore(a.executor));
    }

    function _initializeToken(FleetVotes token, uint256 n) private {
        uint256 batchSize = token.MAX_BATCH_MEMBERS();
        for (uint256 start; start < n; start += batchSize) {
            token.initializeVotes(n - start > batchSize ? batchSize : n - start);
        }
    }

    /// @notice Registration is bounded by both count and manifest bytes, so even maximum-size
    ///         manifests fit into a transaction. Every external call becomes a separate broadcast.
    function deployRegistry(address[] memory members, string[] memory manifests, string memory fleetManifest)
        internal returns (FleetRegistry registry)
    {
        registry = new FleetRegistry(members.length, FleetMembership.commitment(members, manifests), fleetManifest);
        uint256 maxMembers = registry.MAX_BATCH_MEMBERS();
        uint256 maxBytes = registry.MAX_BATCH_MANIFEST_BYTES();
        uint256 start;
        while (start < members.length) {
            uint256 end = start;
            uint256 totalBytes;
            while (end < members.length && end - start < maxMembers) {
                uint256 size = bytes(manifests[end]).length;
                require(size <= registry.MAX_AGENT_MANIFEST_BYTES(), "agent manifest too long");
                if (totalBytes + size > maxBytes) break;
                totalBytes += size;
                ++end;
            }
            address[] memory batch = new address[](end - start);
            string[] memory batchManifests = new string[](end - start);
            for (uint256 i = start; i < end; ++i) {
                batch[i - start] = members[i];
                batchManifests[i - start] = manifests[i];
            }
            registry.registerMembers(start, batch, batchManifests);
            start = end;
        }
    }

    /// @dev Deploys the pinned AgoraGovernor from its creation code. Constructor arguments are
    ///      ABI-encoded as addresses, which is byte-identical to `new AgoraGovernor(...)`; we cannot
    ///      use `new` because the `IHooks` type visible to our files differs nominally from the one the
    ///      governor's constructor declares (see docs/compatibility-notes.md, Task 5, Deviation 2).
    function _deployGovernor(
        uint48 votingDelay,
        uint32 votingPeriod,
        uint256 proposalThreshold,
        uint256 quorumNumerator,
        address token,
        address timelock,
        address hook
    ) private returns (address governor) {
        bytes memory initCode = abi.encodePacked(
            type(AgoraGovernor).creationCode,
            abi.encode(
                votingDelay,
                votingPeriod,
                proposalThreshold,
                quorumNumerator,
                token,
                timelock,
                address(0),
                address(0),
                hook
            )
        );
        assembly ("memory-safe") {
            governor := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (governor == address(0)) revert GovernorDeploymentFailed();
    }
}
