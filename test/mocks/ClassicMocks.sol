// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {
    IFeeQuoter, IUniV3Router, IPancakeV3Router, IAerodromeRouter, ISlipstreamQuoter, ISlipstreamRouter
} from "../../contracts/classic/ClassicInterfaces.sol";

contract ClassicMockToken {
    uint16 private immutable _transferFeeBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint16 transferFeeBps) {
        _transferFeeBps = transferFeeBps;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        balanceOf[from] -= value;
        balanceOf[to] += value - (value * _transferFeeBps / 10_000);
    }
}

/// @dev Local fixture for the exact external selectors used by the desktop adapter.
contract ClassicMockMarket {
    uint24 private constant FEE = 500;
    int24 private constant SPACING = 100;

    address private immutable _payment;
    address private immutable _purchase;
    bool public stablePool;
    uint8 public lastSwapKind;

    constructor(address payment, address purchase) {
        _payment = payment;
        _purchase = purchase;
    }

    function setStablePool(bool enabled) external {
        stablePool = enabled;
    }

    function getPair(address a, address b) external view returns (address) {
        return _pair(a, b) ? address(this) : address(0);
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pair(a, b) && fee == FEE ? address(this) : address(0);
    }

    function getPool(address a, address b, bool stable) external view returns (address) {
        return _pair(a, b) && stable == stablePool ? address(this) : address(0);
    }

    function getPool(address a, address b, int24 spacing) external view returns (address) {
        return _pair(a, b) && spacing == SPACING ? address(this) : address(0);
    }

    function tickSpacings() external pure returns (int24[] memory spacings) {
        spacings = new int24[](1);
        spacings[0] = SPACING;
    }

    function getAmountsOut(uint256 amount, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2 && _pair(path[0], path[1]));
        amounts = new uint256[](2);
        amounts[0] = amount;
        amounts[1] = _quote(path[0], amount);
    }

    function getAmountOut(uint256 amount, address input) external view returns (uint256) {
        return _quote(input, amount);
    }

    function quoteExactInputSingle(IFeeQuoter.Quote calldata p) external view returns (uint256, uint160, uint32, uint256) {
        require(_pair(p.tokenIn, p.tokenOut) && p.fee == FEE);
        return (_quote(p.tokenIn, p.amountIn), 1, 0, 0);
    }

    function quoteExactInputSingle(ISlipstreamQuoter.Quote calldata p)
        external
        view
        returns (uint256, uint160, uint32, uint256)
    {
        require(_pair(p.tokenIn, p.tokenOut) && p.tickSpacing == SPACING);
        return (_quote(p.tokenIn, p.amountIn), 1, 0, 0);
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amount, uint256, address[] calldata path, address recipient, uint256 deadline
    ) external {
        require(path.length == 2 && block.timestamp <= deadline);
        _swap(1, path[0], path[1], recipient, amount);
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amount, uint256, IAerodromeRouter.Hop[] calldata path, address recipient, uint256 deadline
    ) external {
        require(path.length == 1 && block.timestamp <= deadline);
        require(path[0].factory == address(this) && path[0].stable == stablePool);
        _swap(stablePool ? 4 : 3, path[0].from, path[0].to, recipient, amount);
    }

    function exactInputSingle(IUniV3Router.Swap calldata p) external returns (uint256) {
        require(p.fee == FEE && p.priceLimit == 0);
        return _swap(2, p.tokenIn, p.tokenOut, p.recipient, p.amountIn);
    }

    function exactInputSingle(IPancakeV3Router.Swap calldata p) external returns (uint256) {
        require(p.fee == FEE && p.priceLimit == 0 && block.timestamp <= p.deadline);
        return _swap(9, p.tokenIn, p.tokenOut, p.recipient, p.amountIn);
    }

    function exactInputSingle(ISlipstreamRouter.Swap calldata p) external returns (uint256) {
        require(p.tickSpacing == SPACING && p.priceLimit == 0 && block.timestamp <= p.deadline);
        return _swap(5, p.tokenIn, p.tokenOut, p.recipient, p.amountIn);
    }

    function _swap(uint8 kind, address input, address output, address to, uint256 amount) private returns (uint256) {
        require(_pair(input, output));
        lastSwapKind = kind;
        ClassicMockToken paying = ClassicMockToken(input);
        uint256 beforeTransfer = paying.balanceOf(address(this));
        require(paying.transferFrom(msg.sender, address(this), amount));
        uint256 actualInput = paying.balanceOf(address(this)) - beforeTransfer;
        uint256 quotedOutput = _quote(input, actualInput);
        require(ClassicMockToken(output).transfer(to, quotedOutput));
        return quotedOutput;
    }

    function _pair(address a, address b) private view returns (bool) {
        return (a == _payment && b == _purchase) || (a == _purchase && b == _payment);
    }

    function _quote(address input, uint256 amount) private view returns (uint256) {
        return input == _payment ? amount * 10 : amount;
    }
}
