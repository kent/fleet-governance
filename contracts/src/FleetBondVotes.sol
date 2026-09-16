// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {FleetVotes} from "./FleetVotes.sol";
import {FleetRegistry} from "./FleetRegistry.sol";

/// @notice The same fixed-supply FleetGov token carries votes and backs proposal bonds.
/// @dev A reservation keeps votes with the holder. Forfeiture moves actual tokens into
///      the non-voting bond treasury. Only a fresh operator-authorised experiment may
///      redistribute that original supply; nothing can mint or refill an active run.
contract FleetBondVotes is FleetVotes {
    error NotBondController();
    error InvalidBondController();
    error InsufficientUnbondedTokens();
    error InvalidBondAmount();

    address public bondController;
    mapping(address => uint256) public bonded;
    mapping(address => uint256) public forfeited;
    uint256 public totalBonded;
    event BondControllerBound(address indexed controller);
    event TokensBonded(address indexed holder, uint256 amount);
    event BondResolved(address indexed holder, uint256 amount, bool forfeited);
    event ExperimentBalanceReset(address indexed holder, uint256 returnedAmount);

    constructor(string memory name_, string memory symbol_, FleetRegistry registry_)
        FleetVotes(name_, symbol_, registry_)
    {}

    modifier onlyBondController() {
        if (msg.sender != bondController) revert NotBondController();
        _;
    }

    function bindBondController(address controller) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (bondController != address(0) || controller.code.length == 0) revert InvalidBondController();
        bondController = controller;
        emit BondControllerBound(controller);
    }

    function available(address holder) public view returns (uint256) {
        return balanceOf(holder) - bonded[holder];
    }

    function lockBond(address holder, uint256 amount) external onlyBondController {
        if (!registry.isMember(holder) || amount == 0) revert InvalidBondAmount();
        if (available(holder) < amount) revert InsufficientUnbondedTokens();
        bonded[holder] += amount;
        totalBonded += amount;
        emit TokensBonded(holder, amount);
    }

    function resolveBond(address holder, uint256 amount, bool slash) external onlyBondController {
        if (amount == 0 || bonded[holder] < amount) revert InvalidBondAmount();
        bonded[holder] -= amount;
        totalBonded -= amount;
        if (slash) {
            forfeited[holder] += amount;
            // Only this settlement path bypasses FleetVotes' public transfer prohibition.
            // ERC20Votes updates both real balances and future voting checkpoints.
            ERC20Votes._update(holder, bondController, amount);
        }
        emit BondResolved(holder, amount, slash);
    }

    function resetExperimentBalance(address holder) external onlyBondController {
        if (bonded[holder] != 0) revert InvalidBondAmount();
        uint256 amount = forfeited[holder];
        if (amount != 0) {
            forfeited[holder] = 0;
            ERC20Votes._update(bondController, holder, amount);
        }
        emit ExperimentBalanceReset(holder, amount);
    }
}
