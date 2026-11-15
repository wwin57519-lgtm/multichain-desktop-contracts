const assert = require("node:assert/strict");
const references = require("../test/fixtures/desktop-abi.json");

function type(parameter) {
    if (!parameter.type.startsWith("tuple")) return parameter.type;
    return "(" + parameter.components.map(type).join(",") + ")" + parameter.type.slice(5);
}

function key(entry) {
    if (!entry.name) return entry.type;
    return entry.type + " " + entry.name + "(" + (entry.inputs || []).map(type).join(",") + ")";
}

function field(parameter, tupleMember = false) {
    const result = { type: parameter.type };
    if (tupleMember) result.name = parameter.name;
    if (typeof parameter.indexed === "boolean") result.indexed = parameter.indexed;
    if (parameter.components) result.components = parameter.components.map(component => field(component, true));
    return result;
}

function layout(entry) {
    return {
        stateMutability: entry.stateMutability,
        anonymous: entry.anonymous,
        inputs: (entry.inputs || []).map(parameter => field(parameter)),
        outputs: (entry.outputs || []).map(parameter => field(parameter))
    };
}

function check(name, actual) {
    const indexed = new Map(actual.map(entry => [key(entry), entry]));
    for (const [signature, expected] of new Map(references[name].map(entry => [key(entry), entry]))) {
        assert.ok(indexed.has(signature), name + " missing " + signature);
        assert.deepEqual(layout(indexed.get(signature)), layout(expected), name + " changed " + signature);
    }
    return new Set(references[name].map(key)).size;
}

if (require.main === module) {
    for (const name of Object.keys(references)) {
        const rebuilt = require("../artifacts/" + name + ".json");
        console.log(name + ": " + check(name, rebuilt.abi) + " desktop ABI entries matched");
    }
}

module.exports = { check };
