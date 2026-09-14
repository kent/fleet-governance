// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";
import {FleetRegistry} from "./FleetRegistry.sol";

/// @title FleetVotes
/// @notice One governance vote per fleet member. Non-transferable. Delegatable only to members.
/// @dev Bounded initialization mints exactly one vote for each sealed member. No further supply
///      change is possible. The hook cannot activate until initialization is complete.
contract FleetVotes is ERC20Votes {
    error TransfersDisabled();
    error ApprovalsDisabled();
    error NotMember(address account);
    error InvalidDelegatee(address delegatee);
    error RegistryNotInitialized();
    error NotInitialized();
    error InvalidBatch();
    error AlreadyInitialized();
    error NotInitializer();

    uint256 public constant UNIT = 1e18;
    uint256 public constant MAX_BATCH_MEMBERS = 64;
    uint256 public mintedMembers;
    bool public initialized;
    uint48 public initializedAt;
    event VotesInitialized(uint256 memberCount, uint48 timestamp);

    FleetRegistry public immutable registry;
    address public immutable initializer;

    constructor(string memory name_, string memory symbol_, FleetRegistry registry_)
        ERC20(name_, symbol_)
        EIP712(name_, "1")
    {
        registry = registry_;
        initializer = msg.sender;
        if (!registry_.initialized()) revert RegistryNotInitialized();
    }

    /// @notice Bounded setup with no recipient or amount arguments. The immutable sealed
    ///         roster fixes both. Sequential batches cannot repeat, add or omit a member.
    function initializeVotes(uint256 count) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (initialized) revert AlreadyInitialized();
        uint256 start = mintedMembers;
        uint256 n = registry.memberCount();
        if (count == 0 || count > MAX_BATCH_MEMBERS || start + count > n) revert InvalidBatch();
        mintedMembers = start + count;
        for (uint256 i = start; i < start + count; ++i) {
            address member = registry.accountOf(i);
            _mint(member, UNIT);
            // Public delegation is disabled during setup. Only this fixed self-delegation runs.
            super._delegate(member, member);
        }
        if (mintedMembers == n) {
            initialized = true;
            initializedAt = clock();
            emit VotesInitialized(n, initializedAt);
        }
    }

    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /// @dev Only initialization mints pass. Every transfer and burn reverts, including zero-value ones.
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
        if (!initialized) revert NotInitialized();
        if (!registry.isMember(account)) revert NotMember(account);
        if (delegatee != account && !registry.isMember(delegatee)) revert InvalidDelegatee(delegatee);
        super._delegate(account, delegatee);
    }
}
