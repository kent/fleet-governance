// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetHook} from "./FleetHook.sol";
import {FleetRegistry} from "./FleetRegistry.sol";
import {TaskLedger} from "./TaskLedger.sol";
import {FleetProposalBudget} from "./FleetProposalBudget.sol";
import {ICreditToken} from "./FleetProposalCredits.sol";

/// @notice An immutable Governor hook that makes proposal publication and ERC-20
///         fee burning one atomic transaction. All original fleet rules still apply.
contract FleetBudgetHook is FleetHook {
    FleetProposalBudget public proposalBudget;

    constructor(FleetRegistry registry_, TaskLedger ledger_, address initializer_)
        FleetHook(registry_, ledger_, initializer_) {}

    function initialize(address governor_) public override {
        super.initialize(governor_);
        proposalBudget = new FleetProposalBudget(governor_, ICreditToken(address(governor.token())), ledger.operator(), address(this));
    }

    function afterPropose(address sender, uint256 proposalId, address[] memory targets,
        uint256[] memory values, bytes[] memory calldatas, string memory description)
        public override returns (bytes4)
    {
        bytes4 result = super.afterPropose(sender, proposalId, targets, values, calldatas, description);
        proposalBudget.charge(taskOf[proposalId], proposalId, governor.proposalProposer(proposalId));
        return result;
    }
}
