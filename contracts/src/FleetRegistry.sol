// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetMembership} from "./libraries/FleetMembership.sol";

/// @title FleetRegistry
/// @notice Immutable membership and public manifests for one fleet deployment.
/// @dev The constructor commits to a roster. Bounded setup batches populate it, and the final
///      matching batch seals it forever. There is no membership change after activation.
contract FleetRegistry {
    error InvalidMemberCount(uint256 count);
    error LengthMismatch();
    error ZeroAddress();
    error DuplicateMember(address account);
    error ManifestTooLong(uint256 length, uint256 max);
    error NotMember(address account);
    error UnknownAgent(uint256 agentId);
    error NotInitializer();
    error AlreadyInitialized();
    error InvalidBatch();
    error WrongStartIndex(uint256 expected, uint256 supplied);
    error MembershipHashMismatch();

    event MemberRegistered(uint256 indexed agentId, address indexed account, bytes32 manifestHash, string manifest);
    event FleetManifestSet(bytes32 manifestHash, string manifest);
    event MembershipCommitted(uint256 count, bytes32 membershipHash);
    event MembershipInitialized(uint256 count, bytes32 membershipHash);

    uint256 public constant MIN_MEMBERS = 2;
    uint256 public constant MAX_MEMBERS = 4096;
    uint256 public constant MAX_BATCH_MEMBERS = 32;
    uint256 public constant MAX_BATCH_MANIFEST_BYTES = 8192;
    uint256 public constant MAX_FLEET_MANIFEST_BYTES = 4096;
    uint256 public constant MAX_AGENT_MANIFEST_BYTES = 2048;

    bytes32 public immutable fleetManifestHash;
    bytes32 public immutable membershipHash;
    uint256 public immutable expectedMemberCount;
    address public immutable initializer;
    bytes32 public registeredHash;
    bool public initialized;

    address[] private _members;
    string[] private _agentManifests;
    string private _fleetManifest;
    mapping(address account => uint256 idPlusOne) private _idPlusOne;

    constructor(uint256 n, bytes32 membershipHash_, string memory fleetManifest_) {
        if (n < MIN_MEMBERS || n > MAX_MEMBERS) revert InvalidMemberCount(n);
        uint256 fleetLen = bytes(fleetManifest_).length;
        if (fleetLen > MAX_FLEET_MANIFEST_BYTES) revert ManifestTooLong(fleetLen, MAX_FLEET_MANIFEST_BYTES);
        initializer = msg.sender;
        expectedMemberCount = n;
        membershipHash = membershipHash_;
        registeredHash = FleetMembership.seed(n);
        _fleetManifest = fleetManifest_;
        fleetManifestHash = keccak256(bytes(fleetManifest_));
        emit FleetManifestSet(fleetManifestHash, fleetManifest_);
        emit MembershipCommitted(n, membershipHash_);
    }

    function registerMembers(uint256 startIndex, address[] calldata members_, string[] calldata agentManifests_) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (initialized) revert AlreadyInitialized();
        uint256 n = members_.length;
        if (agentManifests_.length != n) revert LengthMismatch();
        uint256 start = _members.length;
        if (startIndex != start) revert WrongStartIndex(start, startIndex);
        if (n == 0 || n > MAX_BATCH_MEMBERS || start + n > expectedMemberCount) revert InvalidBatch();
        uint256 totalBytes;
        bytes32 hash = registeredHash;
        for (uint256 i = 0; i < n; ++i) {
            address member = members_[i];
            if (member == address(0)) revert ZeroAddress();
            if (_idPlusOne[member] != 0) revert DuplicateMember(member);
            uint256 len = bytes(agentManifests_[i]).length;
            if (len > MAX_AGENT_MANIFEST_BYTES) revert ManifestTooLong(len, MAX_AGENT_MANIFEST_BYTES);
            totalBytes += len;
            if (totalBytes > MAX_BATCH_MANIFEST_BYTES) revert InvalidBatch();
            uint256 id = start + i;
            _idPlusOne[member] = id + 1;
            _members.push(member);
            _agentManifests.push(agentManifests_[i]);
            hash = FleetMembership.append(hash, id, member, agentManifests_[i]);
            emit MemberRegistered(id, member, keccak256(bytes(agentManifests_[i])), agentManifests_[i]);
        }
        registeredHash = hash;
        if (_members.length == expectedMemberCount) {
            if (hash != membershipHash) revert MembershipHashMismatch();
            initialized = true;
            emit MembershipInitialized(expectedMemberCount, hash);
        }
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function isMember(address account) external view returns (bool) {
        return initialized && _idPlusOne[account] != 0;
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
