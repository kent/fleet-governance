// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice One experiment's fixed ERC-20 proposal supply. Constructor-only minting.
/// @dev Balances cannot be moved between wallets or experiments. Only the immutable
///      budget contract can burn, after a holder asks it to pay for a proposal.
contract FleetProposalToken is ERC20 {
    error NotController();
    error TransfersDisabled();
    error ApprovalsDisabled();

    address public immutable controller;
    uint256 public immutable taskId;
    bytes32 public immutable runHash;
    uint256 public immutable initialSupply;

    constructor(uint256 taskId_, bytes32 runHash_, address[] memory agents, uint8 tokensPerAgent)
        ERC20("Fleet Proposal", "FPROP")
    {
        controller = msg.sender;
        taskId = taskId_;
        runHash = runHash_;
        initialSupply = agents.length * uint256(tokensPerAgent);
        for (uint256 i; i < agents.length; ++i) _mint(agents[i], tokensPerAgent);
    }

    function decimals() public pure override returns (uint8) { return 0; }

    function burnForProposal(address proposer, uint256 amount) external {
        if (msg.sender != controller) revert NotController();
        _burn(proposer, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert TransfersDisabled();
        super._update(from, to, value);
    }

    function _approve(address, address, uint256, bool) internal pure override {
        revert ApprovalsDisabled();
    }
}
