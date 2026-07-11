// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

/// @notice Marker used as the unique EIP-712 verifying-contract domain for a
/// single market. It holds no funds and exposes no privileged methods.
contract VirtualBook {
    uint32 public immutable productId;

    constructor(uint32 _productId) {
        productId = _productId;
    }
}
