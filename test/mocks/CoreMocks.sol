// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {TradeCore} from "../../contracts/common/TradeCore.sol";
import {IWETH, TokenOps} from "../../contracts/common/TokenOps.sol";

abstract contract CoreMockERC20 {
    mapping(address => uint256) internal balances;
    mapping(address => mapping(address => uint256)) public allowance;

    function balanceOf(address account) public view virtual returns (uint256) {
        return balances[account];
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
        balances[from] -= amount;
        balances[to] += amount;
    }
}

contract CoreMockAsset is CoreMockERC20 {
    bool private _balanceQueriesDisabled;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function disableBalanceQueries(bool disabled) external {
        _balanceQueriesDisabled = disabled;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(!_balanceQueriesDisabled, "balance unavailable");
        return super.balanceOf(account);
    }
}

contract CoreMockWrappedNative is CoreMockERC20, IWETH {
    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balances[msg.sender] -= amount;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        require(success, "withdrawal failed");
    }
}

contract CoreMockRouter {
    uint256 private _quoteRate = 3;
    uint256 private _fillRate = 3;

    function setRates(uint256 quoteRate, uint256 fillRate) external {
        _quoteRate = quoteRate;
        _fillRate = fillRate;
    }

    function quote(uint256 amount) external view returns (uint256) {
        return amount * _quoteRate;
    }

    function swap(address input, address output, uint256 amount, address recipient) external {
        require(CoreMockERC20(input).transferFrom(msg.sender, address(this), amount), "input transfer failed");
        require(CoreMockERC20(output).transfer(recipient, amount * _fillRate), "output transfer failed");
    }
}

contract CoreMockRejectingRecipient {
    receive() external payable {
        revert("native transfers disabled");
    }
}

contract CoreMockExecutor is TradeCore {
    CoreMockRouter public immutable router;

    address private _input;
    address private _output;
    address private _recipient;
    uint256 private _minimum;

    constructor(address initialOwner, address wrapped, CoreMockRouter swapRouter) TradeCore(initialOwner, wrapped) {
        router = swapRouter;
    }

    function save(address input, address output, address recipient, uint256 minimum, uint16 sellLossBps)
        external
        onlyOwner
        nonReentrant
    {
        if (input.code.length == 0 || output.code.length == 0 || input == output) revert InvalidSettings();
        _checkRecipient(recipient);
        _input = input;
        _output = output;
        _recipient = recipient;
        _minimum = minimum;
        _afterSettings(sellLossBps);
        emit SettingsUpdated(input, output, recipient);
    }

    function sampleTaxReport(uint256 amount) external onlyOwner nonReentrant {
        uint256 quote = router.quote(amount);
        (uint256 bought, uint256 received,) = _executeTrade(amount, 1, block.timestamp, 0, false);
        _report(
            TaxExecutionResult({
                amountIn: amount,
                expectedBuy: quote,
                bought: bought,
                probeAmount: 0,
                expectedSell: 0,
                recovered: 0,
                forwarded: bought,
                expectedRecipient: bought,
                received: received,
                kind: 1,
                pool: address(router),
                fee: 0
            })
        );
    }

    function _settingsInput() internal view override returns (address) {
        return _input;
    }

    function _settingsMinimum() internal view override returns (uint256) {
        return _minimum;
    }

    function _executeTrade(uint256 amount, uint256 requestedMinimum, uint256, uint16 autoSlippageBps, bool automatic)
        internal
        override
        returns (uint256 bought, uint256 received, uint256 testInputRecovered)
    {
        uint256 expected = router.quote(amount);
        uint256 minimum = _executionMinimum(expected, requestedMinimum, autoSlippageBps, automatic);
        uint256 inputBefore = TokenOps.balanceOf(_input, address(this));
        uint256 outputBefore = TokenOps.balanceOf(_output, address(this));
        uint256 recipientBefore = TokenOps.balanceOf(_output, _recipient);

        TokenOps.forceApprove(_input, address(router), amount);
        router.swap(_input, _output, amount, address(this));
        TokenOps.forceApprove(_input, address(router), 0);

        if (TokenOps.balanceOf(_input, address(this)) != inputBefore - amount) revert UnexpectedBalance();
        bought = TokenOps.balanceOf(_output, address(this)) - outputBefore;
        if (bought < minimum) revert MinimumNotMet(bought, minimum);

        TokenOps.transfer(_output, _recipient, bought);
        received = TokenOps.balanceOf(_output, _recipient) - recipientBefore;
        emit Bought(1, address(router), 0, amount, expected, bought, received, 0);
        return (bought, received, 0);
    }
}
