// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "../OffchainExchange.sol";
import "../interfaces/IEndpoint.sol";
import "../util/MockERC20.sol";

contract TransferTaxMockERC20 is MockERC20 {
    constructor() MockERC20("Transfer Tax USD", "USDC.e", 6) {}

    function _transfer(
        address sender,
        address recipient,
        uint256 amount
    ) internal override {
        super._transfer(sender, recipient, amount - 1);
        _burn(sender, 1);
    }
}

contract MockSpotEngineForEndpoint {
    address public immutable token;

    constructor(address _token) {
        token = _token;
    }

    function getToken(uint32) external view returns (address) {
        return token;
    }
}

contract MockClearinghouseForEndpoint {
    address public immutable quote;
    address public immutable spotEngine;

    constructor(address _quote, address _spotEngine) {
        quote = _quote;
        spotEngine = _spotEngine;
    }

    function getQuote() external view returns (address) {
        return quote;
    }

    function getEngineByType(
        IProductEngine.EngineType engineType
    ) external view returns (address) {
        return
            engineType == IProductEngine.EngineType.SPOT
                ? spotEngine
                : address(0);
    }

    function getEngineByProduct(uint32) external pure returns (address) {
        return address(0);
    }
}

contract MockEndpointTime {
    uint128 public time;

    constructor(uint128 _time) {
        time = _time;
    }

    function getTime() external view returns (uint128) {
        return time;
    }
}

contract OffchainExchangeReleaseHarness is OffchainExchange {
    function initializeForTest(address endpoint_) external initializer {
        __Ownable_init();
        setEndpoint(endpoint_);
    }

    function validateOrderForTest(
        IEndpoint.SignedOrder memory signedOrder,
        bytes32 orderDigest,
        address linkedSigner
    ) external view returns (bool) {
        CallState memory callState = CallState({
            perp: IPerpEngine(address(0)),
            spot: ISpotEngine(address(0)),
            isPerp: false,
            productId: 0
        });
        MarketInfo memory market;
        return
            _validateOrder(
                callState,
                market,
                signedOrder,
                orderDigest,
                linkedSigner
            );
    }
}

contract TransactionOrdinalHarness {
    function keyOrdinals()
        external
        pure
        returns (
            uint8 depositCollateral,
            uint8 withdrawCollateral,
            uint8 updatePrice,
            uint8 matchOrders,
            uint8 perpTick,
            uint8 transferQuote,
            uint8 finalOrdinal
        )
    {
        return (
            uint8(IEndpoint.TransactionType.DepositCollateral),
            uint8(IEndpoint.TransactionType.WithdrawCollateral),
            uint8(IEndpoint.TransactionType.UpdatePrice),
            uint8(IEndpoint.TransactionType.MatchOrders),
            uint8(IEndpoint.TransactionType.PerpTick),
            uint8(IEndpoint.TransactionType.TransferQuote),
            uint8(IEndpoint.TransactionType.RebalanceXWithdraw)
        );
    }
}
