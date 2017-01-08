const Node = require('./node');
const async = require('async');
const BitcoinNet = require('./net');
const { DeasyncObject } = require('./utils');

const BitcoinGraph = function(net) {
    this.net = net;
};

const space = '              ';
const lpad = (s, len) => {
    const x = (space + s);
    return s.length >= len ? s : x.substr(x.length - len);
};

BitcoinGraph.prototype = {
    printConnectionMatrix(nodes) {
        // sort nodes by port
        let sorted = [];
        for (const n of nodes) sorted.push(n);
        sorted.sort((a,b) => a.port < b.port);
        const map = {};
        let iter = 0;
        for (const n of sorted) {
            iter++;
            map[n.port] = '' + iter;
        }
        let s = "    ";
        for (const n of sorted) s += lpad(map[n.port], 4);
        console.log(s);
        for (const a of sorted) {
            s = lpad(map[a.port], 4);
            for (const b of sorted) {
                let z = '--';
                if (a.port !== b.port) {
                    z = (a.isConnected(b) ? 'o' : 'x') + (b.isConnected(a) ? 'o' : 'x');
                }
                s += lpad(z, 4);
            }
            console.log(s);
        }
    },
    printBlockChains(grpA, grpB, c) {
        const printUnified = (v) => console.log(`        ${v.substr(0,8)}`);
        const printLeft = (v) => console.log(`${v.substr(0,8)}`);
        const printRight = (v) => console.log(`                ${v.substr(0,8)}`);
        const printLeftRight = (v, w) => console.log(`${v.substr(0,8)}        ${w.substr(0,8)}`)
        grpA[0].getGenesisBlockHash((gerr, genesis) => {
            if (gerr) return c(err);
            grpA[0].client.listSinceBlock(genesis, (err, infoA) => {
                if (err) return c(err);
                const lastA = infoA.result.lastblock;
                grpB[0].client.listSinceBlock(genesis, (err2, infoB) => {
                    if (err2) return c(err);
                    const lastB = infoB.result.lastblock;
                    // from genesis and onward until we run into the last block for both groups
                    let ia = 1;
                    let ib = 1;
                    // genesis is shared
                    printUnified(genesis);
                    let unifiedPrinted = 1;
                    let unifiedKept = [];
                    async.whilst(
                        () => (ia > 0 && ib > 0),
                        (whilstCallback) => {
                            grpA[0].client.getBlockHash(ia, (err, bhInfoA) => {
                                grpB[0].client.getBlockHash(ib, (err, bhInfoB) => {
                                    const a = bhInfoA.result;
                                    const b = bhInfoB.result;
                                    if (a === b) {
                                        unifiedPrinted++;
                                        if (unifiedPrinted > 3) {
                                            unifiedKept.push(a);
                                        } else printUnified(a);
                                    } else {
                                        if (unifiedKept.length > 0) {
                                            if (unifiedKept.length > 3) {
                                                console.log('        ...');
                                                unifiedKept = unifiedKept.slice(unifiedKept.length - 3);
                                            }
                                            for (const k of unifiedKept)
                                                printUnified(k);
                                            unifiedKept = [];
                                        }
                                        unifiedPrinted = 0;
                                        printLeftRight(''+a, ''+b);
                                    }
                                    ia = a === lastA ? 0 : ia + 1;
                                    ib = b === lastB ? 0 : ib + 1;
                                    whilstCallback();
                                });
                            });
                        },
                        (err) => {
                            if (unifiedKept.length > 0) {
                                if (unifiedKept.length > 3) {
                                    console.log('        ...');
                                    unifiedKept = unifiedKept.slice(unifiedKept.length - 3);
                                }
                                for (const k of unifiedKept)
                                    printUnified(k);
                            }
                            async.whilst(
                                () => ia > 0,
                                (whilstCallback) => {
                                    grpA[0].client.getBlockHash(ia, (err, bhInfoA) => {
                                        const a = bhInfoA.result;
                                        printLeft('' + a);
                                        ia = a === lastA ? 0 : ia + 1;
                                        whilstCallback();
                                    });
                                },
                                () => {
                                    async.whilst(
                                        () => ib > 0,
                                        (whilstCallback) => {
                                            grpB[0].client.getBlockHash(ib, (err, bhInfoB) => {
                                                const b = bhInfoB.result;
                                                printRight('' + b);
                                                ib = b === lastB ? 0 : ib + 1;
                                                whilstCallback();
                                            });
                                        },
                                        c
                                    );
                                }
                            );
                        }
                    );
                });
            });
        });
    },
};

DeasyncObject(BitcoinGraph, [
  'printConnectionMatrix',
]);

module.exports = BitcoinGraph;
