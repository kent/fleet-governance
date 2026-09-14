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
