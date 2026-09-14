# Fleet Governance v1, Part 1: Contracts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four fleet contracts, the deployment and verification scripts, and a test suite that proves the governance rule, the identity boundary, and the ledger semantics against the unmodified pinned Agora Governor.

**Architecture:** `FleetRegistry` (membership), `FleetVotes` (ERC20Votes, one vote each, delegation only to members), `TaskLedger` (charters and decisions, written only by the timelock), `FleetHook` (Agora hook carrying proposal admission, vote admission, and the For-only success rule). A shared `FleetDeployer` library performs the deployment sequence for both the Foundry script and the test fixture. `HookMiner` finds the CREATE2 salt whose address carries permission mask `0x22C0`.

**Tech Stack:** Solidity 0.8.29, Foundry 1.7.1, forge-std from the Agora submodule, Agora Governor and its OpenZeppelin fork as a git submodule.

**Spec:** `docs/spec.md` sections 5.2, 6, 7, 14 (M1), 15.1, 15.2, 15.3 (contract-level fixtures).

## Global Constraints

See the overview plan. Additionally for this part:

- `pragma solidity 0.8.29;` exact in our files.
- Our files import Agora through `agora-governor/src/...` and OpenZeppelin through `@openzeppelin/contracts/...`. Agora's own files import `src/...`; the context remapping in `remappings.txt` resolves that.
- Tests live in `contracts/test/{unit,integration,invariant,negative}` and share `contracts/test/fixtures/FleetFixture.sol`.
- Run all tests with `forge test` from `contracts/`. Every task ends with `forge test` green and a commit.

## File structure

```
contracts/
  foundry.toml
  remappings.txt
  lib/agora-governor                 (git submodule, pinned 11a1164)
  src/
    libraries/ActionId.sol           actionId hash shared by hook and ledger
    FleetRegistry.sol                membership + manifests
    FleetVotes.sol                   ERC20Votes with transfer lock and member-only delegation
    TaskLedger.sol                   tasks, charters, decisions
    FleetHook.sol                    Agora hook: propose/vote admission, success rule
    deploy/FleetDeployer.sol         deployment sequence as an internal library
    deploy/HookMiner.sol             CREATE2 salt mining for the hook address
  script/
    DeployFleet.s.sol                reads JSON config, deploys, writes manifest
    VerifyDeployment.s.sol           reads manifest, asserts post-conditions
    export-abi.sh                    writes ABIs to packages/abi/abis
  test/
    fixtures/FleetFixture.sol        deploys a 5-member fleet, helpers
    unit/FleetRegistry.t.sol
    unit/FleetVotes.t.sol
    unit/TaskLedger.t.sol
    unit/FleetHook.t.sol
    unit/HookMiner.t.sol
    integration/Lifecycle.t.sol      propose -> vote -> queue -> execute -> ledger
    integration/Admission.t.sol      forbidden targets, malformed calldata, impostor
    integration/Amendment.t.sol      version bump invalidates pending, exceptions scoped
    integration/Guardian.t.sol       pause + cancel
    integration/BallotProfiles.t.sol 4^5 profiles + delegation concentrations
    invariant/FleetVotesInvariant.t.sol
    invariant/TaskLedgerInvariant.t.sol
    negative/UnrestrictedDelegation.t.sol
    negative/ParticipationQuorum.t.sol
    negative/AdminBypass.t.sol
    negative/UnconstrainedTimelock.t.sol
    negative/FrontendOnly.t.sol
deployments/
  31337/latest.json                  written by the deploy script
  configs/local-5.json               example deploy config
docs/compatibility-notes.md
```

---

### Task 1: Foundry project with the pinned Agora submodule

**Files:**
- Create: `contracts/foundry.toml`, `contracts/remappings.txt`, `contracts/.gitignore`, `.gitmodules` (via `git submodule add`)
- Create: `contracts/src/libraries/ActionId.sol` (smallest compilable unit to prove the toolchain)
- Test: `contracts/test/unit/ActionId.t.sol`

**Interfaces:**
- Produces: `library ActionId { function compute(address ledger, uint256 taskId, uint8 kind, uint32 expectedVersion, bytes32 payloadHash) internal view returns (bytes32); }` = `keccak256(abi.encode(block.chainid, ledger, taskId, kind, expectedVersion, payloadHash))`.

- [ ] **Step 1: Add the submodule at the pinned commit**

```bash
cd /home/operator/bliss/agora-ai/fleet-governance
mkdir -p contracts && cd contracts
git submodule add https://github.com/voteagora/agora-governor.git lib/agora-governor
cd lib/agora-governor && git checkout 11a11641ce1f4f691c300d530eae3c7203593b85 && git submodule update --init --recursive && cd ../..
git -C lib/agora-governor/lib/openzeppelin-contracts rev-parse HEAD   # must print 3d139e998b9843179d72b28a3264834b01baf160
```

- [ ] **Step 2: Write foundry.toml and remappings.txt**

`contracts/foundry.toml`:
```toml
[profile.default]
src = 'src'
out = 'out'
libs = ['lib']
test = 'test'
script = 'script'
optimizer = true
optimizer_runs = 200
evm_version = 'cancun'
solc_version = '0.8.29'
fs_permissions = [
  { access = "read-write", path = "./" },
  { access = "read-write", path = "../deployments" },
]

[fuzz]
runs = 256

[invariant]
runs = 64
depth = 32
fail_on_revert = false

[profile.ci.fuzz]
runs = 1024
```

`contracts/remappings.txt`:
```
agora-governor/=lib/agora-governor/
@openzeppelin/contracts/=lib/agora-governor/lib/openzeppelin-contracts/contracts/
forge-std/=lib/agora-governor/lib/forge-std/src/
@solady/=lib/agora-governor/lib/solady/src/
lib/agora-governor/:src/=lib/agora-governor/src/
```

If `forge build` in Step 5 cannot resolve `src/interfaces/IHooks.sol` from inside the submodule, replace the last line with the global remapping `src/=lib/agora-governor/src/` and make sure every test imports our contracts with relative paths (`../../src/...`), never `src/...`. Record which form worked in `docs/compatibility-notes.md`.

`contracts/.gitignore`:
```
out/
cache/
broadcast/
```

- [ ] **Step 3: Write the failing test**

`contracts/test/unit/ActionId.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {ActionId} from "../../src/libraries/ActionId.sol";

contract ActionIdTest is Test {
    function test_ComputeMatchesReferenceEncoding() public view {
        address ledger = address(0x1234);
        bytes32 expected = keccak256(abi.encode(block.chainid, ledger, uint256(7), uint8(1), uint32(1), keccak256("x")));
        assertEq(ActionId.compute(ledger, 7, 1, 1, keccak256("x")), expected);
    }

    function test_DifferentChainDifferentId() public {
        bytes32 a = ActionId.compute(address(1), 1, 0, 1, bytes32(0));
        vm.chainId(84532);
        bytes32 b = ActionId.compute(address(1), 1, 0, 1, bytes32(0));
        assertTrue(a != b);
    }
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd contracts && forge test --match-contract ActionIdTest`
Expected: compilation error, `ActionId` not found.

- [ ] **Step 5: Implement ActionId**

`contracts/src/libraries/ActionId.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Identity of one ledger action, independent of the proposal that carries it.
/// @dev The hook stores it per proposal and the ledger emits it per decision so the two events join.
library ActionId {
    function compute(address ledger, uint256 taskId, uint8 kind, uint32 expectedVersion, bytes32 payloadHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, ledger, taskId, kind, expectedVersion, payloadHash));
    }
}
```

- [ ] **Step 6: Run the test and the full upstream governor build**

Run: `forge test --match-contract ActionIdTest -vv` then `forge build --sizes 2>&1 | grep -E "AgoraGovernor|ActionId"`
Expected: 2 tests pass; `AgoraGovernor` compiles from the submodule (it is pulled in only once a file imports it; if the grep shows nothing yet, that is fine and Task 5 will confirm).

- [ ] **Step 7: Commit**

```bash
cd /home/operator/bliss/agora-ai/fleet-governance
git add .gitmodules contracts
git commit -m "feat(contracts): foundry project pinned to Agora governor 11a1164

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 2: FleetRegistry

**Files:**
- Create: `contracts/src/FleetRegistry.sol`
- Test: `contracts/test/unit/FleetRegistry.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  contract FleetRegistry {
      error InvalidMemberCount(uint256 count); error LengthMismatch(); error ZeroAddress();
      error DuplicateMember(address account); error ManifestTooLong(uint256 length, uint256 max);
      error NotMember(address account); error UnknownAgent(uint256 agentId);
      event MemberRegistered(uint256 indexed agentId, address indexed account, bytes32 manifestHash, string manifest);
      event FleetManifestSet(bytes32 manifestHash, string manifest);
      uint256 constant MIN_MEMBERS = 2; uint256 constant MAX_MEMBERS = 64;
      uint256 constant MAX_FLEET_MANIFEST_BYTES = 4096; uint256 constant MAX_AGENT_MANIFEST_BYTES = 2048;
      bytes32 immutable fleetManifestHash;
      constructor(address[] memory members_, string[] memory agentManifests_, string memory fleetManifest_);
      function memberCount() external view returns (uint256);
      function members() external view returns (address[] memory);
      function isMember(address) external view returns (bool);
      function accountOf(uint256 agentId) external view returns (address);   // reverts UnknownAgent
      function idOf(address) external view returns (uint256);               // reverts NotMember; ids are 0-based
      function agentManifest(uint256 agentId) external view returns (string memory);
      function fleetManifest() external view returns (string memory);
  }
  ```

- [ ] **Step 1: Write the failing tests**

`contracts/test/unit/FleetRegistry.t.sol`:
```solidity
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
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract FleetRegistryTest`
Expected: compilation error, `FleetRegistry` not found.

- [ ] **Step 3: Implement**

`contracts/src/FleetRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @title FleetRegistry
/// @notice Immutable membership and public manifests for one fleet deployment.
/// @dev Agent ids are 0-based and scoped to this deployment. There is no admission, rotation,
///      or removal path: a different fleet is a different deployment.
contract FleetRegistry {
    error InvalidMemberCount(uint256 count);
    error LengthMismatch();
    error ZeroAddress();
    error DuplicateMember(address account);
    error ManifestTooLong(uint256 length, uint256 max);
    error NotMember(address account);
    error UnknownAgent(uint256 agentId);

    event MemberRegistered(uint256 indexed agentId, address indexed account, bytes32 manifestHash, string manifest);
    event FleetManifestSet(bytes32 manifestHash, string manifest);

    uint256 public constant MIN_MEMBERS = 2;
    uint256 public constant MAX_MEMBERS = 64;
    uint256 public constant MAX_FLEET_MANIFEST_BYTES = 4096;
    uint256 public constant MAX_AGENT_MANIFEST_BYTES = 2048;

    bytes32 public immutable fleetManifestHash;

    address[] private _members;
    string[] private _agentManifests;
    string private _fleetManifest;
    mapping(address account => uint256 idPlusOne) private _idPlusOne;

    constructor(address[] memory members_, string[] memory agentManifests_, string memory fleetManifest_) {
        uint256 n = members_.length;
        if (n < MIN_MEMBERS || n > MAX_MEMBERS) revert InvalidMemberCount(n);
        if (agentManifests_.length != n) revert LengthMismatch();
        uint256 fleetLen = bytes(fleetManifest_).length;
        if (fleetLen > MAX_FLEET_MANIFEST_BYTES) revert ManifestTooLong(fleetLen, MAX_FLEET_MANIFEST_BYTES);

        for (uint256 i = 0; i < n; ++i) {
            address member = members_[i];
            if (member == address(0)) revert ZeroAddress();
            if (_idPlusOne[member] != 0) revert DuplicateMember(member);
            uint256 len = bytes(agentManifests_[i]).length;
            if (len > MAX_AGENT_MANIFEST_BYTES) revert ManifestTooLong(len, MAX_AGENT_MANIFEST_BYTES);
            _idPlusOne[member] = i + 1;
            _members.push(member);
            _agentManifests.push(agentManifests_[i]);
            emit MemberRegistered(i, member, keccak256(bytes(agentManifests_[i])), agentManifests_[i]);
        }

        _fleetManifest = fleetManifest_;
        fleetManifestHash = keccak256(bytes(fleetManifest_));
        emit FleetManifestSet(fleetManifestHash, fleetManifest_);
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function isMember(address account) external view returns (bool) {
        return _idPlusOne[account] != 0;
    }

    function accountOf(uint256 agentId) external view returns (address) {
        if (agentId >= _members.length) revert UnknownAgent(agentId);
        return _members[agentId];
    }

    function idOf(address account) external view returns (uint256) {
        uint256 idPlusOne = _idPlusOne[account];
        if (idPlusOne == 0) revert NotMember(account);
        return idPlusOne - 1;
    }

    function agentManifest(uint256 agentId) external view returns (string memory) {
        if (agentId >= _members.length) revert UnknownAgent(agentId);
        return _agentManifests[agentId];
    }

    function fleetManifest() external view returns (string memory) {
        return _fleetManifest;
    }
}
```

- [ ] **Step 4: Run tests**

Run: `forge test --match-contract FleetRegistryTest -vv`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/FleetRegistry.sol contracts/test/unit/FleetRegistry.t.sol
git commit -m "feat(contracts): FleetRegistry with immutable membership and manifests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 3: FleetVotes

**Files:**
- Create: `contracts/src/FleetVotes.sol`
- Test: `contracts/test/unit/FleetVotes.t.sol`

**Interfaces:**
- Consumes: `FleetRegistry` from Task 2.
- Produces:
  ```solidity
  contract FleetVotes is ERC20Votes {
      error TransfersDisabled(); error ApprovalsDisabled(); error NotMember(address); error InvalidDelegatee(address);
      uint256 constant UNIT = 1e18;
      FleetRegistry immutable registry;
      constructor(string memory name_, string memory symbol_, FleetRegistry registry_);   // mints UNIT to each member, self-delegates
      function clock() public view override returns (uint48);        // timestamp
      function CLOCK_MODE() public pure override returns (string memory); // "mode=timestamp"
  }
  ```

- [ ] **Step 1: Write the failing tests**

`contracts/test/unit/FleetVotes.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

contract FleetVotesTest is Test {
    address[] members;
    uint256[] keys;
    string[] manifests;
    FleetRegistry registry;
    FleetVotes token;
    address outsider = makeAddr("outsider");

    function setUp() public {
        vm.warp(1_800_000_000);
        for (uint256 i = 0; i < 5; i++) {
            (address a, uint256 k) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            members.push(a);
            keys.push(k);
            manifests.push("{}");
        }
        registry = new FleetRegistry(members, manifests, "{}");
        token = new FleetVotes("Fleet Vote", "FLEET", registry);
        vm.warp(block.timestamp + 1);
    }

    function test_SupplyAndBalances() public view {
        assertEq(token.totalSupply(), 5e18);
        assertEq(token.decimals(), 18);
        assertEq(token.name(), "Fleet Vote");
        assertEq(token.symbol(), "FLEET");
        for (uint256 i = 0; i < 5; i++) {
            assertEq(token.balanceOf(members[i]), 1e18);
            assertEq(token.getVotes(members[i]), 1e18);
            assertEq(token.delegates(members[i]), members[i]);
        }
        assertEq(token.balanceOf(outsider), 0);
        assertEq(token.getVotes(outsider), 0);
    }

    function test_TimestampClock() public view {
        assertEq(token.clock(), uint48(block.timestamp));
        assertEq(token.CLOCK_MODE(), "mode=timestamp");
        assertEq(token.getPastTotalSupply(block.timestamp - 1), 5e18);
        assertEq(token.getPastVotes(members[0], block.timestamp - 1), 1e18);
    }

    function test_TransfersRevert() public {
        vm.startPrank(members[0]);
        vm.expectRevert(FleetVotes.TransfersDisabled.selector);
        token.transfer(members[1], 1e18);
        vm.expectRevert(FleetVotes.TransfersDisabled.selector);
        token.transfer(members[1], 0);
        vm.stopPrank();
    }

    function test_ApprovalsRevert() public {
        vm.prank(members[0]);
        vm.expectRevert(FleetVotes.ApprovalsDisabled.selector);
        token.approve(members[1], 1);
        vm.prank(members[1]);
        vm.expectRevert(); // transferFrom fails before reaching _update: allowance path is disabled
        token.transferFrom(members[0], members[1], 1);
        assertEq(token.balanceOf(members[0]), 1e18);
    }

    function test_DelegateToMemberMovesPower() public {
        vm.prank(members[0]);
        token.delegate(members[1]);
        assertEq(token.getVotes(members[0]), 0);
        assertEq(token.getVotes(members[1]), 2e18);
        assertEq(token.balanceOf(members[0]), 1e18);
        vm.warp(block.timestamp + 1);
        assertEq(token.getPastVotes(members[1], block.timestamp - 1), 2e18);
        // return power to self
        vm.prank(members[0]);
        token.delegate(members[0]);
        assertEq(token.getVotes(members[0]), 1e18);
        assertEq(token.getVotes(members[1]), 1e18);
    }

    function test_SelfDelegationIdempotent() public {
        vm.prank(members[0]);
        token.delegate(members[0]);
        assertEq(token.getVotes(members[0]), 1e18);
    }

    function test_DelegateToNonMemberOrZeroReverts() public {
        vm.startPrank(members[0]);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, outsider));
        token.delegate(outsider);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, address(0)));
        token.delegate(address(0));
        vm.stopPrank();
    }

    function test_NonMemberCannotDelegate() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.NotMember.selector, outsider));
        token.delegate(members[0]);
    }

    function test_DelegateBySigCannotBypassRestriction() public {
        uint256 nonce = token.nonces(members[0]);
        uint256 expiry = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)"), outsider, nonce, expiry)
        );
        bytes32 digest = _hashTypedData(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], digest);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, outsider));
        token.delegateBySig(outsider, nonce, expiry, v, r, s);
    }

    function test_DelegateBySigToMemberWorks() public {
        uint256 nonce = token.nonces(members[0]);
        uint256 expiry = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)"), members[2], nonce, expiry)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[0], _hashTypedData(structHash));
        token.delegateBySig(members[2], nonce, expiry, v, r, s);
        assertEq(token.getVotes(members[2]), 2e18);
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = token.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract FleetVotesTest`
Expected: compilation error, `FleetVotes` not found.

- [ ] **Step 3: Implement**

`contracts/src/FleetVotes.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";
import {FleetRegistry} from "./FleetRegistry.sol";

/// @title FleetVotes
/// @notice One governance vote per fleet member. Non-transferable. Delegatable only to members.
/// @dev Supply is minted once in the constructor and never changes. Timestamp clock (ERC-6372).
contract FleetVotes is ERC20Votes {
    error TransfersDisabled();
    error ApprovalsDisabled();
    error NotMember(address account);
    error InvalidDelegatee(address delegatee);

    uint256 public constant UNIT = 1e18;

    FleetRegistry public immutable registry;

    constructor(string memory name_, string memory symbol_, FleetRegistry registry_)
        ERC20(name_, symbol_)
        EIP712(name_, "1")
    {
        registry = registry_;
        uint256 n = registry_.memberCount();
        for (uint256 i = 0; i < n; ++i) {
            address member = registry_.accountOf(i);
            _mint(member, UNIT);
            _delegate(member, member);
        }
    }

    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /// @dev Only constructor mints pass. Every transfer and burn reverts, including zero-value ones.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) revert TransfersDisabled();
        super._update(from, to, value);
    }

    /// @dev Closes approve, permit-style, and allowance paths in one place.
    function _approve(address, address, uint256, bool) internal pure override {
        revert ApprovalsDisabled();
    }

    /// @dev Both delegate() and delegateBySig() reach here in the pinned Votes implementation.
    function _delegate(address account, address delegatee) internal override {
        if (!registry.isMember(account)) revert NotMember(account);
        if (delegatee != account && !registry.isMember(delegatee)) revert InvalidDelegatee(delegatee);
        super._delegate(account, delegatee);
    }
}
```

- [ ] **Step 4: Run tests**

Run: `forge test --match-contract FleetVotesTest -vv`
Expected: 10 tests pass. If `CLOCK_MODE` fails to compile because the base declares it `view`, change ours to `view` and keep the test.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/FleetVotes.sol contracts/test/unit/FleetVotes.t.sol
git commit -m "feat(contracts): FleetVotes, one non-transferable member-delegatable vote each

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 4: TaskLedger

**Files:**
- Create: `contracts/src/TaskLedger.sol`
- Test: `contracts/test/unit/TaskLedger.t.sol`

**Interfaces:**
- Consumes: `ActionId` (Task 1).
- Produces:
  ```solidity
  contract TaskLedger {
      enum TaskState { Open, Stopped, Completed, Expired }
      enum DecisionKind { CHOOSE_PATH, GRANT_EXCEPTION, AMEND_CHARTER, STOP_TASK, ESCALATE_TO_HUMAN }
      struct Task { uint256 id; address operator; uint64 createdAt; uint64 expiresAt; TaskState state; uint32 charterVersion; bytes32 charterHash; uint32 decisionCount; bool escalated; }
      struct Decision { uint256 taskId; uint32 index; DecisionKind kind; uint32 charterVersionBefore; uint32 charterVersionAfter; bytes32 payloadHash; bytes32 actionId; uint64 recordedAt; }
      uint256 constant MAX_CHARTER_BYTES = 8192; uint256 constant MAX_SUMMARY_BYTES = 1024; uint64 constant MIN_TASK_LIFETIME = 300;
      address immutable timelock; address immutable operator; address immutable guardian; uint64 immutable maxTaskLifetime;
      bool paused; uint256 taskCount;
      mapping(uint256 => mapping(bytes32 => uint32)) exceptionVersion;
      constructor(address timelock_, address operator_, address guardian_, uint64 maxTaskLifetime_);
      function openTask(string calldata charterText, uint64 lifetime) external returns (uint256 taskId);   // onlyOperator whenNotPaused; ids start at 1
      function recordDecision(uint256 taskId, uint8 kind, uint32 expectedVersion, bytes32 payloadHash, string calldata newCharterText, string calldata summary) external; // onlyTimelock whenNotPaused
      function completeTask(uint256 taskId) external;   // onlyOperator
      function expireTask(uint256 taskId) external;     // permissionless after expiresAt
      function pause() external; function unpause() external;   // onlyGuardian
      function getTask(uint256) external view returns (Task memory);
      function charterText(uint256) external view returns (string memory);
      function getDecision(uint256 taskId, uint32 index) external view returns (Decision memory);
      function decisionCount(uint256 taskId) external view returns (uint256);
  }
  ```
  Events: `TaskOpened(uint256 indexed taskId, address indexed operator, uint64 expiresAt, bytes32 charterHash, string charterText)`, `DecisionRecorded(uint256 indexed taskId, uint32 indexed index, DecisionKind kind, uint32 charterVersionBefore, uint32 charterVersionAfter, bytes32 payloadHash, bytes32 actionId, string summary)`, `CharterAmended(uint256 indexed taskId, uint32 version, bytes32 charterHash, string charterText)`, `TaskStopped(uint256 indexed taskId, uint32 decisionIndex)`, `TaskCompleted(uint256 indexed taskId)`, `TaskLapsed(uint256 indexed taskId)`, `Paused(address account)`, `Unpaused(address account)`.
  Errors: `NotOperator(address)`, `NotTimelock(address)`, `NotGuardian(address)`, `EnforcedPause()`, `ExpectedPause()`, `UnknownTask(uint256)`, `UnknownDecision(uint256,uint32)`, `TaskNotOpen(uint256,TaskState)`, `TaskExpired(uint256)`, `TaskNotExpired(uint256)`, `CharterVersionMismatch(uint32 expected,uint32 actual)`, `InvalidDecisionKind(uint8)`, `CharterTextLengthOutOfRange(uint256)`, `CharterTextNotAllowed()`, `CharterHashMismatch(bytes32 expected,bytes32 actual)`, `SummaryTooLong(uint256)`, `LifetimeOutOfRange(uint64,uint64,uint64)`, `ZeroAddress()`.

- [ ] **Step 1: Write the failing tests**

`contracts/test/unit/TaskLedger.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {ActionId} from "../../src/libraries/ActionId.sol";

contract TaskLedgerTest is Test {
    address timelock = makeAddr("timelock");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address outsider = makeAddr("outsider");
    TaskLedger ledger;
    string charter = '{"schema":"fleet.charter.v1","goal":"pass tests"}';

    function setUp() public {
        vm.warp(1_800_000_000);
        ledger = new TaskLedger(timelock, operator, guardian, 7200);
    }

    function _open() internal returns (uint256) {
        vm.prank(operator);
        return ledger.openTask(charter, 3600);
    }

    function _record(uint256 taskId, uint8 kind, uint32 version, bytes32 payloadHash, string memory text, string memory summary) internal {
        vm.prank(timelock);
        ledger.recordDecision(taskId, kind, version, payloadHash, text, summary);
    }

    function test_ConstructorRejectsZeroAndShortLifetime() public {
        vm.expectRevert(TaskLedger.ZeroAddress.selector);
        new TaskLedger(address(0), operator, guardian, 7200);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.LifetimeOutOfRange.selector, 299, 300, type(uint64).max));
        new TaskLedger(timelock, operator, guardian, 299);
    }

    function test_OpenTaskStoresCharterVersion1() public {
        vm.expectEmit(true, true, false, true);
        emit TaskLedger.TaskOpened(1, operator, uint64(block.timestamp + 3600), keccak256(bytes(charter)), charter);
        uint256 id = _open();
        assertEq(id, 1);
        TaskLedger.Task memory t = ledger.getTask(1);
        assertEq(uint8(t.state), uint8(TaskLedger.TaskState.Open));
        assertEq(t.charterVersion, 1);
        assertEq(t.charterHash, keccak256(bytes(charter)));
        assertEq(t.expiresAt, block.timestamp + 3600);
        assertEq(t.decisionCount, 0);
        assertEq(ledger.charterText(1), charter);
        assertEq(ledger.taskCount(), 1);
    }

    function test_OpenTaskOnlyOperator() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotOperator.selector, outsider));
        ledger.openTask(charter, 3600);
    }

    function test_OpenTaskBounds() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterTextLengthOutOfRange.selector, 0));
        ledger.openTask("", 3600);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterTextLengthOutOfRange.selector, 8193));
        ledger.openTask(new string(8193), 3600);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.LifetimeOutOfRange.selector, 299, 300, 7200));
        ledger.openTask(charter, 299);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.LifetimeOutOfRange.selector, 7201, 300, 7200));
        ledger.openTask(charter, 7201);
        vm.stopPrank();
    }

    function test_RecordDecisionOnlyTimelock() public {
        uint256 id = _open();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotTimelock.selector, operator));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
    }

    function test_ChoosePathRecordsWithoutVersionChange() public {
        uint256 id = _open();
        bytes32 payload = keccak256("path-a");
        bytes32 actionId = ActionId.compute(address(ledger), id, 0, 1, payload);
        vm.expectEmit(true, true, false, true);
        emit TaskLedger.DecisionRecorded(id, 0, TaskLedger.DecisionKind.CHOOSE_PATH, 1, 1, payload, actionId, "take path a");
        _record(id, 0, 1, payload, "", "take path a");
        TaskLedger.Decision memory d = ledger.getDecision(id, 0);
        assertEq(d.actionId, actionId);
        assertEq(d.charterVersionBefore, 1);
        assertEq(d.charterVersionAfter, 1);
        assertEq(ledger.getTask(id).charterVersion, 1);
        assertEq(ledger.decisionCount(id), 1);
    }

    function test_GrantExceptionScopedToVersion() public {
        uint256 id = _open();
        bytes32 payload = keccak256("fetch examples.internal");
        _record(id, 1, 1, payload, "", "one-time exception");
        assertEq(ledger.exceptionVersion(id, payload), 1);
        // amend the charter, exception version no longer equals current version
        string memory newCharter = '{"schema":"fleet.charter.v1","goal":"pass tests","v":2}';
        _record(id, 2, 1, keccak256(bytes(newCharter)), newCharter, "amend");
        assertEq(ledger.getTask(id).charterVersion, 2);
        assertEq(ledger.exceptionVersion(id, payload), 1);
    }

    function test_AmendCharterBumpsVersionAndStoresText() public {
        uint256 id = _open();
        string memory newCharter = '{"goal":"new"}';
        bytes32 h = keccak256(bytes(newCharter));
        vm.expectEmit(true, false, false, true);
        emit TaskLedger.CharterAmended(id, 2, h, newCharter);
        _record(id, 2, 1, h, newCharter, "amend");
        TaskLedger.Task memory t = ledger.getTask(id);
        assertEq(t.charterVersion, 2);
        assertEq(t.charterHash, h);
        assertEq(ledger.charterText(id), newCharter);
        TaskLedger.Decision memory d = ledger.getDecision(id, 0);
        assertEq(d.charterVersionBefore, 1);
        assertEq(d.charterVersionAfter, 2);
    }

    function test_AmendRequiresMatchingHashAndText() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterTextLengthOutOfRange.selector, 0));
        ledger.recordDecision(id, 2, 1, keccak256(""), "", "amend");
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterHashMismatch.selector, bytes32(uint256(1)), keccak256("abc")));
        ledger.recordDecision(id, 2, 1, bytes32(uint256(1)), "abc", "amend");
    }

    function test_NonAmendRejectsCharterText() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(TaskLedger.CharterTextNotAllowed.selector);
        ledger.recordDecision(id, 0, 1, bytes32(0), "abc", "x");
    }

    function test_VersionMismatchRejected() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.CharterVersionMismatch.selector, 2, 1));
        ledger.recordDecision(id, 0, 2, bytes32(0), "", "x");
    }

    function test_InvalidKindAndLongSummaryRejected() public {
        uint256 id = _open();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.InvalidDecisionKind.selector, 5));
        ledger.recordDecision(id, 5, 1, bytes32(0), "", "x");
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.SummaryTooLong.selector, 1025));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", new string(1025));
    }

    function test_StopTaskClosesFurtherDecisions() public {
        uint256 id = _open();
        vm.expectEmit(true, false, false, true);
        emit TaskLedger.TaskStopped(id, 0);
        _record(id, 3, 1, bytes32(0), "", "stop");
        assertEq(uint8(ledger.getTask(id).state), uint8(TaskLedger.TaskState.Stopped));
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.TaskNotOpen.selector, id, TaskLedger.TaskState.Stopped));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
    }

    function test_EscalateSetsFlagAndNextDecisionClearsIt() public {
        uint256 id = _open();
        _record(id, 4, 1, bytes32(0), "", "escalate");
        assertTrue(ledger.getTask(id).escalated);
        _record(id, 0, 1, keccak256("p"), "", "choose");
        assertFalse(ledger.getTask(id).escalated);
    }

    function test_ExpiryBlocksRecordingAndExpireTaskIsPermissionless() public {
        uint256 id = _open();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.TaskNotExpired.selector, id));
        ledger.expireTask(id);
        vm.warp(block.timestamp + 3600);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.TaskExpired.selector, id));
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
        vm.prank(outsider);
        ledger.expireTask(id);
        assertEq(uint8(ledger.getTask(id).state), uint8(TaskLedger.TaskState.Expired));
    }

    function test_CompleteTaskOnlyOperator() public {
        uint256 id = _open();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotOperator.selector, outsider));
        ledger.completeTask(id);
        vm.prank(operator);
        ledger.completeTask(id);
        assertEq(uint8(ledger.getTask(id).state), uint8(TaskLedger.TaskState.Completed));
    }

    function test_PauseBlocksOpenAndRecord() public {
        uint256 id = _open();
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.NotGuardian.selector, outsider));
        ledger.pause();
        vm.prank(guardian);
        ledger.pause();
        assertTrue(ledger.paused());
        vm.prank(operator);
        vm.expectRevert(TaskLedger.EnforcedPause.selector);
        ledger.openTask(charter, 3600);
        vm.prank(timelock);
        vm.expectRevert(TaskLedger.EnforcedPause.selector);
        ledger.recordDecision(id, 0, 1, bytes32(0), "", "x");
        vm.prank(guardian);
        vm.expectRevert(TaskLedger.EnforcedPause.selector);
        ledger.pause();
        vm.prank(guardian);
        ledger.unpause();
        assertFalse(ledger.paused());
        vm.prank(guardian);
        vm.expectRevert(TaskLedger.ExpectedPause.selector);
        ledger.unpause();
    }

    function test_UnknownLookupsRevert() public {
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.UnknownTask.selector, 9));
        ledger.getTask(9);
        uint256 id = _open();
        vm.expectRevert(abi.encodeWithSelector(TaskLedger.UnknownDecision.selector, id, 0));
        ledger.getDecision(id, 0);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract TaskLedgerTest`
Expected: compilation error, `TaskLedger` not found.

- [ ] **Step 3: Implement**

`contracts/src/TaskLedger.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ActionId} from "./libraries/ActionId.sol";

/// @title TaskLedger
/// @notice Public record of tasks, charters, and fleet decisions. Holds no funds.
/// @dev Decisions are written only by the timelock, which only executes operations the governor
///      scheduled after a successful vote. A recorded decision says the fleet decided, not that
///      the fleet obeyed; obedience is enforced offchain by the gateway in v1.
contract TaskLedger {
    enum TaskState {
        Open,
        Stopped,
        Completed,
        Expired
    }

    enum DecisionKind {
        CHOOSE_PATH,
        GRANT_EXCEPTION,
        AMEND_CHARTER,
        STOP_TASK,
        ESCALATE_TO_HUMAN
    }

    struct Task {
        uint256 id;
        address operator;
        uint64 createdAt;
        uint64 expiresAt;
        TaskState state;
        uint32 charterVersion;
        bytes32 charterHash;
        uint32 decisionCount;
        bool escalated;
    }

    struct Decision {
        uint256 taskId;
        uint32 index;
        DecisionKind kind;
        uint32 charterVersionBefore;
        uint32 charterVersionAfter;
        bytes32 payloadHash;
        bytes32 actionId;
        uint64 recordedAt;
    }

    error NotOperator(address account);
    error NotTimelock(address account);
    error NotGuardian(address account);
    error EnforcedPause();
    error ExpectedPause();
    error UnknownTask(uint256 taskId);
    error UnknownDecision(uint256 taskId, uint32 index);
    error TaskNotOpen(uint256 taskId, TaskState state);
    error TaskExpired(uint256 taskId);
    error TaskNotExpired(uint256 taskId);
    error CharterVersionMismatch(uint32 expected, uint32 actual);
    error InvalidDecisionKind(uint8 kind);
    error CharterTextLengthOutOfRange(uint256 length);
    error CharterTextNotAllowed();
    error CharterHashMismatch(bytes32 expected, bytes32 actual);
    error SummaryTooLong(uint256 length);
    error LifetimeOutOfRange(uint64 lifetime, uint64 min, uint64 max);
    error ZeroAddress();

    event TaskOpened(uint256 indexed taskId, address indexed operator, uint64 expiresAt, bytes32 charterHash, string charterText);
    event DecisionRecorded(
        uint256 indexed taskId,
        uint32 indexed index,
        DecisionKind kind,
        uint32 charterVersionBefore,
        uint32 charterVersionAfter,
        bytes32 payloadHash,
        bytes32 actionId,
        string summary
    );
    event CharterAmended(uint256 indexed taskId, uint32 version, bytes32 charterHash, string charterText);
    event TaskStopped(uint256 indexed taskId, uint32 decisionIndex);
    event TaskCompleted(uint256 indexed taskId);
    event TaskLapsed(uint256 indexed taskId);
    event Paused(address account);
    event Unpaused(address account);

    uint256 public constant MAX_CHARTER_BYTES = 8192;
    uint256 public constant MAX_SUMMARY_BYTES = 1024;
    uint64 public constant MIN_TASK_LIFETIME = 300;

    address public immutable timelock;
    address public immutable operator;
    address public immutable guardian;
    uint64 public immutable maxTaskLifetime;

    bool public paused;
    uint256 public taskCount;

    mapping(uint256 taskId => Task) private _tasks;
    mapping(uint256 taskId => string) private _charterTexts;
    mapping(uint256 taskId => Decision[]) private _decisions;
    /// @notice Charter version at which an exception for this exact action payload was granted; 0 when none.
    mapping(uint256 taskId => mapping(bytes32 payloadHash => uint32 version)) public exceptionVersion;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock(msg.sender);
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    constructor(address timelock_, address operator_, address guardian_, uint64 maxTaskLifetime_) {
        if (timelock_ == address(0) || operator_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (maxTaskLifetime_ < MIN_TASK_LIFETIME) {
            revert LifetimeOutOfRange(maxTaskLifetime_, MIN_TASK_LIFETIME, type(uint64).max);
        }
        timelock = timelock_;
        operator = operator_;
        guardian = guardian_;
        maxTaskLifetime = maxTaskLifetime_;
    }

    function openTask(string calldata charterText_, uint64 lifetime) external onlyOperator whenNotPaused returns (uint256 taskId) {
        uint256 len = bytes(charterText_).length;
        if (len == 0 || len > MAX_CHARTER_BYTES) revert CharterTextLengthOutOfRange(len);
        if (lifetime < MIN_TASK_LIFETIME || lifetime > maxTaskLifetime) {
            revert LifetimeOutOfRange(lifetime, MIN_TASK_LIFETIME, maxTaskLifetime);
        }
        taskId = ++taskCount;
        bytes32 charterHash = keccak256(bytes(charterText_));
        uint64 expiresAt = uint64(block.timestamp) + lifetime;
        _tasks[taskId] = Task({
            id: taskId,
            operator: msg.sender,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            state: TaskState.Open,
            charterVersion: 1,
            charterHash: charterHash,
            decisionCount: 0,
            escalated: false
        });
        _charterTexts[taskId] = charterText_;
        emit TaskOpened(taskId, msg.sender, expiresAt, charterHash, charterText_);
    }

    function recordDecision(
        uint256 taskId,
        uint8 kind,
        uint32 expectedVersion,
        bytes32 payloadHash,
        string calldata newCharterText,
        string calldata summary
    ) external onlyTimelock whenNotPaused {
        Task storage task = _task(taskId);
        if (task.state != TaskState.Open) revert TaskNotOpen(taskId, task.state);
        if (block.timestamp >= task.expiresAt) revert TaskExpired(taskId);
        if (expectedVersion != task.charterVersion) revert CharterVersionMismatch(expectedVersion, task.charterVersion);
        if (kind > uint8(DecisionKind.ESCALATE_TO_HUMAN)) revert InvalidDecisionKind(kind);
        if (bytes(summary).length > MAX_SUMMARY_BYTES) revert SummaryTooLong(bytes(summary).length);

        DecisionKind decisionKind = DecisionKind(kind);
        uint32 versionBefore = task.charterVersion;
        uint32 versionAfter = versionBefore;

        if (decisionKind == DecisionKind.AMEND_CHARTER) {
            uint256 len = bytes(newCharterText).length;
            if (len == 0 || len > MAX_CHARTER_BYTES) revert CharterTextLengthOutOfRange(len);
            bytes32 newHash = keccak256(bytes(newCharterText));
            if (newHash != payloadHash) revert CharterHashMismatch(payloadHash, newHash);
            versionAfter = versionBefore + 1;
            task.charterVersion = versionAfter;
            task.charterHash = newHash;
            _charterTexts[taskId] = newCharterText;
            emit CharterAmended(taskId, versionAfter, newHash, newCharterText);
        } else if (bytes(newCharterText).length != 0) {
            revert CharterTextNotAllowed();
        }

        if (decisionKind == DecisionKind.GRANT_EXCEPTION) exceptionVersion[taskId][payloadHash] = versionBefore;
        if (decisionKind == DecisionKind.STOP_TASK) task.state = TaskState.Stopped;
        task.escalated = decisionKind == DecisionKind.ESCALATE_TO_HUMAN;

        bytes32 actionId = ActionId.compute(address(this), taskId, kind, expectedVersion, payloadHash);
        uint32 index = task.decisionCount;
        task.decisionCount = index + 1;
        _decisions[taskId].push(
            Decision({
                taskId: taskId,
                index: index,
                kind: decisionKind,
                charterVersionBefore: versionBefore,
                charterVersionAfter: versionAfter,
                payloadHash: payloadHash,
                actionId: actionId,
                recordedAt: uint64(block.timestamp)
            })
        );
        emit DecisionRecorded(taskId, index, decisionKind, versionBefore, versionAfter, payloadHash, actionId, summary);
        if (decisionKind == DecisionKind.STOP_TASK) emit TaskStopped(taskId, index);
    }

    function completeTask(uint256 taskId) external onlyOperator {
        Task storage task = _task(taskId);
        if (task.state != TaskState.Open) revert TaskNotOpen(taskId, task.state);
        task.state = TaskState.Completed;
        emit TaskCompleted(taskId);
    }

    /// @notice Anyone may mark an expired task for indexing clarity. Funding-path safety never depends on it:
    ///         recordDecision checks the timestamp directly.
    function expireTask(uint256 taskId) external {
        Task storage task = _task(taskId);
        if (task.state != TaskState.Open) revert TaskNotOpen(taskId, task.state);
        if (block.timestamp < task.expiresAt) revert TaskNotExpired(taskId);
        task.state = TaskState.Expired;
        emit TaskLapsed(taskId);
    }

    function pause() external onlyGuardian {
        if (paused) revert EnforcedPause();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyGuardian {
        if (!paused) revert ExpectedPause();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _task(taskId);
    }

    function charterText(uint256 taskId) external view returns (string memory) {
        _task(taskId);
        return _charterTexts[taskId];
    }

    function getDecision(uint256 taskId, uint32 index) external view returns (Decision memory) {
        _task(taskId);
        if (index >= _decisions[taskId].length) revert UnknownDecision(taskId, index);
        return _decisions[taskId][index];
    }

    function decisionCount(uint256 taskId) external view returns (uint256) {
        return _task(taskId).decisionCount;
    }

    function _task(uint256 taskId) private view returns (Task storage task) {
        task = _tasks[taskId];
        if (task.id == 0) revert UnknownTask(taskId);
    }
}
```

- [ ] **Step 4: Run tests**

Run: `forge test --match-contract TaskLedgerTest -vv`
Expected: 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/TaskLedger.sol contracts/test/unit/TaskLedger.t.sol
git commit -m "feat(contracts): TaskLedger with charters, decisions, exceptions, pause

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 5: HookMiner and FleetHook

**Files:**
- Create: `contracts/src/deploy/HookMiner.sol`, `contracts/src/FleetHook.sol`
- Test: `contracts/test/unit/HookMiner.t.sol`, `contracts/test/unit/FleetHook.t.sol`

**Interfaces:**
- Consumes: `FleetRegistry`, `TaskLedger`, `ActionId`; Agora `IHooks`, `Hooks`, `AgoraGovernor`; OZ `IGovernor`, `TimelockController`.
- Produces:
  ```solidity
  library HookMiner {
      function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs) internal view returns (address hookAddress, bytes32 salt);
      function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address);
  }
  contract FleetHook is IHooks {
      uint160 constant PERMISSION_MASK = 0x22C0;
      uint256 constant MAX_DESCRIPTION_BYTES = 4096; uint256 constant MAX_REASON_BYTES = 1024; uint256 constant EXECUTION_MARGIN = 60;
      FleetRegistry immutable registry; TaskLedger immutable ledger; address immutable initializer;
      AgoraGovernor governor;                      // set once by initialize
      mapping(uint256 proposalId => bytes32) actionOf;
      mapping(uint256 proposalId => uint256) taskOf;
      mapping(uint256 taskId => mapping(address member => uint256 proposalId)) lastProposalOf;
      struct DecodedAction { uint256 taskId; uint8 kind; uint32 expectedVersion; bytes32 payloadHash; string newCharterText; string summary; }
      event Initialized(address governor);
      event DecisionProposed(uint256 indexed proposalId, uint256 indexed taskId, uint8 kind, uint32 expectedVersion, bytes32 payloadHash, bytes32 actionId, address indexed proposer);
      constructor(FleetRegistry registry_, TaskLedger ledger_, address initializer_);
      function initialize(address governor_) external;   // onlyInitializer, once, governor_.hooks() must equal this
      function getHookPermissions() public pure returns (Hooks.Permissions memory);
      function decodeAction(bytes memory data) public pure returns (DecodedAction memory);  // reverts MalformedCalldata / InvalidSelector
  }
  ```
  Errors: `NotInitializer(address)`, `AlreadyInitialized()`, `NotInitialized()`, `GovernorHookMismatch(address)`, `NotGovernor(address)`, `HookNotImplemented()`, `NotMember(address)`, `InvalidActionCount(uint256)`, `InvalidTarget(address)`, `NonZeroValue(uint256)`, `InvalidSelector(bytes4)`, `MalformedCalldata()`, `DescriptionLengthOutOfRange(uint256)`, `ReasonLengthOutOfRange(uint256)`, `ParamsNotAllowed()`, `InvalidSupport(uint8)`, `NoVotingPower(address)`, `LedgerPaused()`, `TaskNotOpen(uint256)`, `TaskExpired(uint256)`, `CharterVersionMismatch(uint32,uint32)`, `InvalidDecisionKind(uint8)`, `CharterTextInvalid(uint256)`, `CharterTextNotAllowed()`, `CharterHashMismatch(bytes32,bytes32)`, `SummaryTooLong(uint256)`, `InsufficientTaskTime(uint256 remaining, uint256 required)`, `MemberHasUnsettledProposal(address member, uint256 taskId, uint256 proposalId)`.

- [ ] **Step 1: Write the HookMiner test**

`contracts/test/unit/HookMiner.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {HookMiner} from "../../src/deploy/HookMiner.sol";

contract Probe {
    uint256 public x;
    constructor(uint256 x_) { x = x_; }
}

contract HookMinerTest is Test {
    function test_FindsSaltMatchingFlagsAndDeploysThere() public {
        uint160 flags = 0x22C0;
        (address predicted, bytes32 salt) = HookMiner.find(address(this), flags, type(Probe).creationCode, abi.encode(uint256(42)));
        assertEq(uint160(predicted) & 0xFFFF, flags);
        Probe p = new Probe{salt: salt}(42);
        assertEq(address(p), predicted);
        assertEq(p.x(), 42);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract HookMinerTest`
Expected: compilation error.

- [ ] **Step 3: Implement HookMiner**

`contracts/src/deploy/HookMiner.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Finds a CREATE2 salt whose resulting address carries exactly the requested low-16-bit flags.
/// @dev Expected work is 2^16 hashes. Deterministic: the first matching salt from zero is returned.
library HookMiner {
    uint160 internal constant FLAG_MASK = 0xFFFF;
    uint256 internal constant MAX_ITERATIONS = 500_000;

    error SaltNotFound();

    function find(address deployer, uint160 flags, bytes memory creationCode, bytes memory constructorArgs)
        internal
        view
        returns (address hookAddress, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(abi.encodePacked(creationCode, constructorArgs));
        for (uint256 i = 0; i < MAX_ITERATIONS; ++i) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, initCodeHash);
            if ((uint160(hookAddress) & FLAG_MASK) == flags && hookAddress.code.length == 0) {
                return (hookAddress, salt);
            }
        }
        revert SaltNotFound();
    }

    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
    }
}
```

- [ ] **Step 4: Run HookMiner test**

Run: `forge test --match-contract HookMinerTest -vv`
Expected: pass (takes a few seconds; 65k iterations).

- [ ] **Step 5: Write the FleetHook unit tests**

These test the hook in isolation with a mocked caller. The full governor path is Task 7. `contracts/test/unit/FleetHook.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {HookMiner} from "../../src/deploy/HookMiner.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IHooks} from "agora-governor/src/interfaces/IHooks.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
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
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this), FleetHook.PERMISSION_MASK, type(FleetHook).creationCode, abi.encode(registry, ledger, address(this))
        );
        hook = new FleetHook{salt: salt}(registry, ledger, address(this));
        assertEq(address(hook), predicted);
        governor = new AgoraGovernor(15, 120, 1e18, 6000, IVotes(address(token)), timelock, address(0), address(0), IHooks(address(hook)));
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
            address(this), FleetHook.PERMISSION_MASK, type(FleetHook).creationCode, abi.encode(registry, ledger, outsider)
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
```

- [ ] **Step 6: Run to verify failure**

Run: `forge test --match-contract FleetHookTest`
Expected: compilation error, `FleetHook` not found.

- [ ] **Step 7: Implement FleetHook**

`contracts/src/FleetHook.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IHooks} from "agora-governor/src/interfaces/IHooks.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FleetRegistry} from "./FleetRegistry.sol";
import {TaskLedger} from "./TaskLedger.sol";
import {ActionId} from "./libraries/ActionId.sol";

/// @title FleetHook
/// @notice Every fleet governance rule, attached to an unmodified Agora Governor through its hook system.
/// @dev Permission mask 0x22C0: beforeVoteSucceeded (1<<13), beforeVote (1<<9), beforePropose (1<<7),
///      afterPropose (1<<6). The address must carry exactly those bits; deploy with CREATE2 at a mined salt.
///      The governor calls hooks with `sender` = its own msg.sender (the proposer or voter) and the hook's
///      msg.sender is the governor.
contract FleetHook is IHooks {
    error NotInitializer(address account);
    error AlreadyInitialized();
    error NotInitialized();
    error GovernorHookMismatch(address governor);
    error NotGovernor(address account);
    error HookNotImplemented();
    error NotMember(address account);
    error InvalidActionCount(uint256 count);
    error InvalidTarget(address target);
    error NonZeroValue(uint256 value);
    error InvalidSelector(bytes4 selector);
    error MalformedCalldata();
    error DescriptionLengthOutOfRange(uint256 length);
    error ReasonLengthOutOfRange(uint256 length);
    error ParamsNotAllowed();
    error InvalidSupport(uint8 support);
    error NoVotingPower(address account);
    error LedgerPaused();
    error TaskNotOpen(uint256 taskId);
    error TaskExpired(uint256 taskId);
    error CharterVersionMismatch(uint32 expected, uint32 actual);
    error InvalidDecisionKind(uint8 kind);
    error CharterTextInvalid(uint256 length);
    error CharterTextNotAllowed();
    error CharterHashMismatch(bytes32 expected, bytes32 actual);
    error SummaryTooLong(uint256 length);
    error InsufficientTaskTime(uint256 remaining, uint256 required);
    error MemberHasUnsettledProposal(address member, uint256 taskId, uint256 proposalId);

    event Initialized(address governor);
    event DecisionProposed(
        uint256 indexed proposalId,
        uint256 indexed taskId,
        uint8 kind,
        uint32 expectedVersion,
        bytes32 payloadHash,
        bytes32 actionId,
        address indexed proposer
    );

    struct DecodedAction {
        uint256 taskId;
        uint8 kind;
        uint32 expectedVersion;
        bytes32 payloadHash;
        string newCharterText;
        string summary;
    }

    uint160 public constant PERMISSION_MASK = 0x22C0;
    uint256 public constant MAX_DESCRIPTION_BYTES = 4096;
    uint256 public constant MAX_REASON_BYTES = 1024;
    uint256 public constant EXECUTION_MARGIN = 60;

    FleetRegistry public immutable registry;
    TaskLedger public immutable ledger;
    address public immutable initializer;

    AgoraGovernor public governor;

    mapping(uint256 proposalId => bytes32 actionId) public actionOf;
    mapping(uint256 proposalId => uint256 taskId) public taskOf;
    mapping(uint256 taskId => mapping(address member => uint256 proposalId)) public lastProposalOf;

    modifier onlyGovernor() {
        if (address(governor) == address(0)) revert NotInitialized();
        if (msg.sender != address(governor)) revert NotGovernor(msg.sender);
        _;
    }

    constructor(FleetRegistry registry_, TaskLedger ledger_, address initializer_) {
        registry = registry_;
        ledger = ledger_;
        initializer = initializer_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function initialize(address governor_) external {
        if (msg.sender != initializer) revert NotInitializer(msg.sender);
        if (address(governor) != address(0)) revert AlreadyInitialized();
        if (address(AgoraGovernor(payable(governor_)).hooks()) != address(this)) revert GovernorHookMismatch(governor_);
        governor = AgoraGovernor(payable(governor_));
        emit Initialized(governor_);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeVoteSucceeded = true;
        permissions.beforeVote = true;
        permissions.beforePropose = true;
        permissions.afterPropose = true;
    }

    // ---------------------------------------------------------------------
    // Proposal admission
    // ---------------------------------------------------------------------

    function beforePropose(
        address sender,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) external override onlyGovernor returns (bytes4, uint256) {
        if (!registry.isMember(sender)) revert NotMember(sender);
        if (targets.length != 1 || values.length != 1 || calldatas.length != 1) revert InvalidActionCount(targets.length);
        if (targets[0] != address(ledger)) revert InvalidTarget(targets[0]);
        if (values[0] != 0) revert NonZeroValue(values[0]);
        uint256 descriptionLength = bytes(description).length;
        if (descriptionLength == 0 || descriptionLength > MAX_DESCRIPTION_BYTES) {
            revert DescriptionLengthOutOfRange(descriptionLength);
        }

        DecodedAction memory action = decodeAction(calldatas[0]);
        _validateAgainstLedger(action);
        return (IHooks.beforePropose.selector, 0);
    }

    function afterPropose(
        address,
        uint256 proposalId,
        address[] memory,
        uint256[] memory,
        bytes[] memory calldatas,
        string memory
    ) external override onlyGovernor returns (bytes4) {
        DecodedAction memory action = decodeAction(calldatas[0]);
        address proposer = governor.proposalProposer(proposalId);

        uint256 previous = lastProposalOf[action.taskId][proposer];
        if (previous != 0 && _isUnsettled(governor.state(previous))) {
            revert MemberHasUnsettledProposal(proposer, action.taskId, previous);
        }

        bytes32 actionId =
            ActionId.compute(address(ledger), action.taskId, action.kind, action.expectedVersion, action.payloadHash);
        actionOf[proposalId] = actionId;
        taskOf[proposalId] = action.taskId;
        lastProposalOf[action.taskId][proposer] = proposalId;

        emit DecisionProposed(
            proposalId, action.taskId, action.kind, action.expectedVersion, action.payloadHash, actionId, proposer
        );
        return IHooks.afterPropose.selector;
    }

    // ---------------------------------------------------------------------
    // Vote admission and success rule
    // ---------------------------------------------------------------------

    function beforeVote(
        address,
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory params
    ) external override onlyGovernor returns (bytes4, bool, uint256) {
        if (params.length != 0) revert ParamsNotAllowed();
        if (support > 2) revert InvalidSupport(support);
        if (!registry.isMember(account)) revert NotMember(account);
        uint256 reasonLength = bytes(reason).length;
        if (reasonLength == 0 || reasonLength > MAX_REASON_BYTES) revert ReasonLengthOutOfRange(reasonLength);
        if (governor.getVotes(account, governor.proposalSnapshot(proposalId)) == 0) revert NoVotingPower(account);
        return (IHooks.beforeVote.selector, false, 0);
    }

    /// @notice For-only quorum: For must reach quorum(proposalId) on its own and exceed Against.
    function beforeVoteSucceeded(address, uint256 proposalId) external view override returns (bytes4, bool, bool) {
        (uint256 againstVotes, uint256 forVotes,) = governor.proposalVotes(proposalId);
        bool succeeded = forVotes >= governor.quorum(proposalId) && forVotes > againstVotes;
        return (IHooks.beforeVoteSucceeded.selector, true, succeeded);
    }

    // ---------------------------------------------------------------------
    // Decoding helpers
    // ---------------------------------------------------------------------

    /// @notice Decodes recordDecision calldata and rejects anything that does not re-encode to identical bytes.
    function decodeAction(bytes memory data) public pure returns (DecodedAction memory action) {
        if (data.length < 4) revert MalformedCalldata();
        bytes4 selector = bytes4(data);
        if (selector != TaskLedger.recordDecision.selector) revert InvalidSelector(selector);
        bytes memory args = _tail(data);
        (action.taskId, action.kind, action.expectedVersion, action.payloadHash, action.newCharterText, action.summary) =
            abi.decode(args, (uint256, uint8, uint32, bytes32, string, string));
        bytes memory canonical = abi.encodeWithSelector(
            selector,
            action.taskId,
            action.kind,
            action.expectedVersion,
            action.payloadHash,
            action.newCharterText,
            action.summary
        );
        if (keccak256(canonical) != keccak256(data)) revert MalformedCalldata();
    }

    function _validateAgainstLedger(DecodedAction memory action) internal view {
        if (ledger.paused()) revert LedgerPaused();
        TaskLedger.Task memory task = ledger.getTask(action.taskId);
        if (task.state != TaskLedger.TaskState.Open) revert TaskNotOpen(action.taskId);
        if (block.timestamp >= task.expiresAt) revert TaskExpired(action.taskId);
        if (action.expectedVersion != task.charterVersion) {
            revert CharterVersionMismatch(action.expectedVersion, task.charterVersion);
        }
        if (action.kind > uint8(TaskLedger.DecisionKind.ESCALATE_TO_HUMAN)) revert InvalidDecisionKind(action.kind);

        uint256 charterLength = bytes(action.newCharterText).length;
        if (action.kind == uint8(TaskLedger.DecisionKind.AMEND_CHARTER)) {
            if (charterLength == 0 || charterLength > ledger.MAX_CHARTER_BYTES()) revert CharterTextInvalid(charterLength);
            bytes32 newHash = keccak256(bytes(action.newCharterText));
            if (newHash != action.payloadHash) revert CharterHashMismatch(action.payloadHash, newHash);
        } else if (charterLength != 0) {
            revert CharterTextNotAllowed();
        }
        uint256 summaryLength = bytes(action.summary).length;
        if (summaryLength > ledger.MAX_SUMMARY_BYTES()) revert SummaryTooLong(summaryLength);

        uint256 required = governor.votingDelay() + governor.votingPeriod()
            + TimelockController(payable(governor.timelock())).getMinDelay() + EXECUTION_MARGIN;
        uint256 remaining = task.expiresAt - block.timestamp;
        if (remaining < required) revert InsufficientTaskTime(remaining, required);
    }

    function _isUnsettled(IGovernor.ProposalState state) internal pure returns (bool) {
        return state == IGovernor.ProposalState.Pending || state == IGovernor.ProposalState.Active
            || state == IGovernor.ProposalState.Succeeded || state == IGovernor.ProposalState.Queued;
    }

    /// @dev Copies `data[4:]` into a fresh bytes array using MCOPY (cancun).
    function _tail(bytes memory data) private pure returns (bytes memory out) {
        assembly ("memory-safe") {
            let len := sub(mload(data), 4)
            out := mload(0x40)
            mstore(out, len)
            mcopy(add(out, 0x20), add(data, 0x24), len)
            mstore(0x40, add(out, and(add(add(len, 0x20), 0x1f), not(0x1f))))
        }
    }

    // ---------------------------------------------------------------------
    // Hooks this contract does not request. The governor never calls them because the address
    // lacks their permission bits; they revert so a misconfigured deployment fails loudly.
    // ---------------------------------------------------------------------

    function beforeInitialize(address) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function afterInitialize(address) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function afterVoteSucceeded(address, uint256, bool) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeQuorumCalculation(address, uint256) external pure override returns (bytes4, uint256) { revert HookNotImplemented(); }
    function afterQuorumCalculation(address, uint256, uint256) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function afterVote(address, uint256, uint256, address, uint8, string memory, bytes memory) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeCancel(address, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4, uint256) { revert HookNotImplemented(); }
    function afterCancel(address, uint256, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeQueue(address, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4, address[] memory, uint256[] memory, bytes[] memory, bytes32) { revert HookNotImplemented(); }
    function afterQueue(address, uint256, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeExecute(address, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4, bool) { revert HookNotImplemented(); }
    function afterExecute(address, uint256, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4) { revert HookNotImplemented(); }
}
```

Notes for the implementer:
- `IHooks` declares `beforeQuorumCalculation` and `afterQuorumCalculation` without `view`; if the compiler rejects `pure` overrides of non-view interface functions, drop `pure` on those two only. Same for any other stub the compiler complains about.
- `Hooks.validateHookPermissions` is `internal pure` in the library and expects `IHooks self`; calling it from the constructor with `IHooks(address(this))` is correct because `address(this)` in a constructor is the final address.
- If `forge build` reports the hook exceeds 24,576 bytes (it should be far below), remove the long error argument lists first.

- [ ] **Step 8: Run tests**

Run: `forge test --match-contract "FleetHookTest|HookMinerTest" -vv`
Expected: all pass. The test `test_BeforeVoteSucceededUsesForOnlyRule` proves the hook is wired into the governor's `state()`.

- [ ] **Step 9: Record the size**

Run: `forge build --sizes 2>&1 | grep -E "FleetHook|AgoraGovernor|FleetVotes|TaskLedger|FleetRegistry"`
Expected: `AgoraGovernor` runtime 23,005 bytes (unchanged upstream), `FleetHook` well under 24,576. Paste the table into `docs/compatibility-notes.md` under a "Contract sizes" heading.

- [ ] **Step 10: Commit**

```bash
git add contracts/src/FleetHook.sol contracts/src/deploy/HookMiner.sol contracts/test/unit/FleetHook.t.sol contracts/test/unit/HookMiner.t.sol docs/compatibility-notes.md
git commit -m "feat(contracts): FleetHook carries fleet rules on the unmodified Agora governor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 6: FleetDeployer library and the shared test fixture

**Files:**
- Create: `contracts/src/deploy/FleetDeployer.sol`, `contracts/test/fixtures/FleetFixture.sol`
- Test: `contracts/test/unit/FleetDeployer.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  struct FleetDeployParams {
      string tokenName; string tokenSymbol; address[] members; string[] agentManifests; string fleetManifest;
      address operator; address guardian; uint48 votingDelay; uint32 votingPeriod; uint256 proposalThreshold;
      uint256 quorumNumerator; uint256 timelockDelay; uint64 maxTaskLifetime;
      address create2Deployer;   // address(this) in tests, CREATE2_FACTORY in scripts
      address deployer;          // effective msg.sender for timelock admin and hook initializer
  }
  struct FleetAddresses { address registry; address token; address timelock; address ledger; address hook; address governor; bytes32 hookSalt; }
  library FleetDeployer { function deploy(FleetDeployParams memory p) internal returns (FleetAddresses memory a); }
  ```
  and the fixture:
  ```solidity
  abstract contract FleetFixture is Test {
      uint256 constant N = 5; uint48 constant VOTING_DELAY = 15; uint32 constant VOTING_PERIOD = 120;
      uint256 constant TIMELOCK_DELAY = 30; uint64 constant MAX_LIFETIME = 7200; string constant CHARTER = "...";
      address[] members; uint256[] memberKeys; address operator; address guardian; address keeper; address outsider;
      FleetRegistry registry; FleetVotes token; TimelockController timelock; TaskLedger ledger; FleetHook hook; AgoraGovernor governor;
      function setUp() public virtual;
      function openTask() internal returns (uint256 taskId);
      function actionCalldata(uint256 taskId, uint8 kind, uint32 version, bytes32 payloadHash, string memory newText, string memory summary) internal pure returns (bytes memory);
      function proposeDecision(uint256 agent, bytes memory data, string memory description) internal returns (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c);
      function vote(uint256 agent, uint256 pid, uint8 support, string memory reason) internal;
      function warpToActive(uint256 pid) internal; function warpPastDeadline(uint256 pid) internal;
      function queueAs(address who, ...) / executeAs(address who, ...) internal;
      function descHash(string memory d) internal pure returns (bytes32);
  }
  ```

- [ ] **Step 1: Write the deployer test**

`contracts/test/unit/FleetDeployer.t.sol`:
```solidity
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
```

- [ ] **Step 2: Run to verify failure**

Run: `forge test --match-contract FleetDeployerTest`
Expected: compilation error.

- [ ] **Step 3: Implement FleetDeployer**

`contracts/src/deploy/FleetDeployer.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IHooks} from "agora-governor/src/interfaces/IHooks.sol";
import {FleetRegistry} from "../FleetRegistry.sol";
import {FleetVotes} from "../FleetVotes.sol";
import {TaskLedger} from "../TaskLedger.sol";
import {FleetHook} from "../FleetHook.sol";
import {HookMiner} from "./HookMiner.sol";

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
    bytes32 hookSalt;
}

/// @notice The deployment sequence of spec section 7.1, shared by the Foundry script and the test fixture.
/// @dev Runs in the caller's context. In tests the caller is the test contract (CREATE2 from it);
///      under `vm.broadcast` Foundry routes CREATE2 through the canonical deployer, so `create2Deployer`
///      must be `0x4e59b44847b379578588920cA78FbF26c0B4956C` there.
library FleetDeployer {
    error HookAddressMismatch(address predicted, address actual);

    function deploy(FleetDeployParams memory p) internal returns (FleetAddresses memory a) {
        FleetRegistry registry = new FleetRegistry(p.members, p.agentManifests, p.fleetManifest);
        FleetVotes token = new FleetVotes(p.tokenName, p.tokenSymbol, registry);

        address[] memory none = new address[](0);
        TimelockController timelock = new TimelockController(p.timelockDelay, none, none, p.deployer);
        TaskLedger ledger = new TaskLedger(address(timelock), p.operator, p.guardian, p.maxTaskLifetime);

        (address predictedHook, bytes32 salt) = HookMiner.find(
            p.create2Deployer,
            FleetHook.PERMISSION_MASK,
            type(FleetHook).creationCode,
            abi.encode(registry, ledger, p.deployer)
        );
        FleetHook hook = new FleetHook{salt: salt}(registry, ledger, p.deployer);
        if (address(hook) != predictedHook) revert HookAddressMismatch(predictedHook, address(hook));

        AgoraGovernor governor = new AgoraGovernor(
            p.votingDelay,
            p.votingPeriod,
            p.proposalThreshold,
            p.quorumNumerator,
            IVotes(address(token)),
            timelock,
            address(0),
            address(0),
            IHooks(address(hook))
        );
        hook.initialize(address(governor));

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), p.guardian);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), p.deployer);

        a = FleetAddresses({
            registry: address(registry),
            token: address(token),
            timelock: address(timelock),
            ledger: address(ledger),
            hook: address(hook),
            governor: address(governor),
            hookSalt: salt
        });
    }
}
```

- [ ] **Step 4: Run the deployer test**

Run: `forge test --match-contract FleetDeployerTest -vv`
Expected: pass.

- [ ] **Step 5: Write the fixture**

`contracts/test/fixtures/FleetFixture.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../../src/deploy/FleetDeployer.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

abstract contract FleetFixture is Test {
    uint256 internal constant N = 5;
    uint48 internal constant VOTING_DELAY = 15;
    uint32 internal constant VOTING_PERIOD = 120;
    uint256 internal constant TIMELOCK_DELAY = 30;
    uint64 internal constant MAX_LIFETIME = 7200;
    string internal constant CHARTER =
        '{"schema":"fleet.charter.v1","goal":"pass tests","allowedActionClasses":["read_repo","write_repo","run_tests"],"externalAllowlist":["registry.npmjs.org"]}';
    string internal constant DESC_SUFFIX = "\n#proposalTypeId=0";

    uint8 internal constant AGAINST = 0;
    uint8 internal constant FOR = 1;
    uint8 internal constant ABSTAIN = 2;

    address[] internal members;
    uint256[] internal memberKeys;
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal outsider = makeAddr("outsider");

    FleetRegistry internal registry;
    FleetVotes internal token;
    TimelockController internal timelock;
    TaskLedger internal ledger;
    FleetHook internal hook;
    AgoraGovernor internal governor;
    FleetAddresses internal addrs;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        FleetDeployParams memory p;
        p.tokenName = "Fleet Vote";
        p.tokenSymbol = "FLEET";
        p.members = new address[](N);
        p.agentManifests = new string[](N);
        string[5] memory roles = ["planner", "engineer", "critic", "budget", "safety"];
        for (uint256 i = 0; i < N; i++) {
            (address a, uint256 k) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            members.push(a);
            memberKeys.push(k);
            p.members[i] = a;
            p.agentManifests[i] = string.concat('{"role":"', roles[i], '"}');
        }
        p.fleetManifest = '{"experiment":"fixture"}';
        p.operator = operator;
        p.guardian = guardian;
        p.votingDelay = VOTING_DELAY;
        p.votingPeriod = VOTING_PERIOD;
        p.proposalThreshold = 1e18;
        p.quorumNumerator = 6000;
        p.timelockDelay = TIMELOCK_DELAY;
        p.maxTaskLifetime = MAX_LIFETIME;
        p.create2Deployer = address(this);
        p.deployer = address(this);

        addrs = FleetDeployer.deploy(p);
        registry = FleetRegistry(addrs.registry);
        token = FleetVotes(addrs.token);
        timelock = TimelockController(payable(addrs.timelock));
        ledger = TaskLedger(addrs.ledger);
        hook = FleetHook(addrs.hook);
        governor = AgoraGovernor(payable(addrs.governor));
        vm.warp(block.timestamp + 1);
    }

    function openTask() internal returns (uint256 taskId) {
        vm.prank(operator);
        taskId = ledger.openTask(CHARTER, MAX_LIFETIME);
    }

    function actionCalldata(
        uint256 taskId,
        uint8 kind,
        uint32 version,
        bytes32 payloadHash,
        string memory newText,
        string memory summary
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(TaskLedger.recordDecision, (taskId, kind, version, payloadHash, newText, summary));
    }

    function singleAction(bytes memory data)
        internal
        view
        returns (address[] memory t, uint256[] memory v, bytes[] memory c)
    {
        t = new address[](1);
        v = new uint256[](1);
        c = new bytes[](1);
        t[0] = address(ledger);
        c[0] = data;
    }

    function proposeDecision(uint256 agent, bytes memory data, string memory description)
        internal
        returns (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c)
    {
        (t, v, c) = singleAction(data);
        vm.prank(members[agent]);
        pid = governor.propose(t, v, c, description);
    }

    function vote(uint256 agent, uint256 pid, uint8 support, string memory reason) internal {
        vm.prank(members[agent]);
        governor.castVoteWithReason(pid, support, reason);
    }

    function warpToActive(uint256 pid) internal {
        vm.warp(governor.proposalSnapshot(pid) + 1);
    }

    function warpPastDeadline(uint256 pid) internal {
        vm.warp(governor.proposalDeadline(pid) + 1);
    }

    function descHash(string memory description) internal pure returns (bytes32) {
        return keccak256(bytes(description));
    }

    function queueAs(address who, address[] memory t, uint256[] memory v, bytes[] memory c, string memory description) internal {
        vm.prank(who);
        governor.queue(t, v, c, descHash(description));
    }

    function executeAs(address who, address[] memory t, uint256[] memory v, bytes[] memory c, string memory description) internal {
        vm.prank(who);
        governor.execute(t, v, c, descHash(description));
    }

    function stateOf(uint256 pid) internal view returns (IGovernor.ProposalState) {
        return governor.state(pid);
    }
}
```

- [ ] **Step 6: Compile**

Run: `forge build`
Expected: success (the fixture is abstract and compiles on its own).

- [ ] **Step 7: Commit**

```bash
git add contracts/src/deploy/FleetDeployer.sol contracts/test/fixtures/FleetFixture.sol contracts/test/unit/FleetDeployer.t.sol
git commit -m "feat(contracts): FleetDeployer library and shared test fixture

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 7: Lifecycle integration test

**Files:**
- Test: `contracts/test/integration/Lifecycle.t.sol`

**Interfaces:**
- Consumes: `FleetFixture`.

- [ ] **Step 1: Write the tests**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {ActionId} from "../../src/libraries/ActionId.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract LifecycleTest is FleetFixture {
    function test_GrantExceptionProposalThroughToLedger() public {
        uint256 taskId = openTask();
        bytes32 payload = keccak256("network_fetch|examples.internal|0xargs");
        bytes memory data = actionCalldata(taskId, uint8(TaskLedger.DecisionKind.GRANT_EXCEPTION), 1, payload, "", "one-time fetch");
        string memory description = string.concat("# Grant exception\n\nfetch examples.internal", DESC_SUFFIX);

        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(1, data, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Pending));
        assertEq(hook.taskOf(pid), taskId);
        assertEq(hook.actionOf(pid), ActionId.compute(address(ledger), taskId, 1, 1, payload));
        assertEq(hook.lastProposalOf(taskId, members[1]), pid);

        warpToActive(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Active));
        vote(0, pid, FOR, "FOR. Needed to finish; host is benign.");
        vote(1, pid, FOR, "FOR. I proposed it.");
        vote(2, pid, AGAINST, "AGAINST. Charter forbids it and the task is solvable without.");
        vote(3, pid, FOR, "FOR. Cheap.");
        vote(4, pid, AGAINST, "AGAINST. Provenance unknown.");
        (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes) = governor.proposalVotes(pid);
        assertEq(forVotes, 3e18);
        assertEq(againstVotes, 2e18);
        assertEq(abstainVotes, 0);

        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));

        queueAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));
        vm.prank(keeper);
        vm.expectRevert(); // timelock not ready
        governor.execute(t, v, c, descHash(description));

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Executed));

        assertEq(ledger.exceptionVersion(taskId, payload), 1);
        TaskLedger.Decision memory d = ledger.getDecision(taskId, 0);
        assertEq(d.actionId, hook.actionOf(pid));
        assertEq(uint8(d.kind), uint8(TaskLedger.DecisionKind.GRANT_EXCEPTION));
    }

    function test_DefeatedProposalCannotQueueOrExecute() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 1, 1, keccak256("p"), "", "s");
        string memory description = string.concat("defeat me", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, AGAINST, "against");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
        vm.prank(keeper);
        vm.expectRevert();
        governor.queue(t, v, c, descHash(description));
        vm.prank(keeper);
        vm.expectRevert();
        governor.execute(t, v, c, descHash(description));
        assertEq(ledger.decisionCount(taskId), 0);
    }

    function test_DelegatedWeightCountsAndIsVisible() public {
        // agent 3 and 4 delegate to agent 0 before the snapshot
        vm.prank(members[3]); token.delegate(members[0]);
        vm.prank(members[4]); token.delegate(members[0]);
        vm.warp(block.timestamp + 1);
        assertEq(token.getVotes(members[0]), 3e18);

        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("path"), "", "choose");
        string memory description = string.concat("choose", DESC_SUFFIX);
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for, carrying two delegations");
        vote(1, pid, AGAINST, "against");
        vote(2, pid, AGAINST, "against");
        // agents 3 and 4 have no power at the snapshot
        vm.prank(members[3]);
        vm.expectRevert(abi.encodeWithSelector(FleetHook.NoVotingPower.selector, members[3]));
        governor.castVoteWithReason(pid, FOR, "no power");
        warpPastDeadline(pid);
        (uint256 againstVotes, uint256 forVotes,) = governor.proposalVotes(pid);
        assertEq(forVotes, 3e18);
        assertEq(againstVotes, 2e18);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Succeeded));
    }

    function test_ProposerCancelReleasesSlot() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("a"), "", "a");
        string memory d1 = string.concat("first", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, d1);
        // second proposal by same member on same task is rejected while first is unsettled
        vm.prank(members[0]);
        vm.expectRevert(abi.encodeWithSelector(FleetHook.MemberHasUnsettledProposal.selector, members[0], taskId, pid));
        governor.propose(t, v, c, string.concat("second", DESC_SUFFIX));
        // a different member may propose on the same task
        proposeDecision(1, data, string.concat("by agent 1", DESC_SUFFIX));
        // proposer cancels, slot released
        vm.prank(members[0]);
        governor.cancel(t, v, c, descHash(d1));
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Canceled));
        proposeDecision(0, data, string.concat("second", DESC_SUFFIX));
    }
}
```

- [ ] **Step 2: Run**

Run: `forge test --match-contract LifecycleTest -vvv`
Expected: 4 tests pass. If `execute` before the timelock is ready reverts with a different error than expected, keep the generic `vm.expectRevert()`.

- [ ] **Step 3: Commit**

```bash
git add contracts/test/integration/Lifecycle.t.sol
git commit -m "test(contracts): end-to-end lifecycle through the unmodified governor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 8: Admission, amendment, and guardian integration tests

**Files:**
- Test: `contracts/test/integration/Admission.t.sol`, `contracts/test/integration/Amendment.t.sol`, `contracts/test/integration/Guardian.t.sol`

- [ ] **Step 1: Admission tests**

`contracts/test/integration/Admission.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
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

    // Hook reverts surface through Hooks.callHook as HookCallFailed (ERC-7751 wrapped). We assert a revert
    // and, where forge exposes it, the inner selector. Start with generic expectRevert; tighten if -vvvv shows
    // the custom error is preserved.

    function test_ImpostorCannotPropose() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        vm.prank(outsider);
        vm.expectRevert();
        governor.propose(t, v, c, description);
    }

    function test_ImpostorCannotVote() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vm.prank(outsider);
        vm.expectRevert();
        governor.castVoteWithReason(pid, FOR, "i am not a member");
        vm.prank(outsider);
        vm.expectRevert();
        governor.castVote(pid, FOR);
    }

    function test_EmptyReasonRejected() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vm.prank(members[1]);
        vm.expectRevert();
        governor.castVote(pid, FOR);
        vm.prank(members[1]);
        vm.expectRevert();
        governor.castVoteWithReason(pid, FOR, "");
        vm.prank(members[1]);
        vm.expectRevert();
        governor.castVoteWithReason(pid, FOR, new string(1025));
        vm.prank(members[1]);
        vm.expectRevert();
        governor.castVoteWithReasonAndParams(pid, FOR, "reason", hex"01");
    }

    function test_DoubleVoteRejected() public {
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(1, pid, FOR, "for");
        vm.prank(members[1]);
        vm.expectRevert();
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
            vm.expectRevert();
            governor.propose(t, v, c, description);
        }
        // governance settings and relay are unreachable even with ledger as target because the selector is wrong
        (address[] memory t2, uint256[] memory v2, bytes[] memory c2) = singleAction(abi.encodeCall(GovernorSettings.setVotingDelay, (1)));
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t2, v2, c2, description);
    }

    function test_MultipleActionsValueAndCalldataRejected() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        address[] memory t2 = new address[](2);
        uint256[] memory v2 = new uint256[](2);
        bytes[] memory c2 = new bytes[](2);
        t2[0] = t[0]; t2[1] = t[0]; c2[0] = data; c2[1] = data;
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t2, v2, c2, description);

        v[0] = 1;
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, description);
        v[0] = 0;

        c[0] = bytes.concat(data, hex"00");
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, description);

        c[0] = abi.encodeCall(TaskLedger.completeTask, (taskId));
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, description);
    }

    function test_DescriptionBounds() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(data);
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, "");
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, new string(4097));
    }

    function test_StaleVersionPausedAndExpiredRejected() public {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(actionCalldata(taskId, 0, 2, keccak256("p"), "", "s"));
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, description);

        vm.prank(guardian);
        ledger.pause();
        (t, v, c) = singleAction(data);
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, description);
        vm.prank(guardian);
        ledger.unpause();

        // not enough time left: warp to within required window of expiry
        uint256 required = VOTING_DELAY + VOTING_PERIOD + TIMELOCK_DELAY + 60;
        vm.warp(ledger.getTask(taskId).expiresAt - required + 1);
        vm.prank(members[0]);
        vm.expectRevert();
        governor.propose(t, v, c, description);
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
        vm.prank(guardian);
        vm.expectRevert();
        timelock.grantRole(timelock.PROPOSER_ROLE(), guardian);
    }
}
```

- [ ] **Step 2: Amendment tests**

`contracts/test/integration/Amendment.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract AmendmentTest is FleetFixture {
    string constant CHARTER_V2 = '{"schema":"fleet.charter.v1","goal":"pass tests","externalAllowlist":["registry.npmjs.org","examples.internal"]}';

    function _passAndExecute(uint256 agent, bytes memory data, string memory description) internal returns (uint256 pid) {
        address[] memory t; uint256[] memory v; bytes[] memory c;
        (pid, t, v, c) = proposeDecision(agent, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for"); vote(1, pid, FOR, "for"); vote(2, pid, FOR, "for");
        warpPastDeadline(pid);
        queueAs(keeper, t, v, c, description);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, t, v, c, description);
    }

    function test_AmendmentBumpsVersionAndGatewayReadsNewCharter() public {
        uint256 taskId = openTask();
        bytes32 h = keccak256(bytes(CHARTER_V2));
        bytes memory data = actionCalldata(taskId, uint8(TaskLedger.DecisionKind.AMEND_CHARTER), 1, h, CHARTER_V2, "add host");
        _passAndExecute(0, data, string.concat("amend", DESC_SUFFIX));
        TaskLedger.Task memory t = ledger.getTask(taskId);
        assertEq(t.charterVersion, 2);
        assertEq(t.charterHash, h);
        assertEq(ledger.charterText(taskId), CHARTER_V2);
    }

    function test_PendingProposalOnOldVersionCannotExecuteAfterAmendment() public {
        uint256 taskId = openTask();
        // proposal A (exception on v1) by agent 1, proposal B (amend) by agent 0, both active
        bytes memory dataA = actionCalldata(taskId, 1, 1, keccak256("x"), "", "exception on v1");
        string memory descA = string.concat("A", DESC_SUFFIX);
        (uint256 pidA, address[] memory tA, uint256[] memory vA, bytes[] memory cA) = proposeDecision(1, dataA, descA);
        bytes32 h = keccak256(bytes(CHARTER_V2));
        bytes memory dataB = actionCalldata(taskId, 2, 1, h, CHARTER_V2, "amend");
        string memory descB = string.concat("B", DESC_SUFFIX);
        (uint256 pidB, address[] memory tB, uint256[] memory vB, bytes[] memory cB) = proposeDecision(0, dataB, descB);
        warpToActive(pidB);
        for (uint256 i = 0; i < 3; i++) { vote(i, pidA, FOR, "for"); vote(i, pidB, FOR, "for"); }
        warpPastDeadline(pidB);
        // execute B first
        queueAs(keeper, tB, vB, cB, descB);
        queueAs(keeper, tA, vA, cA, descA);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        executeAs(keeper, tB, vB, cB, descB);
        assertEq(ledger.getTask(taskId).charterVersion, 2);
        // A now names a stale version; the ledger rejects it and the governor call reverts
        vm.prank(keeper);
        vm.expectRevert();
        governor.execute(tA, vA, cA, descHash(descA));
        assertEq(uint8(stateOf(pidA)), uint8(IGovernor.ProposalState.Queued));
        assertEq(ledger.exceptionVersion(taskId, keccak256("x")), 0);
    }

    function test_StopTaskClosesFutureProposals() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, uint8(TaskLedger.DecisionKind.STOP_TASK), 1, bytes32(0), "", "stop");
        _passAndExecute(0, data, string.concat("stop", DESC_SUFFIX));
        assertEq(uint8(ledger.getTask(taskId).state), uint8(TaskLedger.TaskState.Stopped));
        (address[] memory t, uint256[] memory v, bytes[] memory c) = singleAction(actionCalldata(taskId, 0, 1, keccak256("p"), "", "s"));
        vm.prank(members[1]);
        vm.expectRevert();
        governor.propose(t, v, c, string.concat("after stop", DESC_SUFFIX));
    }
}
```

- [ ] **Step 3: Guardian tests**

`contracts/test/integration/Guardian.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract GuardianTest is FleetFixture {
    function test_GuardianPausesAndCancelsQueuedOperation() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 1, 1, keccak256("danger"), "", "risky exception");
        string memory description = string.concat("risky", DESC_SUFFIX);
        (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for"); vote(1, pid, FOR, "for"); vote(2, pid, FOR, "for");
        warpPastDeadline(pid);
        queueAs(keeper, t, v, c, description);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Queued));

        vm.prank(guardian);
        ledger.pause();

        // guardian cancels the timelock operation directly (CANCELLER_ROLE)
        bytes32 opId = timelock.hashOperationBatch(t, v, c, bytes32(0), _timelockSalt(description));
        assertTrue(timelock.isOperationPending(opId));
        vm.prank(guardian);
        timelock.cancel(opId);
        assertFalse(timelock.isOperationPending(opId));
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Canceled));

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        vm.prank(keeper);
        vm.expectRevert();
        governor.execute(t, v, c, descHash(description));
        assertEq(ledger.decisionCount(taskId), 0);

        vm.prank(guardian);
        ledger.unpause();
    }

    function test_GuardianCannotCancelAtGovernorOrProposeOrExecute() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        string memory description = string.concat("x", DESC_SUFFIX);
        (, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);
        vm.prank(guardian);
        vm.expectRevert();
        governor.cancel(t, v, c, descHash(description));
        vm.prank(guardian);
        vm.expectRevert();
        governor.propose(t, v, c, string.concat("guardian", DESC_SUFFIX));
    }

    /// @dev Mirrors AgoraGovernor._timelockSalt: bytes20(address(governor)) ^ descriptionHash.
    function _timelockSalt(string memory description) internal view returns (bytes32) {
        return bytes20(address(governor)) ^ descHash(description);
    }
}
```

If `_timelockSalt` does not match the pinned implementation, read `AgoraGovernor._timelockSalt` (around line 422 of `lib/agora-governor/src/AgoraGovernor.sol`) and copy its formula.

- [ ] **Step 4: Run all three**

Run: `forge test --match-path "test/integration/*" -vv`
Expected: all pass. Where a test uses generic `vm.expectRevert()`, run once with `-vvvv` on a failing variant to confirm the hook's custom error is the cause, and note in `docs/compatibility-notes.md` whether Agora's `HookCallFailed` wrapper preserves inner error data.

- [ ] **Step 5: Commit**

```bash
git add contracts/test/integration
git commit -m "test(contracts): admission, amendment, and guardian integration coverage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 9: Ballot profiles (4^5) and threshold tests for other N

**Files:**
- Test: `contracts/test/integration/BallotProfiles.t.sol`

- [ ] **Step 1: Write the test**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../../src/deploy/FleetDeployer.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract BallotProfilesTest is FleetFixture {
    /// Digit per member: 0 = no vote, 1 = Against, 2 = For, 3 = Abstain. 4^5 = 1024 profiles.
    function test_AllBallotProfilesMatchForOnlyRule() public {
        for (uint256 profile = 0; profile < 1024; profile++) {
            uint256 taskId = openTask();
            bytes memory data = actionCalldata(taskId, 0, 1, keccak256(abi.encode(profile)), "", "profile");
            string memory description = string.concat("profile ", vm.toString(profile), DESC_SUFFIX);
            (uint256 pid,,,) = proposeDecision(0, data, description);
            warpToActive(pid);
            uint256 forCount;
            uint256 againstCount;
            uint256 digits = profile;
            for (uint256 i = 0; i < N; i++) {
                uint256 d = digits % 4;
                digits /= 4;
                if (d == 1) { vote(i, pid, AGAINST, "against"); againstCount++; }
                else if (d == 2) { vote(i, pid, FOR, "for"); forCount++; }
                else if (d == 3) { vote(i, pid, ABSTAIN, "abstain"); }
            }
            warpPastDeadline(pid);
            bool expected = forCount >= 3 && forCount > againstCount;
            IGovernor.ProposalState want = expected ? IGovernor.ProposalState.Succeeded : IGovernor.ProposalState.Defeated;
            assertEq(uint8(stateOf(pid)), uint8(want), string.concat("profile ", vm.toString(profile)));
        }
    }

    function test_EffectiveYesCountForOtherFleetSizes() public {
        _checkFleet(3, 2);   // ceil(0.6*3)  = 2
        _checkFleet(7, 5);   // ceil(0.6*7)  = 5 (4.2 -> 5)
        _checkFleet(10, 6);  // ceil(0.6*10) = 6
    }

    function _checkFleet(uint256 n, uint256 expectedYes) internal {
        FleetDeployParams memory p;
        p.tokenName = "T"; p.tokenSymbol = "T";
        p.members = new address[](n); p.agentManifests = new string[](n);
        for (uint256 i = 0; i < n; i++) { p.members[i] = makeAddr(string.concat("n", vm.toString(n), "-", vm.toString(i))); p.agentManifests[i] = "{}"; }
        p.fleetManifest = "{}"; p.operator = operator; p.guardian = guardian;
        p.votingDelay = VOTING_DELAY; p.votingPeriod = VOTING_PERIOD; p.proposalThreshold = 1e18; p.quorumNumerator = 6000;
        p.timelockDelay = TIMELOCK_DELAY; p.maxTaskLifetime = MAX_LIFETIME; p.create2Deployer = address(this); p.deployer = address(this);
        FleetAddresses memory a = FleetDeployer.deploy(p);
        AgoraGovernor gov = AgoraGovernor(payable(a.governor));
        TaskLedger led = TaskLedger(a.ledger);
        vm.warp(block.timestamp + 1);
        vm.prank(operator);
        uint256 taskId = led.openTask(CHARTER, MAX_LIFETIME);
        address[] memory t = new address[](1); uint256[] memory v = new uint256[](1); bytes[] memory c = new bytes[](1);
        t[0] = a.ledger; c[0] = abi.encodeCall(TaskLedger.recordDecision, (taskId, 0, 1, keccak256("p"), "", "s"));

        // expectedYes - 1 For votes: defeated
        vm.prank(p.members[0]);
        uint256 pid1 = gov.propose(t, v, c, string.concat("under", DESC_SUFFIX));
        vm.warp(gov.proposalSnapshot(pid1) + 1);
        for (uint256 i = 0; i < expectedYes - 1; i++) { vm.prank(p.members[i]); gov.castVoteWithReason(pid1, 1, "for"); }
        vm.warp(gov.proposalDeadline(pid1) + 1);
        assertEq(uint8(gov.state(pid1)), uint8(IGovernor.ProposalState.Defeated), "under threshold");

        // expectedYes For votes: succeeded (different proposer to avoid the unsettled-slot rule)
        vm.prank(p.members[1]);
        uint256 pid2 = gov.propose(t, v, c, string.concat("at", DESC_SUFFIX));
        vm.warp(gov.proposalSnapshot(pid2) + 1);
        for (uint256 i = 0; i < expectedYes; i++) { vm.prank(p.members[i]); gov.castVoteWithReason(pid2, 1, "for"); }
        vm.warp(gov.proposalDeadline(pid2) + 1);
        assertEq(uint8(gov.state(pid2)), uint8(IGovernor.ProposalState.Succeeded), "at threshold");
    }
}
```

- [ ] **Step 2: Run**

Run: `forge test --match-contract BallotProfilesTest -vv`
Expected: 2 tests pass. The profile test takes tens of seconds. If `openTask` fails late in the loop because tasks expire (each task lives 7,200 s and each profile advances about 140 s, so this should not happen), reduce `VOTING_PERIOD` for this test only by deploying a fresh fleet in `setUp`.

- [ ] **Step 3: Commit**

```bash
git add contracts/test/integration/BallotProfiles.t.sol
git commit -m "test(contracts): all 1024 five-member ballot profiles and other fleet sizes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 10: Invariant tests

**Files:**
- Test: `contracts/test/invariant/FleetVotesInvariant.t.sol`, `contracts/test/invariant/TaskLedgerInvariant.t.sol`

- [ ] **Step 1: Token invariants**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";

contract VotesHandler is Test {
    FleetVotes public token;
    address[] public actors;

    constructor(FleetVotes token_, address[] memory members, address[] memory outsiders) {
        token = token_;
        for (uint256 i = 0; i < members.length; i++) actors.push(members[i]);
        for (uint256 i = 0; i < outsiders.length; i++) actors.push(outsiders[i]);
    }

    function delegateTo(uint256 a, uint256 b) external {
        address from = actors[a % actors.length];
        address to = actors[b % actors.length];
        vm.prank(from);
        try token.delegate(to) {} catch {}
    }

    function transfer(uint256 a, uint256 b, uint256 amount) external {
        vm.prank(actors[a % actors.length]);
        try token.transfer(actors[b % actors.length], amount) {} catch {}
    }

    function approveAndTransferFrom(uint256 a, uint256 b, uint256 amount) external {
        address from = actors[a % actors.length];
        address to = actors[b % actors.length];
        vm.prank(from);
        try token.approve(to, amount) {} catch {}
        vm.prank(to);
        try token.transferFrom(from, to, amount) {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + (secs % 1000) + 1);
    }
}

contract FleetVotesInvariant is FleetFixture {
    VotesHandler handler;
    address[] outsiders;

    function setUp() public override {
        super.setUp();
        outsiders.push(outsider);
        outsiders.push(makeAddr("outsider2"));
        handler = new VotesHandler(token, members, outsiders);
        targetContract(address(handler));
    }

    function invariant_SupplyConstant() public view {
        assertEq(token.totalSupply(), N * 1e18);
    }

    function invariant_BalancesFixed() public view {
        for (uint256 i = 0; i < N; i++) assertEq(token.balanceOf(members[i]), 1e18);
    }

    function invariant_VotingPowerSumsToSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < N; i++) sum += token.getVotes(members[i]);
        assertEq(sum, N * 1e18);
    }

    function invariant_NoMemberAboveSupplyAndNoOutsiderPower() public view {
        for (uint256 i = 0; i < N; i++) assertLe(token.getVotes(members[i]), N * 1e18);
        for (uint256 i = 0; i < outsiders.length; i++) {
            assertEq(token.balanceOf(outsiders[i]), 0);
            assertEq(token.getVotes(outsiders[i]), 0);
        }
    }
}
```

- [ ] **Step 2: Ledger invariants**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";

contract LedgerHandler is Test {
    TaskLedger public ledger;
    address public timelock;
    address public operator;
    address public guardian;
    address[] public randos;
    uint256 public directWriteAttempts;

    constructor(TaskLedger ledger_, address timelock_, address operator_, address guardian_) {
        ledger = ledger_; timelock = timelock_; operator = operator_; guardian = guardian_;
        randos.push(makeAddr("r1")); randos.push(makeAddr("r2")); randos.push(operator_); randos.push(guardian_);
    }

    function open(uint64 lifetime) external {
        vm.prank(operator);
        try ledger.openTask("{}", 300 + (lifetime % 6900)) {} catch {}
    }

    function recordAsTimelock(uint256 taskSeed, uint8 kind, uint32 version, bytes32 payload) external {
        uint256 count = ledger.taskCount();
        if (count == 0) return;
        uint256 taskId = (taskSeed % count) + 1;
        string memory text = kind % 5 == 2 ? "{\"v\":\"amended\"}" : "";
        bytes32 ph = kind % 5 == 2 ? keccak256(bytes(text)) : payload;
        vm.prank(timelock);
        try ledger.recordDecision(taskId, kind % 5, version % 3 + 1, ph, text, "s") {} catch {}
    }

    function recordAsRando(uint256 who, uint256 taskSeed) external {
        uint256 count = ledger.taskCount();
        if (count == 0) return;
        directWriteAttempts++;
        vm.prank(randos[who % randos.length]);
        try ledger.recordDecision((taskSeed % count) + 1, 0, 1, bytes32(0), "", "s") { revert("direct write succeeded"); } catch {}
    }

    function togglePause() external {
        vm.prank(guardian);
        if (ledger.paused()) { try ledger.unpause() {} catch {} } else { try ledger.pause() {} catch {} }
    }

    function warp(uint256 secs) external { vm.warp(block.timestamp + (secs % 3000) + 1); }
}

contract TaskLedgerInvariant is FleetFixture {
    LedgerHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new LedgerHandler(ledger, address(timelock), operator, guardian);
        targetContract(address(handler));
    }

    function invariant_EveryDecisionHasConsistentVersions() public view {
        uint256 count = ledger.taskCount();
        for (uint256 id = 1; id <= count; id++) {
            TaskLedger.Task memory t = ledger.getTask(id);
            uint32 expectedVersion = 1;
            for (uint32 i = 0; i < t.decisionCount; i++) {
                TaskLedger.Decision memory d = ledger.getDecision(id, i);
                assertEq(d.charterVersionBefore, expectedVersion);
                if (d.kind == TaskLedger.DecisionKind.AMEND_CHARTER) {
                    assertEq(d.charterVersionAfter, expectedVersion + 1);
                    expectedVersion++;
                } else {
                    assertEq(d.charterVersionAfter, expectedVersion);
                }
            }
            assertEq(t.charterVersion, expectedVersion);
        }
    }

    function invariant_StoppedTasksHaveNoLaterDecisions() public view {
        uint256 count = ledger.taskCount();
        for (uint256 id = 1; id <= count; id++) {
            TaskLedger.Task memory t = ledger.getTask(id);
            if (t.state == TaskLedger.TaskState.Stopped) {
                TaskLedger.Decision memory last = ledger.getDecision(id, t.decisionCount - 1);
                assertEq(uint8(last.kind), uint8(TaskLedger.DecisionKind.STOP_TASK));
            }
        }
    }
}
```

- [ ] **Step 3: Run**

Run: `forge test --match-path "test/invariant/*" -vv`
Expected: all invariants hold across 64 runs × 32 depth.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/invariant
git commit -m "test(contracts): token and ledger invariants

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 11: Negative security demonstrations

**Files:**
- Test: `contracts/test/negative/UnrestrictedDelegation.t.sol`, `ParticipationQuorum.t.sol`, `AdminBypass.t.sol`, `UnconstrainedTimelock.t.sol`, `FrontendOnly.t.sol`
- Create: `contracts/test/negative/fixtures/PlainVotes.sol`, `contracts/test/negative/fixtures/NaiveLedger.sol`

Each file demonstrates why one boundary exists by removing it in a local fixture. They must never be deployed anywhere. Each test asserts the bad outcome happens without the boundary.

- [ ] **Step 1: Fixtures**

`PlainVotes.sol`: an `ERC20Votes` with a public `mint(address,uint256)`, transferable, delegatable to anyone, timestamp clock.
`NaiveLedger.sol`: a copy of `TaskLedger.recordDecision` semantics with the `onlyTimelock` modifier removed and the `whenNotPaused` kept, exposing only `recordDecision`, `taskCount`, `openTask` (anyone), `decisionCount`.

- [ ] **Step 2: Tests (one assertion each, well commented)**

- `UnrestrictedDelegation`: mint 1e18 to five addresses; four delegate to the fifth; assert `getVotes(fifth) == 5e18` and that a governor with quorum 6000 over this token lets the fifth pass a proposal alone with no other votes.
- `ParticipationQuorum`: deploy the pinned `AgoraGovernor` with `hooks = IHooks(address(0))` over `FleetVotes` from the fixture (a second governor, no ledger restrictions); propose any target; 2 For + 1 Abstain; assert `Succeeded`. Comment: this is the default counting; FleetHook replaces it.
- `AdminBypass`: deploy `AgoraGovernor` with `admin = attacker`; member proposes; attacker calls `cancel`; assert `Canceled`. Comment: why admin and manager are zero.
- `UnconstrainedTimelock`: `TimelockController` with an EOA proposer and executor; EOA schedules `TaskLedger.recordDecision` directly on a ledger whose timelock is that controller; after the delay executes; assert a decision exists with no vote. Comment: why only the governor holds those roles.
- `FrontendOnly`: `NaiveLedger` accepts `recordDecision` from anyone; `TaskLedger` reverts `NotTimelock`. Comment: a UI cannot stop a direct call.

- [ ] **Step 3: Run**

Run: `forge test --match-path "test/negative/*" -vv`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/negative
git commit -m "test(contracts): negative demonstrations of each removed boundary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 12: Deploy script, verifier, example config, ABI export, local Anvil run

**Files:**
- Create: `contracts/script/DeployFleet.s.sol`, `contracts/script/VerifyDeployment.s.sol`, `contracts/script/export-abi.sh`, `deployments/configs/local-5.json`, `deployments/.gitignore` (ignore `*/latest.json`? No: commit local manifests; ignore nothing), `contracts/README.md`
- Modify: `docs/compatibility-notes.md`

**Interfaces:**
- Produces: manifest JSON at `deployments/<chainId>/latest.json` with keys `schema: "fleet.manifest.v1"`, `chainId`, `deploymentBlock`, `deployer`, `addresses{registry,token,timelock,ledger,hook,governor}`, `hookSalt`, `params{votingDelay,votingPeriod,proposalThreshold,quorumNumerator,timelockDelay,maxTaskLifetime}`, `countingRule: "for-only-quorum"`, `hookPermissionMask: "0x22c0"`, `configHash`, `compiler{solc,evm,optimizerRuns}`, `pins{agoraGovernor,openzeppelin}`, `codeHashes{...}`.
- Env: `FLEET_DEPLOY_CONFIG` (path), `FLEET_DEPLOYER_KEY` (uint private key), `FLEET_MANIFEST_OUT` (path, default `../deployments/<chainId>/latest.json`).

- [ ] **Step 1: Example config**

`deployments/configs/local-5.json` uses Anvil's default accounts 1 to 5 as members (account 0 is the deployer), account 6 operator, account 7 guardian:
```json
{
  "schema": "fleet.deploy.v1",
  "tokenName": "Fleet Vote",
  "tokenSymbol": "FLEET",
  "members": [
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
  ],
  "agentManifests": [
    "{\"role\":\"planner\",\"provider\":\"scripted\",\"model\":\"scripted-v1\",\"promptVersion\":\"1\",\"operator\":\"local\"}",
    "{\"role\":\"engineer\",\"provider\":\"scripted\",\"model\":\"scripted-v1\",\"promptVersion\":\"1\",\"operator\":\"local\"}",
    "{\"role\":\"critic\",\"provider\":\"scripted\",\"model\":\"scripted-v1\",\"promptVersion\":\"1\",\"operator\":\"local\"}",
    "{\"role\":\"budget\",\"provider\":\"scripted\",\"model\":\"scripted-v1\",\"promptVersion\":\"1\",\"operator\":\"local\"}",
    "{\"role\":\"safety\",\"provider\":\"scripted\",\"model\":\"scripted-v1\",\"promptVersion\":\"1\",\"operator\":\"local\"}"
  ],
  "fleetManifest": "{\"experiment\":\"local-5\",\"constitution\":\"fleet.constitution.v1\",\"harness\":\"dev\"}",
  "operator": "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "guardian": "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "votingDelay": 15,
  "votingPeriod": 120,
  "proposalThreshold": "1000000000000000000",
  "quorumNumerator": 6000,
  "timelockDelay": 30,
  "maxTaskLifetime": 7200
}
```

- [ ] **Step 2: DeployFleet.s.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../src/deploy/FleetDeployer.sol";

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
        vm.startBroadcast(pk);
        a = FleetDeployer.deploy(p);
        vm.stopBroadcast();

        _writeManifest(json, p, a, startBlock);
        console2.log("governor", a.governor);
        console2.log("ledger", a.ledger);
    }

    function _writeManifest(string memory cfgJson, FleetDeployParams memory p, FleetAddresses memory a, uint256 startBlock) internal {
        string memory root = "manifest";
        vm.serializeString(root, "schema", "fleet.manifest.v1");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deploymentBlock", startBlock);
        vm.serializeAddress(root, "deployer", p.deployer);
        vm.serializeBytes32(root, "hookSalt", a.hookSalt);
        vm.serializeString(root, "countingRule", "for-only-quorum");
        vm.serializeString(root, "hookPermissionMask", "0x22c0");
        vm.serializeBytes32(root, "configHash", keccak256(bytes(cfgJson)));

        string memory addrs = "addresses";
        vm.serializeAddress(addrs, "registry", a.registry);
        vm.serializeAddress(addrs, "token", a.token);
        vm.serializeAddress(addrs, "timelock", a.timelock);
        vm.serializeAddress(addrs, "ledger", a.ledger);
        vm.serializeAddress(addrs, "hook", a.hook);
        string memory addrsJson = vm.serializeAddress(addrs, "governor", a.governor);
        vm.serializeString(root, "addresses", addrsJson);

        string memory params = "params";
        vm.serializeUint(params, "votingDelay", p.votingDelay);
        vm.serializeUint(params, "votingPeriod", p.votingPeriod);
        vm.serializeUint(params, "proposalThreshold", p.proposalThreshold);
        vm.serializeUint(params, "quorumNumerator", p.quorumNumerator);
        vm.serializeUint(params, "timelockDelay", p.timelockDelay);
        string memory paramsJson = vm.serializeUint(params, "maxTaskLifetime", p.maxTaskLifetime);
        vm.serializeString(root, "params", paramsJson);

        string memory compiler = "compiler";
        vm.serializeString(compiler, "solc", "0.8.29");
        vm.serializeString(compiler, "evm", "cancun");
        string memory compilerJson = vm.serializeUint(compiler, "optimizerRuns", 200);
        vm.serializeString(root, "compiler", compilerJson);

        string memory pins = "pins";
        vm.serializeString(pins, "agoraGovernor", "11a11641ce1f4f691c300d530eae3c7203593b85");
        string memory pinsJson = vm.serializeString(pins, "openzeppelin", "3d139e998b9843179d72b28a3264834b01baf160");
        vm.serializeString(root, "pins", pinsJson);

        string memory hashes = "codeHashes";
        vm.serializeBytes32(hashes, "registry", a.registry.codehash);
        vm.serializeBytes32(hashes, "token", a.token.codehash);
        vm.serializeBytes32(hashes, "timelock", a.timelock.codehash);
        vm.serializeBytes32(hashes, "ledger", a.ledger.codehash);
        vm.serializeBytes32(hashes, "hook", a.hook.codehash);
        string memory hashesJson = vm.serializeBytes32(hashes, "governor", a.governor.codehash);
        string memory out = vm.serializeString(root, "codeHashes", hashesJson);

        string memory dir = string.concat("../deployments/", vm.toString(block.chainid));
        string memory path = vm.envOr("FLEET_MANIFEST_OUT", string.concat(dir, "/latest.json"));
        vm.createDir(dir, true);
        vm.writeJson(out, path);
        console2.log("manifest", path);
    }
}
```

Note: `vm.serializeString(root, "addresses", addrsJson)` nests a JSON string as an object in forge-std's serializer when the value is valid JSON. If it is written as an escaped string instead, switch to `vm.serializeJson` or build the nested objects with the `objectKey` pattern shown in the Foundry book. Verify with `jq . deployments/31337/latest.json`.

Under broadcast, `a.registry.codehash` reads the simulated chain, which is fine.

- [ ] **Step 3: VerifyDeployment.s.sol**

Reads `FLEET_MANIFEST` (path) and asserts, with `require` and clear messages: chain id matches; `governor.hooks() == hook`; `hook.governor() == governor`; `uint160(hook) & 0xFFFF == 0x22C0`; admin and manager zero; `governor.timelock() == timelock`; `token.registry() == registry`; `ledger.timelock() == timelock`; `token.totalSupply() == memberCount * 1e18`; every member `getVotes == 1e18` at `clock() - 1` when the clock has advanced; timelock roles exactly as Task 6 asserted, including no `DEFAULT_ADMIN_ROLE` for the deployer; `quorumNumerator`, `votingDelay`, `votingPeriod`, `proposalThreshold` equal manifest params; `governor.codehash` equals the manifest's recorded hash. Print `VERIFIED` at the end.

- [ ] **Step 4: export-abi.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
forge build --silent
out=../packages/abi/abis
mkdir -p "$out"
for c in FleetRegistry FleetVotes FleetHook TaskLedger; do
  jq '.abi' "out/$c.sol/$c.json" > "$out/$c.json"
done
jq '.abi' out/AgoraGovernor.sol/AgoraGovernor.json > "$out/AgoraGovernor.json"
jq '.abi' out/TimelockController.sol/TimelockController.json > "$out/TimelockController.json"
echo "ABIs written to $out"
ls -la "$out"
```

- [ ] **Step 5: Run against Anvil**

```bash
anvil --block-time 2 --port 8545 --silent &
sleep 2
cd contracts
FLEET_DEPLOY_CONFIG=../deployments/configs/local-5.json \
FLEET_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
forge script script/DeployFleet.s.sol --rpc-url http://127.0.0.1:8545 --broadcast -vv
jq . ../deployments/31337/latest.json
FLEET_MANIFEST=../deployments/31337/latest.json forge script script/VerifyDeployment.s.sol --rpc-url http://127.0.0.1:8545 -vv
bash script/export-abi.sh
kill %1
```
Expected: 9 transactions broadcast, manifest written and valid JSON, `VERIFIED` printed, six ABI files exported. Record the exact addresses in `docs/compatibility-notes.md` under "Deterministic local addresses" (they are stable for a fresh Anvil with this deployer).

- [ ] **Step 6: contracts/README.md**

Write: what the four contracts do (one paragraph each), the deployment sequence, how to run tests, how to deploy locally (the commands above, now verified), how to export ABIs, and the size table.

- [ ] **Step 7: Full suite and commit**

Run: `forge test` (all), `forge fmt --check` (fix with `forge fmt`), `forge build --sizes`.
Expected: all green.

```bash
git add contracts deployments docs/compatibility-notes.md
git commit -m "feat(contracts): deploy and verify scripts, local manifest, ABI export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

## Part 1 acceptance (spec M1)

- `forge test` green: unit, integration (lifecycle, admission, amendment, guardian, 1,024 ballot profiles, other N), invariants, negative demonstrations.
- One command sequence deploys to Anvil, verifies, and exports ABIs.
- `AgoraGovernor` bytecode hash in the manifest equals the hash of the upstream build at the pinned commit with the recorded compiler settings (compare `codeHashes.governor` with `keccak256` of `deployedBytecode` from `lib/agora-governor/out` after `forge build` there).
- `docs/compatibility-notes.md` records: remapping form that worked, whether hook custom errors survive Agora's `HookCallFailed` wrapper, contract sizes, deterministic local addresses, and the Foundry JSON serializer behaviour.
