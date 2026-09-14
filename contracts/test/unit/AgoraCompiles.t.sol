// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";

contract AgoraCompilesTest is Test {
    function test_AgoraGovernorHasCreationCode() public pure {
        assertTrue(type(AgoraGovernor).creationCode.length > 0);
    }
}
