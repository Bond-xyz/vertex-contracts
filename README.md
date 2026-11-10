# Vertex EVM Contracts

EVM implementation of Vertex. A [Hardhat](https://hardhat.org/) project.

# Local Development

The following assumes the use of `node@>=16`.

## Install Dependencies

`yarn install`

## Compile Contracts

`yarn compile`

# Deployment Profiles

The release pipeline targets one network profile per process, selected with `PERPDEX_NETWORK` (`galileo` by default, `og-mainnet`, `og-mainnet-usdz`). See [OG_MAINNET_DEPLOYMENT.md](OG_MAINNET_DEPLOYMENT.md) for the 0G mainnet profiles and [GALILEO_RELEASE.md](GALILEO_RELEASE.md) for the Galileo release flow.
