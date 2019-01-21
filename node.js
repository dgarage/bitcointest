const bcrpc = require('bcrpc');
const async = require('async');
const assert = require('assert');
const remove = require('remove');
const mkdirp = require('mkdirp');
const { execFile } = require('child_process');
const Transaction = require('./transaction');
const ON_DEATH = require('death');
const { DeasyncObject } = require('./utils');
const { Block, BlockHeader } = require('./block');
const fs = require('fs');

let verbose = process.env.V === '1';
const log = (...args) => verbose ? console.log(...args) : null;

let runningNodes = [];
ON_DEATH((sig, err) => {
    if (runningNodes.length) console.log(`Interrupted: shutting down ${runningNodes.length} node(s) ...`);
    const rn = runningNodes;
    runningNodes = [];
    for (const n of rn) {
        n.stop();
    }
});

const Node = function(path, cfgpath, host, port, rpcport, user = 'user', pass = 'password', prot = 'http') {
    this.connections = [];
    this.connectStamp = {};
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

const embed = (dict, otherDict) => {
    if (!dict) return null;
    for (const k of Object.keys(dict)) {
        otherDict[k] = dict[k];
    }
    return otherDict;
};

Node.setVerbose = (v) => verbose = v;

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
            '-keypool=10',
            '-server=1',
            '-listen=1',
        ]);
    },
    start(cb) {
        assert(!this.bitcoindproc);
        this.running = true;
        remove(this.cfgpath, () => {
            mkdirp(this.cfgpath, (err) => {
                if (err) return cb ? cb(err) : null;
                runningNodes.push(this);
                const fin = (bin) => {
                    this.bitcoindproc = execFile(bin, this.bitcoindargs(), (err, sout, serr) => {
                        this.running = false;
                        this.bitcoindproc = null;
                        // console.log(`${this.port} bitcoind instance finished with out:\n${sout}\nerr:\n${serr}`);
                    });
                    if (cb) cb(null);
                }
                fs.access(`${this.path}/bitcoind`, fs.constants.X_OK, (err) => {
                    if (!err) return fin(`${this.path}/bitcoind`);
                    fs.access(`${this.path}/Bitcoin-Qt`, fs.constants.X_OK, (err) => {
                        if (err) throw err;
                        fin(`${this.path}/Bitcoin-Qt`);
                    });
                });
            });
        });
    },
    stop() {
        assert(this.bitcoindproc);
        for (let i = 0; i < runningNodes.length; i++)
            if (runningNodes[i].port === this.port && runningNodes[i].host === this.host) {
                runningNodes.splice(i, 1);
                break;
            }
        this.bitcoindproc.kill();
    },
    stringid() {
        return `${this.host}:${this.port}`;
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
        const msgPrintDict = {};
        let error = null;
        const expiry = new Date().getTime() + timeout;
        async.whilst(
            () => waitForBitcoind && expiry > new Date().getTime(),
            (cb) => {
                // TODO: look into why getInfo returns twice sometimes
                let calledBack = false;
                this.client.getInfo((err, gbt) => {
                    if (calledBack) return;
                    calledBack = true;
                    error = err;
                    if (err) {
                        if (!gbt || (err.code && err.code === -9)) {
                            // ECONNREFUSED, err === {} && !gbt
                            // err.code === -9 for a split second during bitcoind startup
                            if (connFailurePrint) {
                                if (err.message === 'bitcoin JSON-RPC connection rejected: 401 unauthorized') {
                                    waitForBitcoind = false;
                                    return cb('404 unauthorized');
                                }
                                connFailurePrint = false;
                            }
                            return setTimeout(cb, 200);
                        }
                        if (err.code && err.code === -10) {
                            // getBlockTemplate returns error code -10 while "Bitcoin is downloading blocks..."
                            if (syncPrint) {
                                log('    ○ bitcoind is syncing blocks... waiting for completion');
                                syncPrint = false;
                            }
                            return setTimeout(cb, 1000);
                        }
                        if (err.code && err.code === -28) {
                            // loading something or other
                            if (!msgPrintDict[err.message]) {
                                log(`    ○ bitcoind is ${err.message.toLowerCase()} waiting for completion`);
                                msgPrintDict[err.message] = true;
                            }
                            return setTimeout(cb, 300);
                        }
                        // FATAL: unknown other error
                        waitForBitcoind = false;
                        return cb(`unknown bitcoind error; make sure node is configured: client=${this.client}, port=${this.port}, rpcport=${this.rpcport}`);
                    }
                    waitForBitcoind = false;
                    return cb();
                });
            },
            () => mcb(waitForBitcoind ? 'timeout' : null)
        );
    },
    getBalance(cb) {
        this.client.getBalance((err, info) => cb(err, err ? null : info.result));
    },
    getSyncState(node, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 6000; }
        assert(typeof(cb) == 'function');
        let done = false;
        let synced = false;
        let ourHeight;
        let theirHeight;
        async.waterfall([
            (c) => this.client.getBlockCount((err, info) => {
                if (err) return c(err);
                ourHeight = info.result;
                node.client.getBlockCount((err2, info2) => {
                    if (err2) return c(err2);
                    theirHeight = info2.result;
                    done = ourHeight !== theirHeight;
                    c(done ? 'async' : null);
                });
            }),
            (c) => {
                // we now check if the hashes match
                this.client.getBlockHash(ourHeight, c);
            },
            (info, c) => {
                const ourBlockHash = info.result;
                node.client.getBlockHash(theirHeight, (err, info2) => {
                    if (err) return c(err);
                    const theirBlockHash = info2.result;
                    synced = ourBlockHash === theirBlockHash;
                    c();
                });
            }
        ],
        (err) => {
            cb(err === 'async' ? null : err, synced);
        });
    },
    sync(node, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 6000; }
        assert(typeof(cb) == 'function');
        if (!this.isConnected(node, true))
            log('warning: nodes not connected in sync call; they will probably never sync');
        let synced = false;
        let errored = null;
        const expiry = new Date().getTime() + 6000;
        async.whilst(
            () => !errored && !synced && expiry > new Date().getTime(),
            (c) => this.getSyncState(node, timeout, (err, state) => {
                synced = state;
                errored = !!err;
                if (!err && !synced)
                    setTimeout(c, 100);
                else
                    c(err);
            }),
            (err) => {
                if (err) return cb(err);
                if (!synced) return cb('timeout waiting for node sync');
                cb();
            }
        );
    },
    waitForBalanceChange(oldBalance, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 2000; }
        assert(typeof(cb) === 'function');
        const expiry = new Date().getTime() + timeout;
        const blk = () => {
            this.getBalance((err, bal) => {
                if (err) return cb(err);
                if (bal !== oldBalance) return cb(null, bal);
                if (expiry < new Date().getTime()) return cb(`timeout waiting for balance change (old = ${oldBalance})`);
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
    prepareConnectionChange(node, cb) {
        const noderef = `${node.host}:${node.port}`;
        const myNoderef = `${this.host}:${this.port}`;
        let now = new Date().getTime();
        let lastUpdate = 0;
        for (const s of [this.connectStamp[noderef], node.connectStamp[myNoderef]]) {
            if (s && s > lastUpdate) lastUpdate = s;
        }
        const threshold = lastUpdate + 500; // we allow 1 change in connection state per 500 ms to avoid node confusion
        const waitTime = threshold - now;
        if (waitTime > 0) setTimeout(cb, waitTime); else cb();
    },
    connect(node, cb) {
        assert(typeof(cb) === 'function');
        if (Array.isArray(node)) return this.apply(node, 'connect', cb);
        const noderef = `${node.host}:${node.port}`;
        if (this.connections.indexOf(noderef) !== -1) {
            return cb(null);
        }
        const myNoderef = `${this.host}:${this.port}`;
        if (node.connections.indexOf(myNoderef) !== -1) {
            return cb(null);
        }
        this.prepareConnectionChange(node, () => {
            this.connectStamp[noderef] = new Date().getTime();
            this.connections.push(noderef);
            this.client.addNode(noderef, 'onetry', (err, info) => {
                cb(err, err ? null : info.result);
            });
        });
    },
    disconnect(node, cb) {
        assert(typeof(cb) === 'function');
        if (Array.isArray(node)) return this.apply(node, 'disconnect', cb);
        const noderef = `${node.host}:${node.port}`;
        if (this.connections.indexOf(noderef) === -1) {
            return cb(null);
        }
        this.prepareConnectionChange(node, () => {
            this.connectStamp[noderef] = new Date().getTime();
            this.connections.removeOneByValue(noderef);
            this.client.disconnectNode(noderef, (err, info) => {
                cb(err, err ? null : info.result);
            });
        });
    },
    getGenesisBlockHash(cb) {
        this.client.getBlockHash(0, (err, info) => cb(err, err ? null : info.result));
    },
    generateBlocks(count, cb) {
        assert(typeof(cb) === 'function');
        this.client.getNewAddress((err, info) => {
            if (err) return cb(err);
            const addr = info.result;
            this.client.generateToAddress(count, addr, (err, info) => cb(err, err ? null : info.result));
        });
    },
    getBlock(blockhash, cb) {
        assert(typeof(cb) === 'function');
        const b = new Block();
        b.fetchFromNode(this, blockhash, (err) => {
            cb(err, b);
        });
    },
    getBlockHeader(blockhash, cb) {
        assert(typeof(cb) === 'function');
        const h = new BlockHeader();
        h.fetchFromNode(this, blockhash, (err) => {
            cb(err, h);
        });
    },
    getNewAddress(cb) {
        assert(typeof(cb) === 'function');
        this.client.getNewAddress((err, info) => cb(err, err ? null : info.result));
    },
    sendToNode(node, btc, cb) {
        assert(typeof(cb) === 'function');
        node.client.getNewAddress((err, info) => {
            if (err) return cb(err);
            return this.client.sendToAddress(info.result, btc, (err, info) => cb(err, err ? null : info.result));
        });
    },
    sendToAddress(addr, btc, cb) {
        this.client.sendToAddress(addr, btc, (err, info) => cb(embed(err, { addr, btc }), err ? null : info.result));
    },
    /**
     * Wait for a given transaction with ID txid to appear in the mem pool.
     * The callback is called with (err, result), where result is
     *      false       if the transaction could not be found,
     *      'mempool'   if the transaction was found in the mem pool
     */
    waitForTransaction(txid, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 10000; }
        assert(typeof(cb) === 'function');
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
                    this.client.getRawTransaction(txid, (err2, info2) => {
                        if (!err2) {
                            found = 'getrawtx';
                            return whilstCallback(null);
                        }
                        setTimeout(whilstCallback, 200);
                    });
                });
            },
            (err) => {
                cb(err, found);
            }
        );
    },
    getScriptPubKey(addr, cb) {
        if (Array.isArray(addr)) return this.apply(addr, 'getScriptPubKey', cb);
        this.client.getAddressInfo(addr, (err, info) => {
            if (err) return cb(err);
            const spk1 = info.result.scriptPubKey;
            if (!spk1) return cb(`unable to get scriptPubKey for address ${addr}`);
            return cb(null, spk1);
        });
    },
    validateScriptPubKey(spk, cb) {
        if (spk.length == 50) {
            // P2PKH
            if (spk.substr(0, 2) !== '76') return cb('OP_DUP not found');
            if (spk.substr(2, 2) !== 'a9') return cb('OP_HASH160 not found');
            if (spk.substr(46, 4) !== '88ac') return cb('OP_EQUALVERIFY OP_CHECKSIG not found');
        } else if (spk.length == 46) {
            // P2WPKH
            if (spk.substr(0, 2) !== 'a9') return cb('OP_HASH160 not found');
            if (spk.substr(44, 2) !== '87') return cb('OP_EQUAL not found');
        } else {
            return cb(`unknown scriptPubKey (length=${spk.length})`);
        }
        cb(null);
    },
    /**
     * Send a raw transaction, optionally signing it before sending.
     */
    sendRawTransaction(transaction, signBeforeSend, cb) {
        if (!cb) { cb = signBeforeSend; signBeforeSend = false; }
        async.waterfall([
            (c) => {
                if (signBeforeSend) {
                    this.client.signRawTransactionWithWallet(transaction, c);
                } else {
                    c(null, { result: transaction });
                }
            },
            (info, c) => {
                if (info.result.complete !== true) {
                    return c('Unable to sign transaction');
                }
                this.client.sendRawTransaction(info.result.hex, c);
            },
        ], (err, info) => cb(err, err ? null : info.result));
    },
    /**
     * Find an UTXO which contains at least the given amount.
     * If no UTXO was found matching the requirement, null is returned.
     */
    findSpendableOutput(minimumAmount, cb) {
        if (!cb) { cb = minimumAmount; minimumAmount = 0.0000001; }
        this.client.listUnspent((err, info) => {
            if (err) return cb(err);
            for (const utxo of info.result) {
                if (utxo.amount >= minimumAmount) return cb(null, utxo);
            }
            cb(null, null);
        });
    },
    /**
     * Send the given amount from the given UTXO to the given address.
     * Optionally a UTXO index can be given, which defaults to 0 if left out.
     * A change output to a new address owned by this node is generated and
     * added to the transaction.
     * It is recommended but not required that the utxo parameter is an actual
     * utxo entry in the form seen by `listunspent`. At minimum, it must then
     * contain a txid and a vout, and if it has an amount value it means one
     * less round-trip to the bitcoin daemon, in determining the change output.
     */
    spendUTXO(utxo, toAddress, amount, fromUtxoIndex, cb) {
        if (!cb) { cb = fromUtxoIndex; fromUtxoIndex = 0; }
        let utxoAmount = -1;
        let change;
        if (utxo.txid) {
            // this is a listunspent entry
            fromUtxoIndex = utxo.vout;
            utxoAmount = utxo.amount;
            utxo = utxo.txid;
        }
        const recipientDict = {};
        const utxoDict = [{
            txid: utxo,
            vout: fromUtxoIndex,
        }];
        recipientDict[toAddress] = amount;
        if (utxoAmount > 0) {
            // we do not have to addChangeOutputToTransaction
            change = utxoAmount - amount - 0.0003;
        }
        const trimmedRD = (rd) => {
            const r = {};
            for (const txid of Object.keys(rd)) {
                r[txid] = rd[txid].toFixed(8);
            }
            return r;
        };
        async.waterfall([
            (c) => async.waterfall([
                (cc) => {
                    if (utxoAmount > 0) {
                        if (change > 0) {
                            return this.getNewAddress((err, addr) => {
                                recipientDict[addr] = change;
                                cc();
                            });
                        }
                    }
                    cc();
                },
                (cc) => this.createRawTransaction(trimmedRD(recipientDict), utxoDict, cc),
            ], c),
            (rawtx, c) => utxoAmount > 0 ? c(null, rawtx) : this.addChangeOutputToTransaction(rawtx, c),
            (rawtx, c) => this.sendRawTransaction(rawtx, true, c),
        ], (err, info) => cb(embed(err, { toAddress, amount, utxoAmount, change, fromUtxoIndex }), info));
    },
    /**
     * Hand the private key for the given address (presumably owned by us) to
     * the given node, so that it now owns that address as well.
     * If rescan is true, the node will scan the block chain for unspent outputs
     * and add them to its list of unspents, as well as its balance. For a
     * big block chain, this can take a long time (minutes).
     */
    shareAddressWithNode(node, addr, rescan, cb) {
        if (!cb) { cb = rescan; rescan = false; }
        this.client.getAddressInfo(addr, (err, info) => {
            if (err) return cb(err);
            if (info.result.ismine) {
                // we give the other node our private key
                this.client.dumpPrivKey(addr, (dumpErr, dumpInfo) => {
                    if (dumpErr) return cb(dumpErr);
                    node.client.importPrivKey(dumpInfo.result, '', rescan, (importErr, importInfo) => cb(importErr, importErr ? null : importInfo.result));
                });
            } else {
                // it must belong to the other node then
                node.client.dumpPrivKey(addr, (dumpErr, dumpInfo) => {
                    if (dumpErr) return cb(dumpErr);
                    this.client.importPrivKey(dumpInfo.result, '', rescan, (importErr, importInfo) => cb(importErr, importErr ? null : importInfo.result));
                });
            }
        });
    },
    getTransaction(txid, detailed, cb) {
        if (!cb) { cb = detailed; detailed = false; }
        if (detailed) {
            this.client.getRawTransaction(txid, true, (err, info) => cb(err, info.result));
        } else {
            this.client.getTransaction(txid, (err, info) => cb(err, info.result));
        }
    },
    /**
     * Create a raw transaction sending bitcoins according to the recipient dict,
     * which is of the form
     *  { bitcoinaddress: bitcoinvalue, [...] }
     * The UTXO dict, if provided, is an array of outpoints, in the format
     *  [
     *      {
     *          txid: <transaction ID>,
     *          vout: <the output number>,
     *      },
     *  ]
     */
    createRawTransaction(recipientDict, utxoDict, cb) {
        this.client.createRawTransaction(utxoDict, recipientDict, (err, info) => cb(err, err ? null : info.result));
    },
    createAndFundTransaction(recipientDict, cb) {
        this.client.createRawTransaction([], recipientDict, (err, info) => {
            if (err) return cb(err);
            this.client.fundRawTransaction(info.result, (fundErr, fundInfo) => {
                if (fundErr) return cb(fundErr);
                cb(fundErr, fundInfo.result);
            });
        })
    },
    /**
     * Calculates the total input value and generates a change UTXO to the
     * node's own address (or optionally to a specific changeAddress).
     * A flat rate fee of 150 satoshis per byte (approxpimately) is deducted
     * from the final value.
     */
    addChangeOutputToTransaction(transaction, changeAddress, cb) {
        if (!cb) { cb = changeAddress; changeAddress = null; }
        // transaction may be a hex string of a raw transaction, or it may be
        // a Transaction object
        const txob = transaction.decode ? transaction : new Transaction(transaction);
        // we need to gather the total input value from each of the vins
        let totalValue = 0;
        let totalSpent = 0;
        let changeScriptPubKey;
        const txbytes = (txob.encode().length / 2) + 20; // add some for the change vout; the encode is a hex string, hence halved
        for (const utxo of txob.vout) {
            totalSpent += utxo.value;
        }
        async.waterfall([
            (c) => {
                if (changeAddress) return c();
                this.client.getNewAddress((err, info) => {
                    if (err) return c(err);
                    changeAddress = info.result;
                    c();
                });
            },
            (c) => this.getScriptPubKey(changeAddress, c),
            (spk, c) => {
                changeScriptPubKey = spk;
                async.eachSeries(
                    txob.vin,
                    (outpoint, asyncCallback) => {
                        this.client.getTransaction(outpoint.hash, (err, info) => {
                            if (err) return asyncCallback(err);
                            if (!info || !info.result || !info.hex) return asyncCallback('client.getTransaction did not return a hex value');
                            const prevtx = new Transaction(info.result.hex);
                            if (prevtx.vout.length <= outpoint.n) return asyncCallback(`prevout only has outpoints [0..${prevtx.vout.length-1}]; ${outpoint.n} is out of bounds`);
                            const prevutxo = prevtx.vout[outpoint.n];
                            totalValue += prevutxo.value;
                            asyncCallback();
                        });
                    },
                    c
                );
            }
        ],
        (err) => {
            if (err) return cb(err);
            // calculate fee as 150 satoshi / byte
            const fee = 150 * txbytes;
            let change = (totalValue - totalSpent);
            change = change < fee ? 0 : change - fee;
            txob.vout.push({
                amount: change,
                scriptPubKey: changeScriptPubKey,
            });
            cb(null, transaction.decode ? txob : txob.encode());
        });
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
            this.createAndFundTransaction(recips1, (errtx1, tx1result) => {
                if (errtx1) {
                    console.log(`error funding transaction: ${JSON.stringify(errtx1)}`);
                    return cb(errtx1);
                }
                // 3. create a copy of the first tx
                const rawtx1 = tx1result.hex;
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

DeasyncObject(Node, [
  'baseargs',
  'bitcoindargs',
  'stop',
  'stringid',
  'isConnected',
  'getConnected',
]);

module.exports = Node;
