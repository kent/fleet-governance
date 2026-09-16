// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetHook} from "./FleetHook.sol";
import {FleetRegistry} from "./FleetRegistry.sol";
import {TaskLedger} from "./TaskLedger.sol";
import {FleetBondVotes} from "./FleetBondVotes.sol";
import {FleetProposalBonds} from "./FleetProposalBonds.sol";

contract FleetBondHook is FleetHook {
    FleetProposalBonds public proposalBonds;
    constructor(FleetRegistry registry_, TaskLedger ledger_, address initializer_)
        FleetHook(registry_, ledger_, initializer_)
    {}

    function initialize(address governor_) public override {
        super.initialize(governor_);
        proposalBonds = new FleetProposalBonds(
            governor_, FleetBondVotes(address(governor.token())), ledger.operator(), address(this)
        );
    }

    function afterPropose(
        address sender,
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override returns (bytes4) {
        bytes4 result = super.afterPropose(sender, proposalId, targets, values, calldatas, description);
        proposalBonds.bond(taskOf[proposalId], proposalId, governor.proposalProposer(proposalId));
        return result;
    }
}
