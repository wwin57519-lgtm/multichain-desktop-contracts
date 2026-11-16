const assert = require("node:assert/strict");
const { before, test } = require("node:test");
const ganache = require("ganache");
const { BrowserProvider, ContractFactory, ZeroAddress } = require("ethers");
const { compile } = require("../scripts/compile.cjs");

const CHAIN_ID = 31337;
const GAS_LIMIT = 1_000_000n;
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

async function fixture(t) {
    const chain = ganache.provider({
        chain: { chainId: CHAIN_ID, hardfork: "shanghai" },
        logging: { quiet: true },
        wallet: { deterministic: true, totalAccounts: 4 }
    });
    t.after(() => chain.disconnect());
    const provider = new BrowserProvider(chain, CHAIN_ID, { cacheTimeout: -1 });
    const [owner, watcher, outsider] = await Promise.all(
        [0, 1, 2].map((index) => provider.getSigner(index))
    );
    const recipient = await (await provider.getSigner(3)).getAddress();
    const wrapped = await deploy("CoreMockWrappedNative", owner);
    const input = await deploy("CoreMockAsset", owner);
    const output = await deploy("CoreMockAsset", owner);
    const router = await deploy("CoreMockRouter", owner);
    const routerAddress = await router.getAddress();
    const executor = await deploy(
        "CoreMockExecutor", owner, await owner.getAddress(), await wrapped.getAddress(), routerAddress
    );
    const executorAddress = await executor.getAddress();
    return {
        chain, provider, owner, watcher, outsider, recipient, wrapped, input, output, router,
        routerAddress, executor, executorAddress
    };
}

async function latestTime(chain) {
    const block = await chain.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    return BigInt(block.timestamp);
}

async function advanceTime(chain, seconds) {
    await chain.request({ method: "evm_increaseTime", params: [seconds] });
    await chain.request({ method: "evm_mine", params: [] });
}

async function expectRevert(action, contract, name) {
    let args;
    await assert.rejects(action, (error) => {
        assert.equal(error.code, "CALL_EXCEPTION");
        const decoded = contract.interface.parseError(error.data);
        assert.equal(decoded?.name, name);
        args = decoded.args;
        return true;
    });
    return args;
}

async function expectFailedTransaction(transaction) {
    await assert.rejects(async () => mine(transaction), (error) => {
        assert.equal(error.code, "CALL_EXCEPTION");
        assert.equal(error.receipt?.status, 0);
        return true;
    });
}

async function save(ctx, minimum = 1n) {
    const [input, output] = await Promise.all([ctx.input.getAddress(), ctx.output.getAddress()]);
    await mine(ctx.executor.save(input, output, ctx.recipient, minimum, 750));
}

async function fund(ctx, inputAmount = 100n) {
    await mine(ctx.input.mint(ctx.executorAddress, inputAmount));
    await mine(ctx.output.mint(ctx.routerAddress, 10_000n));
}

async function authorize(ctx, allowed = true) {
    await mine(ctx.executor.setTriggerWallets([await ctx.watcher.getAddress()], allowed));
}

async function arm(ctx, amount = 20n, slippage = 10_000, wait = 0) {
    const now = await latestTime(ctx.chain);
    const notBefore = wait ? now + BigInt(wait) : 0n;
    const expiresAt = now + 600n;
    await mine(ctx.executor.armTrigger(amount, slippage, notBefore, expiresAt));
    return ctx.executor.triggerEpoch();
}

async function tradeBalances(ctx) {
    const [executorInput, routerInput, recipientOutput, routerOutput, allowance] = await Promise.all([
        ctx.input.balanceOf(ctx.executorAddress),
        ctx.input.balanceOf(ctx.routerAddress),
        ctx.output.balanceOf(ctx.recipient),
        ctx.output.balanceOf(ctx.routerAddress),
        ctx.input.allowance(ctx.executorAddress, ctx.routerAddress)
    ]);
    return { executorInput, routerInput, recipientOutput, routerOutput, allowance };
}

function findEvent(receipt, contract, name) {
    for (const log of receipt.logs) {
        const decoded = contract.interface.parseLog(log);
        if (decoded?.name === name) return decoded.args;
    }
    assert.fail("Expected event " + name);
}

test("only the owner can change an executor policy, buy, or recover funds", async (t) => {
    const ctx = await fixture(t);
    const { executor, owner, outsider, recipient, input, output } = ctx;
    assert.equal(await executor.owner(), await owner.getAddress());
    assert.equal(await executor.networkChainId(), BigInt(CHAIN_ID));
    assert.equal(await executor.wrappedNative(), await ctx.wrapped.getAddress());

    const epoch = await executor.triggerEpoch();
    const until = await latestTime(ctx.chain) + 600n;
    const inputAddress = await input.getAddress();
    const outputAddress = await output.getAddress();
    const other = executor.connect(outsider);

    const attempts = [
        () => other.save.staticCall(inputAddress, outputAddress, recipient, 0, 750),
        () => other.setTriggerWallets.staticCall([recipient], true),
        () => other.armTrigger.staticCall(20, 500, 0, until),
        () => other.disarmTrigger.staticCall(),
        () => other.buy.staticCall(20, 1, until, epoch),
        () => other.withdrawToken.staticCall(inputAddress, recipient, 1),
        () => other.withdrawNative.staticCall(recipient, 1)
    ];
    for (const call of attempts) await expectRevert(call, executor, "NotOwner");
    await expectRevert(() => other.trigger.staticCall(epoch), executor, "NotTriggerWallet");
    await expectRevert(() => executor.armTrigger.staticCall(20, 500, 0, until), executor, "NotConfigured");
    await expectRevert(() => executor.buy.staticCall(20, 1, until, epoch), executor, "NotConfigured");

    const factory = new ContractFactory(artifacts.CoreMockExecutor.abi, artifacts.CoreMockExecutor.bytecode, owner);
    const invalid = await factory.getDeployTransaction(ZeroAddress, await ctx.wrapped.getAddress(), ctx.routerAddress);
    await expectRevert(() => ctx.provider.call(invalid), executor, "InvalidConfiguration");
});

test("a permitted wallet can trigger only once and only within the armed time window", async (t) => {
    const ctx = await fixture(t);
    const { executor, watcher, outsider } = ctx;
    await save(ctx);
    await fund(ctx);
    await authorize(ctx);

    const epoch = await arm(ctx, 20n, 10_000, 120);
    const policy = await executor.getTriggerPolicy();
    assert.equal(policy.amountIn, 20n);
    assert.equal(policy.slippageBps, 10_000n);
    assert.ok(policy.notBefore > await latestTime(ctx.chain));
    assert.ok(policy.expiresAt > policy.notBefore);
    await expectRevert(() => executor.connect(watcher).trigger.staticCall(epoch), executor, "TriggerTooEarly");
    await expectRevert(() => executor.connect(outsider).trigger.staticCall(epoch), executor, "NotTriggerWallet");

    await advanceTime(ctx.chain, 121);
    const receipt = await mine(executor.connect(watcher).trigger(epoch));
    const triggered = findEvent(receipt, executor, "TriggerExecuted");
    assert.equal(triggered.wallet, await watcher.getAddress());
    assert.equal(triggered.epoch, epoch);
    assert.deepEqual(await tradeBalances(ctx), {
        executorInput: 80n, routerInput: 20n, recipientOutput: 60n, routerOutput: 9_940n, allowance: 0n
    });
    assert.equal(await executor.triggerArmed(), false);
    assert.equal(await executor.executed(), true);
    await expectRevert(() => executor.connect(watcher).trigger.staticCall(epoch), executor, "AlreadyExecuted");
    await expectRevert(
        () => executor.armTrigger.staticCall(20, 10_000, 0, policy.expiresAt), executor, "AlreadyExecuted"
    );

    await save(ctx);
    const expiringEpoch = await arm(ctx);
    await advanceTime(ctx.chain, 601);
    await expectRevert(() => executor.connect(watcher).trigger.staticCall(expiringEpoch), executor, "Expired");
});

test("minimum failure rolls back transfers and leaves the same authorized round retryable", async (t) => {
    const ctx = await fixture(t);
    const { executor, watcher, router } = ctx;
    await save(ctx, 29n);
    await fund(ctx);
    await authorize(ctx);
    await mine(router.setRates(3, 2));

    const epoch = await arm(ctx, 10n);
    const balances = await tradeBalances(ctx);
    const caller = executor.connect(watcher);
    const failure = await expectRevert(() => caller.trigger.staticCall(epoch), executor, "MinimumNotMet");
    assert.deepEqual(Array.from(failure), [20n, 29n]);
    await expectFailedTransaction(caller.trigger(epoch, { gasLimit: GAS_LIMIT }));
    assert.deepEqual(await tradeBalances(ctx), balances);
    assert.equal(await executor.triggerEpoch(), epoch);
    assert.equal(await executor.executed(), false);
    assert.equal(await executor.triggerArmed(), true);

    await mine(router.setRates(3, 3));
    const receipt = await mine(caller.trigger(epoch));
    const bought = findEvent(receipt, executor, "Bought");
    assert.equal(bought.bought, 30n);
    assert.equal(bought.received, 30n);
    assert.deepEqual(await tradeBalances(ctx), {
        executorInput: 90n, routerInput: 10n, recipientOutput: 30n, routerOutput: 9_970n, allowance: 0n
    });
});

test("an absolute minimum cannot be replaced with a caller-supplied price floor", async (t) => {
    const ctx = await fixture(t);
    const { executor, watcher } = ctx;
    await save(ctx, 25n);
    await fund(ctx);
    await authorize(ctx);

    const now = await latestTime(ctx.chain);
    await expectRevert(() => executor.armTrigger.staticCall(10, 100, 0, now + 600n), executor, "InvalidTriggerPolicy");
    const epoch = await arm(ctx, 10n, 10_000);
    await expectRevert(() => executor.buy.staticCall(10, 1, now + 600n, epoch), executor, "InvalidPriceProtection");
    await expectRevert(() => executor.buy.staticCall(10, 0, now - 1n, epoch), executor, "Expired");
    const belowMinimum = await expectRevert(
        () => executor.buy.staticCall(8, 0, now + 600n, epoch), executor, "MinimumNotMet"
    );
    assert.deepEqual(Array.from(belowMinimum), [24n, 25n]);

    await mine(executor.buy(10, 0, now + 600n, epoch));
    assert.equal(await executor.executed(), true);
    assert.equal(await executor.triggerArmed(), false);
    assert.equal(await ctx.output.balanceOf(ctx.recipient), 30n);
    await expectRevert(() => executor.connect(watcher).trigger.staticCall(epoch), executor, "AlreadyExecuted");
});

test("policy changes, authorization changes and withdrawals invalidate the old epoch", async (t) => {
    const ctx = await fixture(t);
    const { executor, watcher, input, recipient } = ctx;
    await save(ctx);
    await fund(ctx);
    await authorize(ctx);
    const caller = executor.connect(watcher);

    const changes = [
        () => mine(executor.disarmTrigger()),
        () => authorize(ctx),
        () => save(ctx),
        async () => mine(executor.withdrawToken(await input.getAddress(), recipient, 1n))
    ];

    for (const change of changes) {
        const epoch = await arm(ctx);
        await change();
        const next = await executor.triggerEpoch();
        assert.ok(next > epoch);
        assert.equal(await executor.triggerArmed(), false);
        assert.deepEqual(Array.from(await executor.getTriggerPolicy()), [0n, 0n, 0n, 0n]);
        await expectRevert(() => caller.trigger.staticCall(epoch), executor, "StaleTriggerEpoch");
        await expectRevert(() => caller.trigger.staticCall(next), executor, "TriggerNotArmed");
    }

    const revokedEpoch = await arm(ctx);
    await authorize(ctx, false);
    assert.equal(await executor.isTriggerWallet(await watcher.getAddress()), false);
    await expectRevert(() => caller.trigger.staticCall(revokedEpoch), executor, "NotTriggerWallet");

    await authorize(ctx);
    const fixedAmountEpoch = await arm(ctx);
    await mine(caller.trigger(fixedAmountEpoch));
    assert.equal(await input.balanceOf(ctx.executorAddress), 79n);
    assert.equal(await ctx.output.balanceOf(recipient), 60n);
});

test("automatic execution requires a nonzero amount and an absolute recipient floor", async (t) => {
    const ctx = await fixture(t);
    const { executor } = ctx;
    const expiry = await latestTime(ctx.chain) + 600n;
    await save(ctx, 0n);
    await expectRevert(
        () => executor.armTrigger.staticCall(10n, 10_000, 0, expiry), executor, "InvalidTriggerPolicy"
    );
    await save(ctx, 25n);
    const epoch = await executor.triggerEpoch();
    await expectRevert(
        () => executor.armTrigger.staticCall(0n, 10_000, 0, expiry), executor, "InvalidTriggerPolicy"
    );
    assert.equal(await executor.triggerEpoch(), epoch);
    assert.equal(await executor.triggerArmed(), false);
});

test("native deposits wrap value and a failed recovery leaves both balances intact", async (t) => {
    const ctx = await fixture(t);
    const { executor, executorAddress, owner, wrapped, recipient, provider } = ctx;
    const deposit = await mine(executor.depositNative({ value: 35n }));
    assert.equal(findEvent(deposit, executor, "NativeDeposited").amount, 35n);
    assert.equal(await wrapped.balanceOf(executorAddress), 35n);
    assert.equal(await provider.getBalance(executorAddress), 0n);
    await mine(owner.sendTransaction({ to: executorAddress, value: 5n }));

    const rejecting = await deploy("CoreMockRejectingRecipient", owner);
    const rejectingAddress = await rejecting.getAddress();
    const epoch = await executor.triggerEpoch();
    await expectRevert(
        () => executor.withdrawNative.staticCall(rejectingAddress, 10n), executor, "NativeTransferFailed"
    );
    await expectFailedTransaction(executor.withdrawNative(rejectingAddress, 10n, { gasLimit: GAS_LIMIT }));
    assert.equal(await wrapped.balanceOf(executorAddress), 35n);
    assert.equal(await provider.getBalance(executorAddress), 5n);
    assert.equal(await executor.triggerEpoch(), epoch);

    const recipientBefore = await provider.getBalance(recipient);
    const partial = await mine(executor.withdrawNative(recipient, 10n));
    const event = findEvent(partial, executor, "Withdrawn");
    assert.equal(event.token, ZeroAddress);
    assert.equal(event.to, recipient);
    assert.equal(event.amount, 10n);
    assert.equal(await wrapped.balanceOf(executorAddress), 30n);
    assert.equal(await provider.getBalance(executorAddress), 0n);
    assert.equal(await provider.getBalance(recipient), recipientBefore + 10n);

    await mine(executor.withdrawNative(recipient, 0n));
    assert.equal(await wrapped.balanceOf(executorAddress), 0n);
    assert.equal(await provider.getBalance(recipient), recipientBefore + 40n);
});

test("explicit ERC-20 withdrawals still work when the token cannot report a balance", async (t) => {
    const ctx = await fixture(t);
    const { executor, input, recipient, executorAddress } = ctx;
    const token = await input.getAddress();
    await mine(input.mint(executorAddress, 50n));
    await mine(input.disableBalanceQueries(true));

    const unavailable = await expectRevert(
        () => executor.withdrawToken.staticCall(token, recipient, 0n), executor, "TokenOperationFailed"
    );
    assert.equal(unavailable.token, token);
    await mine(executor.withdrawToken(token, recipient, 19n));
    await mine(input.disableBalanceQueries(false));
    assert.equal(await input.balanceOf(executorAddress), 31n);
    assert.equal(await input.balanceOf(recipient), 19n);

    await mine(executor.withdrawToken(token, recipient, 0n));
    assert.equal(await input.balanceOf(executorAddress), 0n);
    assert.equal(await input.balanceOf(recipient), 50n);
});

test("the shared tax report encodes observed output and a reverted attempt moves no funds", async (t) => {
    const ctx = await fixture(t);
    const { executor, outsider, routerAddress } = ctx;
    await save(ctx, 0n);
    await fund(ctx);
    const before = await tradeBalances(ctx);

    await expectRevert(
        () => executor.connect(outsider).sampleTaxReport.staticCall(10n), executor, "NotOwner"
    );
    const report = await expectRevert(() => executor.sampleTaxReport.staticCall(10n), executor, "TaxReport");
    assert.deepEqual(Array.from(report), [10n, 30n, 30n, 0n, 0n, 0n, 30n, 30n, 30n, 1n, routerAddress, 0n]);
    await expectFailedTransaction(executor.sampleTaxReport(10n, { gasLimit: GAS_LIMIT }));
    assert.deepEqual(await tradeBalances(ctx), before);
    assert.equal(await executor.executed(), false);
});
