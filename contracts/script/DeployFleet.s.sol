// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../src/deploy/FleetDeployer.sol";

/// @notice Reads a fleet config JSON, deploys the full sequence to whatever chain `--rpc-url`
///         points at, and writes a manifest describing the result. See deployments/configs for
///         example configs and docs/compatibility-notes.md for the JSON serializer behaviour this
///         relies on.
contract DeployFleet is Script {
    function run() external returns (FleetAddresses memory a) {
        string memory cfgPath = vm.envString("FLEET_DEPLOY_CONFIG");
        string memory json = vm.readFile(cfgPath);
        uint256 pk = vm.envUint("FLEET_DEPLOYER_KEY");

        FleetDeployParams memory p;
        p.tokenName = vm.parseJsonString(json, ".tokenName");
        p.tokenSymbol = vm.parseJsonString(json, ".tokenSymbol");
        p.members = vm.parseJsonAddressArray(json, ".members");
        p.agentManifests = vm.parseJsonStringArray(json, ".agentManifests");
        p.fleetManifest = vm.parseJsonString(json, ".fleetManifest");
        p.operator = vm.parseJsonAddress(json, ".operator");
        p.guardian = vm.parseJsonAddress(json, ".guardian");
        p.votingDelay = uint48(vm.parseJsonUint(json, ".votingDelay"));
        p.votingPeriod = uint32(vm.parseJsonUint(json, ".votingPeriod"));
        p.proposalThreshold = vm.parseJsonUint(json, ".proposalThreshold");
        p.quorumNumerator = vm.parseJsonUint(json, ".quorumNumerator");
        p.timelockDelay = vm.parseJsonUint(json, ".timelockDelay");
        p.maxTaskLifetime = uint64(vm.parseJsonUint(json, ".maxTaskLifetime"));
        p.create2Deployer = CREATE2_FACTORY;
        p.deployer = vm.addr(pk);

        uint256 startBlock = block.number;
        uint256 startTimestamp = block.timestamp;
        vm.startBroadcast(pk);
        a = FleetDeployer.deploy(p);
        vm.stopBroadcast();

        _writeManifest(cfgPath, json, p, a, startBlock, startTimestamp);
        console2.log("registry", a.registry);
        console2.log("token", a.token);
        console2.log("timelock", a.timelock);
        console2.log("ledger", a.ledger);
        console2.log("hook", a.hook);
        console2.log("governor", a.governor);
    }

    function _writeManifest(
        string memory cfgPath,
        string memory cfgJson,
        FleetDeployParams memory p,
        FleetAddresses memory a,
        uint256 startBlock,
        uint256 startTimestamp
    ) internal {
        string memory root = "manifest";
        vm.serializeString(root, "schema", "fleet.manifest.v1");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deploymentBlock", startBlock);
        vm.serializeUint(root, "deploymentTimestamp", startTimestamp);
        vm.serializeAddress(root, "deployer", p.deployer);
        vm.serializeAddress(root, "members", p.members);
        vm.serializeAddress(root, "operator", p.operator);
        vm.serializeAddress(root, "guardian", p.guardian);
        vm.serializeString(root, "tokenName", p.tokenName);
        vm.serializeString(root, "tokenSymbol", p.tokenSymbol);
        vm.serializeBytes32(root, "hookSalt", a.hookSalt);
        vm.serializeString(root, "countingRule", "for-only-quorum");
        // Uppercase hex digits, matching FleetHook.PERMISSION_MASK as the README and the verifier
        // write it. The mask is compared as a string by the read side, so the spelling is part of
        // the manifest's contract.
        vm.serializeString(root, "hookPermissionMask", "0x22C0");
        vm.serializeString(root, "configPath", cfgPath);
        vm.serializeBytes32(root, "configHash", keccak256(bytes(cfgJson)));

        vm.serializeString(root, "addresses", _addressesJson(a));
        vm.serializeString(root, "params", _paramsJson(p));
        vm.serializeString(root, "compiler", _compilerJson());
        vm.serializeString(root, "pins", _pinsJson());
        string memory out = vm.serializeString(root, "codeHashes", _codeHashesJson(a));

        string memory dir = string.concat("../deployments/", vm.toString(block.chainid));
        string memory override_ = vm.envOr("FLEET_MANIFEST_OUT", string(""));
        if (bytes(override_).length != 0) {
            // An explicit output path means a throwaway or redirected run, so write only that file:
            // the archive below is the permanent record of real deployments, not a scratch artifact.
            _write(out, override_);
            console2.log("manifest", override_);
            return;
        }

        // `latest.json` is a pointer the next deployment overwrites; the timestamped copy is the
        // archive, and the two are byte-identical.
        string memory path = string.concat(dir, "/latest.json");
        string memory archivePath = string.concat(dir, "/", vm.toString(startTimestamp), ".json");
        vm.createDir(dir, true);
        _write(out, path);
        _write(out, archivePath);
        console2.log("manifest", path);
        console2.log("archive", archivePath);
    }

    /// @dev The nested objects are built in their own functions, and handed to the root as the JSON
    ///      strings `vm.serialize*` returns (see docs/compatibility-notes.md, Task 12, for why that
    ///      is the shape the serializer needs). Splitting them out also keeps `_writeManifest` inside
    ///      the stack limit without the IR pipeline.
    function _addressesJson(FleetAddresses memory a) internal returns (string memory) {
        string memory addrs = "addresses";
        vm.serializeAddress(addrs, "registry", a.registry);
        vm.serializeAddress(addrs, "token", a.token);
        vm.serializeAddress(addrs, "timelock", a.timelock);
        vm.serializeAddress(addrs, "ledger", a.ledger);
        vm.serializeAddress(addrs, "hook", a.hook);
        return vm.serializeAddress(addrs, "governor", a.governor);
    }

    function _paramsJson(FleetDeployParams memory p) internal returns (string memory) {
        string memory params = "params";
        vm.serializeUint(params, "votingDelay", p.votingDelay);
        vm.serializeUint(params, "votingPeriod", p.votingPeriod);
        // A decimal string, not a JSON number: 1e18 is past IEEE-754 double precision, so a reader
        // that parses JSON numbers as doubles would silently round it. The config declares it the
        // same way.
        vm.serializeString(params, "proposalThreshold", vm.toString(p.proposalThreshold));
        vm.serializeUint(params, "quorumNumerator", p.quorumNumerator);
        vm.serializeUint(params, "timelockDelay", p.timelockDelay);
        return vm.serializeUint(params, "maxTaskLifetime", p.maxTaskLifetime);
    }

    function _compilerJson() internal returns (string memory) {
        string memory compiler = "compiler";
        vm.serializeString(compiler, "solc", "0.8.29");
        vm.serializeString(compiler, "evm", "cancun");
        return vm.serializeUint(compiler, "optimizerRuns", 200);
    }

    function _pinsJson() internal returns (string memory) {
        string memory pins = "pins";
        vm.serializeString(pins, "agoraGovernor", "11a11641ce1f4f691c300d530eae3c7203593b85");
        return vm.serializeString(pins, "openzeppelin", "3d139e998b9843179d72b28a3264834b01baf160");
    }

    function _codeHashesJson(FleetAddresses memory a) internal returns (string memory) {
        string memory hashes = "codeHashes";
        vm.serializeBytes32(hashes, "registry", a.registry.codehash);
        vm.serializeBytes32(hashes, "token", a.token.codehash);
        vm.serializeBytes32(hashes, "timelock", a.timelock.codehash);
        vm.serializeBytes32(hashes, "ledger", a.ledger.codehash);
        vm.serializeBytes32(hashes, "hook", a.hook.codehash);
        return vm.serializeBytes32(hashes, "governor", a.governor.codehash);
    }

    /// @dev `vm.writeJson` writes the pretty-printed object with no trailing newline, which makes
    ///      every committed manifest a "\ No newline at end of file" diff. `vm.writeLine` appends its
    ///      argument plus a newline, so appending an empty line terminates the file properly.
    function _write(string memory json, string memory path) internal {
        vm.writeJson(json, path);
        vm.writeLine(path, "");
    }
}
