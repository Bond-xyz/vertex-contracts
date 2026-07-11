// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "./common/Constants.sol";
import "./interfaces/IVersion.sol";

/// @dev Compile-restoration file. The audited a06f33 snapshot imports Version
/// but omitted this implementation; this is the exact implementation used by
/// the preceding Vertex release line.
abstract contract Version is IVersion {
    function getVersion() external pure returns (uint64) {
        return VERSION;
    }
}
