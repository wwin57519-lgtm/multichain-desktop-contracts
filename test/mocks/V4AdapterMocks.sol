// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {V4Types} from "../../contracts/v4/V4Types.sol";

interface V4MockToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract V4MockPermit2 {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(amount, expiration);
    }

    function settle(address owner, address token, uint160 amount) external {
        Allowance storage access = allowance[owner][token][msg.sender];
        require(access.expiration >= block.timestamp, "permit expired");
        access.amount -= amount;
        require(V4MockToken(token).transferFrom(owner, msg.sender, amount), "payment failed");
    }
}

contract V4MockQuoter {
    function quoteExactInputSingle(V4Types.UniQuote calldata params) external pure returns (uint256, uint256) {
        require(params.hookData.length == 0, "unexpected hook");
        return (uint256(params.amount) * (params.key.fee == 500 ? 3 : 2), 0);
    }

    function quoteExactInputSingle(V4Types.InfinityQuote calldata params) external pure returns (uint256, uint256) {
        require(params.hookData.length == 0, "unexpected hook");
        return (uint256(params.amount) * (params.key.fee == 500 ? 3 : 2), 0);
    }
}

contract V4MockUniversalRouter {
    address private _permit2;
    bool private _infinity;
    bool private _partial;
    bytes3 public lastActions;

    function configure(address permit2, bool infinity) external {
        _permit2 = permit2;
        _infinity = infinity;
    }

    function setPartial(bool partialFill) external {
        _partial = partialFill;
    }

    receive() external payable {}

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(commands.length == 1 && commands[0] == 0x10 && inputs.length == 1, "bad command");
        require(deadline >= block.timestamp, "expired");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(actions.length == 3 && params.length == 3 && actions[1] == 0x0c && actions[2] == 0x0f, "bad actions");

        address currencyIn;
        address currencyOut;
        uint24 fee;
        uint128 amount;
        uint128 minimum;
        if (_infinity) {
            require(actions[0] == 0x06 || actions[0] == 0x1c, "bad Infinity action");
            V4Types.InfinitySwap memory swap = abi.decode(params[0], (V4Types.InfinitySwap));
            require(swap.key.hooks == address(0) && swap.hookData.length == 0, "unexpected hook");
            currencyIn = swap.zeroForOne ? swap.key.currency0 : swap.key.currency1;
            currencyOut = swap.zeroForOne ? swap.key.currency1 : swap.key.currency0;
            fee = swap.key.fee;
            amount = swap.amount;
            minimum = swap.minimum;
        } else {
            require(actions[0] == 0x06, "bad Uniswap action");
            V4Types.UniSwap memory swap = abi.decode(params[0], (V4Types.UniSwap));
            require(swap.minHopPriceX36 == 0 && swap.hookData.length == 0, "wrong swap layout");
            currencyIn = swap.zeroForOne ? swap.key.currency0 : swap.key.currency1;
            currencyOut = swap.zeroForOne ? swap.key.currency1 : swap.key.currency0;
            fee = swap.key.fee;
            amount = swap.amount;
            minimum = swap.minimum;
        }
        require(keccak256(params[1]) == keccak256(abi.encode(currencyIn, uint256(amount))), "bad settle");
        require(keccak256(params[2]) == keccak256(abi.encode(currencyOut, uint256(minimum))), "bad take");

        uint128 settled = _partial ? amount - 1 : amount;
        uint256 received = uint256(settled) * (fee == 500 ? 3 : 2);
        require(received >= minimum, "too little output");
        if (currencyIn == address(0)) {
            require(msg.value == amount, "bad native payment");
            (bool ok,) = payable(address(0x100)).call{value: settled}("");
            require(ok, "native settlement failed");
        } else {
            require(msg.value == 0, "unexpected native payment");
            V4MockPermit2(_permit2).settle(msg.sender, currencyIn, settled);
        }
        if (currencyOut == address(0)) {
            (bool ok,) = payable(msg.sender).call{value: received}("");
            require(ok, "native output failed");
        } else {
            require(V4MockToken(currencyOut).transfer(msg.sender, received), "output failed");
        }
        lastActions = bytes3(actions);
    }
}

/// @dev Recipient-specific fees let tests distinguish input, pool receipt and final delivery.
contract V4MockRecipientFeeAsset {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address private _target;
    uint16 private _feeBps;

    function setRecipientFee(address target, uint16 feeBps) external {
        _target = target;
        _feeBps = feeBps;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        uint256 fee = to == _target ? (amount * _feeBps) / 10_000 : 0;
        balanceOf[to] += amount - fee;
    }
}
