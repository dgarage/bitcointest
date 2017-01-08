const SZ_HEX8   = 2;
const SZ_HEX16  = 4;
const SZ_HEX32  = 8;
const SZ_HEX64  = 16;
const SZ_HEX256 = 64;

function hexSwapEndian(s) {
    let v = '';
    for (let i = s.length - 2; i >= 0; i -= 2) {
        v += s.substr(i, 2);
    }
    return v;
}

const Parser = function(s) {
    this.s = s;
    this.i = 0;
    this.l = s.length;
    this.storageContexts = [];
};

Parser.swapIntEndian = (sz, i) => {
    let s = ('000000000000000' + i.toString(16));
    s = s.substr(s.length - (2 * sz));
    return Number.parseInt(hexSwapEndian(s), 16);
};

Parser.swapHex = (s) => hexSwapEndian(s);

Parser.prototype = {
    next(count, hexSwap = false) {
        const ss = this.s.substr(this.i, count);
        this.i += count;
        return hexSwap && count > 2 ? hexSwapEndian(ss) : ss;
    },
    nextInt(sz) {
        return Number.parseInt(this.next(sz, true), 16);
    },
    nextVarInt() {
        const b1 = this.nextInt(SZ_HEX8);
        if (b1 < 0xfd) return b1;
        return this.nextInt(6 + 4 * [0xfd, 0xfe, 0x00, 0xff].indexOf(b1));
    },
    pushStorageContext() {
        this.storageContexts.push(this.i);
    },
    popStorageContext() {
        const ss = this.s.substring(this.storageContexts[this.storageContexts.length-1], this.i);
        this.storageContexts.pop();
        return ss;
    },
};

const Serializer = function() {
    this.s = '';
};

Serializer.prototype = {
    write(hex, hexSwap = false) {
        this.s += hexSwap && hex.length > 2 ? hexSwapEndian(hex) : hex;
    },
    writeInt(sz, i) {
        const v = ('0000000000000000000000000' + i.toString(16));
        const w = v.substr(v.length - sz);
        this.write(w, true);
    },
    writeVarInt(i) {
        if (i < 0xfd) return this.writeInt(2, i);
        let [prefix, sz] = [0xff, SZ_HEX64];
        if (i <= 0xffff) [prefix, sz] = [0xfd, SZ_HEX16];
        else if (i <= 0xffffffff) [prefix, sz] = [0xfe, SZ_HEX32];
        this.write(prefix);
        this.writeInt(sz, i);
    },
};

module.exports = {
    Parser,
    Serializer,
    SZ_HEX8,
    SZ_HEX16,
    SZ_HEX32,
    SZ_HEX64,
    SZ_HEX256,
};
