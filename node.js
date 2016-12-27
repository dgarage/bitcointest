const bcrpc = require('bcrpc');
const async = require('async');
const assert = require('assert');
const remove = require('remove');
const mkdirp = require('mkdirp');
const { execFile } = require('child_process');
const Transaction = require('./transaction');

const deinfo = (cb) => (err, info) => cb(err, err ? null : info.result);

const Node = function(path, cfgpath, host, port, rpcport, user = 'user', pass = 'password', prot = 'http') {
    this.connections = [];
    this.path = path;
    this.cfgpath = cfgpath;
    this.host = host;
    this.port = port;
    this.rpcport = rpcport;
    this.user = user;
    this.pass = pass;
    this.prot = prot;
    this.client = new bcrpc({ host, port: rpcport, user, pass, prot });
};

Node.prototype = {
    baseargs() {
        return [
            '-regtest',
            `-datadir=${this.cfgpath}`,
            `-rpcuser=${this.user}`,
            `-rpcpassword=${this.pass}`,
            `-rpcport=${this.rpcport}`,
        ];
    },
    bitcoindargs() {
        const result = this.baseargs();
        return result.concat([
            `-port=${this.port}`,
            '-server=1',
            '-listen=1',
            '-blockprioritysize=50000',
        ]);
    },
    start(cb) {
        assert(!this.bitcoindproc);
        this.running = true;
        remove(this.cfgpath, () => {
            mkdirp(this.cfgpath, (err) => {
                if (err) return cb ? cb(err) : null;
                this.bitcoindproc = execFile(`${this.path}/bitcoind`, this.bitcoindargs(), (err, sout, serr) => {
                    this.running = false;
                    this.bitcoindproc = null;
                    // console.log(`${this.port} bitcoind instance finished with out:\n${sout}\nerr:\n${serr}`);
                });
                if (cb) cb(null);
            });
        });
    },
    stop() {
        assert(this.bitcoindproc);
        this.bitcoindproc.kill();
    },
    /**
     * Wait for this node to finish starting up so it can take commands via
     * the RPC interface.
     * The timeout is rather high (10 seconds) because nodes seem to take 
     * up to 6 seconds to start up in some situations.
     * TODO: investigate the reason for long startup times
     */
    waitUntilReady(timeout, mcb) {
        if (!mcb) { mcb = timeout; timeout = 10000; }
        let waitForBitcoind = true;
        let connFailurePrint = true;
        let syncPrint = true;
        let blockIndexPrint = true;
        let error = null;
        const expiry = new Date().getTime() + timeout;
        async.whilst(
            () => waitForBitcoind && expiry > new Date().getTime(),
            (cb) => {
                this.client.getInfo((err, gbt) => {
                    error = err;
                    if (err) {
                        if (!gbt || (err.code && err.code === -9)) {
                            // ECONNREFUSED, err === {} && !gbt
                            // err.code === -9 for a split second during bitcoind startup
                            if (connFailurePrint) {
                                if (err.message === 'bitcoin JSON-RPC connection rejected: 401 unauthorized') {
                                    waitForBitcoind = false;
                                    cb('404 unauthorized');
                                    return;
                                }
                                connFailurePrint = false;
                            }
                            setTimeout(cb, 200);
                        } else if (err.code && err.code === -10) {
                            // getBlockTemplate returns error code -10 while "Bitcoin is downloading blocks..."
                            if (syncPrint) {
                                console.log('bitcoind is syncing blocks ... waiting for completion');
                                syncPrint = false;
                            }
                            setTimeout(cb, 1000);
                        } else if (err.code && err.code === -28) {
                            // loading block index
                            if (blockIndexPrint) {
                                console.log('bitcoind is loading block index ... waiting for completion');
                                blockIndexPrint = false;
                            }
                            setTimeout(cb, 300);
                        } else {
                            // FATAL: unknown other error
                            waitForBitcoind = false;
                            cb(`unknown bitcoind error; make sure node is configured: client=${this.client}, port=${this.port}, rpcport=${this.rpcport}`);
                        }
                    } else {
                        waitForBitcoind = false;
                        cb();
                    }
                });
            },
            () => {
                if (waitForBitcoind) {
                    // expired
                    return mcb('timeout');
                }
                mcb();
            }
        );
    },
    getBalance(cb) {
        this.client.getBalance(deinfo(cb));
    },
    waitForBalanceChange(oldBalance, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 2000; }
        assert(cb);
        const expiry = new Date().getTime() + timeout;
        const blk = () => {
            this.getBalance((err, bal) => {
                if (err) return cb(err);
                if (bal !== oldBalance) return cb(null, bal);
                if (expiry < new Date().getTime()) return cb('timeout waiting for balance change (old = ${oldBalance})');
                setTimeout(blk, 100);
            });
        };
        blk();
    },
    apply(arr, fun, cb) {
        const v = [];
        return async.eachSeries(
            arr,
            (item, asyncCallback) => this[fun](item, (err, res) => {
                if (!err) v.push(res);
                asyncCallback(err);
            }),
            (err) => {
                cb(err, v);
            }
        );
    },
    /**
     * Determine if we are connected to the given node.
     * Returns true if we are, false if not.
     */
    isConnected(node, bidirectionalCheck = false) {
        return this.connections.indexOf(`${node.host}:${node.port}`) !== -1 ||
               (bidirectionalCheck && node.connections.indexOf(`${this.host}:${this.port}`) !== -1);
    },
    /**
     * Determine if we are connected to the given set of nodes. 
     * An array listing the connected nodes is returned.
     */
    getConnected(nodes) {
        const connected = [];
        for (const node of nodes) {
            const noderef = `${node.host}:${node.port}`;
            if (this.connections.indexOf(noderef) !== -1) connected.push(node);
        }
        return connected;
    },
    connect(node, cb) {
        if (Array.isArray(node)) return this.apply(node, 'connect', cb);
        const noderef = `${node.host}:${node.port}`;
        if (this.connections.indexOf(noderef) !== -1) {
            return cb(null);
        }
        this.connections.push(noderef);
        this.client.addNode(noderef, 'onetry', (err, info) => {
            cb(err, info);
        });
    },
    disconnect(node, cb) {
        if (Array.isArray(node)) return this.apply(node, 'disconnect', cb);
        const noderef = `${node.host}:${node.port}`;
        if (this.connections.indexOf(noderef) === -1) {
            return cb(null);
        }
        this.connections.removeOneByValue(noderef);
        this.client.disconnectNode(noderef, deinfo(cb));
    },
    generateBlocks(count, cb) {
        this.client.generate(count, deinfo(cb));
    },
    getNewAddress(cb) {
        this.client.getNewAddress(deinfo(cb));
    },
    sendToNode(node, btc, cb) {
        node.client.getNewAddress((err, info) => {
            if (err) return cb(err);
            return this.sendToAddress(info.result, btc, deinfo(cb));
        });
    },
    sendToAddress(addr, btc, cb) {
        this.client.sendToAddress(addr, btc, deinfo(cb));
    },
    /**
     * Wait for a given transaction with ID txid to appear in the mem pool.
     * The callback is called with (err, result), where result is 
     *      false       if the transaction could not be found,
     *      'mempool'   if the transaction was found in the mem pool
     */
    waitForTransaction(txid, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 2000; }
        let found = false;
        let broken = false;
        const expiry = new Date().getTime() + timeout;
        async.whilst(
            () => !found && !broken && expiry > new Date().getTime(),
            (whilstCallback) => {
                this.client.getRawMemPool((err, info) => {
                    if (err) {
                        broken = true;
                        return whilstCallback(err);
                    }
                    if (info.result.indexOf(txid) !== -1) {
                        found = 'mempool';
                        return whilstCallback(null);
                    }
                    setTimeout(whilstCallback, 200);
                });
            },
            (err) => {
                cb(err, found);
            }
        );
    },
    getScriptPubKey(addr, cb) {
        if (Array.isArray(addr)) return this.apply(addr, 'getScriptPubKey', cb);
        this.client.validateAddress(addr, (err, info) => {
            if (err) return cb(err);
            const spk1 = info.result.scriptPubKey;
            if (!spk1) return cb(`unable to get scriptPubKey for address ${addr}`);
            return cb(null, spk1);
        });
    },
    validateScriptPubKey(spk, cb) {
        if (spk.length < 50) return cb('scriptpubkey too short');
        if (spk.length > 50) return cb('scriptpubkey too long');
        if (spk.substr(0, 2) !== '76') return cb('OP_DUP not found');
        if (spk.substr(2, 2) !== 'a9') return cb('OP_HASH160 not found');
        if (spk.substr(46, 4) !== '88ac') return cb('OP_EQUALVERIFY OP_CHECKSIG not found');
        cb(null);
    },
    shareAddressWithNode(node, addr, cb) {
        this.client.validateAddress(addr, (err, info) => {
            if (err) return cb(err);
            if (info.ismine) {
                // we give the other node our private key
                this.client.dumpPrivKey(addr, (dumpErr, dumpInfo) => {
                    if (dumpErr) return cb(dumpErr);
                    node.client.importPrivKey(dumpInfo.result, deinfo(cb));
                });
            } else {
                // it must belong to the other node then
                node.client.dumpPrivKey(addr, (dumpErr, dumpInfo) => {
                    if (dumpErr) return cb(dumpErr);
                    this.client.importPrivKey(dumpInfo.result, '', false, deinfo(cb));
                });
            }
        });
    },
    createRawTransaction(recipientDict, utxoDict, cb) {
        this.client.createRawTransaction(utxoDict, recipientDict, deinfo(cb));
    },
    fundTransaction(recipientDict, cb) {
        this.client.createRawTransaction([], recipientDict, (err, info) => {
            if (err) return cb(err);
            this.client.fundRawTransaction(info.result, (fundErr, fundInfo) => {
                if (fundErr) return cb(fundErr);
                cb(fundErr, fundInfo.result.hex, fundInfo.result.changepos, fundInfo.result.fee);
            });
        })
    },
    createDoubleSpendTransaction(address1, address2, amount, cb) {
        if (!cb) { cb = amount; amount = 1; }
        if (!cb) { cb = address2; address2 = null; }
        if (!cb) { cb = address1; address1 = null; }
        if (!address1 || !address2)
            return this.client.getNewAddress((err, info) => {
                if (err) return cb(err);
                return this.createDoubleSpendTransaction(address1 || info.result, address1 ? address2 || info.result : address2, amount, cb);
            });
        // we do this in a few steps:
        // 1. get scriptPubKey for both addresses
        // 2. create and fund one transaction to address1
        // 3. copy first tx and replace scriptPubKey
        // 4. return both transactions as an array
        const recips1 = {};
        const recips2 = {};
        recips1[address1] = amount;
        recips2[address2] = amount;
        this.getScriptPubKey([address1, address2], (spkErr, spks) => {
            if (spkErr) return cb(spkErr);
            // 1. create and fund first tx
            this.fundTransaction(recips1, (errtx1, rawtx1) => {
                if (errtx1) {
                    console.log(`error funding transaction: ${JSON.stringify(errtx1)}`);
                    return cb(errtx1);
                }
                // 3. create a copy of the first tx
                const tx1 = new Transaction(rawtx1);
                //    find & replace the address1 scriptPubKey with the address2 one
                let found = false;
                for (const v of tx1.vout) {
                    if (v.scriptPubKey === spks[0]) {
                        v.scriptPubKey = spks[1];
                        found = true;
                        break;
                    }
                }
                if (!found) return cb('internal error -- unable to find scriptPubKey in transaction');
                const rawtx2 = tx1.encode();
                // check that this actually decodes
                this.client.decodeRawTransaction(rawtx2, (decErr, decInfo) => {
                    if (decErr) return cb(decErr);
                    // all is swell
                    cb(null, [rawtx1, rawtx2]);
                });
            });
        });
    },
};

module.exports = Node;
