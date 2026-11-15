const assert = require("node:assert/strict");
const { before, test } = require("node:test");
const ganache = require("ganache");
const { BrowserProvider, Contract, ContractFactory, ZeroAddress } = require("ethers");
const { compile } = require("../scripts/compile.cjs");

let artifacts;

before(() => {
    artifacts = compile({ includeMocks: true });
});

async function deploy(name, signer, ...args) {
    const { abi, bytecode } = artifacts[name];
    const contract = await new ContractFactory(abi, bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function mine(transaction) {
    return (await transaction).wait();
}

async function fixture(t, { fee = 0, distinctSlipstream = false } = {}) {
    const chain = ganache.provider({
        chain: { chainId: 31337, hardfork: "shanghai" },
        logging: { quiet: true },
        wallet: { deterministic: true, totalAccounts: 2 }
    });
    t.after(() => chain.disconnect());
    const provider = new BrowserProvider(chain, 31337, { cacheTimeout: -1 });
    const owner = await provider.getSigner(0);
    const recipient = await (await provider.getSigner(1)).getAddress();
    const wrapped = await deploy("CoreMockWrappedNative", owner);
    const wrappedAddress = await wrapped.getAddress();
    const payment = await deploy("ClassicMockToken", owner, 0);
    const purchase = await deploy("ClassicMockToken", owner, fee);
    const tokenIn = await payment.getAddress();
    const tokenOut = await purchase.getAddress();
    const market = await deploy("ClassicMockMarket", owner, tokenIn, tokenOut);
    const marketAddress = await market.getAddress();
    const groups = [market, market, market];
    if (distinctSlipstream) {
        groups[1] = await deploy("ClassicMockMarket", owner, tokenIn, tokenOut);
        groups[2] = await deploy("ClassicMockMarket", owner, tokenIn, tokenOut);
    }
    const [one, two, three] = await Promise.all(groups.map(group => group.getAddress()));
    const uni = [wrappedAddress, marketAddress, marketAddress, marketAddress, marketAddress, marketAddress];
    const aero = [marketAddress, marketAddress, one, one, one, two, two, two, three, three, three];
    const pancake = new Array(5).fill(marketAddress);
    const executor = await deploy("BaseSwapExecutor", owner, await owner.getAddress(), uni, aero, pancake);
    const executorAddress = await executor.getAddress();
    await mine(payment.mint(executorAddress, 10_000));
    for (const address of new Set([one, two, three])) {
        await mine(payment.mint(address, 100_000));
        await mine(purchase.mint(address, 1_000_000));
    }
    const settings = {
        tokenIn, tokenOut, recipient, minPoolInput: 0, minBuyAmount: 0, allowV2: true,
        checkBurn: false, maxBurnBps: 0, testSell: false, testSellBps: 0
    };
    return {
        provider, chain, executor, executorAddress, payment, purchase, market, marketAddress, groups,
        settings, recipient, uni, aero, pancake
    };
}

async function expiry(chain) {
    const block = await chain.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    return BigInt(block.timestamp) + 300n;
}

function boughtEvent(receipt, executor) {
    for (const entry of receipt.logs) {
        const event = executor.interface.parseLog(entry);
        if (event?.name === "Bought") return event.args;
    }
    assert.fail("Bought event not emitted");
}

async function revertDetails(action, executor, name) {
    let args;
    await assert.rejects(action, error => {
        assert.equal(error.code, "CALL_EXCEPTION");
        const details = executor.interface.parseError(error.data);
        assert.equal(details.name, name);
        args = details.args;
        return true;
    });
    return args;
}

test("all nine desktop route identifiers quote and execute through their configured adapters", async (t) => {
    const ctx = await fixture(t, { distinctSlipstream: true });
    const { executor, payment, purchase, market, groups, recipient, executorAddress, marketAddress } = ctx;
    const quoteHelper = new Contract(await executor.aerodromeQuoteHelper(), artifacts.ProtocolQuoteHelper.abi, ctx.provider);
    const config = await quoteHelper.getNetworkConfig();
    assert.deepEqual(Array.from(config[0]), ctx.uni);
    assert.deepEqual(Array.from(config[1]), ctx.aero);
    assert.deepEqual(Array.from(config[2]), ctx.pancake);
    const cases = [
        { kind: 1, venue: 0, fees: [], allowV2: true, actual: 1 },
        { kind: 2, venue: 0, fees: [500], allowV2: false, actual: 2 },
        { kind: 3, venue: 1, fees: [], allowV2: true, actual: 3 },
        { kind: 4, venue: 1, fees: [], allowV2: true, actual: 4, stable: true },
        { kind: 5, venue: 1, fees: [], allowV2: false, actual: 5, group: 0 },
        { kind: 6, venue: 1, fees: [], allowV2: false, actual: 5, group: 1 },
        { kind: 7, venue: 1, fees: [], allowV2: false, actual: 5, group: 2 },
        { kind: 8, venue: 2, fees: [], allowV2: true, actual: 1 },
        { kind: 9, venue: 2, fees: [500], allowV2: false, actual: 9 }
    ];

    for (const route of cases) {
        const target = route.group === undefined ? market : groups[route.group];
        const targetAddress = await target.getAddress();
        if (route.stable) await mine(market.setStablePool(true));
        const spacings = route.group === undefined ? [] : [route.group * 16_777_216 + 100];
        const settings = { ...ctx.settings, allowV2: route.allowV2 };
        await mine(executor.setSettingsAndDex(settings, route.fees, 100, route.venue, spacings));
        const [best, routes] = await executor.quoteBest.staticCall(10);
        assert.equal(best.kind, BigInt(route.kind));
        assert.equal(best.pool, targetAddress);
        assert.equal(best.amountOut, 100n);
        assert.ok(best.poolInput >= 100_000n);
        assert.equal(routes.filter(option => option.amountOut > 0n).length, 1);
        const receipt = await mine(executor.buy(10, 99, await expiry(ctx.chain), await executor.triggerEpoch()));
        const bought = boughtEvent(receipt, executor);
        assert.equal(bought.kind, BigInt(route.kind));
        assert.equal(bought.pool, targetAddress);
        assert.equal(bought.received, 100n);
        assert.equal(await target.lastSwapKind(), BigInt(route.actual));
        assert.equal(await payment.allowance(executorAddress, targetAddress), 0n);
    }
    assert.equal(await purchase.balanceOf(recipient), 900n);
    const blocked = { ...ctx.settings, minPoolInput: 200_000 };
    await mine(executor.setSettingsAndDex(blocked, [], 100, 0, []));
    const [best, routes] = await executor.quoteBest.staticCall(10);
    assert.equal(best.pool, ZeroAddress);
    assert.equal(routes[0].pool, marketAddress);
    assert.equal(routes[0].amountOut, 0n);
    const deadline = await expiry(ctx.chain);
    const epoch = await executor.triggerEpoch();
    await revertDetails(() => executor.buy.staticCall(10, 1, deadline, epoch), executor, "NoEligiblePool");

    await revertDetails(
        () => executor.setSettingsAndDex.staticCall(ctx.settings, [500, 500], 100, 0, []), executor, "InvalidFees"
    );
    await revertDetails(
        () => executor.setSettingsAndDex.staticCall(ctx.settings, [], 100, 1, [101]), executor, "InvalidDexPolicy"
    );
});

test("tax reports revert atomically and the cumulative recipient guard measures actual balances", async (t) => {
    const ctx = await fixture(t, { fee: 500 });
    const { executor, payment, purchase, recipient, marketAddress, executorAddress } = ctx;
    const settings = { ...ctx.settings, testSell: true, testSellBps: 1000 };
    const balances = () => Promise.all([
        payment.balanceOf(executorAddress), purchase.balanceOf(executorAddress), purchase.balanceOf(recipient),
        payment.balanceOf(marketAddress), purchase.balanceOf(marketAddress),
        payment.allowance(executorAddress, marketAddress), purchase.allowance(executorAddress, marketAddress)
    ]);
    const initial = await balances();
    const report = await revertDetails(
        () => executor.simulateTaxWithDex.staticCall(settings, [], 100, 0, []), executor, "TaxReport"
    );
    assert.deepEqual(Array.from(report), [100n, 1000n, 950n, 95n, 95n, 91n, 855n, 900n, 813n, 1n, marketAddress, 0n]);
    await assert.rejects(
        () => mine(executor.simulateTaxWithDex(settings, [], 100, 0, [], { gasLimit: 2_000_000 })),
        error => error.receipt?.status === 0
    );
    assert.deepEqual(await balances(), initial);
    await revertDetails(
        () => executor.runTaxSimulationWithDex.staticCall(settings, [], 100, 0, []), executor, "TaxSimulationOnlySelf"
    );

    const fractional = { ...settings, testSellBps: 3333 };
    const fractionalReport = await revertDetails(
        () => executor.simulateTaxWithDex.staticCall(fractional, [], 7, 0, []), executor, "TaxReport"
    );
    assert.deepEqual(
        Array.from(fractionalReport),
        [7n, 70n, 67n, 22n, 22n, 21n, 45n, 46n, 43n, 1n, marketAddress, 0n]
    );
    await mine(executor.setSettingsAndDex({ ...fractional, checkBurn: true, maxBurnBps: 1000 }, [], 400, 0, []));
    const fractionalDeadline = await expiry(ctx.chain);
    const fractionalEpoch = await executor.triggerEpoch();
    const smallSellLoss = await revertDetails(
        () => executor.buy.staticCall(7, 1, fractionalDeadline, fractionalEpoch), executor, "SellLossLimitExceeded"
    );
    assert.deepEqual(Array.from(smallSellLoss), [22n, 21n]);

    const guarded = { ...settings, checkBurn: true, maxBurnBps: 500, minBuyAmount: 900 };
    await mine(executor.setSettingsAndDex(guarded, [], 500, 0, []));
    let epoch = await executor.triggerEpoch();
    let deadline = await expiry(ctx.chain);
    const burn = await revertDetails(() => executor.buy.staticCall(100, 0, deadline, epoch), executor, "BurnLimitExceeded");
    assert.deepEqual(Array.from(burn), [900n, 813n]);
    assert.deepEqual(await balances(), initial);
    assert.equal(await executor.executed(), false);

    await mine(executor.setSettingsAndDex({ ...guarded, maxBurnBps: 1000 }, [], 500, 0, []));
    epoch = await executor.triggerEpoch();
    deadline = await expiry(ctx.chain);
    const receipt = await mine(executor.buy(100, 0, deadline, epoch));
    const bought = boughtEvent(receipt, executor);
    assert.deepEqual([bought.bought, bought.received, bought.testInputRecovered], [950n, 813n, 91n]);
    assert.deepEqual(await balances(), [9991n, 0n, 813n, 100009n, 999091n, 0n, 0n]);
});
