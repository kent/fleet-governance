// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

/// @title PlainVotes
/// @notice NOT FOR DEPLOYMENT. Test-only fixture for test/negative/UnrestrictedDelegation.t.sol.
/// @dev A bare ERC20Votes token with none of FleetVotes's boundaries: mint is public and
///      unrestricted, transfers are left enabled, and delegation is open to any address, not just
///      registered fleet members. It exists only to demonstrate why FleetVotes closes each of
///      those doors: fixed one-time minting scoped to the registry, transfers disabled outright,
///      and delegation restricted to other members.
contract PlainVotes is ERC20Votes {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) EIP712(name_, "1") {}

    /// @dev Unrestricted on purpose: this is the boundary FleetVotes removes by minting once, in
    ///      its constructor, in amounts fixed by the registry, with no public mint at all.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }
}
