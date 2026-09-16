# FleetGov proposal bonds on Base Sepolia

One fixed-supply ERC-20 now carries voting power, delegation and proposal collateral.
The new Governor uses an immutable FleetBondHook. Its Agora voting logic is unchanged.

[Deployment workflow](https://github.com/kent/fleet-governance/actions/runs/35158732609)
completed successfully. [Deployment manifest](deployment.json) contains the addresses,
code hashes and compiler pins. Local contract validation passed 165 tests.

The live protocol acceptance is running through GitHub before activation. Its ballots are
scripted contract checks, not model-generated decisions. The record will include cancellation,
a well-attended losing proposal and an insufficient-participation proposal.
