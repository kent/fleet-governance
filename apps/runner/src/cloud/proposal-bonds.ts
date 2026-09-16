import { parseAbi, parseUnits } from "viem";

export const BOND_DEPLOYMENT = "contracts/proposal-bonds-v4.json";
export const bondUnits = (amount: number) => parseUnits(String(amount), 18);
export const bondHookAbi = parseAbi(["function proposalBonds() view returns (address)"]);
export const proposalBondsAbi = parseAbi([
  "function governor() view returns (address)", "function token() view returns (address)",
  "function operator() view returns (address)", "function hook() view returns (address)",
  "function currentTaskId() view returns (uint256)",
  "function runs(uint256) view returns (bytes32 runHash, uint64 expiresAt, uint256 bondAmount, uint256 proposalThreshold, uint32 cooldownSeconds, uint16 participationBps, bool closed)",
  "function registerRunPolicy(uint256 taskId, bytes32 runHash, uint64 expiresAt, uint256 bondAmount, uint256 proposalThreshold, uint32 cooldownSeconds, uint16 participationBps, address[] agents)",
  "function participants(uint256 taskId, address agent) view returns (bool)",
  "function lastProposedAt(uint256 taskId, address agent) view returns (uint64)",
  "function receipts(uint256) view returns (uint256 taskId, address proposer, uint64 bondedAt, uint256 amount, uint256 votingPower, uint8 settlement)",
  "function proposalCount(uint256 taskId) view returns (uint256)", "function proposalAt(uint256 taskId, uint256 index) view returns (uint256)",
  "function settle(uint256 proposalId) returns (uint8)", "function closeRun(uint256 taskId)",
  "event ProposalBonded(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint256 amount)",
  "event ProposalBondSettled(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint256 amount, uint8 settlement, uint256 participation, uint256 requiredParticipation)",
]);
export const bondVotesAbi = parseAbi([
  "function bondController() view returns (address)", "function registry() view returns (address)",
  "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)",
  "function available(address) view returns (uint256)", "function bonded(address) view returns (uint256)",
  "function forfeited(address) view returns (uint256)", "function totalBonded() view returns (uint256)",
  "event TokensBonded(address indexed holder, uint256 amount)",
  "event BondResolved(address indexed holder, uint256 amount, bool forfeited)",
  "event ExperimentBalanceReset(address indexed holder, uint256 returnedAmount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
