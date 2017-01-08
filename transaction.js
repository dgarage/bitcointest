const { Parser, Serializer, SZ_HEX8, SZ_HEX16, SZ_HEX32, SZ_HEX64, SZ_HEX256 } = require('./parser');

const Transaction = function(hex, isParser = false) {
    if (isParser) {
        hex.pushStorageContext();
        this.decode(hex);
        this.hex = hex.popStorageContext();
    } else {
        this.hex = hex;
        this.decode(new Parser(hex));
    }
};

Transaction.prototype = {
    decode(p = null) {
        if (!p) p = new Parser(this.hex);
        this.version = p.nextInt(SZ_HEX32);
        const vins = p.nextVarInt();
        const vin = this.vin = [];
        for (let i = 0; i < vins; i++) {
            // outpoint
            const v = {};
            v.prevout = {
                hash: p.next(SZ_HEX256),
            };
            v.prevout.n = p.nextInt(SZ_HEX32);
            const scriptlen = p.nextVarInt();
            v.scriptSig = p.next(scriptlen * 2);
            v.sequence = p.nextInt(SZ_HEX32);
            vin.push(v);
        }
        const vouts = p.nextVarInt();
        const vout = this.vout = [];
        for (let i = 0; i < vouts; i++) {
            const v = {};
            v.amount = p.nextInt(SZ_HEX64);
            const scriptlen = p.nextVarInt();
            v.scriptPubKey = p.next(scriptlen * 2);
            vout.push(v);
        }
        this.lockTime = p.nextInt(SZ_HEX32);
    },
    encode(s = null) {
        if (!s) s = new Serializer();
        s.writeInt(SZ_HEX32, this.version);
        s.writeVarInt(this.vin.length);
        for (const v of this.vin) {
            s.write(v.prevout.hash);
            s.writeInt(SZ_HEX32, v.prevout.n);
            s.writeVarInt(v.scriptSig.length / 2);
            s.write(v.scriptSig);
            s.writeInt(SZ_HEX32, v.sequence);
        }
        s.writeVarInt(this.vout.length);
        for (const v of this.vout) {
            s.writeInt(SZ_HEX64, v.amount);
            s.writeVarInt(v.scriptPubKey.length / 2);
            s.write(v.scriptPubKey);
        }
        s.writeInt(SZ_HEX32, this.lockTime);
        return s.s;
    },
};

module.exports = Transaction;
