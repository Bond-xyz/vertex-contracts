// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

interface IClearinghouseEventEmitter {
    /// @notice Emitted during initialization
    event ClearinghouseInitialized(address endpoint, address quote);

    /// @notice Emitted when collateral is modified for a subaccount
    event ModifyCollateral(
        int128 amount,
        bytes32 indexed subaccount,
        uint32 productId
    );

    /// @notice Final on-chain evidence that the configured collateral token
    /// left Clearinghouse custody for a user withdrawal.
    event WithdrawalSettled(
        bytes32 indexed subaccount,
        uint32 indexed productId,
        address indexed recipient,
        address token,
        uint128 requestedAmount,
        int128 requestedAmountDeltaX18
    );

    event ReleaseModeChanged(uint8 previousMode, uint8 newMode);

    event Liquidation(
        bytes32 indexed liquidatorSubaccount,
        bytes32 indexed liquidateeSubaccount,
        uint32 productId,
        bool isEncodedSpread,
        int128 amount,
        int128 amountQuote
    );
}
