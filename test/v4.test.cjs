const assert = require("node:assert/strict");
const { before, test } = require("node:test");
const ganache = require("ganache");
const { AbiCoder, BrowserProvider, Contract, ContractFactory, getAddress, keccak256, toBeHex, ZeroAddress, ZeroHash } =
    require("ethers");
const { compile } = require("../scripts/compile.cjs");
const { check } = require("../scripts/check-client-abi.cjs");

const CHAIN_ID = 8453;
const WRAPPED = "0x4200000000000000000000000000000000000006";
const BASE_ENDPOINTS = [
    "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
    "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "0x238a358808379702088667322f80aC48bAd5e6c4",
    "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
    "0xC697d2898e0D09264376196696c51D7aBbbAA4a9",
    "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB",
    "0xd0737C9762912dD34c3271197E362Aa736Df0926",
    "0xC631f4B0Fc2Dd68AD45f74B2942628db117dD359",
    "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768"
];
const UNI_KEY = "tuple(address,address,uint24,int24,address)";
const INFINITY_KEY = "tuple(address,address,address,address,uint24,bytes32)";
const coder = AbiCoder.defaultAbiCoder();
let artifacts;

before(() => {
    artifacts = compile({ includeMocks: true });
});

async function mine(transaction) {
    return (await transaction).wait();
}

async function deploy(name, signer, ...args) {
    const artifact = artifacts[name];
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function fixture(t, outputName = "CoreMockAsset") {
    const chain = ganache.provider({
        chain: { chainId: CHAIN_ID, hardfork: "shanghai" },
        logging: { quiet: true },
        wallet: { deterministic: true, totalAccounts: 3 }
    });
    t.after(() => chain.disconnect());
    const provider = new BrowserProvider(chain, CHAIN_ID, { cacheTimeout: -1 });
    const owner = await provider.getSigner(0);
    const recipient = await (await provider.getSigner(1)).getAddress();
    const other = await provider.getSigner(2);
    async function install(address, name) {
        const code = name ? artifacts[name].deployedBytecode : "0x60006000f3";
        await chain.request({ method: "evm_setAccountCode", params: [address, code] });
        return name && new Contract(address, artifacts[name].abi, owner);
    }

    await install(WRAPPED, "CoreMockWrappedNative");
    for (const i of [0, 3, 5, 6, 7]) await install(BASE_ENDPOINTS[i]);
    for (const i of [2, 9, 10]) await install(BASE_ENDPOINTS[i], "V4MockQuoter");
    const uniPermit2 = await install(BASE_ENDPOINTS[4], "V4MockPermit2");
    const infPermit2 = await install(BASE_ENDPOINTS[11], "V4MockPermit2");
    const uniRouter = await install(BASE_ENDPOINTS[1], "V4MockUniversalRouter");
    const infRouter = await install(BASE_ENDPOINTS[8], "V4MockUniversalRouter");
    await mine(uniRouter.configure(BASE_ENDPOINTS[4], false));
    await mine(infRouter.configure(BASE_ENDPOINTS[11], true));

    const executor = await deploy("V4SwapExecutor", owner, await owner.getAddress());
    const helper = new Contract(await executor.quoteHelper(), artifacts.V4QuoteHelper.abi, owner);
    const wrapped = new Contract(WRAPPED, artifacts.CoreMockWrappedNative.abi, owner);
    const input = await deploy("CoreMockAsset", owner);
    const output = await deploy(outputName, owner);
    const executorAddress = await executor.getAddress();
    return {
        chain, provider, owner, other, recipient, executor, helper, executorAddress, wrapped, input, output,
        uniRouter, infRouter, uniPermit2, infPermit2
    };
}

function pool(kind, a, b, fee = 3000) {
    const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const manager = BASE_ENDPOINTS[kind === 10 ? 0 : kind === 11 ? 6 : 7];
    const tickSpacing = kind === 12 ? 0 : 60;
    const parameters = kind === 10 ? ZeroHash : toBeHex(BigInt(kind === 12 ? 10 : tickSpacing) << 16n, 32);
    const key = kind === 10
        ? [currency0, currency1, fee, tickSpacing, ZeroAddress]
        : [currency0, currency1, ZeroAddress, manager, fee, parameters];
    const poolId = keccak256(coder.encode([kind === 10 ? UNI_KEY : INFINITY_KEY], [key]));
    return { kind, currency0, currency1, hooks: ZeroAddress, tickSpacing, fee, parameters, poolId };
}

function settings(ctx, tokenIn, tokenOut, overrides = {}) {
    return {
        tokenIn, tokenOut, recipient: ctx.recipient, priceMode: 0, minBuyAmount: 0, checkBurn: false,
        maxBurnBps: 2000, testSell: false, testSellBps: 0, ...overrides
    };
}

async function deadline(ctx) {
    const block = await ctx.chain.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    return BigInt(block.timestamp) + 600n;
}

async function expectError(call, contract, name) {
    let result;
    await assert.rejects(call, (error) => {
        assert.equal(error.code, "CALL_EXCEPTION");
        result = contract.interface.parseError(error.data);
        assert.equal(result?.name, name);
        return true;
    });
    return result.args;
}

async function assertApprovalsCleared(ctx, address, router, permit2, token) {
    assert.equal(await token.allowance(ctx.executorAddress, address), 0n);
    assert.equal((await permit2.allowance(ctx.executorAddress, await token.getAddress(), router)).amount, 0n);
}

test("V4 contracts retain the desktop ABI and validate fixed config, pool keys and locks", async (t) => {
    check("V4SwapExecutor", artifacts.V4SwapExecutor.abi);
    check("V4QuoteHelper", artifacts.V4QuoteHelper.abi);
    const ctx = await fixture(t);
    const [a, b] = await Promise.all([ctx.input.getAddress(), ctx.output.getAddress()]);
    const p0 = pool(10, a, b, 3000);
    const p1 = pool(10, a, b, 500);
    const wanted = settings(ctx, a, b);
    assert.equal(await ctx.helper.controller(), ctx.executorAddress);
    assert.deepEqual(Array.from(await ctx.helper.getV4Config()), BASE_ENDPOINTS.map(getAddress));
    await expectError(() => ctx.helper.connect(ctx.other).clearV4.staticCall(), ctx.helper, "V4OnlyController");
    await expectError(
        () => ctx.executor.setSettingsAndV4.staticCall(wanted, 100, 0, [{ ...p0, poolId: ZeroHash }], ZeroHash),
        ctx.executor, "InvalidV4Pool"
    );
    await mine(ctx.executor.setSettingsAndV4(wanted, 100, 0, [p0, p1], ZeroHash));
    const [best, routes] = await ctx.executor.quoteBest.staticCall(20);
    assert.equal(best.poolId, p1.poolId);
    assert.equal(best.candidateIndex, 1n);
    assert.deepEqual(routes.map(route => route.amountOut), [40n, 60n]);

    await mine(ctx.executor.setSettingsAndV4(wanted, 100, 0, [p0, p1], p0.poolId));
    const [locked, lockedRoutes] = await ctx.executor.quoteBest.staticCall(20);
    assert.equal(locked.poolId, p0.poolId);
    assert.deepEqual(lockedRoutes.map(route => route.amountOut), [40n, 0n]);
    await expectError(() => ctx.helper.encodeV4(1, p1.poolId, a, b, 20, 31), ctx.helper, "InvalidV4Pool");
    const [, , , , command, inputs] = await ctx.helper.encodeV4(0, p0.poolId, a, b, 20, 31);
    const [actions, params] = coder.decode(["bytes", "bytes[]"], inputs[0]);
    const [swap] = coder.decode([ "tuple(" + UNI_KEY + ",bool,uint128,uint128,uint256,bytes)" ], params[0]);
    assert.equal(command, "0x10");
    assert.equal(actions, "0x060c0f");
    assert.deepEqual(Array.from(swap).slice(1), [p0.currency0 === a, 20n, 31n, 0n, "0x"]);
});

test("Uniswap V4 and both Infinity pool types execute the selected adapter with cleared approvals", async (t) => {
    const ctx = await fixture(t);
    const [a, b] = await Promise.all([ctx.input.getAddress(), ctx.output.getAddress()]);
    await mine(ctx.input.mint(ctx.executorAddress, 70));
    await mine(ctx.output.mint(BASE_ENDPOINTS[1], 200));
    await mine(ctx.output.mint(BASE_ENDPOINTS[8], 200));

    for (const kind of [10, 11, 12]) {
        const venue = kind === 10 ? 0 : 2;
        const chosen = pool(kind, a, b);
        await mine(ctx.executor.setSettingsAndV4(settings(ctx, a, b), 100, venue, [chosen], chosen.poolId));
        const [route] = await ctx.executor.quoteBest.staticCall(20);
        assert.equal(route.kind, BigInt(kind));
        assert.equal(route.amountOut, 40n);
        const time = await deadline(ctx);
        const epoch = await ctx.executor.triggerEpoch();
        const expected = await ctx.executor.buy.staticCall(20, 39, time, epoch);
        assert.deepEqual(Array.from(expected), [40n, 40n, 0n]);
        await mine(ctx.executor.buy(20, 39, time, epoch));

        const router = kind === 10 ? ctx.uniRouter : ctx.infRouter;
        assert.equal(await router.lastActions(), kind === 12 ? "0x1c0c0f" : "0x060c0f");
        if (kind !== 10) {
            const [, , , , command, inputs] = await ctx.helper.encodeV4(0, chosen.poolId, a, b, 20, 39);
            const [actions, params] = coder.decode(["bytes", "bytes[]"], inputs[0]);
            const [swap] = coder.decode(["tuple(" + INFINITY_KEY + ",bool,uint128,uint128,bytes)"], params[0]);
            assert.equal(command, "0x10");
            assert.equal(actions, kind === 12 ? "0x1c0c0f" : "0x060c0f");
            assert.deepEqual(Array.from(swap).slice(1), [chosen.currency0 === a, 20n, 39n, "0x"]);
        }
        await assertApprovalsCleared(ctx, BASE_ENDPOINTS[4], BASE_ENDPOINTS[1], ctx.uniPermit2, ctx.input);
        await assertApprovalsCleared(ctx, BASE_ENDPOINTS[11], BASE_ENDPOINTS[8], ctx.infPermit2, ctx.input);
    }
    assert.equal(await ctx.output.balanceOf(ctx.recipient), 120n);
    assert.equal(await ctx.input.balanceOf(ctx.executorAddress), 10n);
});

test("tax sampling rolls back approvals and a taxed recipient must still meet the scaled minimum", async (t) => {
    const ctx = await fixture(t, "V4MockRecipientFeeAsset");
    const [a, b] = await Promise.all([ctx.input.getAddress(), ctx.output.getAddress()]);
    const chosen = pool(10, a, b);
    await mine(ctx.input.mint(ctx.executorAddress, 100));
    await mine(ctx.output.mint(BASE_ENDPOINTS[1], 1000));
    await mine(ctx.output.setRecipientFee(ctx.recipient, 2500));
    await mine(ctx.executor.setSettingsAndV4(settings(ctx, a, b, { testSell: true, testSellBps: 2500 }), 100, 0, [chosen], ZeroHash));
    const tax = await expectError(() => ctx.executor.simulateTaxSaved.staticCall(100, 2500), ctx.executor, "TaxReport");
    assert.deepEqual(Array.from(tax).slice(0, 9), [100n, 200n, 200n, 50n, 100n, 100n, 150n, 150n, 113n]);

    await assert.rejects(async () => mine(ctx.executor.simulateTaxSaved(100, 2500, { gasLimit: 3_000_000 })),
        (error) => error.receipt?.status === 0);
    await expectError(() => ctx.executor.runTaxSimulationSaved.staticCall(100, 2500), ctx.executor, "TaxSimulationOnlySelf");
    const time = await deadline(ctx);
    const epoch = await ctx.executor.triggerEpoch();
    const rejected = await expectError(() => ctx.executor.buy.staticCall(100, 180, time, epoch), ctx.executor, "MinimumNotMet");
    assert.deepEqual(Array.from(rejected), [113n, 135n]);
    await assert.rejects(async () => mine(ctx.executor.buy(100, 180, time, epoch, { gasLimit: 3_000_000 })),
        (error) => error.receipt?.status === 0);

    assert.equal(await ctx.executor.executed(), false);
    assert.equal(await ctx.input.balanceOf(ctx.executorAddress), 100n);
    assert.equal(await ctx.output.balanceOf(ctx.recipient), 0n);
    assert.equal(await ctx.output.balanceOf(BASE_ENDPOINTS[1]), 1000n);
    await assertApprovalsCleared(ctx, BASE_ENDPOINTS[4], BASE_ENDPOINTS[1], ctx.uniPermit2, ctx.input);
    await assertApprovalsCleared(ctx, BASE_ENDPOINTS[4], BASE_ENDPOINTS[1], ctx.uniPermit2, ctx.output);

    // A 37-unit loss on 150 exceeds 24.66%, even though the rounded retained quote is 113.
    const strict = settings(ctx, a, b, { checkBurn: true, maxBurnBps: 2466, testSellBps: 2500 });
    await mine(ctx.executor.setSettingsAndV4(strict, 100, 0, [chosen], ZeroHash));
    const strictEpoch = await ctx.executor.triggerEpoch();
    const loss = await expectError(
        () => ctx.executor.buy.staticCall(100, 1, time, strictEpoch), ctx.executor, "BurnLimitExceeded"
    );
    assert.deepEqual(Array.from(loss), [150n, 113n]);
});

test("native input uses exact value without router dust and native output is rewrapped", async (t) => {
    const ctx = await fixture(t);
    const other = await ctx.output.getAddress();
    const nativePool = pool(10, ZeroAddress, other);
    await mine(ctx.executor.depositNative({ value: 50 }));
    await mine(ctx.output.mint(BASE_ENDPOINTS[1], 1000));
    await mine(ctx.executor.setSettingsAndV4(settings(ctx, WRAPPED, other), 100, 0, [nativePool], ZeroHash));

    const time = await deadline(ctx);
    let epoch = await ctx.executor.triggerEpoch();
    await mine(ctx.uniRouter.setPartial(true));
    await expectError(() => ctx.executor.buy.staticCall(10, 1, time, epoch), ctx.executor, "UnexpectedBalance");
    assert.equal(await ctx.wrapped.balanceOf(ctx.executorAddress), 50n);
    assert.equal(await ctx.provider.getBalance(BASE_ENDPOINTS[1]), 0n);

    await mine(ctx.uniRouter.setPartial(false));
    await mine(ctx.executor.buy(10, 19, time, epoch));
    assert.equal(await ctx.wrapped.balanceOf(ctx.executorAddress), 40n);
    assert.equal(await ctx.output.balanceOf(ctx.recipient), 20n);
    assert.equal(await ctx.provider.getBalance(BASE_ENDPOINTS[1]), 0n);

    await mine(ctx.owner.sendTransaction({ to: BASE_ENDPOINTS[1], value: 100 }));
    await mine(ctx.output.mint(ctx.executorAddress, 10));
    await mine(ctx.executor.setSettingsAndV4(settings(ctx, other, WRAPPED), 100, 0, [nativePool], ZeroHash));
    epoch = await ctx.executor.triggerEpoch();
    await mine(ctx.executor.buy(10, 19, time, epoch));
    assert.equal(await ctx.wrapped.balanceOf(ctx.recipient), 20n);
    assert.equal(await ctx.provider.getBalance(ctx.executorAddress), 0n);
    await assertApprovalsCleared(ctx, BASE_ENDPOINTS[4], BASE_ENDPOINTS[1], ctx.uniPermit2, ctx.output);
});

test("automatic execution enforces the full net floor after a sell probe and token fees", async (t) => {
    const ctx = await fixture(t, "V4MockRecipientFeeAsset");
    const [input, output, triggerWallet] = await Promise.all([
        ctx.input.getAddress(), ctx.output.getAddress(), ctx.other.getAddress()
    ]);
    const chosen = pool(10, input, output);
    await mine(ctx.input.mint(ctx.executorAddress, 100));
    await mine(ctx.output.mint(BASE_ENDPOINTS[1], 1000));
    await mine(ctx.output.setRecipientFee(ctx.recipient, 2500));
    await mine(ctx.executor.setSettingsAndV4(
        settings(ctx, input, output, { priceMode: 1, minBuyAmount: 130n, testSell: true, testSellBps: 2500 }),
        100, 0, [chosen], chosen.poolId
    ));
    await mine(ctx.executor.setTriggerWallets([triggerWallet], true));
    await mine(ctx.executor.armTrigger(100n, 10_000, 0, await deadline(ctx)));
    const epoch = await ctx.executor.triggerEpoch();
    const caller = ctx.executor.connect(ctx.other);
    const failure = await expectError(() => caller.trigger.staticCall(epoch), ctx.executor, "MinimumNotMet");
    assert.deepEqual(Array.from(failure), [113n, 130n]);
    await assert.rejects(async () => mine(caller.trigger(epoch, { gasLimit: 3_000_000 })),
        (error) => error.receipt?.status === 0);
    assert.equal(await ctx.executor.triggerArmed(), true);
    assert.equal(await ctx.executor.triggerEpoch(), epoch);
    assert.equal(await ctx.input.balanceOf(ctx.executorAddress), 100n);
    assert.equal(await ctx.output.balanceOf(ctx.recipient), 0n);
    await assertApprovalsCleared(ctx, BASE_ENDPOINTS[4], BASE_ENDPOINTS[1], ctx.uniPermit2, ctx.input);
    await assertApprovalsCleared(ctx, BASE_ENDPOINTS[4], BASE_ENDPOINTS[1], ctx.uniPermit2, ctx.output);

    await mine(ctx.output.setRecipientFee(ctx.recipient, 0));
    await mine(caller.trigger(epoch));
    assert.equal(await ctx.output.balanceOf(ctx.recipient), 150n);
    assert.equal(await ctx.executor.executed(), true);
});
