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
