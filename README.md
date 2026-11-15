# Multichain Desktop Contracts

从 MultiChain Swap、MultiChain Trigger 和 V4 Trading 桌面客户端的接口及配置重写的 Solidity 合约，适用于用户自有资金和已授权钱包。Batch Transmitter 使用标准代币接口及调用人指定的目标地址。

| 合约 | 功能 |
| --- | --- |
| BaseSwapExecutor | Uniswap V2/V3、PancakeSwap V2/V3、Aerodrome 普通池和 Slipstream 直连交易 |
| ProtocolQuoteHelper | 查询符合交易所策略、费率、tick spacing 和池余额门槛的候选池，提供买入和反向报价 |
| V4SwapExecutor | Uniswap V4、PancakeSwap Infinity CL/Bin 直连交易 |
| V4QuoteHelper | 保存无 Hook 的候选池及锁定池，生成报价和 Universal Router 参数 |

执行器提供 ERC-20 与原生币资金管理、所有者操作、授权触发钱包、时限和单轮执行。更新设置或撤销授权会使旧的触发 epoch 失效。交易使用链上保存的最低购买量或报价滑点，并以余额变化核算实际买入、试卖和收款。税费模拟通过回滚返回报告。

## 构建与验证

使用 Node.js 24 和 npm。

```sh
npm ci --ignore-scripts
npm run build
npm run check:client
npm test
```

构建使用 Solidity 0.8.36。`artifacts/` 包含重写版本的 ABI、字节码、不可变引用和内嵌源码的编译元数据。`test/fixtures/desktop-abi.json` 保存用于兼容检查的桌面端 ABI。

协议路由和资金操作在本地 Ganache 与模拟协议合约中验证。链上依赖按恢复的桌面客户端配置。真实池、网络状态和成交行为待独立验证。路由接口参考 [Uniswap V4](https://developers.uniswap.org/docs/sdks/v4/guides/swapping/single-hop-swapping)、[PancakeSwap Infinity](https://developer.pancakeswap.finance/contracts/universal-router/addresses)、[Aerodrome Router](https://github.com/aerodrome-finance/contracts/blob/main/contracts/interfaces/IRouter.sol) 和 [Slipstream](https://github.com/aerodrome-finance/slipstream/tree/main/contracts/periphery/interfaces)。

## 桌面端接入

MultiChain Swap 与 MultiChain Trigger 共用 `BaseSwapExecutor.json` 和 `ProtocolQuoteHelper.json`。V4 Trading 使用 `V4SwapExecutor.json` 和 `V4QuoteHelper.json`。

桌面端通过运行时代码识别执行器和报价辅助合约。接入时将新产物加入识别列表，并保留历史产物供读取和资金取回。重写合约的部署字节码及未来部署地址独立于历史版本。

## 源码与许可

原安装包提供旧合约的 ABI、字节码、编译设置和源码哈希。这里的 Solidity 实现来自桌面客户端用法和接口重建。代码采用 [MIT 许可证](LICENSE)。
