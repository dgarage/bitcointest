const { Parser, Serializer, SZ_HEX8, SZ_HEX16, SZ_HEX32, SZ_HEX64, SZ_HEX256 } = require('./parser');
const deasync = require('deasync');
const Transaction = require('./transaction');
const async = require('async');
let crypto = null; // loaded on demand, as some node.js installs do not have crypto

const BlockHeader = function(hex) {
    this.hex = hex;
    if (hex) this.decode();
};

BlockHeader.prototype = {
    decode(p) {
        if (!p) p = new Parser(this.hex);
        /* 000 */ this.version = p.nextInt(SZ_HEX32);   /* 004 */
        /* 004 */ this.prevBlock = p.next(SZ_HEX256);   /* 036 */
        /* 036 */ this.merkleRoot = p.next(SZ_HEX256);  /* 068 */
        /* 068 */ this.timestamp = p.nextInt(SZ_HEX32); /* 072 */
        /* 072 */ this.bits = p.nextInt(SZ_HEX32);      /* 076 */
        /* 076 */ this.nonce = p.nextInt(SZ_HEX32);     /* 080 */
    },
    encode(s) {
        if (!s) s = new Serializer();
        s.writeInt(SZ_HEX32, this.version);
        s.write(this.prevBlock);
        s.write(this.merkleRoot);
        s.writeInt(SZ_HEX32, this.timestamp);
        s.writeInt(SZ_HEX32, this.bits);
        s.writeInt(SZ_HEX32, this.nonce);
        return s.s;
    },
    fetchFromNode(node, blockhash, cb) {
        node.client.getBlock(blockhash, (err, info) => {
            if (err) return cb(err);
            const blockinfo = info.result;
            this.version = blockinfo.version;
            this.prevBlock = Parser.swapHex(blockinfo.previousblockhash);
            this.merkleRoot = Parser.swapHex(blockinfo.merkleroot);
            this.timestamp = blockinfo.time;
            this.bits = blockinfo.bits;
            this.nonce = blockinfo.nonce;
            this.tx = blockinfo.tx;
            cb(null, this);
        });
    },
    toBuffer() {
        this.hex = this.encode();
        return Buffer.from(this.hex, 'hex');
    },
};

BlockHeader.prototype.fetchFromNodeS = deasync(BlockHeader.prototype.fetchFromNode);

const Block = function(hex) {
    this.hex = hex;
    this.header = new BlockHeader();
    if (hex) this.decode();
};

Block.prototype = {
    decode() {
        let p = new Parser(this.hex);
        this.header.decode(p);
        const txs = p.nextVarInt();
        const vtx = this.vtx = [];
        for (let i = 0; i < txs; i++) {
            vtx.push(new Transaction(p, true));
        }
    },
    encode() {
        let s = new Serializer();
        this.header.encode(s);
        s.writeVarInt(this.vtx.length);
        for (const tx of this.vtx) {
            tx.encode(s);
        }
        return s.s;
    },
    fetchFromNode(node, blockhash, cb) {
        this.header.fetchFromNode(node, blockhash, (err) => {
            if (err) return cb(err);
            const vtxid = this.header.tx;
            const vtx = this.vtx = [];
            async.eachSeries(
                vtxid,
                (txid, eachSeriesCB) => {
                    node.client.getRawTransaction(txid, (err2, info2) => {
                        if (err2) return eachSeriesCB(err2);
                        vtx.push(new Transaction(info2.result));
                        eachSeriesCB();
                    });
                },
                (esErr) => {
                    cb(esErr, this);
                }
            );
        });
    },
};

Block.prototype.fetchFromNodeS = deasync(Block.prototype.fetchFromNode);

const setNonceInBuffer = function(buf, nonce) {
    buf.writeInt32LE(nonce, 76);
};

const setTimeInBuffer = function(buf, time) {
    buf.writeInt32LE(time, 68);
};

const cmpbufs = (a, b) => {
    for (let i = 31; i >= 0; i--) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return 0;
};

const hash256 = function(buf) {
    if (!crypto) crypto = require('crypto');
    const c1 = crypto.createHash('sha256');
    c1.update(buf);
    const d1 = c1.digest();
    const c2 = crypto.createHash('sha256');
    c2.update(d1);
    return c2.digest();
};

Block.getHashForBuffer = function(buf) {
    return hash256(buf);
};

Block.performPoW = function(buf, tgtbuf, timeout = 600000) {
    if (!crypto) crypto = require('crypto');
    const expiry = new Date().getTime() + timeout;
    const targetValueString = tgtbuf.toString('hex');
    let nonce = 0;
    let iters = 0;
    let noncePoint = nonce;
    const start = Math.trunc(new Date().getTime() / 1000);
    let time = start;
    setNonceInBuffer(buf, nonce);
    setTimeInBuffer(buf, time);
    console.log(`Starting time=${time}, nonce=${nonce}`);
    console.log(`Timeout = ${timeout/60000} minutes`);
    console.log(`PoW with target = ${targetValueString}`);
    console.log('Depending on the difficulty, this may take awhile...');
    let progressIter = 0;
    let hash = hash256(buf);
    let lowest = hash;
    while (expiry > new Date().getTime() && cmpbufs(hash, tgtbuf) >= 0) {
        progressIter++;
        if (cmpbufs(hash, lowest) < 0) {
            lowest = hash;
            console.log(`Progress after ${progressIter} iterations:`);
            progressIter = 0;
            console.log(`- lowest value -> ${hash.toString('hex')} [${nonce}]`);
            console.log(`- target value -> ${targetValueString}`);
        }
        nonce++;
        setNonceInBuffer(buf, nonce);
        iters++;
        if (nonce === noncePoint) {
            time++;
            setTimeInBuffer(buf, time);
            console.log(`- iterated over all nonce values; updating time -> ${time}`);
        }
        if (iters % 1000000 == 0) {
            const now = Math.trunc(new Date().getTime() / 1000);
            const hps = iters / (now-start);
            console.log(`- ${iters} iters [${nonce}] -- ${hps} h/s`);
        }
        hash = hash256(buf);
    }
    if (cmpbufs(hash, tgtbuf) < 0) {
        console.log(`*** solved POW with nonce=${nonce}, time=${time} -> hash=${hash.toString('hex')} ***`);
    } else {
        console.log('timed out trying to solve POW');
    }
    return {
        hash, buf, nonce, time
    };
};


module.exports = {
    Block,
    BlockHeader,
};
